//! Runs the MAINNET build against real mainnet account data (USDC mint, PREQ
//! Token-2022 mint with metadata, the Meteora DAMM v2 PREQ pool and its
//! vaults), snapshotted into fixtures/mainnet-accounts.txt.
//! Run with BOND_SO_MAINNET pointing at the mainnet build.

use litesvm::LiteSVM;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROGRAM: Address = Address::from_str_const("9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const CLASSIC: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const T2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const USDC: Address = Address::from_str_const("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const PREQ: Address = Address::from_str_const("aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX");
const WSOL: Address = Address::from_str_const("So11111111111111111111111111111111111111112");
const POOL: Address = Address::from_str_const("51F34MKDFBLr5GwKiiJMWV9HsHv63dkkP3ZMMxPN71xc");
const VAULT_A: Address = Address::from_str_const("95oWJxdDrzfGbuPRTSEyyhzNmpeUcmzkvbLn3SxJxthG");
const VAULT_B: Address = Address::from_str_const("9xNpx65Ayw39NkhdVAn2fGn2S5bDTPeb1mdpQ8cC2GWX");
const DAY: i64 = 86_400;
const GRACE: i64 = DAY;
const D_INIT: [u8; 8] = [247, 168, 146, 45, 125, 26, 142, 80];
const D_INIT_CONFIG: [u8; 8] = [23, 235, 115, 232, 168, 96, 1, 231];
const D_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const D_CONFIRM: [u8; 8] = [203, 36, 80, 115, 249, 12, 141, 170];
const D_PAY: [u8; 8] = [121, 220, 140, 105, 242, 163, 148, 24];
const D_SETTLE: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];
const D_CLAIM_SELLER: [u8; 8] = [238, 218, 144, 171, 49, 203, 29, 50];
const D_CLAIM_BUYER: [u8; 8] = [13, 61, 90, 109, 208, 223, 195, 211];
const D_OBSERVE: [u8; 8] = [147, 178, 4, 21, 14, 213, 81, 159];
const D_ACTIVATE: [u8; 8] = [181, 205, 243, 174, 176, 192, 111, 71];

fn hex(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
}

fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> Result<(), String> {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
    svm.expire_blockhash();
    r
}

fn code(r: Result<(), String>, c: u32) {
    let e = r.expect_err("expected failure");
    assert!(e.contains(&format!("Custom({c})")), "expected {c}, got {e}");
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
    svm.expire_blockhash();
}

/// A token account for `owner`, laid out like the real programs expect.
fn token_account(svm: &mut LiteSVM, tp: Address, mint: &Address, owner: &Address, amount: u64) -> Address {
    let at = Address::new_unique();
    let mut d = vec![0u8; if tp == T2022 { 166 } else { 165 }];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // initialized
    if tp == T2022 {
        d[165] = 2; // account type: Account
    }
    svm.set_account(at, solana_account::Account { lamports: 10_000_000, data: d, owner: tp, executable: false, rent_epoch: 0 }).unwrap();
    at
}

fn bal(svm: &LiteSVM, a: &Address) -> u64 {
    svm.get_account(a).map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap())).unwrap_or(0)
}

struct W {
    svm: LiteSVM,
    payer: Keypair,
    seller: Keypair,
    buyer: Keypair,
    config: Address,
}

fn counter_of(mint: &Address) -> Address {
    Address::find_program_address(&[b"counter", mint.as_ref()], &PROGRAM).0
}

fn world() -> W {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, std::env::var("BOND_SO_MAINNET").expect("BOND_SO_MAINNET")).unwrap();
    let text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/fixtures/mainnet-accounts.txt")).unwrap();
    for line in text.lines().filter(|l| !l.starts_with('#') && !l.is_empty()) {
        let p: Vec<&str> = line.split(' ').collect();
        let acc = solana_account::Account {
            lamports: p[2].parse().unwrap(),
            data: hex(p[3]),
            owner: Address::from_str_const(p[1]),
            executable: false,
            rent_epoch: 0,
        };
        svm.set_account(Address::from_str_const(p[0]), acc).unwrap();
    }
    set_time(&mut svm, 1_796_000_000);
    let payer = Keypair::new();
    let seller = Keypair::new();
    let buyer = Keypair::new();
    for k in [&payer, &seller, &buyer] {
        svm.airdrop(&k.pubkey(), 100_000_000_000).unwrap();
    }
    let config = Address::find_program_address(&[b"config"], &PROGRAM).0;
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config, false), AccountMeta::new_readonly(SYSTEM, false)],
        data: D_INIT_CONFIG.to_vec(),
    };
    let p = payer.insecure_clone();
    send(&mut svm, &[ix], &p, &[]).unwrap();
    W { svm, payer, seller, buyer, config }
}

fn init_counter(w: &mut W, mint: Address) -> Result<(), String> {
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(w.payer.pubkey(), true),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(counter_of(&mint), false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data: D_INIT.to_vec(),
    };
    let p = w.payer.insecure_clone();
    send(&mut w.svm, &[ix], &p, &[])
}

struct Deal {
    deal: Address,
    vault: Address,
    st: Address,
    bt: Address,
    mint: Address,
    tp: Address,
}

#[allow(clippy::too_many_arguments)]
fn open(w: &mut W, mint: Address, tp: Address, st: Address, bt: Address, nonce: u64, price: u64, bond: u64, dep: u64, deliver_by: i64) -> Result<Deal, String> {
    let (s, b) = (w.seller.pubkey(), w.buyer.pubkey());
    let deal = Address::find_program_address(&[b"deal", s.as_ref(), b.as_ref(), &nonce.to_le_bytes()], &PROGRAM).0;
    let vault = Address::find_program_address(&[b"vault", deal.as_ref()], &PROGRAM).0;
    let mut data = D_OPEN.to_vec();
    data.extend(nonce.to_le_bytes());
    for v in [price, bond, dep] {
        data.extend(v.to_le_bytes());
    }
    for v in [deliver_by, 0i64, DAY] {
        data.extend(v.to_le_bytes());
    }
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(s, true),
            AccountMeta::new_readonly(b, true),
            AccountMeta::new_readonly(mint, false),
            AccountMeta::new(st, false),
            AccountMeta::new(bt, false),
            AccountMeta::new(deal, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(counter_of(&mint), false),
            AccountMeta::new_readonly(w.config, false),
            AccountMeta::new_readonly(tp, false),
            AccountMeta::new_readonly(SYSTEM, false),
        ],
        data,
    };
    let (sk, bk) = (w.seller.insecure_clone(), w.buyer.insecure_clone());
    send(&mut w.svm, &[ix], &sk, &[&bk])?;
    Ok(Deal { deal, vault, st, bt, mint, tp })
}

fn confirm_and_pay(w: &mut W, d: &Deal) {
    let b = w.buyer.insecure_clone();
    let c = Instruction {
        program_id: PROGRAM,
        accounts: vec![AccountMeta::new_readonly(b.pubkey(), true), AccountMeta::new(d.deal, false)],
        data: D_CONFIRM.to_vec(),
    };
    let p = Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new_readonly(b.pubkey(), true),
            AccountMeta::new(d.deal, false),
            AccountMeta::new_readonly(d.mint, false),
            AccountMeta::new(d.bt, false),
            AccountMeta::new(d.st, false),
            AccountMeta::new_readonly(d.tp, false),
        ],
        data: D_PAY.to_vec(),
    };
    let payer = w.payer.insecure_clone();
    send(&mut w.svm, &[c, p], &payer, &[&b]).unwrap();
}

fn settle(w: &mut W, d: &Deal) -> Result<(), String> {
    let claim = |to: Address, disc: [u8; 8]| Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(w.seller.pubkey(), false),
            AccountMeta::new(d.deal, false),
            AccountMeta::new_readonly(d.mint, false),
            AccountMeta::new(d.vault, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(d.tp, false),
        ],
        data: disc.to_vec(),
    };
    let ixs = [
        Instruction {
            program_id: PROGRAM,
            accounts: vec![AccountMeta::new(d.deal, false), AccountMeta::new_readonly(d.vault, false), AccountMeta::new(counter_of(&d.mint), false)],
            data: D_SETTLE.to_vec(),
        },
        claim(d.bt, D_CLAIM_BUYER),
        claim(d.st, D_CLAIM_SELLER),
    ];
    let p = w.payer.insecure_clone();
    send(&mut w.svm, &ixs, &p, &[])
}

fn pool_ix(disc: [u8; 8], vault: Address) -> Instruction {
    Instruction {
        program_id: PROGRAM,
        accounts: vec![AccountMeta::new(counter_of(&PREQ), false), AccountMeta::new_readonly(POOL, false), AccountMeta::new_readonly(vault, false)],
        data: disc.to_vec(),
    }
}

#[test]
fn real_mints_and_pool_work_with_the_mainnet_build() {
    if std::env::var("BOND_SO_MAINNET").is_err() {
        eprintln!("skipped: set BOND_SO_MAINNET to a mainnet build to run this test");
        return;
    }
    let mut w = world();
    // The mainnet build's admin is the Squads vault (index 0) of multisig Af32e2sJ...
    let cfg = w.svm.get_account(&w.config).unwrap();
    assert_eq!(&cfg.data[8..40], Address::from_str_const("36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc").as_ref());
    // All three real mints pass screening: USDC (issuer freeze authority,
    // allowed), PREQ (Token-2022 with metadata extensions), wSOL.
    for m in [USDC, PREQ, WSOL] {
        init_counter(&mut w, m).unwrap();
    }
    let now = 1_796_000_000;
    let (s, b) = (w.seller.pubkey(), w.buyer.pubkey());
    const U: u64 = 1_000_000; // 6 decimals for USDC and PREQ

    // USDC: delivered and paid. Locked 90 USDC passes; 101 USDC exceeds the 100 USDC per-deal cap.
    let st = token_account(&mut w.svm, CLASSIC, &USDC, &s, 1_000 * U);
    let bt = token_account(&mut w.svm, CLASSIC, &USDC, &b, 1_000 * U);
    code(open(&mut w, USDC, CLASSIC, st, bt, 1, 300 * U, 30 * U, 71 * U, now + 10 * DAY).map(|_| ()), 6012);
    let d = open(&mut w, USDC, CLASSIC, st, bt, 2, 300 * U, 30 * U, 60 * U, now + 10 * DAY).unwrap();
    confirm_and_pay(&mut w, &d);
    settle(&mut w, &d).unwrap();
    assert_eq!(bal(&w.svm, &st), 1_300 * U);
    assert_eq!(bal(&w.svm, &bt), 700 * U);
    assert!(w.svm.get_account(&d.deal).map(|a| a.lamports == 0).unwrap_or(true));

    // PREQ (Token-2022): seller never delivers; buyer gets bond + deposit.
    let st = token_account(&mut w.svm, T2022, &PREQ, &s, 100_000 * U);
    let bt = token_account(&mut w.svm, T2022, &PREQ, &b, 100_000 * U);
    let d = open(&mut w, PREQ, T2022, st, bt, 3, 50_000 * U, 1_000 * U, 5_000 * U, now + 2 * DAY).unwrap();
    set_time(&mut w.svm, now + 2 * DAY + GRACE + 1);
    settle(&mut w, &d).unwrap();
    assert_eq!(bal(&w.svm, &st), 99_000 * U);
    assert_eq!(bal(&w.svm, &bt), 101_000 * U);

    // Real pool: the wrong vault is refused; the right one records a price.
    // Quote liquidity is 1 lamport, far below 50 SOL, so mode B stays off.
    let p = w.payer.insecure_clone();
    code(send(&mut w.svm, &[pool_ix(D_OBSERVE, VAULT_A)], &p, &[]), 6028);
    send(&mut w.svm, &[pool_ix(D_OBSERVE, VAULT_B)], &p, &[]).unwrap();
    code(send(&mut w.svm, &[pool_ix(D_ACTIVATE, VAULT_B)], &p, &[]), 6029);
}
