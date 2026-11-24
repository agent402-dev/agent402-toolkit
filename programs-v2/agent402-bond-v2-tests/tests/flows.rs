//! End-to-end tests of Bond v2 in LiteSVM with real SPL token moves.
//! Build first: cargo-build-sbf --features test-mints, then BOND_V2_SO=<path to agent402_bond_v2.so>.

use agent402_bond_v2_core::{DAY, HOUR};
use litesvm::LiteSVM;
use litesvm_token::{get_spl_account, spl_token::state::Account as TokenAcc, CreateAccount, CreateAssociatedTokenAccount, CreateMint, MintTo, TOKEN_ID};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROGRAM: Address = Address::from_str_const("5TotaQm4RbhRfhZzwFwnfoRLMWJ4jn3dpA9gRVsgd5bx");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const T0: i64 = 1_800_000_000;
const U: u64 = 1_000_000;

const D_INIT_CONFIG: [u8; 8] = [23, 235, 115, 232, 168, 96, 1, 231];
const D_INIT_COUNTER: [u8; 8] = [247, 168, 146, 45, 125, 26, 142, 80];
const D_SET_PAUSED: [u8; 8] = [91, 60, 125, 192, 176, 225, 166, 218];
const D_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const D_MARK_DELIVERED: [u8; 8] = [240, 118, 188, 142, 64, 85, 107, 18];
const D_ACCEPT: [u8; 8] = [65, 150, 70, 216, 133, 6, 107, 4];
const D_SETTLE: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];
const D_CANCEL: [u8; 8] = [232, 219, 223, 41, 219, 236, 220, 190];
const D_SETTLE_AGREED: [u8; 8] = [231, 63, 88, 124, 88, 192, 159, 78];
const D_SELLER_RELEASE: [u8; 8] = [76, 135, 77, 213, 145, 225, 24, 194];
const D_DECIDE: [u8; 8] = [123, 125, 184, 125, 249, 43, 113, 15];
const D_SET_PAYOUT: [u8; 8] = [55, 43, 132, 51, 227, 169, 242, 195];
const D_CLAIM_SELLER: [u8; 8] = [238, 218, 144, 171, 49, 203, 29, 50];
const D_CLAIM_BUYER: [u8; 8] = [13, 61, 90, 109, 208, 223, 195, 211];

// Deal account offsets (8-byte discriminator, then fields in order)
const OFF_STATE: usize = 331;
const OFF_OUTCOME: usize = 332;

fn admin() -> Keypair { Keypair::new_from_array([7u8; 32]) }
fn config_pda() -> Address { Address::find_program_address(&[b"config"], &PROGRAM).0 }

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    seller: Keypair,
    buyer: Keypair,
    arbiter: Keypair,
    mint: Address,
    seller_ata: Address,
    buyer_ata: Address,
    counter: Address,
}

#[derive(Clone, Copy)]
struct Args { price: u64, bond: u64, deposit: u64, deliver_by: i64, grace: i64, review: i64, bps: u16, arbiter: Option<Address>, arb_window: i64 }
fn args() -> Args {
    Args { price: 30 * U, bond: 3 * U, deposit: 5 * U, deliver_by: T0 + DAY, grace: DAY, review: DAY, bps: 0, arbiter: None, arb_window: 0 }
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
    svm.expire_blockhash();
}
fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs.iter().rev().take(8).collect::<Vec<_>>()));
    svm.expire_blockhash();
    r
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, std::env::var("BOND_V2_SO").expect("set BOND_V2_SO")).unwrap();
    set_time(&mut svm, T0);
    let (payer, seller, buyer, arbiter) = (Keypair::new(), Keypair::new(), Keypair::new(), Keypair::new());
    for k in [&payer, &seller, &buyer, &arbiter, &admin()] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();
    let seller_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&seller.pubkey()).send().unwrap();
    let buyer_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&buyer.pubkey()).send().unwrap();
    MintTo::new(&mut svm, &payer, &mint, &seller_ata, 1_000 * U).send().unwrap();
    MintTo::new(&mut svm, &payer, &mint, &buyer_ata, 1_000 * U).send().unwrap();
    let counter = Address::find_program_address(&[b"counter", mint.as_ref()], &PROGRAM).0;
    let p = payer.insecure_clone();
    send(&mut svm, &[Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config_pda(), false), AccountMeta::new_readonly(SYSTEM, false),
    ], data: D_INIT_CONFIG.to_vec() }], &p, &[]).unwrap();
    send(&mut svm, &[Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(mint, false), AccountMeta::new(counter, false), AccountMeta::new_readonly(SYSTEM, false),
    ], data: D_INIT_COUNTER.to_vec() }], &p, &[]).unwrap();
    Env { svm, payer, seller, buyer, arbiter, mint, seller_ata, buyer_ata, counter }
}

fn pdas(e: &Env, nonce: u64) -> (Address, Address) {
    let deal = Address::find_program_address(&[b"deal", e.seller.pubkey().as_ref(), e.buyer.pubkey().as_ref(), &nonce.to_le_bytes()], &PROGRAM).0;
    (deal, Address::find_program_address(&[b"vault", deal.as_ref()], &PROGRAM).0)
}
fn bal(e: &Env, a: &Address) -> u64 { get_spl_account::<TokenAcc>(&e.svm, a).map(|x| x.amount).unwrap_or(0) }
fn counter_u64(e: &Env, off: usize) -> u64 { let a = e.svm.get_account(&e.counter).unwrap(); u64::from_le_bytes(a.data[off..off + 8].try_into().unwrap()) }
fn total_locked(e: &Env) -> u64 { counter_u64(e, 41) }
fn deal_byte(e: &Env, deal: &Address, off: usize) -> Option<u8> { e.svm.get_account(deal).filter(|a| a.lamports > 0 && !a.data.is_empty()).map(|a| a.data[off]) }

fn open_with(e: &mut Env, nonce: u64, a: Args, seller_payout: Address, buyer_payout: Address) -> Result<(Address, Address), String> {
    let (deal, vault) = pdas(e, nonce);
    let mut data = D_OPEN.to_vec();
    data.extend(nonce.to_le_bytes());
    for v in [a.price, a.bond, a.deposit] { data.extend(v.to_le_bytes()); }
    for v in [a.deliver_by, a.grace, a.review] { data.extend(v.to_le_bytes()); }
    data.extend(a.bps.to_le_bytes());
    data.extend(a.arbiter.unwrap_or_default().as_ref());
    data.extend(a.arb_window.to_le_bytes());
    data.extend([9u8; 32]); // job_hash
    let ix = Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(e.seller.pubkey(), true), AccountMeta::new_readonly(e.buyer.pubkey(), true), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(e.seller_ata, false), AccountMeta::new(e.buyer_ata, false),
        AccountMeta::new_readonly(seller_payout, false), AccountMeta::new_readonly(buyer_payout, false),
        AccountMeta::new(deal, false), AccountMeta::new(vault, false), AccountMeta::new(e.counter, false), AccountMeta::new_readonly(config_pda(), false),
        AccountMeta::new_readonly(TOKEN_ID, false), AccountMeta::new_readonly(SYSTEM, false),
    ], data };
    let (s, b) = (e.seller.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, &[ix], &s, &[&b])?;
    Ok((deal, vault))
}
fn open(e: &mut Env, nonce: u64, a: Args) -> Result<(Address, Address), String> {
    let (sp, bp) = (e.seller_ata, e.buyer_ata);
    open_with(e, nonce, a, sp, bp)
}
fn mark(e: &mut Env, deal: Address) -> Result<(), String> {
    let mut data = D_MARK_DELIVERED.to_vec();
    data.extend([5u8; 32]);
    let ix = Instruction { program_id: PROGRAM, accounts: vec![AccountMeta::new_readonly(e.seller.pubkey(), true), AccountMeta::new(deal, false)], data };
    let (p, s) = (e.payer.insecure_clone(), e.seller.insecure_clone());
    send(&mut e.svm, &[ix], &p, &[&s])
}
fn accept_ix(e: &Env, deal: Address, vault: Address, seller_payout: Address) -> Instruction {
    Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new_readonly(e.buyer.pubkey(), true), AccountMeta::new(deal, false), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(e.buyer_ata, false), AccountMeta::new(seller_payout, false), AccountMeta::new_readonly(vault, false),
        AccountMeta::new(e.counter, false), AccountMeta::new_readonly(TOKEN_ID, false),
    ], data: D_ACCEPT.to_vec() }
}
fn accept(e: &mut Env, deal: Address, vault: Address) -> Result<(), String> {
    let ix = accept_ix(e, deal, vault, e.seller_ata);
    let (p, b) = (e.payer.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, &[ix], &p, &[&b])
}
fn decide_accounts(e: &Env, deal: Address, vault: Address, signers: &[Address]) -> Vec<AccountMeta> {
    let mut v: Vec<AccountMeta> = signers.iter().map(|s| AccountMeta::new_readonly(*s, true)).collect();
    v.extend([AccountMeta::new(deal, false), AccountMeta::new_readonly(vault, false), AccountMeta::new(e.counter, false)]);
    v
}
fn settle(e: &mut Env, deal: Address, vault: Address) -> Result<(), String> {
    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(e, deal, vault, &[]), data: D_SETTLE.to_vec() };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, &[ix], &p, &[])
}
fn claim_ix(e: &Env, deal: Address, vault: Address, to: Address, buyer_side: bool) -> Instruction {
    Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(e.seller.pubkey(), false), AccountMeta::new(deal, false), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(vault, false), AccountMeta::new(to, false), AccountMeta::new_readonly(TOKEN_ID, false),
    ], data: if buyer_side { D_CLAIM_BUYER.to_vec() } else { D_CLAIM_SELLER.to_vec() } }
}
fn claim_both(e: &mut Env, deal: Address, vault: Address, buyer_first: bool) -> Result<(), String> {
    // Separate transactions: the first claim may already close the deal (nothing owed to the other side).
    let p = e.payer.insecure_clone();
    for buyer in if buyer_first { [true, false] } else { [false, true] } {
        if e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0) { break; }
        let to = if buyer { e.buyer_ata } else { e.seller_ata };
        let ix = claim_ix(e, deal, vault, to, buyer);
        send(&mut e.svm, &[ix], &p, &[])?;
    }
    Ok(())
}

#[test]
fn accept_pays_balance_and_releases_bond_and_deposit() {
    let mut e = setup();
    let a = args();
    let (s0, b0) = (bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata));
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    assert_eq!(bal(&e, &vault), 8 * U);
    assert_eq!(total_locked(&e), 8 * U);
    mark(&mut e, deal).unwrap();
    let rent0 = e.svm.get_balance(&e.seller.pubkey()).unwrap();
    accept(&mut e, deal, vault).unwrap();
    assert_eq!(deal_byte(&e, &deal, OFF_STATE), Some(3));
    assert_eq!(deal_byte(&e, &deal, OFF_OUTCOME), Some(0));
    assert_eq!(total_locked(&e), 0);
    claim_both(&mut e, deal, vault, true).unwrap();
    assert_eq!(bal(&e, &e.seller_ata), s0 + 30 * U - 0, "seller: price in total (balance 25 + deposit 5), bond back");
    assert_eq!(bal(&e, &e.buyer_ata), b0 - 30 * U);
    assert!(e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0), "deal closed");
    assert!(e.svm.get_balance(&e.seller.pubkey()).unwrap() > rent0, "rent back to the payer");
}

#[test]
fn accept_before_mark_and_deadlines() {
    let mut e = setup();
    let a = args();
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    set_time(&mut e.svm, a.deliver_by + a.grace + 1);
    assert!(accept(&mut e, deal, vault).is_err(), "unmarked: accept closes with the mark deadline");
    assert!(mark(&mut e, deal).is_err(), "mark too late");
    set_time(&mut e.svm, a.deliver_by + a.grace);
    // still inside the window at exactly M
    let (deal2, vault2) = open(&mut e, 2, Args { deliver_by: a.deliver_by + 2 * DAY, ..a }).unwrap();
    accept(&mut e, deal2, vault2).unwrap();
    let _ = (deal, vault);
}

#[test]
fn seller_default_then_claims_in_either_order_close_the_deal() {
    for buyer_first in [true, false] {
        let mut e = setup();
        let a = args();
        let b0 = bal(&e, &e.buyer_ata);
        let (deal, vault) = open(&mut e, 1, a).unwrap();
        set_time(&mut e.svm, a.deliver_by + a.grace);
        assert!(settle(&mut e, deal, vault).is_err(), "not at M");
        set_time(&mut e.svm, a.deliver_by + a.grace + 1);
        settle(&mut e, deal, vault).unwrap();
        assert_eq!(deal_byte(&e, &deal, OFF_OUTCOME), Some(2));
        if buyer_first {
            // the seller is owed nothing: the buyer's claim alone empties and closes the deal (v1 kept it open)
            let ix = claim_ix(&e, deal, vault, e.buyer_ata, true);
            let p = e.payer.insecure_clone();
            send(&mut e.svm, &[ix], &p, &[]).unwrap();
        } else {
            claim_both(&mut e, deal, vault, false).unwrap();
        }
        assert_eq!(bal(&e, &e.buyer_ata), b0 + 3 * U, "buyer gets its deposit and the seller bond");
        assert!(e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0), "closed whatever the claim order");
    }
}

#[test]
fn unconfirmed_neutral_and_with_share() {
    for (bps, seller_gain) in [(0u16, 0u64), (4_000, 2 * U)] {
        let mut e = setup();
        let a = Args { bps, ..args() };
        let (s0, b0) = (bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata));
        let (deal, vault) = open(&mut e, 1, a).unwrap();
        set_time(&mut e.svm, T0 + 10);
        mark(&mut e, deal).unwrap();
        let ad = a.deliver_by + a.review; // early mark counts from deliver_by
        set_time(&mut e.svm, ad);
        assert!(settle(&mut e, deal, vault).is_err());
        set_time(&mut e.svm, ad + 1);
        assert!(accept(&mut e, deal, vault).is_err());
        settle(&mut e, deal, vault).unwrap();
        claim_both(&mut e, deal, vault, false).unwrap();
        assert_eq!(bal(&e, &e.seller_ata), s0 + seller_gain);
        assert_eq!(bal(&e, &e.buyer_ata), b0 - seller_gain);
    }
}

#[test]
fn cancel_agreed_and_seller_release() {
    let mut e = setup();
    let a = args();
    let (s0, b0) = (bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata));
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey(), e.buyer.pubkey()]), data: D_CANCEL.to_vec() };
    let (p, s, b) = (e.payer.insecure_clone(), e.seller.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, &[ix], &p, &[&s, &b]).unwrap();
    claim_both(&mut e, deal, vault, true).unwrap();
    assert_eq!((bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata)), (s0, b0));

    let (deal, vault) = open(&mut e, 2, a).unwrap();
    let mut data = D_SETTLE_AGREED.to_vec();
    data.extend((6 * U).to_le_bytes());
    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey(), e.buyer.pubkey()]), data };
    send(&mut e.svm, &[ix], &p, &[&s, &b]).unwrap();
    claim_both(&mut e, deal, vault, true).unwrap();
    assert_eq!(bal(&e, &e.seller_ata), s0 + 3 * U);

    let (deal, vault) = open(&mut e, 3, a).unwrap();
    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey()]), data: D_SELLER_RELEASE.to_vec() };
    send(&mut e.svm, &[ix], &p, &[&s]).unwrap();
    claim_both(&mut e, deal, vault, false).unwrap();
    assert_eq!(bal(&e, &e.seller_ata), s0 + 3 * U);
    assert_eq!(total_locked(&e), 0);
}

#[test]
fn arbiter_only_inside_its_window() {
    let mut e = setup();
    let a = Args { arbiter: Some(e.arbiter.pubkey()), arb_window: DAY, ..args() };
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    mark(&mut e, deal).unwrap();
    let ad = a.deliver_by + a.review;
    let dec = |e: &mut Env, who: &Keypair, x: u64| {
        let mut data = D_DECIDE.to_vec();
        data.extend(x.to_le_bytes());
        let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(e, deal, vault, &[who.pubkey()]), data };
        let p = e.payer.insecure_clone();
        send(&mut e.svm, &[ix], &p, &[who])
    };
    let arb = e.arbiter.insecure_clone();
    set_time(&mut e.svm, ad);
    assert!(dec(&mut e, &arb, U).is_err(), "not before A");
    set_time(&mut e.svm, ad + 1);
    let s = e.seller.insecure_clone();
    assert!(dec(&mut e, &s, U).is_err(), "only the arbiter");
    assert!(settle(&mut e, deal, vault).is_err(), "settle waits for the arbiter window");
    let s0 = bal(&e, &e.seller_ata);
    dec(&mut e, &arb, 7 * U).unwrap();
    claim_both(&mut e, deal, vault, true).unwrap();
    assert_eq!(bal(&e, &e.seller_ata), s0 + 7 * U);
}

#[test]
fn payouts_are_fixed_and_changed_only_by_their_owner() {
    let mut e = setup();
    let a = args();
    let other_owner = Keypair::new();
    let p = e.payer.insecure_clone();
    let stranger_acc = CreateAccount::new(&mut e.svm, &p, &e.mint).owner(&other_owner.pubkey()).send().unwrap();
    let bp = e.buyer_ata;
    assert!(open_with(&mut e, 9, a, stranger_acc, bp).is_err(), "seller payout must be owned by the seller");
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    set_time(&mut e.svm, a.deliver_by + a.grace + 1);
    settle(&mut e, deal, vault).unwrap();
    let ix = claim_ix(&e, deal, vault, stranger_acc, true);
    assert!(send(&mut e.svm, &[ix], &p, &[]).is_err(), "claim only to the recorded payout");
    // the buyer moves its payout to a second account it owns
    let b = e.buyer.insecure_clone();
    let second = CreateAccount::new(&mut e.svm, &p, &e.mint).owner(&b.pubkey()).send().unwrap();
    let set = |who: &Keypair, acc: Address| Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new_readonly(who.pubkey(), true), AccountMeta::new(deal, false), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new_readonly(acc, false), AccountMeta::new_readonly(TOKEN_ID, false),
    ], data: D_SET_PAYOUT.to_vec() };
    assert!(send(&mut e.svm, &[set(&other_owner, stranger_acc)], &p, &[&other_owner]).is_err(), "a stranger cannot set a payout");
    send(&mut e.svm, &[set(&b, second)], &p, &[&b]).unwrap();
    let ix = claim_ix(&e, deal, vault, second, true);
    send(&mut e.svm, &[ix], &p, &[]).unwrap();
    assert_eq!(bal(&e, &second), 8 * U);
}

#[test]
fn failed_balance_payment_leaves_the_deal_unchanged() {
    let mut e = setup();
    let a = Args { price: 1_000 * U, bond: 3 * U, deposit: 5 * U, ..args() };
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    // buyer now holds 995, the balance is 995: spend 1 elsewhere so the payment fails
    let p = e.payer.insecure_clone();
    let sink = CreateAccount::new(&mut e.svm, &p, &e.mint).owner(&p.pubkey()).send().unwrap();
    let b = e.buyer.insecure_clone();
    let t = spl_transfer(&e.buyer_ata, &sink, &b.pubkey(), U);
    send(&mut e.svm, &[t], &p, &[&b]).unwrap();
    assert!(accept(&mut e, deal, vault).is_err());
    assert_eq!(deal_byte(&e, &deal, OFF_STATE), Some(1), "still open: no 'accepted but unpaid' state");
    assert_eq!(total_locked(&e), 8 * U);
}

#[test]
fn pause_blocks_only_new_deals_and_extra_tokens_go_to_the_buyer() {
    let mut e = setup();
    let a = args();
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    let ad = admin();
    let mut data = D_SET_PAUSED.to_vec();
    data.push(1);
    let ix = Instruction { program_id: PROGRAM, accounts: vec![AccountMeta::new_readonly(ad.pubkey(), true), AccountMeta::new(config_pda(), false)], data };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, &[ix], &p, &[&ad]).unwrap();
    assert!(open(&mut e, 2, a).is_err(), "paused");
    // someone sends 1 token straight to the vault
    let s = e.seller.insecure_clone();
    let t = spl_transfer(&e.seller_ata, &vault, &s.pubkey(), U);
    send(&mut e.svm, &[t], &p, &[&s]).unwrap();
    let b0 = bal(&e, &e.buyer_ata);
    mark(&mut e, deal).unwrap();
    accept(&mut e, deal, vault).unwrap();
    claim_both(&mut e, deal, vault, false).unwrap();
    assert_eq!(bal(&e, &e.buyer_ata), b0 - 25 * U + U, "the extra token goes to the buyer");
    assert!(e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0));
}

#[test]
fn caps_are_enforced() {
    let mut e = setup();
    let big = Args { price: 1_000 * U, bond: 100 * U, deposit: 1 * U, ..args() };
    assert!(open(&mut e, 1, big).is_err(), "101 locked > 100 per deal");
    let _ = HOUR;
}

/// SPL Token transfer (instruction 3).
fn spl_transfer(from: &Address, to: &Address, owner: &Address, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend(amount.to_le_bytes());
    Instruction { program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)], data }
}


/// SPL Token SetAuthority(AccountOwner) on a token account.
fn set_owner(acc: &Address, owner: &Address, new_owner: &Address) -> Instruction {
    let mut data = vec![6u8, 2, 1];
    data.extend(new_owner.as_ref());
    Instruction { program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*acc, false), AccountMeta::new_readonly(*owner, true)], data }
}

#[test]
fn claims_and_accept_recheck_the_payout_owner() {
    // a payout account that no longer belongs to its party is refused until the party sets a new one
    let mut e = setup();
    let a = args();
    let (deal, vault) = open(&mut e, 1, a).unwrap();
    mark(&mut e, deal).unwrap();
    let (p, s) = (e.payer.insecure_clone(), e.seller.insecure_clone());
    let other = Keypair::new();
    let sa = e.seller_ata;
    send(&mut e.svm, &[set_owner(&sa, &s.pubkey(), &other.pubkey())], &p, &[&s]).unwrap();
    assert!(accept(&mut e, deal, vault).is_err(), "accept refuses a seller payout now owned by someone else");
    set_time(&mut e.svm, a.deliver_by + a.review + 1);
    settle(&mut e, deal, vault).unwrap();
    let ix = claim_ix(&e, deal, vault, sa, false);
    assert!(send(&mut e.svm, &[ix], &p, &[]).is_err(), "seller claim refused");
    let ix = claim_ix(&e, deal, vault, e.buyer_ata, true);
    send(&mut e.svm, &[ix], &p, &[]).unwrap();
    assert!(e.svm.get_account(&deal).map_or(false, |x| x.lamports > 0), "deal stays open while the seller is owed");
}
