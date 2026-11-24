//! Agent402 Bond v2 — pure deal rules. No Solana dependencies, so every rule is tested on its own.
//!
//! Amounts are token base units (u64). Times are unix seconds (i64, the Solana clock).
//! Principle: a party's action is allowed while `now <= deadline`; settling is allowed when `now > deadline`.
//! Every terminal path goes through [`finalize`], which cannot fail, and pays out exactly what the vault holds
//! for the deal: `to_seller + to_buyer == locked` (or `== vault` if the vault were ever short).

pub mod caps;
#[cfg(test)]
mod tests;

pub const DAY: i64 = 86_400;
pub const HOUR: i64 = 3_600;
/// Seller's grace after `deliver_by` to mark delivery (decision 2: provisional, to confirm against clock research).
pub const GRACE_MIN: i64 = HOUR;
pub const GRACE_MAX: i64 = DAY;
/// Buyer's minimum time to review after a mark.
pub const REVIEW_MIN: i64 = GRACE_MIN;
pub const REVIEW_MAX: i64 = 7 * DAY;
pub const ARB_MIN: i64 = HOUR;
pub const ARB_MAX: i64 = 7 * DAY;
/// `deliver_by - opened_at`, including extensions.
pub const MAX_DELIVER: i64 = 30 * DAY;
/// Seller bond at most 20% of the price (decision 7).
pub const MAX_BOND_BPS: u64 = 2_000;
pub const BPS: u64 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Error {
    Paused,
    SameParty,
    ZeroPrice,
    ZeroBond,
    BondTooLarge,
    DepositTooLarge,
    DeadlineInPast,
    TermTooLong,
    GraceOutOfRange,
    ReviewWindowOutOfRange,
    BadShare,
    BadArbiter,
    PerDealCapExceeded,
    TotalCapExceeded,
    NotOpen,
    AlreadyMarked,
    MarkTooLate,
    AcceptTooLate,
    NotYetSettleable,
    BadSplit,
    ArbiterSet,
    ReleaseTooLate,
    Unauthorized,
    OutsideArbiterWindow,
    ExtendNotLonger,
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Open,
    Marked,
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Accepted,
    Unconfirmed,
    SellerDefault,
    Cancelled,
    Agreed,
    Arbitrated,
    Released,
}

/// Terms fixed at open (both parties sign them).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Terms {
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub grace: i64,
    pub review_window: i64,
    /// Share of the buyer deposit paid to the seller if a marked deal is never accepted (0 = neutral, as v1).
    pub seller_share_bps: u16,
    /// Whether an arbiter was named (its key lives in the on-chain account).
    pub has_arbiter: bool,
    pub arbiter_window: i64,
}

impl Terms {
    /// Locked in the vault: seller bond + buyer deposit.
    pub fn locked(&self) -> u64 {
        self.seller_bond.saturating_add(self.buyer_deposit)
    }
    /// Paid by the buyer directly to the seller on accept (never held by the program).
    pub fn balance(&self) -> u64 {
        self.price - self.buyer_deposit
    }
    /// Mark deadline.
    pub fn m(&self) -> i64 {
        self.deliver_by.saturating_add(self.grace)
    }
}

/// Checks the open arguments. `caps` are the effective caps at `now`; `total_locked` the mint's open total.
#[allow(clippy::too_many_arguments)]
pub fn check_open(
    t: &Terms,
    now: i64,
    paused: bool,
    same_party: bool,
    arbiter_is_party: bool,
    per_deal_cap: u64,
    total_cap: u64,
    total_locked: u64,
) -> Result<(), Error> {
    if paused {
        return Err(Error::Paused);
    }
    if same_party {
        return Err(Error::SameParty);
    }
    if t.price == 0 {
        return Err(Error::ZeroPrice);
    }
    if t.seller_bond == 0 {
        return Err(Error::ZeroBond);
    }
    let max_bond = (t.price as u128 * MAX_BOND_BPS as u128 / BPS as u128) as u64;
    if t.seller_bond > max_bond {
        return Err(Error::BondTooLarge);
    }
    if t.buyer_deposit > t.price {
        return Err(Error::DepositTooLarge);
    }
    if t.deliver_by <= now {
        return Err(Error::DeadlineInPast);
    }
    if t.deliver_by - now > MAX_DELIVER {
        return Err(Error::TermTooLong);
    }
    if !(GRACE_MIN..=GRACE_MAX).contains(&t.grace) {
        return Err(Error::GraceOutOfRange);
    }
    if !(REVIEW_MIN..=REVIEW_MAX).contains(&t.review_window) {
        return Err(Error::ReviewWindowOutOfRange);
    }
    if t.seller_share_bps as u64 > BPS {
        return Err(Error::BadShare);
    }
    if t.has_arbiter {
        if arbiter_is_party || !(ARB_MIN..=ARB_MAX).contains(&t.arbiter_window) {
            return Err(Error::BadArbiter);
        }
    } else if t.arbiter_window != 0 {
        return Err(Error::BadArbiter);
    }
    let l = t.seller_bond.checked_add(t.buyer_deposit).ok_or(Error::Overflow)?;
    if l > per_deal_cap {
        return Err(Error::PerDealCapExceeded);
    }
    if total_locked.checked_add(l).map_or(true, |x| x > total_cap) {
        return Err(Error::TotalCapExceeded);
    }
    Ok(())
}

/// The rule state of one deal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Deal {
    pub terms: Terms,
    pub opened_at: i64,
    pub state: State,
    pub marked_at: Option<i64>,
}

/// What a terminal path decided: shares of the locked amount.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Decision {
    pub outcome: Outcome,
    pub to_seller: u64,
    pub to_buyer: u64,
}

impl Deal {
    pub fn open(terms: Terms, now: i64) -> Self {
        Deal { terms, opened_at: now, state: State::Open, marked_at: None }
    }

    /// Accept deadline after a mark: an early mark never shortens the buyer's time (counts from `deliver_by` at the earliest).
    pub fn a(&self) -> Option<i64> {
        self.marked_at.map(|m| m.max(self.terms.deliver_by).saturating_add(self.terms.review_window))
    }
    /// End of the arbiter window (== A when there is no arbiter).
    pub fn r(&self) -> Option<i64> {
        self.a().map(|a| a.saturating_add(self.terms.arbiter_window))
    }
    /// The time from which settle always succeeds, whatever the parties do (bounded at open).
    pub fn settle_by(&self) -> i64 {
        let t = &self.terms;
        t.deliver_by
            .saturating_add(t.grace)
            .saturating_add(t.review_window)
            .saturating_add(t.arbiter_window)
            .saturating_add(1)
    }

    fn require_live(&self) -> Result<(), Error> {
        if self.state == State::Settled {
            Err(Error::NotOpen)
        } else {
            Ok(())
        }
    }

    pub fn mark(&mut self, now: i64) -> Result<(), Error> {
        match self.state {
            State::Settled => return Err(Error::NotOpen),
            State::Marked => return Err(Error::AlreadyMarked),
            State::Open => {}
        }
        if now > self.terms.m() {
            return Err(Error::MarkTooLate);
        }
        self.marked_at = Some(now);
        self.state = State::Marked;
        Ok(())
    }

    /// Buyer accepts and pays the balance in the same instruction. Returns the decision; the balance
    /// (`terms.balance()`) moves buyer → seller outside the vault in the same instruction.
    pub fn accept(&mut self, now: i64) -> Result<Decision, Error> {
        self.require_live()?;
        let deadline = match self.state {
            State::Open => self.terms.m(),
            _ => self.a().unwrap_or(i64::MIN),
        };
        if now > deadline {
            return Err(Error::AcceptTooLate);
        }
        Ok(self.close(Outcome::Accepted, self.terms.locked()))
    }

    /// Anyone, once the outcome is fixed by time.
    pub fn settle(&mut self, now: i64) -> Result<Decision, Error> {
        self.require_live()?;
        let t = self.terms;
        match self.state {
            State::Open if now > t.m() => Ok(self.close(Outcome::SellerDefault, 0)),
            State::Marked if now > self.r().unwrap_or(i64::MAX) => {
                let k = (t.buyer_deposit as u128 * t.seller_share_bps as u128 / BPS as u128) as u64;
                Ok(self.close(Outcome::Unconfirmed, t.seller_bond + k))
            }
            _ => Err(Error::NotYetSettleable),
        }
    }

    /// Both parties sign: each side gets its own money back.
    pub fn cancel(&mut self) -> Result<Decision, Error> {
        self.require_live()?;
        Ok(self.close(Outcome::Cancelled, self.terms.seller_bond))
    }

    /// Both parties sign any split of the locked amount.
    pub fn settle_agreed(&mut self, to_seller: u64) -> Result<Decision, Error> {
        self.require_live()?;
        if to_seller > self.terms.locked() {
            return Err(Error::BadSplit);
        }
        Ok(self.close(Outcome::Agreed, to_seller))
    }

    /// Seller alone ends the deal neutrally (each side its own money). Not when an arbiter is named, and not
    /// after the mark deadline of an unmarked deal (it cannot be used to escape SellerDefault).
    pub fn seller_release(&mut self, now: i64) -> Result<Decision, Error> {
        self.require_live()?;
        if self.terms.has_arbiter {
            return Err(Error::ArbiterSet);
        }
        if self.state == State::Open && now > self.terms.m() {
            return Err(Error::ReleaseTooLate);
        }
        Ok(self.close(Outcome::Released, self.terms.seller_bond))
    }

    /// The named arbiter splits the locked amount between the two parties, only in (A, R].
    pub fn decide(&mut self, now: i64, is_arbiter: bool, to_seller: u64) -> Result<Decision, Error> {
        self.require_live()?;
        if !self.terms.has_arbiter || !is_arbiter {
            return Err(Error::Unauthorized);
        }
        let (a, r) = match (self.state, self.a(), self.r()) {
            (State::Marked, Some(a), Some(r)) => (a, r),
            _ => return Err(Error::OutsideArbiterWindow),
        };
        if now <= a || now > r {
            return Err(Error::OutsideArbiterWindow);
        }
        if to_seller > self.terms.locked() {
            return Err(Error::BadSplit);
        }
        Ok(self.close(Outcome::Arbitrated, to_seller))
    }

    /// Both parties sign longer deadlines (never shorter). grace and arbiter_window do not change.
    pub fn extend(&mut self, deliver_by: i64, review_window: i64) -> Result<(), Error> {
        self.require_live()?;
        let t = &mut self.terms;
        if deliver_by < t.deliver_by || review_window < t.review_window || (deliver_by == t.deliver_by && review_window == t.review_window) {
            return Err(Error::ExtendNotLonger);
        }
        if deliver_by - self.opened_at > MAX_DELIVER {
            return Err(Error::TermTooLong);
        }
        if review_window > REVIEW_MAX {
            return Err(Error::ReviewWindowOutOfRange);
        }
        t.deliver_by = deliver_by;
        t.review_window = review_window;
        Ok(())
    }

    fn close(&mut self, outcome: Outcome, to_seller: u64) -> Decision {
        self.state = State::Settled;
        let l = self.terms.locked();
        let s = to_seller.min(l);
        Decision { outcome, to_seller: s, to_buyer: l - s }
    }
}

/// Amounts owed after a decision, given what the vault actually holds. Never fails.
/// If the vault holds less than `locked` (no known path; a safety net), both shares shrink pro rata and the
/// remainder goes to the buyer; `short` is reported so operators can pause.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Owed {
    pub seller: u64,
    pub buyer: u64,
    pub short: bool,
}

pub fn finalize(d: &Decision, locked: u64, vault: u64) -> Owed {
    if vault >= locked || locked == 0 {
        Owed { seller: d.to_seller, buyer: d.to_buyer, short: false }
    } else {
        let s = (d.to_seller as u128 * vault as u128 / locked as u128) as u64;
        Owed { seller: s, buyer: vault - s, short: true }
    }
}

/// Seller claim: what to transfer now (never more than the vault holds).
pub fn claim_seller_amount(owed_seller: u64, vault: u64) -> u64 {
    owed_seller.min(vault)
}

/// Buyer claim: everything in the vault beyond what is still owed to the seller (includes tokens sent directly).
pub fn claim_buyer_amount(owed_seller: u64, vault: u64) -> u64 {
    vault.saturating_sub(owed_seller)
}
