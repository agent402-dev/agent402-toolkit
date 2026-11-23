//! Agent402 performance bond (stage 2, beta).
//!
//! A seller bond and an optional buyer deposit are locked per deal. The
//! settlement result depends only on recorded signatures and the on-chain
//! clock (see `agent402-bond-core`). There is no fee and no key that can move
//! a deal's funds other than the rules below. The admin can only pause new
//! deals, hand over the role (two steps) and, in mode A, adjust WSOL/PREQ caps
//! for new deals within hard bounds. The total cap limits active (undecided)
//! deals; decided shares waiting to be claimed do not count against it.
//!
//! Not covered: quality disputes, identity, refunds by judgement. A deal where
//! the seller marked delivery but the buyer never confirmed is released
//! neutrally (each side gets its own money back).

use agent402_bond_core as bond;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked,
};

#[cfg(not(feature = "test-mints"))]
declare_id!("9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK");
// Test builds use a different program id, so a test-mints binary fails
// (DeclaredProgramIdMismatch) if it is ever deployed at the real address.
#[cfg(feature = "test-mints")]
declare_id!("Howw2bfGrx5QGWD79oUoaMhWEgEgeJgFgunQCZ7NbJ6f");

/// Holds the only operator power: pausing NEW deals. It cannot move funds,
/// stop settlement or cancellation, or change any open deal.
/// Mainnet: the Squads v4 multisig vault (index 0) of multisig
/// Af32e2sJty7f6yLTmjUy2suregQdALR78GSBSCatnhWn (3 members, threshold 2).
#[cfg(not(any(feature = "test-mints", feature = "devnet")))]
pub const ADMIN: Pubkey = Pubkey::from_str_const("36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc");
/// Devnet-only operator key (replaced 2026-11-23: the previous devnet key was partly exposed). Never used in a mainnet build.
#[cfg(all(feature = "devnet", not(feature = "test-mints")))]
pub const ADMIN: Pubkey = Pubkey::from_str_const("83VvXU3uTypqKpRo9v9cg64aZ8UyCZSmEWseg76U9RxR");
/// Test-only admin (ed25519 seed [7; 32]). Never used in a mainnet build.
#[cfg(feature = "test-mints")]
pub const ADMIN: Pubkey = Pubkey::from_str_const("GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB");

/// Cap growth starts here (2026-11-22 00:00 UTC). Set to the deploy date.
pub const DEPLOYED_AT: i64 = 1_795_305_600;

pub mod mints {
    use anchor_lang::prelude::Pubkey;
    #[cfg(not(feature = "devnet"))]
    pub const USDC: Pubkey = Pubkey::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    /// Circle's devnet USDC.
    #[cfg(feature = "devnet")]
    pub const USDC: Pubkey = Pubkey::from_str_const("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    pub const WSOL: Pubkey = Pubkey::from_str_const("So11111111111111111111111111111111111111112");
    pub const PREQ: Pubkey = Pubkey::from_str_const("aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX");
}

/// Meteora DAMM v2 program and the PREQ pool read by price mode B.
pub const DAMM_V2: Pubkey = Pubkey::from_str_const("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
pub const PREQ_POOL: Pubkey = Pubkey::from_str_const("51F34MKDFBLr5GwKiiJMWV9HsHv63dkkP3ZMMxPN71xc");
pub mod pool_layout {
    /// sha256("account:Pool")[..8]
    pub const DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];
    pub const TOKEN_A_MINT: usize = 168;
    pub const TOKEN_B_MINT: usize = 200;
    pub const TOKEN_A_VAULT: usize = 232;
    pub const TOKEN_B_VAULT: usize = 264;
    pub const SQRT_PRICE: usize = 456;
    pub const LEN: usize = 1112;
}

/// Minimum quote liquidity in the pool before mode B may switch on.
pub fn min_quote_reserve(quote: &Pubkey) -> Option<u64> {
    if *quote == mints::USDC {
        return Some(10_000_000_000); // 10,000 USDC
    }
    if *quote == mints::WSOL {
        return Some(50_000_000_000); // 50 SOL
    }
    None
}

/// Hard limits for operator cap changes (mode A). USDC caps are fixed.
pub fn cap_bounds(mint: &Pubkey) -> Option<bond::caps::Bounds> {
    use bond::caps::Bounds;
    if *mint == mints::WSOL {
        return Some(Bounds {
            min_per_deal: 50_000_000,       // 0.05 SOL
            max_per_deal: 5_000_000_000,    // 5 SOL
            min_total: 1_000_000_000,       // 1 SOL
            max_total: 100_000_000_000,     // 100 SOL
        });
    }
    if *mint == mints::PREQ {
        // Upper bounds: 1 SOL / 20 SOL worth at the pool floor
        // (0.14% / 2.75% of supply). Lower bounds only prevent zero caps.
        return Some(Bounds {
            min_per_deal: 1_000_000,             // 1 PREQ
            max_per_deal: 1_376_000_000_000,     // 1,376,000 PREQ
            min_total: 10_000_000,               // 10 PREQ
            max_total: 27_520_000_000_000,       // 27,520,000 PREQ
        });
    }
    #[cfg(feature = "test-mints")]
    {
        if *mint != mints::USDC {
            return Some(Bounds {
                min_per_deal: 1_000_000,
                max_per_deal: 1_000_000_000,
                min_total: 10_000_000,
                max_total: 100_000_000_000,
            });
        }
    }
    None
}

/// (per-deal cap, total cap) in base units at DEPLOYED_AT.
pub fn base_caps(mint: &Pubkey) -> Option<(u64, u64)> {
    if *mint == mints::USDC {
        return Some((100_000_000, 2_000_000_000)); // 100 / 2,000 USDC
    }
    if *mint == mints::WSOL {
        return Some((500_000_000, 10_000_000_000)); // 0.5 / 10 SOL
    }
    if *mint == mints::PREQ {
        // 0.5 / 10 SOL worth at the pool floor (1 SOL = 1,376,000 PREQ,
        // sqrt_min_price, checked on mainnet 2026-11-22). The pool price
        // cannot go below the floor, so these never mean less than 0.5 / 10 SOL.
        return Some((688_000_000_000, 13_760_000_000_000)); // 688,000 / 13,760,000 PREQ
    }
    #[cfg(feature = "test-mints")]
    {
        return Some((100_000_000, 2_000_000_000));
    }
    #[allow(unreachable_code)]
    None
}

#[program]
pub mod agent402_bond {
    use super::*;

    /// Anyone may create the per-mint counter once.
    pub fn init_counter(ctx: Context<InitCounter>) -> Result<()> {
        require!(base_caps(&ctx.accounts.mint.key()).is_some(), BondError::MintNotAllowed);
        check_mint(&ctx.accounts.mint)?;
        let c = &mut ctx.accounts.counter;
        c.mint = ctx.accounts.mint.key();
        c.total_locked = 0;
        c.bump = ctx.bumps.counter;
        let (p, t) = base_caps(&c.mint).ok_or(BondError::MintNotAllowed)?;
        c.cap_per_deal = p;
        c.cap_total = t;
        Ok(())
    }

    /// Anyone may create the config once; the admin is fixed in code.
    pub fn init_config(ctx: Context<InitConfig>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ADMIN;
        c.pending_admin = Pubkey::default();
        c.paused = false;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin only: stop or resume NEW deals. Open deals are unaffected.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(PauseChanged { paused });
        Ok(())
    }

    /// Admin only: hand the pause power to another key.
    /// Step 1 of 2: the admin names a successor. Nothing changes until the
    /// successor accepts, so a typo cannot lose the admin role.
    pub fn set_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        Ok(())
    }

    /// Step 2 of 2: the named successor signs to take over.
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require_keys_eq!(ctx.accounts.new_admin.key(), c.pending_admin, BondError::Unauthorized);
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminChanged { new_admin: c.admin });
        Ok(())
    }

    /// Admin only (mode A): change caps for NEW deals of WSOL or PREQ.
    /// Bounded, at most 2x per change, effective 48 hours later.
    pub fn propose_caps(ctx: Context<ProposeCaps>, per_deal: u64, total: u64) -> Result<()> {
        let st = &mut ctx.accounts.counter;
        require!(st.price_mode == 0, BondError::PriceModeActive);
        let b = cap_bounds(&st.mint).ok_or(BondError::CapsFixed)?;
        let now = Clock::get()?.unix_timestamp;
        let mut c = st.caps();
        c.propose(now, per_deal, total, &b).map_err(to_err)?;
        st.set_caps(&c);
        emit!(CapsProposed { mint: st.mint, per_deal, total, effective_at: c.effective_at });
        Ok(())
    }

    /// Anyone: record the PREQ pool price (speed-limited).
    pub fn observe_price(ctx: Context<ObservePrice>) -> Result<()> {
        let (spot, quote, quote_vault) = read_pool(&ctx.accounts.pool)?;
        let qv = &ctx.accounts.quote_vault;
        require_keys_eq!(qv.key(), quote_vault, BondError::BadPool);
        require_keys_eq!(qv.mint, quote, BondError::BadPool);
        let min = min_quote_reserve(&quote).ok_or(BondError::BadPool)?;
        let now = Clock::get()?.unix_timestamp;
        let st = &mut ctx.accounts.counter;
        let mut r = st.record();
        r.observe_liquidity(qv.amount >= min, now);
        r.observe(spot, now);
        st.set_record(&r);
        st.quote_mint = quote;
        Ok(())
    }

    /// Anyone: switch PREQ caps to mode B for good, once the data thresholds
    /// are met. After this the operator can no longer change PREQ caps.
    pub fn activate_price_mode(ctx: Context<ActivatePriceMode>) -> Result<()> {
        let (_, quote, quote_vault) = read_pool(&ctx.accounts.pool)?;
        let qv = &ctx.accounts.quote_vault;
        require_keys_eq!(qv.key(), quote_vault, BondError::BadPool);
        require_keys_eq!(qv.mint, quote, BondError::BadPool);
        let min = min_quote_reserve(&quote).ok_or(BondError::BadPool)?;
        let now = Clock::get()?.unix_timestamp;
        let st = &mut ctx.accounts.counter;
        require!(st.price_mode == 0, BondError::PriceModeActive);
        let ready = bond::price::switch_ready(&st.record(), st.settled_deals, qv.amount, min, now);
        require!(ready, BondError::SwitchNotReady);
        st.price_mode = 1;
        st.quote_mint = quote;
        emit!(PriceModeActivated { mint: st.mint, quote, at: now });
        Ok(())
    }

    /// Seller and buyer sign together; both amounts are locked at once.
    pub fn open(ctx: Context<Open>, nonce: u64, args: OpenArgs) -> Result<()> {
        let a = &ctx.accounts;
        require!(!a.config.paused, BondError::Paused);
        require_keys_neq!(a.seller.key(), a.buyer.key(), BondError::SameParty);
        let now = Clock::get()?.unix_timestamp;
        let caps = caps_now(&a.mint.key(), &a.counter, now)?;
        let terms = bond::Terms {
            price: args.price,
            seller_bond: args.seller_bond,
            buyer_deposit: args.buyer_deposit,
            deliver_by: args.deliver_by,
            late_window: args.late_window,
            pay_window: args.pay_window,
        };
        let d = bond::open(terms, now, &caps, a.counter.total_locked).map_err(to_err)?;
        let locked = terms.locked().map_err(to_err)?;

        transfer(
            &a.token_program,
            &a.seller_token,
            &a.vault,
            &a.mint,
            &a.seller.to_account_info(),
            args.seller_bond,
            None,
        )?;
        if args.buyer_deposit > 0 {
            transfer(
                &a.token_program,
                &a.buyer_token,
                &a.vault,
                &a.mint,
                &a.buyer.to_account_info(),
                args.buyer_deposit,
                None,
            )?;
        }

        let deal = &mut ctx.accounts.deal;
        deal.seller = ctx.accounts.seller.key();
        deal.buyer = ctx.accounts.buyer.key();
        deal.mint = ctx.accounts.mint.key();
        deal.nonce = nonce;
        deal.bump = ctx.bumps.deal;
        deal.vault_bump = ctx.bumps.vault;
        deal.store(&d);

        let counter = &mut ctx.accounts.counter;
        counter.total_locked = counter
            .total_locked
            .checked_add(locked)
            .ok_or(BondError::Overflow)?;

        emit!(Opened {
            deal: deal.key(),
            seller: deal.seller,
            buyer: deal.buyer,
            mint: deal.mint,
            seller_bond: args.seller_bond,
            buyer_deposit: args.buyer_deposit,
            deliver_by: args.deliver_by,
        });
        Ok(())
    }

    /// Seller says it delivered. Not proof; protects against a buyer
    /// withholding confirmation (leads to neutral release, not forfeiture).
    pub fn mark_delivered(ctx: Context<SellerOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &mut ctx.accounts.deal;
        let mut d = deal.load();
        d.seller_mark(now).map_err(to_err)?;
        deal.store(&d);
        Ok(())
    }

    /// Buyer confirms receipt. This is the only proof of delivery.
    pub fn confirm_receipt(ctx: Context<BuyerOnly>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &mut ctx.accounts.deal;
        let mut d = deal.load();
        d.buyer_confirm(now).map_err(to_err)?;
        deal.store(&d);
        Ok(())
    }

    /// Buyer sends the balance straight to the seller (not held).
    pub fn pay_balance(ctx: Context<PayBalance>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let amount = d.pay_balance(now).map_err(to_err)?;
        if amount > 0 {
            let a = &ctx.accounts;
            transfer(
                &a.token_program,
                &a.buyer_token,
                &a.seller_token,
                &a.mint,
                &a.buyer.to_account_info(),
                amount,
                None,
            )?;
        }
        ctx.accounts.deal.store(&d);
        Ok(())
    }

    /// Both sign: move the deadlines.
    pub fn extend(ctx: Context<BothSign>, deliver_by: i64, late_window: i64, pay_window: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let deal = &mut ctx.accounts.deal;
        let mut d = deal.load();
        d.extend(deliver_by, late_window, pay_window, now).map_err(to_err)?;
        deal.store(&d);
        Ok(())
    }

    /// Both sign: each side gets its own money back.
    pub fn cancel(mut ctx: Context<Cancel>) -> Result<()> {
        let mut d = ctx.accounts.deal.load();
        let p = d.cancel().map_err(to_err)?;
        let a = &mut ctx.accounts;
        decide(&mut a.deal, &a.vault, &mut a.counter, p)
    }

    /// Anyone: fix the outcome once time and signatures decide it. No money
    /// moves here; each side then claims its share (claim_seller /
    /// claim_buyer, then claim_seller), usually in the same transaction. Separate claims keep
    /// one side's frozen token account from blocking the other side.
    pub fn settle(mut ctx: Context<Settle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.deal.load();
        let p = d.settle(now).map_err(to_err)?;
        let a = &mut ctx.accounts;
        decide(&mut a.deal, &a.vault, &mut a.counter, p)
    }

    /// Anyone: pay the seller exactly what the outcome gives the seller.
    pub fn claim_seller(ctx: Context<Claim>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.deal.outcome != 0, BondError::NotOpen);
        require_keys_eq!(a.to.owner, a.deal.seller, BondError::Unauthorized);
        let amount = a.deal.owed_seller;
        pay_out(ctx, amount, false)
    }

    /// Anyone: pay the buyer everything in the vault except what the seller
    /// is still owed. Any extra sent straight to the vault goes to the buyer:
    /// the program cannot tell who sent it, and a mistaken overpayment
    /// usually comes from the paying side.
    pub fn claim_buyer(ctx: Context<Claim>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.deal.outcome != 0, BondError::NotOpen);
        require_keys_eq!(a.to.owner, a.deal.buyer, BondError::Unauthorized);
        let amount = a.vault.amount.saturating_sub(a.deal.owed_seller);
        pay_out(ctx, amount, true)
    }
}

/// Transfers one side's share. The seller's claim also closes the vault and
/// the deal (rent to the seller) once the vault is empty.
fn pay_out(mut ctx: Context<Claim>, amount: u64, buyer_side: bool) -> Result<()> {
    let a = &mut ctx.accounts;
    let deal = &a.deal;
    let nonce = deal.nonce.to_le_bytes();
    let seeds: &[&[u8]] = &[b"deal", deal.seller.as_ref(), deal.buyer.as_ref(), nonce.as_ref(), &[deal.bump]];
    let signer = &[seeds];
    let auth = deal.to_account_info();
    if amount > 0 {
        transfer(&a.token_program, &a.vault, &a.to, &a.mint, &auth, amount, Some(signer))?;
    }
    if !buyer_side {
        a.deal.owed_seller = 0;
    }
    a.vault.reload()?;
    // Only the seller's claim closes, so a claim never finds the deal gone.
    // Usual order in one transaction: settle, claim_buyer, claim_seller.
    if !buyer_side && a.vault.amount == 0 {
        let deal = &a.deal;
        let nonce = deal.nonce.to_le_bytes();
        let seeds: &[&[u8]] = &[b"deal", deal.seller.as_ref(), deal.buyer.as_ref(), nonce.as_ref(), &[deal.bump]];
        token_interface::close_account(
            CpiContext::new(
                a.token_program.key(),
                CloseAccount {
                    account: a.vault.to_account_info(),
                    destination: a.seller.to_account_info(),
                    authority: deal.to_account_info(),
                },
            )
            .with_signer(&[seeds]),
        )?;
        a.deal.close(a.seller.to_account_info())?;
    }
    Ok(())
}

/// Caps in force for a new deal.
/// USDC: fixed base growing 2% a year. WSOL and PREQ in mode A: operator caps
/// (bounded). PREQ in mode B: the quote cap converted at the recorded price.
fn caps_now(mint: &Pubkey, st: &Counter, now: i64) -> Result<bond::Caps> {
    if *mint == mints::USDC {
        let (p, t) = base_caps(mint).ok_or(BondError::MintNotAllowed)?;
        return Ok(bond::Caps { per_deal: bond::cap_at(p, DEPLOYED_AT, now), total: bond::cap_at(t, DEPLOYED_AT, now) });
    }
    if st.price_mode == 1 {
        let r = st.record();
        // Stale record or thin liquidity: fall back to the last mode A caps
        // (frozen at the switch, within bounds) instead of guessing.
        if !r.is_fresh(now) || r.liquid_since == 0 {
            let (p, t) = st.caps().effective(now);
            return Ok(bond::Caps { per_deal: p, total: t });
        }
        let (qp, qt) = base_caps(&st.quote_mint).ok_or(BondError::BadPool)?;
        let b = cap_bounds(mint).ok_or(BondError::MintNotAllowed)?;
        return Ok(bond::Caps {
            per_deal: r.preq_cap(bond::cap_at(qp, DEPLOYED_AT, now), b.min_per_deal, b.max_per_deal),
            total: r.preq_cap(bond::cap_at(qt, DEPLOYED_AT, now), b.min_total, b.max_total),
        });
    }
    let (p, t) = st.caps().effective(now);
    Ok(bond::Caps { per_deal: p, total: t })
}

/// Rejects mints that could break settlement: a freeze authority (except
/// USDC, whose issuer has one) or any Token-2022 extension other than
/// metadata pointer (18) and token metadata (19).
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

/// Reads the PREQ pool: (spot price Q64.64, quote mint, quote vault).
fn read_pool(pool: &UncheckedAccount) -> Result<(u128, Pubkey, Pubkey)> {
    use pool_layout as L;
    require_keys_eq!(pool.key(), PREQ_POOL, BondError::BadPool);
    require_keys_eq!(*pool.owner, DAMM_V2, BondError::BadPool);
    let d = pool.try_borrow_data()?;
    require!(d.len() >= L::LEN && d[..8] == L::DISC, BondError::BadPool);
    let key = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
    let (a, b) = (key(L::TOKEN_A_MINT), key(L::TOKEN_B_MINT));
    let preq_is_a = if a == mints::PREQ {
        true
    } else if b == mints::PREQ {
        false
    } else {
        return err!(BondError::BadPool);
    };
    let quote = if preq_is_a { b } else { a };
    require!(min_quote_reserve(&quote).is_some(), BondError::BadPool);
    let sqrt = u128::from_le_bytes(d[L::SQRT_PRICE..L::SQRT_PRICE + 16].try_into().unwrap());
    let spot = bond::price::spot_from_sqrt(sqrt, preq_is_a).map_err(to_err)?;
    let quote_vault = if preq_is_a { key(L::TOKEN_B_VAULT) } else { key(L::TOKEN_A_VAULT) };
    Ok((spot, quote, quote_vault))
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
    let accounts = TransferChecked {
        from: from.to_account_info(),
        mint: mint.to_account_info(),
        to: to.to_account_info(),
        authority: authority.clone(),
    };
    let ctx = CpiContext::new(token_program.key(), accounts);
    let ctx = match signer_seeds {
        Some(s) => ctx.with_signer(s),
        None => ctx,
    };
    token_interface::transfer_checked(ctx, amount, mint.decimals)
}

/// Records the outcome and what the buyer is owed; frees the cap.
fn decide<'info>(
    deal: &mut Account<'info, Deal>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    counter: &mut Account<'info, Counter>,
    p: bond::Payout,
) -> Result<()> {
    require!(deal.outcome == 0, BondError::NotOpen);
    let locked = deal
        .seller_bond
        .checked_add(deal.buyer_deposit)
        .ok_or(BondError::Overflow)?;
    require!(vault.amount >= locked, BondError::VaultShort);
    let to_buyer = p.to_buyer.checked_add(vault.amount - locked).ok_or(BondError::Overflow)?;
    deal.outcome = p.outcome as u8 + 1;
    deal.owed_seller = p.to_seller;
    counter.total_locked = counter
        .total_locked
        .checked_sub(locked)
        .ok_or(BondError::Overflow)?;
    // Only real-sized, real-length deals count toward the mode B switch:
    // delivered deals with seller bond >= 5% of the base per-deal cap, open
    // for >= 1 day. (A speed bump, not proof of real usage.)
    let min_bond = base_caps(&deal.mint).map(|(p, _)| p / 20).unwrap_or(u64::MAX);
    let lasted = Clock::get()?.unix_timestamp.saturating_sub(deal.opened_at) >= 86_400;
    if p.outcome == bond::Outcome::Delivered && deal.seller_bond >= min_bond && lasted {
        counter.settled_deals = counter.settled_deals.saturating_add(1);
        counter.settled_volume = counter.settled_volume.saturating_add(locked);
    }
    emit!(Settled {
        deal: deal.key(),
        seller: deal.seller,
        buyer: deal.buyer,
        outcome: p.outcome as u8,
        to_seller: p.to_seller,
        to_buyer,
    });
    Ok(())
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct OpenArgs {
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub late_window: i64,
    pub pay_window: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    pub paused: bool,
    pub bump: u8,
}

/// Per-mint state: locked total, usage stats, caps (mode A) and the price
/// record (mode B).
#[account]
#[derive(InitSpace)]
pub struct Counter {
    pub mint: Pubkey,
    pub total_locked: u64,
    pub bump: u8,
    pub settled_deals: u64,
    pub settled_volume: u64,
    pub cap_per_deal: u64,
    pub cap_total: u64,
    pub pending_per_deal: u64,
    pub pending_total: u64,
    pub pending_effective_at: i64,
    /// 0 = mode A (operator caps), 1 = mode B (price record). One-way.
    pub price_mode: u8,
    pub quote_mint: Pubkey,
    pub price_q64: u128,
    pub price_last_update: i64,
    pub price_streak_start: i64,
    pub price_updates: u64,
    pub price_liquid_since: i64,
}

impl Counter {
    pub fn caps(&self) -> bond::caps::AdjustableCaps {
        bond::caps::AdjustableCaps {
            per_deal: self.cap_per_deal,
            total: self.cap_total,
            pending_per_deal: self.pending_per_deal,
            pending_total: self.pending_total,
            effective_at: self.pending_effective_at,
        }
    }
    pub fn set_caps(&mut self, c: &bond::caps::AdjustableCaps) {
        self.cap_per_deal = c.per_deal;
        self.cap_total = c.total;
        self.pending_per_deal = c.pending_per_deal;
        self.pending_total = c.pending_total;
        self.pending_effective_at = c.effective_at;
    }
    pub fn record(&self) -> bond::price::PriceRecord {
        bond::price::PriceRecord {
            price_q64: self.price_q64,
            last_update: self.price_last_update,
            streak_start: self.price_streak_start,
            updates: self.price_updates,
            liquid_since: self.price_liquid_since,
        }
    }
    pub fn set_record(&mut self, r: &bond::price::PriceRecord) {
        self.price_q64 = r.price_q64;
        self.price_last_update = r.last_update;
        self.price_streak_start = r.streak_start;
        self.price_updates = r.updates;
        self.price_liquid_since = r.liquid_since;
    }
}

#[account]
#[derive(InitSpace)]
pub struct Deal {
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub nonce: u64,
    pub price: u64,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
    pub late_window: i64,
    pub pay_window: i64,
    pub opened_at: i64,
    /// 0 = not marked.
    pub seller_mark: i64,
    /// 0 = not confirmed.
    pub buyer_confirm: i64,
    pub balance_paid: bool,
    pub bump: u8,
    pub vault_bump: u8,
    /// 0 = open; otherwise outcome + 1 (decided, waiting for claims).
    pub outcome: u8,
    /// What the seller may still claim after the outcome is decided; the
    /// buyer gets the rest of the vault.
    pub owed_seller: u64,
}

fn opt(v: i64) -> Option<i64> {
    if v == 0 {
        None
    } else {
        Some(v)
    }
}

impl Deal {
    pub fn load(&self) -> bond::Deal {
        bond::Deal {
            terms: bond::Terms {
                price: self.price,
                seller_bond: self.seller_bond,
                buyer_deposit: self.buyer_deposit,
                deliver_by: self.deliver_by,
                late_window: self.late_window,
                pay_window: self.pay_window,
            },
            opened_at: self.opened_at,
            seller_mark: opt(self.seller_mark),
            buyer_confirm: opt(self.buyer_confirm),
            balance_paid: self.balance_paid,
            status: if self.outcome == 0 { bond::Status::Open } else { bond::Status::Closed },
        }
    }

    pub fn store(&mut self, d: &bond::Deal) {
        self.price = d.terms.price;
        self.seller_bond = d.terms.seller_bond;
        self.buyer_deposit = d.terms.buyer_deposit;
        self.deliver_by = d.terms.deliver_by;
        self.late_window = d.terms.late_window;
        self.pay_window = d.terms.pay_window;
        self.opened_at = d.opened_at;
        self.seller_mark = d.seller_mark.unwrap_or(0);
        self.buyer_confirm = d.buyer_confirm.unwrap_or(0);
        self.balance_paid = d.balance_paid;
    }
}

#[derive(Accounts)]
pub struct InitCounter<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Counter::INIT_SPACE,
        seeds = [b"counter", mint.key().as_ref()],
        bump
    )]
    pub counter: Account<'info, Counter>,
    pub system_program: Program<'info, System>,
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
pub struct ObservePrice<'info> {
    #[account(mut, seeds = [b"counter", mints::PREQ.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
    /// CHECK: address, owner and layout are checked in read_pool.
    pub pool: UncheckedAccount<'info>,
    /// The pool's quote-side vault; checked against the pool.
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct ActivatePriceMode<'info> {
    #[account(mut, seeds = [b"counter", mints::PREQ.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
    /// CHECK: address, owner and layout are checked in read_pool.
    pub pool: UncheckedAccount<'info>,
    /// The pool's quote-side vault; checked against the pool's vaults.
    pub quote_vault: InterfaceAccount<'info, TokenAccount>,
}

#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct Open<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    pub buyer: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = seller, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = seller,
        space = 8 + Deal::INIT_SPACE,
        seeds = [b"deal", seller.key().as_ref(), buyer.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub deal: Account<'info, Deal>,
    #[account(
        init,
        payer = seller,
        seeds = [b"vault", deal.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = deal,
        token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", mint.key().as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
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
pub struct BuyerOnly<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer)]
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
pub struct PayBalance<'info> {
    pub buyer: Signer<'info>,
    #[account(mut, has_one = buyer, has_one = mint)]
    pub deal: Account<'info, Deal>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, token::mint = mint, token::authority = buyer, token::token_program = token_program)]
    pub buyer_token: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = deal.seller, token::token_program = token_program)]
    pub seller_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Cancel<'info> {
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
pub struct Settle<'info> {
    #[account(mut)]
    pub deal: Account<'info, Deal>,
    #[account(seeds = [b"vault", deal.key().as_ref()], bump = deal.vault_bump, token::authority = deal)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, seeds = [b"counter", deal.mint.as_ref()], bump = counter.bump)]
    pub counter: Account<'info, Counter>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    /// CHECK: receives the rent back; must equal deal.seller (has_one).
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    #[account(mut, has_one = seller, has_one = mint)]
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
    /// The claiming side's token account; its owner is checked per side.
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[event]
pub struct Opened {
    pub deal: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub seller_bond: u64,
    pub buyer_deposit: u64,
    pub deliver_by: i64,
}

/// outcome: 0 Delivered, 1 BuyerDefault, 2 Disputed, 3 SellerDefault, 4 Cancelled.
#[event]
pub struct Settled {
    pub deal: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub outcome: u8,
    pub to_seller: u64,
    pub to_buyer: u64,
}

#[event]
pub struct CapsProposed {
    pub mint: Pubkey,
    pub per_deal: u64,
    pub total: u64,
    pub effective_at: i64,
}

#[event]
pub struct PriceModeActivated {
    pub mint: Pubkey,
    pub quote: Pubkey,
    pub at: i64,
}

#[event]
pub struct PauseChanged {
    pub paused: bool,
}

#[event]
pub struct AdminChanged {
    pub new_admin: Pubkey,
}

#[error_code]
pub enum BondError {
    #[msg("Mint is not allowed")]
    MintNotAllowed,
    #[msg("Seller and buyer must differ")]
    SameParty,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Vault holds less than the locked amount")]
    VaultShort,
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
    #[msg("New deals are paused; open deals still settle normally")]
    Paused,
    CapChangeOutOfBounds,
    BadPoolPrice,
    #[msg("This mint's caps are fixed in code")]
    CapsFixed,
    #[msg("Price mode B is active; caps follow the price record")]
    PriceModeActive,
    #[msg("Pool account is not the expected PREQ pool")]
    BadPool,
    #[msg("Switch thresholds not met yet")]
    SwitchNotReady,
    #[msg("Price record is stale; call observe_price first")]
    PriceStale,
    #[msg("Signer is not the pending admin")]
    Unauthorized,
}

fn to_err(e: bond::Error) -> Error {
    use bond::Error as E;
    let b = match e {
        E::ZeroPrice => BondError::ZeroPrice,
        E::ZeroBond => BondError::ZeroBond,
        E::BondTooLarge => BondError::BondTooLarge,
        E::DepositTooLarge => BondError::DepositTooLarge,
        E::DeadlineInPast => BondError::DeadlineInPast,
        E::TermTooLong => BondError::TermTooLong,
        E::LateWindowTooLong => BondError::LateWindowTooLong,
        E::PayWindowOutOfRange => BondError::PayWindowOutOfRange,
        E::PerDealCapExceeded => BondError::PerDealCapExceeded,
        E::TotalCapExceeded => BondError::TotalCapExceeded,
        E::NotOpen => BondError::NotOpen,
        E::AlreadyMarked => BondError::AlreadyMarked,
        E::AlreadyConfirmed => BondError::AlreadyConfirmed,
        E::MarkTooLate => BondError::MarkTooLate,
        E::ConfirmTooLate => BondError::ConfirmTooLate,
        E::NotConfirmed => BondError::NotConfirmed,
        E::AlreadyPaid => BondError::AlreadyPaid,
        E::PayTooLate => BondError::PayTooLate,
        E::NotYetSettleable => BondError::NotYetSettleable,
        E::Overflow => BondError::Overflow,
        E::CapChangeOutOfBounds => BondError::CapChangeOutOfBounds,
        E::BadPoolPrice => BondError::BadPoolPrice,
    };
    b.into()
}
