//! End-to-end tests of the bond program in LiteSVM with real SPL token moves.
//! Build the program first (cargo-build-sbf --features test-mints) and point
//! BOND_SO at agent402_bond.so.

use agent402_bond_core::{DAY, GRACE};
use litesvm::LiteSVM;
use litesvm_token::{
    get_spl_account, spl_token::state::Account as TokenAcc, CreateAssociatedTokenAccount,
    CreateMint, MintTo, TOKEN_ID,
};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROGRAM: Address = Address::from_str_const("Howw2bfGrx5QGWD79oUoaMhWEgEgeJgFgunQCZ7NbJ6f");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const T0: i64 = 1_800_000_000;
const UNIT: u64 = 1_000_000; // 6 decimals

const D_INIT: [u8; 8] = [247, 168, 146, 45, 125, 26, 142, 80];
const D_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const D_MARK: [u8; 8] = [240, 118, 188, 142, 64, 85, 107, 18];
const D_CONFIRM: [u8; 8] = [203, 36, 80, 115, 249, 12, 141, 170];
const D_PAY: [u8; 8] = [121, 220, 140, 105, 242, 163, 148, 24];
const D_EXTEND: [u8; 8] = [228, 127, 0, 1, 227, 154, 54, 168];
const D_CANCEL: [u8; 8] = [232, 219, 223, 41, 219, 236, 220, 190];
const D_SETTLE: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];
const D_INIT_CONFIG: [u8; 8] = [23, 235, 115, 232, 168, 96, 1, 231];
const D_SET_PAUSED: [u8; 8] = [91, 60, 125, 192, 176, 225, 166, 218];
const D_SET_ADMIN: [u8; 8] = [251, 163, 0, 52, 91, 194, 187, 92];
const D_ACCEPT_ADMIN: [u8; 8] = [112, 42, 45, 90, 116, 181, 13, 170];

fn admin() -> Keypair {
    Keypair::new_from_array([7u8; 32])
}

fn config_pda() -> Address {
    Address::find_program_address(&[b"config"], &PROGRAM).0
}

struct Env {
    svm: LiteSVM,
    payer: Keypair,
    seller: Keypair,
    buyer: Keypair,
    mint: Address,
    seller_ata: Address,
    buyer_ata: Address,
    counter: Address,
}

#[derive(Clone, Copy)]
struct Args {
    price: u64,
    bond: u64,
    deposit: u64,
    deliver_by: i64,
    late: i64,
    pay: i64,
}

fn default_args() -> Args {
    Args {
        price: 300 * UNIT,
        bond: 30 * UNIT,
        deposit: 30 * UNIT,
        deliver_by: T0 + 10 * DAY,
        late: 2 * DAY,
        pay: 3 * DAY,
    }
}

fn so_path() -> String {
    std::env::var("BOND_SO").expect("set BOND_SO to the built agent402_bond.so")
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
    svm.expire_blockhash();
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    r
}

fn setup() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, so_path()).unwrap();
    set_time(&mut svm, T0);
    let payer = Keypair::new();
    let seller = Keypair::new();
    let buyer = Keypair::new();
    for k in [&payer, &seller, &buyer] {
        svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
    }
    let mint = CreateMint::new(&mut svm, &payer).decimals(6).send().unwrap();
    let seller_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint)
        .owner(&seller.pubkey())
        .send()
        .unwrap();
    let buyer_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint)
        .owner(&buyer.pubkey())
        .send()
        .unwrap();
    MintTo::new(&mut svm, &payer, &mint, &seller_ata, 1_000 * UNIT).send().unwrap();
    MintTo::new(&mut svm, &payer, &mint, &buyer_ata, 1_000 * UNIT).send().unwrap();
    let (counter, _) = Address::find_program_address(&[b"counter", mint.as_ref()], &PROGRAM);
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: D_INIT.to_vec(),
    };
    let p = payer.insecure_clone();
    send(&mut svm, ix, &p, &[]).unwrap();
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true),
            AccountMeta::new(config_pda(), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: D_INIT_CONFIG.to_vec(),
    };
    send(&mut svm, ix, &p, &[]).unwrap();
    Env { svm, payer, seller, buyer, mint, seller_ata, buyer_ata, counter }
}

fn pdas(e: &Env, nonce: u64) -> (Address, Address) {
    let (deal, _) = Address::find_program_address(
        &[b"deal", e.seller.pubkey().as_ref(), e.buyer.pubkey().as_ref(), &nonce.to_le_bytes()],
        &PROGRAM,
    );
    let (vault, _) = Address::find_program_address(&[b"vault", deal.as_ref()], &PROGRAM);
    (deal, vault)
}

fn balance(e: &Env, a: &Address) -> u64 {
    get_spl_account::<TokenAcc>(&e.svm, a).map(|x| x.amount).unwrap_or(0)
}

fn counter_total(e: &Env) -> u64 {
    let acc = e.svm.get_account(&e.counter).unwrap();
    u64::from_le_bytes(acc.data[40..48].try_into().unwrap())
}

fn open(e: &mut Env, nonce: u64, a: Args) -> Result<(Address, Address), String> {
    let (deal, vault) = pdas(e, nonce);
    let mut data = D_OPEN.to_vec();
    data.extend(nonce.to_le_bytes());
    for v in [a.price, a.bond, a.deposit] {
        data.extend(v.to_le_bytes());
    }
    for v in [a.deliver_by, a.late, a.pay] {
        data.extend(v.to_le_bytes());
    }
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(e.seller.pubkey(), true),
            AccountMeta::new_readonly(e.buyer.pubkey(), true),
            AccountMeta::new_readonly(e.mint, false),
            AccountMeta::new(e.seller_ata, false),
            AccountMeta::new(e.buyer_ata, false),
            AccountMeta::new(deal, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(e.counter, false),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new_readonly(TOKEN_ID, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    };
    let (s, b) = (e.seller.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, ix, &s, &[&b])?;
    Ok((deal, vault))
}

fn simple(e: &mut Env, disc: [u8; 8], signer: &Keypair, deal: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(deal, false),
        ],
        data: disc.to_vec(),
    };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, ix, &p, &[signer])
}

fn pay(e: &mut Env, deal: Address, seller_dest: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(e.buyer.pubkey(), true),
            AccountMeta::new(deal, false),
            AccountMeta::new_readonly(e.mint, false),
            AccountMeta::new(e.buyer_ata, false),
            AccountMeta::new(seller_dest, false),
            AccountMeta::new_readonly(TOKEN_ID, false),
        ],
        data: D_PAY.to_vec(),
    };
    let (p, b) = (e.payer.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, ix, &p, &[&b])
}

const D_CLAIM_SELLER: [u8; 8] = [238, 218, 144, 171, 49, 203, 29, 50];
const D_CLAIM_BUYER: [u8; 8] = [13, 61, 90, 109, 208, 223, 195, 211];

fn send_all(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    r
}

/// settle (anyone) or cancel (both sign): decides the outcome, moves nothing.
fn decide_ix(e: &Env, deal: Address, vault: Address, cancel: bool) -> Instruction {
    let accounts = if cancel {
        vec![
            AccountMeta::new_readonly(e.seller.pubkey(), true),
            AccountMeta::new_readonly(e.buyer.pubkey(), true),
            AccountMeta::new(deal, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new(e.counter, false),
        ]
    } else {
        vec![AccountMeta::new(deal, false), AccountMeta::new_readonly(vault, false), AccountMeta::new(e.counter, false)]
    };
    Instruction { program_id: PROGRAM, accounts, data: if cancel { D_CANCEL.to_vec() } else { D_SETTLE.to_vec() } }
}

fn claim_ix(e: &Env, deal: Address, vault: Address, to: Address, buyer_side: bool) -> Instruction {
    Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(e.seller.pubkey(), false),
            AccountMeta::new(deal, false),
            AccountMeta::new_readonly(e.mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(TOKEN_ID, false),
        ],
        data: if buyer_side { D_CLAIM_BUYER.to_vec() } else { D_CLAIM_SELLER.to_vec() },
    }
}

fn settle(e: &mut Env, deal: Address, vault: Address) -> Result<(), String> {
    let (s, b) = (e.seller_ata, e.buyer_ata);
    settle_to(e, deal, vault, s, b)
}

/// The usual path: settle and both claims in one transaction.
fn settle_to(e: &mut Env, deal: Address, vault: Address, sd: Address, bd: Address) -> Result<(), String> {
    let ixs = [decide_ix(e, deal, vault, false), claim_ix(e, deal, vault, bd, true), claim_ix(e, deal, vault, sd, false)];
    let p = e.payer.insecure_clone();
    send_all(&mut e.svm, &ixs, &p, &[])
}

fn expect_code(r: Result<(), String>, code: u32) {
    let e = r.expect_err("expected failure");
    assert!(e.contains(&format!("Custom({code})")), "expected code {code}, got {e}");
}

fn assert_closed(e: &Env, deal: Address, vault: Address) {
    assert!(e.svm.get_account(&deal).map(|a| a.lamports == 0).unwrap_or(true), "deal not closed");
    assert!(e.svm.get_account(&vault).map(|a| a.lamports == 0).unwrap_or(true), "vault not closed");
    assert_eq!(counter_total(e), 0);
}

#[test]
fn delivered_and_paid() {
    let mut e = setup();
    let (deal, vault) = open(&mut e, 1, default_args()).unwrap();
    assert_eq!(balance(&e, &vault), 60 * UNIT);
    assert_eq!(counter_total(&e), 60 * UNIT);
    let b = e.buyer.insecure_clone();
    simple(&mut e, D_CONFIRM, &b, deal).unwrap();
    let sd = e.seller_ata;
    pay(&mut e, deal, sd).unwrap();
    settle(&mut e, deal, vault).unwrap();
    // seller: 1000 - 30 + 270 (balance) + 30 (bond back) + 30 (deposit) = 1300
    assert_eq!(balance(&e, &e.seller_ata), 1_300 * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), 700 * UNIT);
    assert_closed(&e, deal, vault);
    // Cannot settle twice.
    assert!(settle(&mut e, deal, vault).is_err());
}

#[test]
fn seller_default_pays_buyer() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 2, a).unwrap();
    let t2 = a.deliver_by + GRACE + a.late;
    set_time(&mut e.svm, t2);
    expect_code(settle(&mut e, deal, vault), 6022);
    set_time(&mut e.svm, t2 + 1);
    settle(&mut e, deal, vault).unwrap();
    assert_eq!(balance(&e, &e.seller_ata), 970 * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), 1_030 * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn disputed_is_neutral() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 3, a).unwrap();
    set_time(&mut e.svm, T0 + DAY);
    let s = e.seller.insecure_clone();
    simple(&mut e, D_MARK, &s, deal).unwrap();
    // The window runs from max(mark, T1), T1 = deliver_by + GRACE.
    set_time(&mut e.svm, a.deliver_by + GRACE + a.pay + GRACE);
    expect_code(settle(&mut e, deal, vault), 6022);
    set_time(&mut e.svm, a.deliver_by + GRACE + a.pay + GRACE + 1);
    settle(&mut e, deal, vault).unwrap();
    assert_eq!(balance(&e, &e.seller_ata), 1_000 * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), 1_000 * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn late_delivery_pro_rata() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 4, a).unwrap();
    let t1 = a.deliver_by + GRACE;
    set_time(&mut e.svm, t1 + DAY); // half of a 2-day late window
    let s = e.seller.insecure_clone();
    simple(&mut e, D_MARK, &s, deal).unwrap();
    let b = e.buyer.insecure_clone();
    simple(&mut e, D_CONFIRM, &b, deal).unwrap();
    let sd = e.seller_ata;
    pay(&mut e, deal, sd).unwrap();
    settle(&mut e, deal, vault).unwrap();
    // bond 30: 15 to buyer, 15 back to seller. deposit 30 + balance 270 to seller.
    assert_eq!(balance(&e, &e.seller_ata), (970 + 270 + 15 + 30) * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), (1_000 - 30 - 270 + 15) * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn buyer_default_after_confirm() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 5, a).unwrap();
    set_time(&mut e.svm, T0 + DAY);
    let b = e.buyer.insecure_clone();
    simple(&mut e, D_CONFIRM, &b, deal).unwrap();
    set_time(&mut e.svm, a.deliver_by + GRACE + a.pay + GRACE + 1);
    let sd = e.seller_ata;
    expect_code(pay(&mut e, deal, sd), 6021);
    settle(&mut e, deal, vault).unwrap();
    assert_eq!(balance(&e, &e.seller_ata), 1_030 * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), 970 * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn cancel_needs_both_and_refunds_each() {
    let mut e = setup();
    let (deal, vault) = open(&mut e, 6, default_args()).unwrap();
    // Seller alone cannot cancel: buyer meta not a signer.
    let mut ix = decide_ix(&e, deal, vault, true);
    ix.accounts[1] = AccountMeta::new_readonly(e.buyer.pubkey(), false);
    let s = e.seller.insecure_clone();
    assert!(send(&mut e.svm, ix, &s, &[]).is_err());
    let ixs = [decide_ix(&e, deal, vault, true), claim_ix(&e, deal, vault, e.buyer_ata, true), claim_ix(&e, deal, vault, e.seller_ata, false)];
    let b = e.buyer.insecure_clone();
    send_all(&mut e.svm, &ixs, &s, &[&b]).unwrap();
    assert_eq!(balance(&e, &e.seller_ata), 1_000 * UNIT);
    assert_eq!(balance(&e, &e.buyer_ata), 1_000 * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn extend_needs_both() {
    let mut e = setup();
    let a = default_args();
    let (deal, _vault) = open(&mut e, 7, a).unwrap();
    let mut data = D_EXTEND.to_vec();
    for v in [a.deliver_by + 5 * DAY, a.late, a.pay] {
        data.extend(v.to_le_bytes());
    }
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(e.seller.pubkey(), true),
            AccountMeta::new_readonly(e.buyer.pubkey(), true),
            AccountMeta::new(deal, false),
        ],
        data: data.clone(),
    };
    let (s, b, p) = (e.seller.insecure_clone(), e.buyer.insecure_clone(), e.payer.insecure_clone());
    send(&mut e.svm, ix, &p, &[&s, &b]).unwrap();
    let acc = e.svm.get_account(&deal).unwrap();
    // deliver_by offset: 8 disc + 3*32 + 4*8
    let off = 8 + 96 + 32;
    assert_eq!(i64::from_le_bytes(acc.data[off..off + 8].try_into().unwrap()), a.deliver_by + 5 * DAY);
    // Buyer key as non-signer fails.
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(e.seller.pubkey(), true),
            AccountMeta::new_readonly(e.buyer.pubkey(), false),
            AccountMeta::new(deal, false),
        ],
        data,
    };
    assert!(send(&mut e.svm, ix, &p, &[&s]).is_err());
}

#[test]
fn wrong_party_and_wrong_destination_fail() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 8, a).unwrap();
    // A stranger cannot mark or confirm.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_code(simple(&mut e, D_MARK, &stranger, deal), 2001);
    expect_code(simple(&mut e, D_CONFIRM, &stranger, deal), 2001);
    // Settling into a stranger's token account fails.
    let p = e.payer.insecure_clone();
    let mint = e.mint;
    let evil = CreateAssociatedTokenAccount::new(&mut e.svm, &p, &mint)
        .owner(&stranger.pubkey())
        .send()
        .unwrap();
    set_time(&mut e.svm, a.deliver_by + GRACE + a.late + 1);
    let sd = e.seller_ata;
    expect_code(settle_to(&mut e, deal, vault, sd, evil), 6031);
    let bd = e.buyer_ata;
    expect_code(settle_to(&mut e, deal, vault, evil, bd), 6031);
    // Claiming each side into the other side's account also fails.
    expect_code(settle_to(&mut e, deal, vault, bd, sd), 6031);
    settle(&mut e, deal, vault).unwrap();
    assert_eq!(balance(&e, &evil), 0);
}

#[test]
fn donation_does_not_block_settlement() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 9, a).unwrap();
    let (p, mint) = (e.payer.insecure_clone(), e.mint);
    MintTo::new(&mut e.svm, &p, &mint, &vault, 5 * UNIT).send().unwrap();
    set_time(&mut e.svm, a.deliver_by + GRACE + a.late + 1);
    settle(&mut e, deal, vault).unwrap();
    // Seller default: buyer gets 60 plus the extra 5 sent to the vault.
    assert_eq!(balance(&e, &e.buyer_ata), 1_035 * UNIT);
    assert_eq!(balance(&e, &e.seller_ata), 970 * UNIT);
    assert_closed(&e, deal, vault);
}

/// Extra sent to the vault goes to the buyer even when the seller is the one
/// paid (delivered), and even when it arrives after the outcome is decided.
#[test]
fn extra_in_vault_goes_to_buyer() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 31, a).unwrap();
    let b = e.buyer.insecure_clone();
    simple(&mut e, D_CONFIRM, &b, deal).unwrap();
    let sd = e.seller_ata;
    pay(&mut e, deal, sd).unwrap();
    let (p, mint) = (e.payer.insecure_clone(), e.mint);
    MintTo::new(&mut e.svm, &p, &mint, &vault, 3 * UNIT).send().unwrap();
    // Decide and pay the seller first; then 2 more arrive; then the buyer claims.
    let ixs = [decide_ix(&e, deal, vault, false), claim_ix(&e, deal, vault, e.seller_ata, false)];
    send_all(&mut e.svm, &ixs, &p, &[]).unwrap();
    MintTo::new(&mut e.svm, &p, &mint, &vault, 2 * UNIT).send().unwrap();
    let ixs = [claim_ix(&e, deal, vault, e.buyer_ata, true), claim_ix(&e, deal, vault, e.seller_ata, false)];
    send_all(&mut e.svm, &ixs, &p, &[]).unwrap();
    // Delivered: seller gets bond back + deposit + balance = +270 net of its 30 bond.
    assert_eq!(balance(&e, &e.seller_ata), 1_300 * UNIT);
    // Buyer paid 300 and gets the 5 extra back.
    assert_eq!(balance(&e, &e.buyer_ata), 705 * UNIT);
    assert_closed(&e, deal, vault);
}

#[test]
fn caps_and_ratios_enforced() {
    let mut e = setup();
    let mut a = default_args();
    a.bond = 61 * UNIT; // > 20% of 300
    expect_code(open(&mut e, 10, a).map(|_| ()), 6006);
    let mut a = default_args();
    a.price = 1_000 * UNIT;
    a.bond = 60 * UNIT;
    a.deposit = 41 * UNIT; // 101 > per-deal cap 100
    expect_code(open(&mut e, 11, a).map(|_| ()), 6012);
    let mut a = default_args();
    a.deliver_by = T0 - 1;
    expect_code(open(&mut e, 12, a).map(|_| ()), 6008);
    // Same seller and buyer is refused.
    assert_eq!(counter_total(&e), 0);
}

fn admin_ix(e: &mut Env, signer: &Keypair, data: Vec<u8>) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new(config_pda(), false),
        ],
        data,
    };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, ix, &p, &[signer])
}

fn paused(v: bool) -> Vec<u8> {
    let mut d = D_SET_PAUSED.to_vec();
    d.push(v as u8);
    d
}

#[test]
fn pause_stops_only_new_deals() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 20, a).unwrap();
    // A stranger cannot pause.
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_code(admin_ix(&mut e, &stranger, paused(true)), 2001);
    // Admin pauses: new deals are refused.
    let adm = admin();
    e.svm.airdrop(&adm.pubkey(), 1_000_000_000).unwrap();
    admin_ix(&mut e, &adm, paused(true)).unwrap();
    expect_code(open(&mut e, 21, a).map(|_| ()), 6023);
    // The open deal still runs and settles while paused.
    let b = e.buyer.insecure_clone();
    simple(&mut e, D_CONFIRM, &b, deal).unwrap();
    let sd = e.seller_ata;
    pay(&mut e, deal, sd).unwrap();
    settle(&mut e, deal, vault).unwrap();
    assert_closed(&e, deal, vault);
    // Unpause: new deals work again.
    admin_ix(&mut e, &adm, paused(false)).unwrap();
    open(&mut e, 22, a).unwrap();
    // Hand over the pause power; the old admin loses it.
    let next = Keypair::new();
    e.svm.airdrop(&next.pubkey(), 1_000_000_000).unwrap();
    let mut d = D_SET_ADMIN.to_vec();
    d.extend_from_slice(next.pubkey().as_ref());
    admin_ix(&mut e, &adm, d).unwrap();
    // Two-step: nothing changes until the successor accepts.
    admin_ix(&mut e, &adm, paused(false)).unwrap();
    expect_code(admin_ix(&mut e, &next, paused(true)), 2001);
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_code(admin_ix(&mut e, &stranger, D_ACCEPT_ADMIN.to_vec()), 6031);
    admin_ix(&mut e, &next, D_ACCEPT_ADMIN.to_vec()).unwrap();
    expect_code(admin_ix(&mut e, &adm, paused(true)), 2001);
    admin_ix(&mut e, &next, paused(true)).unwrap();
}

// ---------------- mode A: operator caps ----------------

const D_PROPOSE: [u8; 8] = [63, 24, 101, 104, 86, 149, 67, 243];
const D_OBSERVE: [u8; 8] = [147, 178, 4, 21, 14, 213, 81, 159];
const D_ACTIVATE: [u8; 8] = [181, 205, 243, 174, 176, 192, 111, 71];

fn propose(e: &mut Env, signer: &Keypair, counter: Address, per: u64, total: u64) -> Result<(), String> {
    let mut data = D_PROPOSE.to_vec();
    data.extend(per.to_le_bytes());
    data.extend(total.to_le_bytes());
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(signer.pubkey(), true),
            AccountMeta::new_readonly(config_pda(), false),
            AccountMeta::new(counter, false),
        ],
        data,
    };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, ix, &p, &[signer])
}

#[test]
fn mode_a_cap_change_is_delayed_and_bounded() {
    let mut e = setup();
    let adm = admin();
    e.svm.airdrop(&adm.pubkey(), 1_000_000_000).unwrap();
    let c = e.counter;
    let stranger = Keypair::new();
    e.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
    expect_code(propose(&mut e, &stranger, c, 200 * UNIT, 4_000 * UNIT), 2001);
    expect_code(propose(&mut e, &adm, c, 201 * UNIT, 4_000 * UNIT), 6024); // > 2x
    propose(&mut e, &adm, c, 200 * UNIT, 4_000 * UNIT).unwrap();
    // A 150-unit deal is still over the old 100 cap until 48h pass.
    let mut a = default_args();
    a.price = 1_000 * UNIT;
    a.bond = 100 * UNIT;
    a.deposit = 50 * UNIT;
    a.deliver_by = T0 + 30 * DAY;
    expect_code(open(&mut e, 30, a).map(|_| ()), 6012);
    set_time(&mut e.svm, T0 + 2 * DAY);
    open(&mut e, 31, a).unwrap();
}

// ---------------- mode B: price record and automatic switch ----------------

const PREQ: Address = Address::from_str_const("aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX");
const USDC: Address = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const POOL: Address = Address::from_str_const("51F34MKDFBLr5GwKiiJMWV9HsHv63dkkP3ZMMxPN71xc");
const DAMM: Address = Address::from_str_const("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

fn raw_mint(svm: &mut LiteSVM, at: Address, authority: &Address) {
    let mut d = vec![0u8; 82];
    d[0..4].copy_from_slice(&1u32.to_le_bytes());
    d[4..36].copy_from_slice(authority.as_ref());
    d[44] = 6;
    d[45] = 1;
    svm.set_account(at, solana_account::Account { lamports: 10_000_000, data: d, owner: TOKEN_ID, executable: false, rent_epoch: 0 })
        .unwrap();
}

fn raw_token_account(svm: &mut LiteSVM, at: Address, mint: &Address, owner: &Address, amount: u64) {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1;
    svm.set_account(at, solana_account::Account { lamports: 10_000_000, data: d, owner: TOKEN_ID, executable: false, rent_epoch: 0 })
        .unwrap();
}

/// sqrt price as Q64.64 for a price of 1 PREQ unit = num/den quote units.
fn sqrt_q64(num: u128, den: u128) -> u128 {
    // integer sqrt of (num/den) * 2^128
    let target = (num << 120) / den * 256; // ~ num/den * 2^128 (num small)
    let mut x = 1u128 << 64;
    for _ in 0..200 {
        let nx = (x + target / x) / 2;
        if nx == x {
            break;
        }
        x = nx;
    }
    x
}

fn write_pool(svm: &mut LiteSVM, owner: Address, sqrt: u128, a_vault: &Address, b_vault: &Address) {
    let mut d = vec![0u8; 1112];
    d[0..8].copy_from_slice(&[241, 154, 109, 4, 17, 177, 109, 188]);
    d[168..200].copy_from_slice(PREQ.as_ref());
    d[200..232].copy_from_slice(USDC.as_ref());
    d[232..264].copy_from_slice(a_vault.as_ref());
    d[264..296].copy_from_slice(b_vault.as_ref());
    d[456..472].copy_from_slice(&sqrt.to_le_bytes());
    svm.set_account(POOL, solana_account::Account { lamports: 10_000_000, data: d, owner, executable: false, rent_epoch: 0 })
        .unwrap();
}

struct PreqEnv {
    e: Env,
    counter: Address,
    a_vault: Address,
    b_vault: Address,
}

fn setup_preq() -> PreqEnv {
    let mut e = setup();
    let payer = e.payer.pubkey();
    raw_mint(&mut e.svm, PREQ, &payer);
    raw_mint(&mut e.svm, USDC, &payer);
    let p = e.payer.insecure_clone();
    let sa = CreateAssociatedTokenAccount::new(&mut e.svm, &p, &PREQ).owner(&e.seller.pubkey()).send().unwrap();
    let ba = CreateAssociatedTokenAccount::new(&mut e.svm, &p, &PREQ).owner(&e.buyer.pubkey()).send().unwrap();
    MintTo::new(&mut e.svm, &p, &PREQ, &sa, 1_000_000 * UNIT).send().unwrap();
    MintTo::new(&mut e.svm, &p, &PREQ, &ba, 30_000_000 * UNIT).send().unwrap();
    e.mint = PREQ;
    e.seller_ata = sa;
    e.buyer_ata = ba;
    let (counter, _) = Address::find_program_address(&[b"counter", PREQ.as_ref()], &PROGRAM);
    e.counter = counter;
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new_readonly(PREQ, false),
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: D_INIT.to_vec(),
    };
    send(&mut e.svm, ix, &p, &[]).unwrap();
    let a_vault = Address::new_unique();
    let b_vault = Address::new_unique();
    raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 20_000 * UNIT);
    // 1 PREQ unit = 0.5 USDC unit.
    write_pool(&mut e.svm, DAMM, sqrt_q64(1, 2), &a_vault, &b_vault);
    PreqEnv { e, counter, a_vault, b_vault }
}

fn observe(e: &mut Env, counter: Address, vault: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(POOL, false),
            AccountMeta::new_readonly(vault, false),
        ],
        data: D_OBSERVE.to_vec(),
    };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, ix, &p, &[])
}

fn activate(e: &mut Env, counter: Address, vault: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(counter, false),
            AccountMeta::new_readonly(POOL, false),
            AccountMeta::new_readonly(vault, false),
        ],
        data: D_ACTIVATE.to_vec(),
    };
    let p = e.payer.insecure_clone();
    send(&mut e.svm, ix, &p, &[])
}

fn now_of(svm: &LiteSVM) -> i64 {
    let c: Clock = svm.get_sysvar();
    c.unix_timestamp
}

/// One fully paid deal (price == deposit, so no balance), settled at once.
/// Opens a deal that counts toward the switch (bond 40,000 PREQ, above the
/// 34,400 minimum) and confirms it; the caller settles it a day later.
fn quick_deal(e: &mut Env, nonce: u64) -> (Address, Address) {
    let now = now_of(&e.svm);
    let a = Args { price: 200_000 * UNIT, bond: 40_000 * UNIT, deposit: 200_000 * UNIT, deliver_by: now + 2 * DAY, late: 0, pay: DAY };
    let (deal, vault) = open(e, nonce, a).unwrap_or_else(|x| panic!("nonce {nonce} sb {} bb {}: {x}", balance(e, &e.seller_ata), balance(e, &e.buyer_ata)));
    let b = e.buyer.insecure_clone();
    simple(e, D_CONFIRM, &b, deal).unwrap();
    (deal, vault)
}

#[test]
fn mode_b_switches_automatically_when_data_is_enough() {
    let PreqEnv { mut e, counter, a_vault, b_vault } = setup_preq();
    // A fake pool owned by another program is refused.
    write_pool(&mut e.svm, Address::new_unique(), sqrt_q64(1, 2), &a_vault, &b_vault);
    expect_code(observe(&mut e, counter, b_vault), 6028);
    write_pool(&mut e.svm, DAMM, sqrt_q64(1, 2), &a_vault, &b_vault);
    // The wrong vault is refused.
    raw_token_account(&mut e.svm, a_vault, &PREQ, &POOL, 1);
    expect_code(observe(&mut e, counter, a_vault), 6028);
    // Start with thin liquidity (5,000 < 10,000 USDC).
    raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 5_000 * UNIT);
    observe(&mut e, counter, b_vault).unwrap();
    expect_code(activate(&mut e, counter, b_vault), 6029);

    // 100 counted deals and 90 days of observations every 5 hours.
    // Liquidity becomes enough only after day 50.
    let start = now_of(&e.svm);
    let mut nonce = 100;
    let mut pending: Vec<(u64, (Address, Address))> = Vec::new();
    for i in 0..440u64 {
        let t = now_of(&e.svm) + 5 * 3600;
        set_time(&mut e.svm, t);
        if t >= start + 50 * DAY {
            raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 20_000 * UNIT);
        }
        observe(&mut e, counter, b_vault).unwrap();
        if i < 100 {
            pending.push((i, quick_deal(&mut e, nonce)));
            nonce += 1;
        }
        // Settle each deal 25 hours after it opened.
        while let Some(&(j, (deal, vault))) = pending.first() {
            if i < j + 5 {
                break;
            }
            settle(&mut e, deal, vault).unwrap();
            pending.remove(0);
        }
    }
    // A deal settled in under a day does not count.
    let (deal, vault) = quick_deal(&mut e, 9_500);
    settle(&mut e, deal, vault).unwrap();
    let settled_before = {
        let acc = e.svm.get_account(&counter).unwrap();
        u64::from_le_bytes(acc.data[49..57].try_into().unwrap())
    };
    assert_eq!(settled_before, 100);
    // A rich USDC account that is not the pool's vault is refused.
    let fake = Address::new_unique();
    raw_token_account(&mut e.svm, fake, &USDC, &POOL, 1_000_000 * UNIT);
    expect_code(activate(&mut e, counter, fake), 6028);
    // A one-moment drain observed right before activation resets the run.
    raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 1 * UNIT);
    observe(&mut e, counter, b_vault).unwrap();
    raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 20_000 * UNIT);
    observe(&mut e, counter, b_vault).unwrap();
    expect_code(activate(&mut e, counter, b_vault), 6029);
    // 30 more days of healthy observations, then the switch works.
    for _ in 0..150u64 {
        let t = now_of(&e.svm) + 5 * 3600;
        set_time(&mut e.svm, t);
        observe(&mut e, counter, b_vault).unwrap();
    }
    activate(&mut e, counter, b_vault).unwrap();
    // Mode B is one-way: the admin can no longer change PREQ caps.
    let adm = admin();
    e.svm.airdrop(&adm.pubkey(), 1_000_000_000).unwrap();
    expect_code(propose(&mut e, &adm, counter, 2_000 * UNIT, 40_000 * UNIT), 6027);
    expect_code(activate(&mut e, counter, b_vault), 6027);

    // Caps now follow the price: 100 USDC per deal at 0.5 USDC/PREQ = 200 PREQ.
    let now = now_of(&e.svm);
    let mut a = Args { price: 2_000 * UNIT, bond: 101 * UNIT, deposit: 100 * UNIT, deliver_by: now + 10 * DAY, late: 0, pay: DAY };
    expect_code(open(&mut e, 9_000, a).map(|_| ()), 6012);
    a.bond = 100 * UNIT;
    open(&mut e, 9_001, a).unwrap();
    // A stale record falls back to the frozen mode A caps (688,000 PREQ
    // per deal), so a 101 PREQ bond is accepted while stale...
    set_time(&mut e.svm, now + 7 * 3600);
    let mut a2 = a;
    // 201 PREQ locked: above the 200 PREQ mode B cap.
    a2.bond = 101 * UNIT;
    a2.deposit = 100 * UNIT;
    a2.deliver_by = now + 10 * DAY;
    open(&mut e, 9_002, a2).unwrap();
    // ...and refused again once the record is fresh.
    observe(&mut e, counter, b_vault).unwrap();
    expect_code(open(&mut e, 9_003, a2).map(|_| ()), 6012);
    a2.bond = UNIT;
    a2.deposit = 0;
    open(&mut e, 9_004, a2).unwrap();
    // Thin liquidity after the switch also falls back.
    raw_token_account(&mut e.svm, b_vault, &USDC, &POOL, 1 * UNIT);
    observe(&mut e, counter, b_vault).unwrap();
    a2.bond = 101 * UNIT;
    a2.deposit = 100 * UNIT;
    open(&mut e, 9_005, a2).unwrap();
}

/// One side's frozen token account no longer blocks the other side.
#[test]
fn frozen_account_blocks_only_its_own_side() {
    let mut e = setup();
    let a = default_args();
    let (deal, vault) = open(&mut e, 30, a).unwrap();
    set_time(&mut e.svm, a.deliver_by + GRACE + a.late + 1);
    // Freeze the buyer's token account (state byte 108 = Frozen).
    let bd = e.buyer_ata;
    let mut acc = e.svm.get_account(&bd).unwrap();
    acc.data[108] = 2;
    e.svm.set_account(bd, acc.clone()).unwrap();
    // The usual one-transaction path fails as a whole...
    assert!(settle(&mut e, deal, vault).is_err());
    // ...but settle and the seller's claim work on their own.
    let ixs = [decide_ix(&e, deal, vault, false), claim_ix(&e, deal, vault, e.seller_ata, false)];
    let p = e.payer.insecure_clone();
    send_all(&mut e.svm, &ixs, &p, &[]).unwrap();
    // Seller default: the seller had nothing left to claim, buyer is owed 60.
    assert_eq!(balance(&e, &e.seller_ata), 970 * UNIT);
    assert!(e.svm.get_account(&deal).map(|x| x.lamports > 0).unwrap_or(false), "deal must stay until the buyer claims");
    // Settling twice is refused.
    let again = decide_ix(&e, deal, vault, false);
    expect_code(send(&mut e.svm, again, &p, &[]), 6014);
    // The buyer can claim into another account it owns.
    let mint = e.mint;
    let other = Keypair::new();
    let owner = e.buyer.pubkey();
    let fresh = litesvm_token::CreateAccount::new(&mut e.svm, &p, &mint).owner(&owner).account_kp(other).send().unwrap();
    let claim = claim_ix(&e, deal, vault, fresh, true);
    send(&mut e.svm, claim, &p, &[]).unwrap();
    assert_eq!(balance(&e, &fresh), 60 * UNIT);
    // Anyone then closes the empty deal; the rent goes to the seller.
    let close = claim_ix(&e, deal, vault, e.seller_ata, false);
    send(&mut e.svm, close, &p, &[]).unwrap();
    assert_closed(&e, deal, vault);
}
