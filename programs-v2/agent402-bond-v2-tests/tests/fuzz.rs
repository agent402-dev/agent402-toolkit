//! Differential fuzzing: random actions and times on several deals; the program must agree with the pure model
//! (agent402-bond-v2-core) on every success/failure and every payout, and tokens are conserved.
//! Build first: cargo-build-sbf --features test-mints, then BOND_V2_SO=<path to agent402_bond_v2.so>.

use agent402_bond_v2_core::{self as model, DAY, HOUR};
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

/// SPL Token transfer (instruction 3).
fn spl_transfer(from: &Address, to: &Address, owner: &Address, amount: u64) -> Instruction {
    let mut data = vec![3u8];
    data.extend(amount.to_le_bytes());
    Instruction { program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*owner, true)], data }
}


struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn u(&mut self, n: u64) -> u64 { self.next() % (n + 1) }
    fn i(&mut self, lo: i64, hi: i64) -> i64 { lo + (self.next() % ((hi - lo + 1) as u64)) as i64 }
}

fn model_terms(a: &Args) -> model::Terms {
    model::Terms { price: a.price, seller_bond: a.bond, buyer_deposit: a.deposit, deliver_by: a.deliver_by, grace: a.grace, review_window: a.review,
        seller_share_bps: a.bps, has_arbiter: a.arbiter.is_some(), arbiter_window: a.arb_window }
}

#[test]
fn differential_fuzz() {
    let rounds: u64 = std::env::var("FUZZ_ROUNDS").ok().and_then(|v| v.parse().ok()).unwrap_or(40);
    let mut stats = [0u64; 10];
    for seed in 1..=rounds {
        let mut r = Rng(0x2545_F491_4F6C_DD1D ^ seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let mut e = setup();
        let arb_key = e.arbiter.pubkey();
        let all = [e.seller_ata, e.buyer_ata];
        let total0: u64 = all.iter().map(|a| bal(&e, a)).sum();
        let mut now = T0;
        struct Live { deal: Address, vault: Address, m: model::Deal, settled: Option<model::Decision>, paid: [u64; 2] }
        let mut deals: Vec<Live> = vec![];
        for step in 0..40u64 {
            let op = r.u(9);
            if op == 0 || deals.is_empty() {
                let price = 1 + r.u(40 * U);
                let a = Args {
                    price: price.max(5),
                    bond: 1 + r.u(price.max(5) / 5 - 1),
                    deposit: r.u(price.max(5).min(80 * U)),
                    deliver_by: now + r.i(1, 3 * DAY),
                    grace: r.i(HOUR, DAY),
                    review: r.i(HOUR, 2 * DAY),
                    bps: r.u(10_000) as u16,
                    arbiter: if r.u(2) == 0 { Some(arb_key) } else { None },
                    arb_window: 0,
                };
                let a = Args { arb_window: if a.arbiter.is_some() { r.i(HOUR, DAY) } else { 0 }, ..a };
                let nonce = 1000 + seed * 100 + step;
                let locked_now: u64 = deals.iter().filter(|d| d.settled.is_none()).map(|d| d.m.terms.locked()).sum();
                let expect = model::check_open(&model_terms(&a), now, false, false, false, 100 * U, 2_000 * U, locked_now).is_ok();
                let got = open(&mut e, nonce, a);
                assert_eq!(got.is_ok(), expect, "seed {seed} step {step} open {:?}", got.err());
                if got.is_ok() { stats[0] += 1; }
                if let Ok((deal, vault)) = got {
                    deals.push(Live { deal, vault, m: model::Deal::open(model_terms(&a), now), settled: None, paid: [0, 0] });
                }
                continue;
            }
            if op == 1 {
                now += r.i(1, 2 * DAY);
                set_time(&mut e.svm, now);
                continue;
            }
            let mut k = r.u(deals.len() as u64 - 1) as usize;
            if op == 8 {
                // prefer a live, marked deal that names an arbiter, so decide is exercised often
                if let Some(j) = deals.iter().position(|d| d.settled.is_none() && d.m.terms.has_arbiter && d.m.state == model::State::Marked) { k = j; }
            }
            let (deal, vault) = (deals[k].deal, deals[k].vault);
            let mut m = deals[k].m;
            let p = e.payer.insecure_clone();
            let (s, b, arb) = (e.seller.insecure_clone(), e.buyer.insecure_clone(), e.arbiter.insecure_clone());
            let (expect, got) = match op {
                2 => (m.mark(now).map(|_| None), mark(&mut e, deal)),
                3 => (m.accept(now).map(Some), accept(&mut e, deal, vault)),
                4 => (m.settle(now).map(Some), settle(&mut e, deal, vault)),
                5 => {
                    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey(), e.buyer.pubkey()]), data: D_CANCEL.to_vec() };
                    (m.cancel().map(Some), send(&mut e.svm, &[ix], &p, &[&s, &b]))
                }
                6 => {
                    let x = r.u(m.terms.locked() + 2);
                    let mut data = D_SETTLE_AGREED.to_vec();
                    data.extend(x.to_le_bytes());
                    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey(), e.buyer.pubkey()]), data };
                    (m.settle_agreed(x).map(Some), send(&mut e.svm, &[ix], &p, &[&s, &b]))
                }
                7 => {
                    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[e.seller.pubkey()]), data: D_SELLER_RELEASE.to_vec() };
                    (m.seller_release(now).map(Some), send(&mut e.svm, &[ix], &p, &[&s]))
                }
                8 => {
                    // Usually move the clock into the arbiter window (forward only) so decide is reached, then
                    // pick the boundary, an inside time, or a share past the limit; sometimes sign with a party.
                    if let (model::State::Marked, Some(a_t), Some(r_t)) = (m.state, m.a(), m.r()) {
                        if r.u(3) != 0 && r_t > a_t && now < r_t {
                            let lo = now.max(a_t + 1);
                            let t = match r.u(3) { 0 => lo, 1 => r_t, _ => r.i(lo, r_t) };
                            if t > now { now = t; set_time(&mut e.svm, now); }
                        }
                    }
                    let x = if r.u(9) == 0 { m.terms.locked() + 1 } else { r.u(m.terms.locked()) };
                    let mut data = D_DECIDE.to_vec();
                    data.extend(x.to_le_bytes());
                    let wrong = r.u(7) == 0;
                    let who = if wrong { s.insecure_clone() } else { arb.insecure_clone() };
                    let ix = Instruction { program_id: PROGRAM, accounts: decide_accounts(&e, deal, vault, &[who.pubkey()]), data };
                    (m.decide(now, m.terms.has_arbiter && !wrong, x).map(Some), send(&mut e.svm, &[ix], &p, &[&who]))
                }
                _ => {
                    // claims (anyone); only meaningful once settled
                    if deals[k].settled.is_some() && e.svm.get_account(&deal).map_or(false, |a| a.lamports > 0) {
                        let (s0, b0) = (bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata));
                        let _ = claim_both(&mut e, deal, vault, r.u(1) == 0);
                        deals[k].paid[0] += bal(&e, &e.seller_ata) - s0;
                        deals[k].paid[1] += bal(&e, &e.buyer_ata) - b0;
                    }
                    continue;
                }
            };
            assert_eq!(got.is_ok(), expect.is_ok(), "seed {seed} step {step} op {op}: program {:?} model {:?}", got.err(), expect.err());
            if got.is_ok() {
                stats[op as usize] += 1;
                deals[k].m = m;
                if let Ok(Some(dec)) = expect {
                    deals[k].settled = Some(dec);
                    assert_eq!(bal(&e, &vault), m.terms.locked(), "vault holds exactly the locked amount at settlement");
                }
            }
            // the counter equals the sum of unsettled deals
            let live: u64 = deals.iter().filter(|d| d.settled.is_none()).map(|d| d.m.terms.locked()).sum();
            assert_eq!(total_locked(&e), live, "seed {seed} step {step}");
        }
        // settle everything that can be, claim all, and check conservation and payouts
        now += 60 * DAY;
        set_time(&mut e.svm, now);
        for d in deals.iter_mut() {
            if d.settled.is_none() {
                let mut m = d.m;
                d.settled = Some(m.settle(now).expect("settleable after the longest deadline"));
                settle(&mut e, d.deal, d.vault).unwrap();
            }
            let dec = d.settled.unwrap();
            let (s0, b0) = (bal(&e, &e.seller_ata), bal(&e, &e.buyer_ata));
            if e.svm.get_account(&d.deal).map_or(false, |a| a.lamports > 0) {
                claim_both(&mut e, d.deal, d.vault, true).unwrap_or_else(|_| { let _ = claim_both(&mut e, d.deal, d.vault, false); });
                d.paid[0] += bal(&e, &e.seller_ata) - s0;
                d.paid[1] += bal(&e, &e.buyer_ata) - b0;
            }
            // each deal's claims pay exactly the decided split of what it locked (no shortfall on these paths)
            assert_eq!(d.paid, [dec.to_seller, dec.to_buyer], "seed {seed}: per-deal payout {:?} vs decision {:?}", d.paid, dec);
            assert!(e.svm.get_account(&d.deal).map_or(true, |a| a.lamports == 0), "seed {seed}: deal closed after claims");
        }
        let total: u64 = all.iter().map(|a| bal(&e, a)).sum();
        assert_eq!(total, total0, "seed {seed}: tokens conserved between the two parties");
        assert_eq!(total_locked(&e), 0);
    }
    println!("FUZZ rounds {rounds}: successful open {} mark {} accept {} settle {} cancel {} agreed {} release {} decide {}", stats[0], stats[2], stats[3], stats[4], stats[5], stats[6], stats[7], stats[8]);
}
