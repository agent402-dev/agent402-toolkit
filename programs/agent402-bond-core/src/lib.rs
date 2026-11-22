//! Settlement logic for the Agent402 performance bond.
//!
//! This crate has no dependencies and no I/O. The on-chain program calls these
//! functions and only moves tokens according to the returned `Payout`.
//!
//! Rules (all times are the on-chain clock, in seconds):
//! - T1 = deliver_by + GRACE, T2 = T1 + late_window.
//! - Delivery time = seller mark time if the seller marked and the buyer
//!   later confirmed; otherwise the buyer confirmation time.
//! - Buyer confirmed: seller bond goes to the seller, minus a pro-rata
//!   late deduction to the buyer. Buyer deposit goes to the seller (it is part
//!   of the price). If the balance is not paid by delivery + pay_window + GRACE,
//!   the deposit still goes to the seller (buyer default).
//! - Seller marked, buyer never confirmed: neutral release (bond to seller,
//!   deposit to buyer). Recorded as disputed.
//! - Nothing marked by T2: bond and deposit go to the buyer (seller default).
//! - Both parties may cancel together: bond to seller, deposit to buyer.

pub mod caps;
pub mod price;

pub const DAY: i64 = 86_400;
pub const YEAR: i64 = 365 * DAY;
pub const GRACE: i64 = DAY;
pub const MAX_TERM: i64 = 180 * DAY;
pub const MAX_LATE_WINDOW: i64 = 7 * DAY;
pub const MIN_PAY_WINDOW: i64 = DAY;
pub const MAX_PAY_WINDOW: i64 = 30 * DAY;
/// Seller bond may be at most 20% of the price.
pub const MAX_BOND_BPS: u64 = 2_000;
/// Caps grow 2% per full year after deployment (inflation target).
pub const CAP_GROWTH_NUM: u128 = 102;
pub const CAP_GROWTH_DEN: u128 = 100;
/// Bound the growth loop so compute stays fixed.
pub const MAX_CAP_YEARS: i64 = 100;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    ZeroPrice,
    ZeroBond,
    BondTooLarge,
    DepositTooLarge,
    DeadlineInPast,
    TermTooLong,
    LateWindowTooLong,
    PayWindowOutOfRange,
    PerDealCapExceeded,
    TotalCapExceeded,
    NotOpen,
    AlreadyMarked,
    AlreadyConfirmed,
    MarkTooLate,
    ConfirmTooLate,
    NotConfirmed,
    AlreadyPaid,
    PayTooLate,
    NotYetSettleable,
    Overflow,
    CapChangeOutOfBounds,
    BadPoolPrice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Terms {
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub late_window: i64,
    pub pay_window: i64,
}

impl Terms {
    pub fn balance(&self) -> u64 {
        // Safe: validate() guarantees buyer_deposit <= price.
        self.price - self.buyer_deposit
    }
    pub fn locked(&self) -> Result<u64, Error> {
        self.seller_bond
            .checked_add(self.buyer_deposit)
            .ok_or(Error::Overflow)
    }
    pub fn t1(&self) -> i64 {
        self.deliver_by.saturating_add(GRACE)
    }
    pub fn t2(&self) -> i64 {
        self.t1().saturating_add(self.late_window)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Deal {
    pub terms: Terms,
    pub opened_at: i64,
    pub seller_mark: Option<i64>,
    pub buyer_confirm: Option<i64>,
    pub balance_paid: bool,
    pub status: Status,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Delivered,
    BuyerDefault,
    Disputed,
    SellerDefault,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payout {
    pub to_seller: u64,
    pub to_buyer: u64,
    pub outcome: Outcome,
}

/// Cap after `n` full years at 2% per year, computed in integers.
pub fn cap_at(base: u64, deployed_at: i64, now: i64) -> u64 {
    if now <= deployed_at {
        return base;
    }
    let years = ((now - deployed_at) / YEAR).min(MAX_CAP_YEARS);
    let mut cap = base as u128;
    for _ in 0..years {
        cap = cap * CAP_GROWTH_NUM / CAP_GROWTH_DEN;
    }
    cap.min(u64::MAX as u128) as u64
}

pub struct Caps {
    pub per_deal: u64,
    pub total: u64,
}

fn check_windows(t: &Terms, now: i64) -> Result<(), Error> {
    if t.deliver_by <= now {
        return Err(Error::DeadlineInPast);
    }
    if t.deliver_by - now > MAX_TERM {
        return Err(Error::TermTooLong);
    }
    if t.late_window < 0 || t.late_window > MAX_LATE_WINDOW {
        return Err(Error::LateWindowTooLong);
    }
    if t.pay_window < MIN_PAY_WINDOW || t.pay_window > MAX_PAY_WINDOW {
        return Err(Error::PayWindowOutOfRange);
    }
    Ok(())
}

/// Validate terms at opening. `total_locked` is the program-wide amount
/// currently held for this mint.
pub fn open(t: Terms, now: i64, caps: &Caps, total_locked: u64) -> Result<Deal, Error> {
    if t.price == 0 {
        return Err(Error::ZeroPrice);
    }
    if t.seller_bond == 0 {
        return Err(Error::ZeroBond);
    }
    let max_bond = (t.price as u128 * MAX_BOND_BPS as u128 / 10_000) as u64;
    if t.seller_bond > max_bond {
        return Err(Error::BondTooLarge);
    }
    if t.buyer_deposit > t.price {
        return Err(Error::DepositTooLarge);
    }
    check_windows(&t, now)?;
    let locked = t.locked()?;
    if locked > caps.per_deal {
        return Err(Error::PerDealCapExceeded);
    }
    let new_total = total_locked.checked_add(locked).ok_or(Error::Overflow)?;
    if new_total > caps.total {
        return Err(Error::TotalCapExceeded);
    }
    Ok(Deal {
        terms: t,
        opened_at: now,
        seller_mark: None,
        buyer_confirm: None,
        balance_paid: false,
        status: Status::Open,
    })
}

impl Deal {
    fn require_open(&self) -> Result<(), Error> {
        if self.status != Status::Open {
            return Err(Error::NotOpen);
        }
        Ok(())
    }

    /// Delivery time once the buyer has confirmed.
    pub fn delivery_time(&self) -> Option<i64> {
        let c = self.buyer_confirm?;
        Some(match self.seller_mark {
            Some(m) => m.min(c),
            None => c,
        })
    }

    /// Last moment the buyer may confirm or pay.
    /// A mark or confirm before T1 never shortens the buyer's time: the
    /// window always runs from max(delivery, T1). This keeps a seller from
    /// ending a deal early by marking right after opening.
    fn buyer_deadline(&self) -> i64 {
        let first = match (self.seller_mark, self.buyer_confirm) {
            (Some(m), Some(c)) => Some(m.min(c)),
            (m, c) => m.or(c),
        };
        let t = self.terms;
        match first {
            Some(d) => {
                let w = d.max(t.t1()).saturating_add(t.pay_window).saturating_add(GRACE);
                // Before a confirm, a mark never cuts the window below T2.
                if self.buyer_confirm.is_none() { w.max(t.t2()) } else { w }
            }
            None => t.t2(),
        }
    }

    pub fn seller_mark(&mut self, now: i64) -> Result<(), Error> {
        self.require_open()?;
        if self.seller_mark.is_some() {
            return Err(Error::AlreadyMarked);
        }
        if self.buyer_confirm.is_some() {
            return Err(Error::AlreadyConfirmed);
        }
        if now > self.terms.t2() {
            return Err(Error::MarkTooLate);
        }
        self.seller_mark = Some(now);
        Ok(())
    }

    pub fn buyer_confirm(&mut self, now: i64) -> Result<(), Error> {
        self.require_open()?;
        if self.buyer_confirm.is_some() {
            return Err(Error::AlreadyConfirmed);
        }
        if now > self.buyer_deadline() {
            return Err(Error::ConfirmTooLate);
        }
        self.buyer_confirm = Some(now);
        if self.terms.balance() == 0 {
            self.balance_paid = true;
        }
        Ok(())
    }

    /// Records that the balance was sent directly to the seller.
    /// Returns the amount the program must transfer buyer -> seller.
    pub fn pay_balance(&mut self, now: i64) -> Result<u64, Error> {
        self.require_open()?;
        if self.buyer_confirm.is_none() {
            return Err(Error::NotConfirmed);
        }
        if self.balance_paid {
            return Err(Error::AlreadyPaid);
        }
        if now > self.buyer_deadline() {
            return Err(Error::PayTooLate);
        }
        self.balance_paid = true;
        Ok(self.terms.balance())
    }

    /// Both parties signed: change the deadlines.
    pub fn extend(&mut self, deliver_by: i64, late_window: i64, pay_window: i64, now: i64) -> Result<(), Error> {
        self.require_open()?;
        // The whole term stays within MAX_TERM of opening, so a deal cannot
        // be kept locked forever by repeated extensions.
        if deliver_by.saturating_sub(self.opened_at) > MAX_TERM {
            return Err(Error::TermTooLong);
        }
        let mut t = self.terms;
        t.deliver_by = deliver_by;
        t.late_window = late_window;
        t.pay_window = pay_window;
        check_windows(&t, now)?;
        self.terms = t;
        Ok(())
    }

    /// Both parties signed: return each party's own money.
    pub fn cancel(&mut self) -> Result<Payout, Error> {
        self.require_open()?;
        self.status = Status::Closed;
        Ok(Payout {
            to_seller: self.terms.seller_bond,
            to_buyer: self.terms.buyer_deposit,
            outcome: Outcome::Cancelled,
        })
    }

    /// Pro-rata late deduction from the seller bond, paid to the buyer.
    pub fn late_deduction(&self) -> u64 {
        let d = match self.delivery_time() {
            Some(d) => d,
            None => return 0,
        };
        let t1 = self.terms.t1();
        if d <= t1 || self.terms.late_window == 0 {
            return 0;
        }
        let late = (d - t1).min(self.terms.late_window) as u128;
        (self.terms.seller_bond as u128 * late / self.terms.late_window as u128) as u64
    }

    /// Anyone may call. Returns the payout and closes the deal.
    pub fn settle(&mut self, now: i64) -> Result<Payout, Error> {
        self.require_open()?;
        let t = self.terms;
        let p = if self.buyer_confirm.is_some() {
            let deduct = self.late_deduction();
            let outcome = if self.balance_paid {
                Outcome::Delivered
            } else if now > self.buyer_deadline() {
                Outcome::BuyerDefault
            } else {
                return Err(Error::NotYetSettleable);
            };
            Payout {
                to_seller: t.seller_bond - deduct + t.buyer_deposit,
                to_buyer: deduct,
                outcome,
            }
        } else if self.seller_mark.is_some() {
            if now <= self.buyer_deadline() {
                return Err(Error::NotYetSettleable);
            }
            Payout {
                to_seller: t.seller_bond,
                to_buyer: t.buyer_deposit,
                outcome: Outcome::Disputed,
            }
        } else {
            if now <= t.t2() {
                return Err(Error::NotYetSettleable);
            }
            Payout {
                to_seller: 0,
                to_buyer: t.seller_bond + t.buyer_deposit,
                outcome: Outcome::SellerDefault,
            }
        };
        self.status = Status::Closed;
        Ok(p)
    }

    /// Latest time at which `settle` is guaranteed to succeed.
    pub fn settle_by(&self) -> i64 {
        let t = self.terms;
        t.t2()
            .saturating_add(t.pay_window)
            .saturating_add(GRACE)
            .saturating_add(1)
    }
}

#[cfg(test)]
mod tests;
