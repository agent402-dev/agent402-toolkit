//! Agent402 Bond v2 (beta). One deal between a seller and a buyer: the seller locks a bond, the buyer may lock a
//! deposit. The outcome depends only on signatures and the Solana clock (rules: `agent402-bond-v2-core`).
//!
//! Changes from v1: one `accept` (confirm + balance payment) so there is no "confirmed but unpaid" state; per-deal
//! grace and review window, at most 30 days to deliver and about 45 days locked; dispute option chosen at open
//! (neutral, a share of the deposit to the seller, an optional arbiter that can only split between the parties);
//! settlement that cannot fail on accounting; job and output hashes; fixed payout accounts; rent back to the payer;
//! every state change emits an event. No price record. The program never judges quality.
//! The admin (a multisig) can only pause NEW deals, hand over the role in two steps and move caps within hard
//! bounds (2x per change, 48 hours later). It cannot move locked funds or stop settlement.

use agent402_bond_v2_core as rules;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};

// Mainnet program id. A test-mints build (any mint, a test admin) has a different id, so it can never run at this address.
#[cfg(not(feature = "test-mints"))]
declare_id!("Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev");
#[cfg(feature = "test-mints")]
declare_id!("5TotaQm4RbhRfhZzwFwnfoRLMWJ4jn3dpA9gRVsgd5bx");

/// Operator: the Squads v4 vault of the Agent402 Ops multisig (2 of 3), as for v1 (decision 12, to confirm).
#[cfg(not(feature = "test-mints"))]
pub const ADMIN: Pubkey = Pubkey::from_str_const("36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc");
/// Test-only admin (ed25519 seed [7; 32]). Never in a mainnet build.
#[cfg(feature = "test-mints")]
pub const ADMIN: Pubkey = Pubkey::from_str_const("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");

pub const VERSION: u8 = 2;

// Contact and source information readable from the deployed binary (solana-security-txt). The source revision is a
// fixed tag string, not a build-time git hash, so the build stays reproducible.
#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "Agent402 Bond v2",
    project_url: "https://github.com/agent402-dev/agent402-toolkit",
    contacts: "email:agent402-security.discern669@passinbox.com",
    policy: "https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS-v2.md",
    preferred_languages: "en",
    source_code: "https://github.com/agent402-dev/agent402-toolkit",
    source_revision: "bond-v2-0.1.0",
    auditors: "None. Internal review only, not independently audited: docs/bond/INTERNAL-REVIEW-v2.md"
}

pub mod mints {
    use anchor_lang::prelude::Pubkey;
    pub const USDC: Pubkey = Pubkey::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    pub const WSOL: Pubkey = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
    pub const PREQ: Pubkey = Pubkey::from_str_const("aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX");
}

/// (initial caps, hard bounds) per mint, in base units. USDC starts as v1: 100 per deal, 2,000 in total
/// (no independent review: bounds kept low, decision 5/10).
pub fn mint_caps(mint: &Pubkey) -> Option<((u64, u64), rules::caps::Bounds)> {
    use rules::caps::Bounds;
    if *mint == mints::USDC {
        return Some(((100_000_000, 2_000_000_000), Bounds {
            per_deal_min: 10_000_000, per_deal_max: 200_000_000, total_min: 1_000_000_000, total_max: 10_000_000_000,
        }));
    }
    if *mint == mints::WSOL {
        return Some(((500_000_000, 10_000_000_000), Bounds {
            per_deal_min: 50_000_000, per_deal_max: 5_000_000_000, total_min: 1_000_000_000, total_max: 100_000_000_000,
        }));
    }
    if *mint == mints::PREQ {
        return Some(((688_000_000_000, 13_760_000_000_000), Bounds {
            per_deal_min: 1_000_000, per_deal_max: 1_376_000_000_000, total_min: 10_000_000, total_max: 27_520_000_000_000,
        }));
    }
    #[cfg(feature = "test-mints")]
    {
        return Some(((100_000_000, 2_000_000_000), Bounds {
            per_deal_min: 1_000_000, per_deal_max: 1_000_000_000, total_min: 10_000_000, total_max: 100_000_000_000,
        }));
    }
    #[allow(unreachable_code)]
    None
}

#[program]
pub mod agent402_bond_v2 {
    use super::*;

    /// Anyone, once. The admin is fixed in code.
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.version = VERSION;
        c.admin = ADMIN;
        c.pending_admin = Pubkey::default();
        c.paused = false;
        c.bump = ctx.bumps.config;
        emit!(ConfigInitialized { admin: ADMIN });
        Ok(())
    }

    /// Anyone, once per allowed mint.
    pub fn init_counter(ctx: Context<InitCounter>) -> Result<()> {
        let ((p, t), _) = mint_caps(&ctx.accounts.mint.key()).ok_or(BondError::MintNotAllowed)?;
        check_mint(&ctx.accounts.mint)?;
        let c = &mut ctx.accounts.counter;
        c.version = VERSION;
        c.mint = ctx.accounts.mint.key();
        c.bump = ctx.bumps.counter;
        c.cap_per_deal = p;
        c.cap_total = t;
        emit!(CounterInitialized { mint: c.mint, cap_per_deal: p, cap_total: t });
        Ok(())
    }

    /// Admin: stop or resume NEW deals. Open deals are unaffected.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused, at: Clock::get()?.unix_timestamp });
        Ok(())
    }

    /// Admin, step 1 of 2: name a successor.
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        emit!(AdminProposed { admin: ctx.accounts.config.admin, pending_admin: new_admin });
        Ok(())
    }

    /// Step 2 of 2: the successor signs.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_admin != Pubkey::default(), BondError::Unauthorized);
        require_keys_eq!(ctx.accounts.new_admin.key(), c.pending_admin, BondError::Unauthorized);
        let old_admin = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminChanged { old_admin, new_admin: c.admin });
        Ok(())
    }

    /// Admin: caps for NEW deals of one mint, within hard bounds, at most 2x per change, 48 hours later.
    pub fn propose_caps(ctx: Context<ProposeCaps>, per_deal: u64, total: u64) -> Result<()> {
        let st = &mut ctx.accounts.counter;
        let (_, b) = mint_caps(&st.mint).ok_or(BondError::MintNotAllowed)?;
        let now = Clock::get()?.unix_timestamp;
        let mut c = st.caps();
        c.propose(now, per_deal, total, &b).map_err(|_| BondError::CapChangeOutOfBounds)?;
        st.set_caps(&c);
        emit!(CapsProposed { mint: st.mint, per_deal, total, effective_at: c.pending_effective_at });
        Ok(())
    }

    /// Seller and buyer sign together. Locks the seller bond and the buyer deposit; records the payout accounts.
    pub fn open(ctx: Context<Open>, nonce: u64, args: OpenArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        let has_arbiter = args.arbiter != Pubkey::default();
        let terms = args.terms(has_arbiter);
        let (per_deal, total) = a.counter.caps().effective(now);
        rules::check_open(
            &terms,
            now,
            a.config.paused,
            a.seller.key() == a.buyer.key(),
            has_arbiter && (args.arbiter == a.seller.key() || args.arbiter == a.buyer.key()),
            per_deal,
            total,
            a.counter.total_locked,
        )
        .map_err(to_err)?;
        check_mint(&a.mint)?;
        require_keys_eq!(a.seller_payout.owner, a.seller.key(), BondError::BadPayout);
        require_keys_eq!(a.buyer_payout.owner, a.buyer.key(), BondError::BadPayout);

        transfer(&a.token_program, &a.seller_token, &a.vault, &a.mint, &a.seller.to_account_info(), args.seller_bond, None)?;
        if args.buyer_deposit > 0 {
            transfer(&a.token_program, &a.buyer_token, &a.vault, &a.mint, &a.buyer.to_account_info(), args.buyer_deposit, None)?;
        }

        let counter = &mut ctx.accounts.counter;
        let seq = counter.next_seq;
        counter.next_seq = counter.next_seq.saturating_add(1);
        counter.total_locked = counter.total_locked.checked_add(terms.locked()).ok_or(BondError::Overflow)?;
        counter.open_deals = counter.open_deals.saturating_add(1);

        let d = &mut ctx.accounts.deal;
        d.version = VERSION;
        d.seller = ctx.accounts.seller.key();
        d.buyer = ctx.accounts.buyer.key();
        d.mint = ctx.accounts.mint.key();
        d.arbiter = args.arbiter;
        d.rent_payer = ctx.accounts.seller.key();
        d.seller_payout = ctx.accounts.seller_payout.key();
        d.buyer_payout = ctx.accounts.buyer_payout.key();
        d.seq = seq;
        d.nonce = nonce;
        d.price = args.price;
        d.seller_bond = args.seller_bond;
        d.buyer_deposit = args.buyer_deposit;
        d.deliver_by = args.deliver_by;
        d.grace = args.grace;
        d.review_window = args.review_window;
        d.arbiter_window = args.arbiter_window;
        d.seller_share_bps = args.seller_share_bps;
        d.opened_at = now;
        d.job_hash = args.job_hash;
        d.state = STATE_OPEN;
        d.bump = ctx.bumps.deal;
        d.vault_bump = ctx.bumps.vault;

        emit!(Opened {
            deal: d.key(), seq, seller: d.seller, buyer: d.buyer, mint: d.mint, price: d.price,
            seller_bond: d.seller_bond, buyer_deposit: d.buyer_deposit, deliver_by: d.deliver_by, grace: d.grace,
            review_window: d.review_window, seller_share_bps: d.seller_share_bps, arbiter: d.arbiter,
            arbiter_window: d.arbiter_window, job_hash: d.job_hash, rent_payer: d.rent_payer,
            seller_payout: d.seller_payout, buyer_payout: d.buyer_payout, opened_at: now,
        });
        Ok(())
    }

    /// Seller: delivered, with the hash of what was delivered.
    pub fn mark_delivered(ctx: Context<SellerOnly>, output_hash: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &mut ctx.accounts.deal;
        let mut d = deal.load();
        d.mark(now).map_err(to_err)?;
        deal.state = STATE_MARKED;
        deal.marked_at = now;
        deal.output_hash = output_hash;
        let accept_deadline = d.a().unwrap_or(now);
        emit!(Delivered { deal: deal.key(), seq: deal.seq, marked_at: now, output_hash, accept_deadline });
        Ok(())
    }

    /// Buyer accepts and pays the balance to the seller's payout account in the same instruction.
    pub fn accept(mut ctx: Context<Accept>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let dec = d.accept(now).map_err(to_err)?;
        let bal = ctx.accounts.deal.price.checked_sub(ctx.accounts.deal.buyer_deposit).ok_or(BondError::Overflow)?;
        if bal > 0 {
            let a = &ctx.accounts;
            transfer(&a.token_program, &a.buyer_token, &a.seller_payout, &a.mint, &a.buyer.to_account_info(), bal, None)?;
        }
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, bal)
    }

    /// Anyone, once the outcome is fixed by time.
    pub fn settle(mut ctx: Context<Decide>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let dec = d.settle(now).map_err(to_err)?;
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, 0)
    }

    /// Both sign: each side gets its own money back.
    pub fn cancel(mut ctx: Context<BothDecide>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let dec = d.cancel().map_err(to_err)?;
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, 0)
    }

    /// Both sign any split of the locked amount.
    pub fn settle_agreed(mut ctx: Context<BothDecide>, to_seller: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let dec = d.settle_agreed(to_seller).map_err(to_err)?;
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, 0)
    }

    /// Seller alone ends the deal neutrally (no arbiter; not after the mark deadline of an unmarked deal).
    pub fn seller_release(mut ctx: Context<SellerDecide>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let dec = d.seller_release(now).map_err(to_err)?;
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, 0)
    }

    /// The named arbiter splits the locked amount between the two parties, only in its window.
    pub fn decide(mut ctx: Context<ArbiterDecide>, to_seller: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let is_arbiter = ctx.accounts.deal.arbiter != Pubkey::default() && ctx.accounts.arbiter.key() == ctx.accounts.deal.arbiter;
        let mut d = ctx.accounts.deal.load();
        let dec = d.decide(now, is_arbiter, to_seller).map_err(to_err)?;
        let a = &mut ctx.accounts;
        finalize(&mut a.deal, &a.vault, &mut a.counter, dec, now, 0)
    }

    /// Both sign longer deadlines.
    pub fn extend(ctx: Context<BothSign>, deliver_by: i64, review_window: i64) -> Result<()> {
        let deal = &mut ctx.accounts.deal;
        let mut d = deal.load();
        d.extend(deliver_by, review_window).map_err(to_err)?;
        deal.deliver_by = d.terms.deliver_by;
        deal.review_window = d.terms.review_window;
        emit!(Extended { deal: deal.key(), seq: deal.seq, deliver_by, review_window });
        Ok(())
    }

    /// A party changes its own payout account (same mint, owned by that party).
    pub fn set_payout(mut ctx: Context<SetPayout>) -> Result<()> {
        let a = &mut ctx.accounts;
        let who = a.party.key();
        require_keys_eq!(a.new_payout.owner, who, BondError::BadPayout);
        let side = if who == a.deal.seller {
            a.deal.seller_payout = a.new_payout.key();
            0
        } else if who == a.deal.buyer {
            a.deal.buyer_payout = a.new_payout.key();
            1
        } else {
            return err!(BondError::Unauthorized);
        };
        emit!(PayoutChanged { deal: a.deal.key(), seq: a.deal.seq, side, payout: a.new_payout.key() });
        Ok(())
    }

    /// Anyone: pay the seller what it is owed.
    pub fn claim_seller(ctx: Context<Claim>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.deal.state == STATE_SETTLED, BondError::NotSettled);
        require_keys_eq!(a.to.key(), a.deal.seller_payout, BondError::BadPayout);
        // The account may have been closed and recreated at the same address since open: check its owner again.
        require_keys_eq!(a.to.owner, a.deal.seller, BondError::BadPayout);
        let amount = rules::claim_seller_amount(a.deal.owed_seller, a.vault.amount);
        pay_out(ctx, amount, false)
    }

    /// Anyone: pay the buyer everything in the vault beyond what the seller is still owed.
    pub fn claim_buyer(ctx: Context<Claim>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.deal.state == STATE_SETTLED, BondError::NotSettled);
        require_keys_eq!(a.to.key(), a.deal.buyer_payout, BondError::BadPayout);
        require_keys_eq!(a.to.owner, a.deal.buyer, BondError::BadPayout);
        let amount = rules::claim_buyer_amount(a.deal.owed_seller, a.vault.amount);
        pay_out(ctx, amount, true)
    }
}

pub const STATE_OPEN: u8 = 1;
pub const STATE_MARKED: u8 = 2;
pub const STATE_SETTLED: u8 = 3;

/// Records the decision and frees the cap. Has no failure path.
fn finalize<'info>(
    deal: &mut Account<'info, Deal>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    counter: &mut Account<'info, Counter>,
    dec: rules::Decision,
    now: i64,
    balance_paid: u64,
) -> Result<()> {
    let locked = deal.seller_bond.saturating_add(deal.buyer_deposit);
    let owed = rules::finalize(&dec, locked, vault.amount);
    deal.state = STATE_SETTLED;
    deal.outcome = dec.outcome as u8;
    deal.owed_seller = owed.seller;
    deal.owed_buyer = owed.buyer;
    deal.vault_short = owed.short;
    deal.settled_at = now;
    deal.seller_claimed = owed.seller == 0;
    // Done when nothing is owed (spec 4). claim_buyer stays callable while settled, so anything sent to the vault
    // directly is still swept to the buyer, and the deal then closes.
    deal.buyer_claimed = owed.buyer == 0;
    counter.total_locked = counter.total_locked.saturating_sub(locked);
    counter.open_deals = counter.open_deals.saturating_sub(1);
    counter.settled_deals = counter.settled_deals.saturating_add(1);
    emit!(Settled {
        deal: deal.key(), seq: deal.seq, seller: deal.seller, buyer: deal.buyer, mint: deal.mint, outcome: deal.outcome,
        to_seller: owed.seller, to_buyer: owed.buyer, balance_paid, vault_short: owed.short, at: now,
    });
    Ok(())
}

/// Transfers one side's share; closes the vault and the deal (rent to the payer) when both sides are done.
fn pay_out(mut ctx: Context<Claim>, amount: u64, buyer_side: bool) -> Result<()> {
    let a = &mut ctx.accounts;
    let nonce = a.deal.nonce.to_le_bytes();
    let (seller, buyer, bump) = (a.deal.seller, a.deal.buyer, a.deal.bump);
    let seeds: &[&[u8]] = &[b"deal", seller.as_ref(), buyer.as_ref(), nonce.as_ref(), &[bump]];
    let signer = &[seeds];
    if amount > 0 {
        transfer(&a.token_program, &a.vault, &a.to, &a.mint, &a.deal.to_account_info(), amount, Some(signer))?;
    }
    if buyer_side {
        a.deal.owed_buyer = 0;
        a.deal.buyer_claimed = true;
    } else {
        a.deal.owed_seller = a.deal.owed_seller.checked_sub(amount).ok_or(BondError::Overflow)?;
        if a.deal.owed_seller == 0 {
            a.deal.seller_claimed = true;
        }
    }
    emit!(Claimed { deal: a.deal.key(), seq: a.deal.seq, side: buyer_side as u8, amount, to: a.to.key() });
    a.vault.reload()?;
    if a.deal.seller_claimed && a.deal.buyer_claimed && a.vault.amount == 0 {
        require_keys_eq!(a.rent_payer.key(), a.deal.rent_payer, BondError::BadRentPayer);
        token_interface::close_account(
            CpiContext::new(
                a.token_program.key(),
                CloseAccount { account: a.vault.to_account_info(), destination: a.rent_payer.to_account_info(), authority: a.deal.to_account_info() },
            )
            .with_signer(signer),
        )?;
        emit!(Closed { deal: a.deal.key(), seq: a.deal.seq, rent_payer: a.deal.rent_payer });
        a.deal.close(a.rent_payer.to_account_info())?;
    }
    Ok(())
}

/// Rejects mints that could break settlement: a freeze authority (except USDC, whose issuer has one) or any
/// Token-2022 extension other than metadata pointer (18) and token metadata (19).
fn check_mint(mint: &InterfaceAccount<Mint>) -> Result<()> {
    if mint.key() != mints::USDC {
        require!(mint.freeze_authority.is_none(), BondError::MintNotAllowed);
    }
    let info = mint.to_account_info();
    if *info.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let d = info.try_borrow_data()?;
    if d.len() <= 82 {
        return Ok(());
    }
    require!(d.len() >= 166 && d[165] == 1, BondError::MintNotAllowed);
    let mut i = 166;
    while i + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[i], d[i + 1]]);
        let len = u16::from_le_bytes([d[i + 2], d[i + 3]]) as usize;
        if ty == 0 {
            break;
        }
        require!(ty == 18 || ty == 19, BondError::MintNotAllowed);
        i += 4 + len;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn transfer<'info>(
    token_program: &Interface<'info, TokenInterface>,
    from: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: Option<&[&[&[u8]]]>,
) -> Result<()> {
    let accounts = TransferChecked { from: from.to_account_info(), mint: mint.to_account_info(), to: to.to_account_info(), authority: authority.clone() };
    let ctx = CpiContext::new(token_program.key(), accounts);
    let ctx = match signer_seeds {
        Some(s) => ctx.with_signer(s),
        None => ctx,
    };
    token_interface::transfer_checked(ctx, amount, mint.decimals)
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenArgs {
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub grace: i64,
    pub review_window: i64,
    pub seller_share_bps: u16,
    /// Pubkey::default() = no arbiter
    pub arbiter: Pubkey,
    pub arbiter_window: i64,
    /// sha256 of the canonical job description (Job Protocol v2)
    pub job_hash: [u8; 32],
}

impl OpenArgs {
    fn terms(&self, has_arbiter: bool) -> rules::Terms {
        rules::Terms {
            price: self.price,
            seller_bond: self.seller_bond,
            buyer_deposit: self.buyer_deposit,
            deliver_by: self.deliver_by,
            grace: self.grace,
            review_window: self.review_window,
            seller_share_bps: self.seller_share_bps,
            has_arbiter,
            arbiter_window: self.arbiter_window,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub paused: bool,
    pub bump: u8,
    pub reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub version: u8,
    pub mint: Pubkey,
    pub total_locked: u64,
    pub open_deals: u64,
    pub settled_deals: u64,
    pub next_seq: u64,
    pub cap_per_deal: u64,
    pub cap_total: u64,
    pub pending_per_deal: u64,
    pub pending_total: u64,
    pub pending_effective_at: i64,
    pub bump: u8,
    pub reserved: [u8; 64],
}

impl Counter {
    pub fn caps(&self) -> rules::caps::Caps {
        rules::caps::Caps {
            per_deal: self.cap_per_deal,
            total: self.cap_total,
            pending_per_deal: self.pending_per_deal,
            pending_total: self.pending_total,
            pending_effective_at: self.pending_effective_at,
        }
    }
    pub fn set_caps(&mut self, c: &rules::caps::Caps) {
        self.cap_per_deal = c.per_deal;
        self.cap_total = c.total;
        self.pending_per_deal = c.pending_per_deal;
        self.pending_total = c.pending_total;
        self.pending_effective_at = c.pending_effective_at;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub version: u8,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub arbiter: Pubkey,
    pub rent_payer: Pubkey,
    pub seller_payout: Pubkey,
    pub buyer_payout: Pubkey,
    pub seq: u64,
    pub nonce: u64,
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub grace: i64,
    pub review_window: i64,
    pub arbiter_window: i64,
    pub seller_share_bps: u16,
    pub opened_at: i64,
    /// 0 = not marked
    pub marked_at: i64,
    pub settled_at: i64,
    pub state: u8,
    /// rules::Outcome as u8, valid when settled
    pub outcome: u8,
    pub owed_seller: u64,
    pub owed_buyer: u64,
    pub seller_claimed: bool,
    pub buyer_claimed: bool,
    pub vault_short: bool,
    pub job_hash: [u8; 32],
    pub output_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
    pub reserved: [u8; 32],
}

impl Deal {
    pub fn load(&self) -> rules::Deal {
        let has_arbiter = self.arbiter != Pubkey::default();
        rules::Deal {
            terms: rules::Terms {
                price: self.price,
                seller_bond: self.seller_bond,
                buyer_deposit: self.buyer_deposit,
                deliver_by: self.deliver_by,
                grace: self.grace,
                review_window: self.review_window,
                seller_share_bps: self.seller_share_bps,
                has_arbiter,
                arbiter_window: self.arbiter_window,
            },
            opened_at: self.opened_at,
            state: match self.state {
                STATE_OPEN => rules::State::Open,
                STATE_MARKED => rules::State::Marked,
                _ => rules::State::Settled,
            },
            // Marked always has a mark time (even 0 on a test clock), so the time rules can always settle it.
            marked_at: if self.state == STATE_MARKED || self.marked_at != 0 { Some(self.marked_at) } else { None },
        }
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = payer, space = 8 + Counter::INIT_SPACE, seeds = [b"counter", mint.key().as_ref()], bump)]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct ProposeCaps<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"counter", counter.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Open<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the seller is paid (owner checked = seller).
    #[account(token::mint = mint, token::token_program = token_program)]
    pub seller_payout: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Where the buyer is paid (owner checked = buyer).
    #[account(token::mint = mint, token::token_program = token_program)]
    pub buyer_payout: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = seller,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", seller.key().as_ref(), buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub deal: Box<Account<'info, Deal>>,
    #[account(
        init,
        payer = seller,
        seeds = [b"vault", deal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = deal,
        token::token_program = token_program
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [b"counter", mint.key().as_ref()], bump = counter.bump)]
    pub counter: Box<Account<'info, Counter>>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SellerOnly<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct BothSign<'info> {
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(mut, has_one = seller, has_one = buyer)]
    pub deal: Account<'info, Deal>,
}

#[derive(Accounts)]
pub struct Accept<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer, has_one = mint, has_one = seller_payout)]
    pub deal: Account<'info, Deal>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::token_program = token_program, constraint = seller_payout.owner == deal.seller @ BondError::BadPayout)]
    pub seller_payout: InterfaceAccount<'info, TokenAccount>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Decide<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct BothDecide<'info> {
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(mut, has_one = seller, has_one = buyer)]
    pub deal: Account<'info, Deal>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct SellerDecide<'info> {
    pub seller: Signer<'info>,
    #[account(mut, has_one = seller)]
    pub deal: Account<'info, Deal>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct ArbiterDecide<'info> {
    pub arbiter: Signer<'info>,
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct SetPayout<'info> {
    pub party: Signer<'info>,
    #[account(mut, has_one = mint)]
    pub deal: Account<'info, Deal>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(token::mint = mint, token::token_program = token_program)]
    pub new_payout: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// CHECK: receives the rent when the deal closes; must equal deal.rent_payer (checked before closing).
    #[account(mut)]
    pub rent_payer: UncheckedAccount<'info>,
    #[account(mut, has_one = mint)]
    pub deal: Account<'info, Deal>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [b"vault", deal.key().as_ref()],
        bump = deal.vault_bump,
        token::mint = mint,
        token::authority = deal,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// Must be the recorded payout account of the claiming side (checked per side).
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct ConfigInitialized {
    pub admin: Pubkey,
}
#[event]
pub struct CounterInitialized {
    pub mint: Pubkey,
    pub cap_per_deal: u64,
    pub cap_total: u64,
}
#[event]
pub struct Opened {
    pub deal: Pubkey,
    pub seq: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub grace: i64,
    pub review_window: i64,
    pub seller_share_bps: u16,
    pub arbiter: Pubkey,
    pub arbiter_window: i64,
    pub job_hash: [u8; 32],
    pub rent_payer: Pubkey,
    pub seller_payout: Pubkey,
    pub buyer_payout: Pubkey,
    pub opened_at: i64,
}
#[event]
pub struct Delivered {
    pub deal: Pubkey,
    pub seq: u64,
    pub marked_at: i64,
    pub output_hash: [u8; 32],
    /// the buyer can accept until this time (unix seconds)
    pub accept_deadline: i64,
}
#[event]
pub struct Settled {
    pub deal: Pubkey,
    pub seq: u64,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    /// rules::Outcome as u8: 0 Accepted, 1 Unconfirmed, 2 SellerDefault, 3 Cancelled, 4 Agreed, 5 Arbitrated, 6 Released
    pub outcome: u8,
    pub to_seller: u64,
    pub to_buyer: u64,
    pub balance_paid: u64,
    pub vault_short: bool,
    pub at: i64,
}
#[event]
pub struct Claimed {
    pub deal: Pubkey,
    pub seq: u64,
    /// 0 seller, 1 buyer
    pub side: u8,
    pub amount: u64,
    pub to: Pubkey,
}
#[event]
pub struct Closed {
    pub deal: Pubkey,
    pub seq: u64,
    pub rent_payer: Pubkey,
}
#[event]
pub struct Extended {
    pub deal: Pubkey,
    pub seq: u64,
    pub deliver_by: i64,
    pub review_window: i64,
}
#[event]
pub struct PayoutChanged {
    pub deal: Pubkey,
    pub seq: u64,
    /// 0 seller, 1 buyer
    pub side: u8,
    pub payout: Pubkey,
}
#[event]
pub struct CapsProposed {
    pub mint: Pubkey,
    pub per_deal: u64,
    pub total: u64,
    pub effective_at: i64,
}
#[event]
pub struct PauseChanged {
    pub paused: bool,
    pub at: i64,
}
#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
}
#[event]
pub struct AdminChanged {
    pub old_admin: Pubkey,
    pub new_admin: Pubkey,
}

#[error_code]
pub enum BondError {
    #[msg("Mint is not allowed")]
    MintNotAllowed,
    #[msg("New deals are paused; open deals still settle normally")]
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
    #[msg("An arbiter is named for this deal")]
    ArbiterSet,
    ReleaseTooLate,
    Unauthorized,
    OutsideArbiterWindow,
    ExtendNotLonger,
    Overflow,
    #[msg("Not the recorded payout account, or not owned by the party")]
    BadPayout,
    NotSettled,
    BadRentPayer,
    CapChangeOutOfBounds,
}

fn to_err(e: rules::Error) -> Error {
    use rules::Error as E;
    let b = match e {
        E::Paused => BondError::Paused,
        E::SameParty => BondError::SameParty,
        E::ZeroPrice => BondError::ZeroPrice,
        E::ZeroBond => BondError::ZeroBond,
        E::BondTooLarge => BondError::BondTooLarge,
        E::DepositTooLarge => BondError::DepositTooLarge,
        E::DeadlineInPast => BondError::DeadlineInPast,
        E::TermTooLong => BondError::TermTooLong,
        E::GraceOutOfRange => BondError::GraceOutOfRange,
        E::ReviewWindowOutOfRange => BondError::ReviewWindowOutOfRange,
        E::BadShare => BondError::BadShare,
        E::BadArbiter => BondError::BadArbiter,
        E::PerDealCapExceeded => BondError::PerDealCapExceeded,
        E::TotalCapExceeded => BondError::TotalCapExceeded,
        E::NotOpen => BondError::NotOpen,
        E::AlreadyMarked => BondError::AlreadyMarked,
        E::MarkTooLate => BondError::MarkTooLate,
        E::AcceptTooLate => BondError::AcceptTooLate,
        E::NotYetSettleable => BondError::NotYetSettleable,
        E::BadSplit => BondError::BadSplit,
        E::ArbiterSet => BondError::ArbiterSet,
        E::ReleaseTooLate => BondError::ReleaseTooLate,
        E::Unauthorized => BondError::Unauthorized,
        E::OutsideArbiterWindow => BondError::OutsideArbiterWindow,
        E::ExtendNotLonger => BondError::ExtendNotLonger,
        E::Overflow => BondError::Overflow,
    };
    b.into()
}
