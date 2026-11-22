//! Differential, stateful fuzzing: random actors, random times and random
//! (often invalid) instructions run against the real program in LiteSVM and
//! against the pure model in agent402-bond-core. After every step the two must
//! agree on success/failure and payouts, and global invariants must hold.

use agent402_bond_core as model;
use litesvm::LiteSVM;
use litesvm_token::CreateAssociatedTokenAccount;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;

const PROGRAM: Address = Address::from_str_const("Howw2bfGrx5QGWD79oUoaMhWEgEgeJgFgunQCZ7NbJ6f");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const DAY: i64 = 86_400;
const T0: i64 = 1_800_000_000;
const D_INIT: [u8; 8] = [247, 168, 146, 45, 125, 26, 142, 80];
const D_INIT_CONFIG: [u8; 8] = [23, 235, 115, 232, 168, 96, 1, 231];
const D_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const D_MARK: [u8; 8] = [240, 118, 188, 142, 64, 85, 107, 18];
const D_CONFIRM: [u8; 8] = [203, 36, 80, 115, 249, 12, 141, 170];
const D_PAY: [u8; 8] = [121, 220, 140, 105, 242, 163, 148, 24];
const D_EXTEND: [u8; 8] = [228, 127, 0, 1, 227, 154, 54, 168];
const D_CANCEL: [u8; 8] = [232, 219, 223, 41, 219, 236, 220, 190];
const D_SETTLE: [u8; 8] = [175, 42, 185, 87, 144, 131, 102, 212];
/// Classic SPL Token (USDC, wSOL) and Token-2022 (PREQ).
const CLASSIC: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const T2022: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const PER_DEAL: u64 = 100_000_000;
const TOTAL: u64 = 2_000_000_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
}

struct Party {
    kp: Keypair,
    ata: Address,
}

struct Live {
    seller: usize,
    buyer: usize,
    deal: Address,
    vault: Address,
    m: model::Deal,
    donated: u64,
}

struct W {
    svm: LiteSVM,
    payer: Keypair,
    parties: Vec<Party>,
    outsider: Party,
    mint: Address,
    counter: Address,
    config: Address,
    minted: u64,
    tp: Address,
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> bool {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let ok = svm.send_transaction(tx).is_ok();
    svm.expire_blockhash();
    ok
}

const D_CLAIM_SELLER: [u8; 8] = [238, 218, 144, 171, 49, 203, 29, 50];
const D_CLAIM_BUYER: [u8; 8] = [13, 61, 90, 109, 208, 223, 195, 211];

fn send_all(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, signers: &[&Keypair]) -> bool {
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend_from_slice(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, svm.latest_blockhash());
    let ok = svm.send_transaction(tx).is_ok();
    svm.expire_blockhash();
    ok
}

/// settle/cancel followed by both claims, in one transaction.
#[allow(clippy::too_many_arguments)]
fn close_ixs(w: &W, s: usize, b: usize, deal: Address, vault: Address, sd: Address, bd: Address, cancel: bool) -> Vec<Instruction> {
    let (sk, bk) = (w.parties[s].kp.pubkey(), w.parties[b].kp.pubkey());
    let decide = if cancel {
        vec![
            AccountMeta::new_readonly(sk, true),
            AccountMeta::new_readonly(bk, true),
            AccountMeta::new(deal, false),
            AccountMeta::new_readonly(vault, false),
            AccountMeta::new(w.counter, false),
        ]
    } else {
        vec![AccountMeta::new(deal, false), AccountMeta::new_readonly(vault, false), AccountMeta::new(w.counter, false)]
    };
    let claim = |to: Address, disc: [u8; 8]| Instruction {
        program_id: PROGRAM,
        accounts: vec![
            AccountMeta::new(sk, false),
            AccountMeta::new(deal, false),
            AccountMeta::new_readonly(w.mint, false),
            AccountMeta::new(vault, false),
            AccountMeta::new(to, false),
            AccountMeta::new_readonly(w.tp, false),
        ],
        data: disc.to_vec(),
    };
    vec![
        Instruction { program_id: PROGRAM, accounts: decide, data: if cancel { D_CANCEL.to_vec() } else { D_SETTLE.to_vec() } },
        claim(bd, D_CLAIM_BUYER),
        claim(sd, D_CLAIM_SELLER),
    ]
}

fn now(svm: &LiteSVM) -> i64 {
    let c: Clock = svm.get_sysvar();
    c.unix_timestamp
}

fn set_time(svm: &mut LiteSVM, t: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = t;
    svm.set_sysvar(&c);
    svm.expire_blockhash();
}

fn bal(svm: &LiteSVM, a: &Address) -> u64 {
    svm.get_account(a).filter(|x| x.data.len() >= 72).map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap())).unwrap_or(0)
}

/// Creates a mint like the real one: classic for USDC/wSOL, or Token-2022 with
/// only the metadata pointer + token metadata extensions, as PREQ has.
fn make_mint(svm: &mut LiteSVM, payer: &Keypair, tp: Address) -> Address {
    use spl_token_2022_interface::{extension::ExtensionType, instruction as ti, state::Mint};
    let mint = Keypair::new();
    let m = mint.pubkey();
    let mut ixs = Vec::new();
    if tp == T2022 {
        let space = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::MetadataPointer]).unwrap();
        ixs.push(solana_system_interface::instruction::create_account(&payer.pubkey(), &m, 100_000_000, space as u64, &tp));
        ixs.push(spl_token_2022_interface::extension::metadata_pointer::instruction::initialize(&tp, &m, None, Some(m)).unwrap());
        ixs.push(ti::initialize_mint2(&tp, &m, &payer.pubkey(), None, 6).unwrap());
        ixs.push(spl_token_metadata_interface::instruction::initialize(&tp, &m, &payer.pubkey(), &m, &payer.pubkey(), "Test".into(), "TST".into(), "https://example.com/t.json".into()));
    } else {
        ixs.push(solana_system_interface::instruction::create_account(&payer.pubkey(), &m, 10_000_000, 82, &tp));
        ixs.push(ti::initialize_mint2(&tp, &m, &payer.pubkey(), None, 6).unwrap());
    }
    let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &[payer, &mint], svm.latest_blockhash());
    svm.send_transaction(tx).expect("mint");
    if tp == T2022 {
        assert!(svm.get_account(&m).unwrap().data.len() > 234, "metadata extension missing");
    }
    m
}

fn closed(svm: &LiteSVM, a: &Address) -> bool {
    svm.get_account(a).map(|x| x.lamports == 0).unwrap_or(true)
}

fn mint_to(svm: &mut LiteSVM, payer: &Keypair, tp: Address, mint: &Address, to: &Address, amt: u64) {
    let ix = spl_token_2022_interface::instruction::mint_to(&tp, mint, to, &payer.pubkey(), &[], amt).unwrap();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[payer], svm.latest_blockhash());
    svm.send_transaction(tx).expect("mint_to");
    svm.expire_blockhash();
}

fn world(tp: Address) -> W {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, std::env::var("BOND_SO").expect("BOND_SO")).unwrap();
    set_time(&mut svm, T0);
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let mint = make_mint(&mut svm, &payer, tp);
    let make = |svm: &mut LiteSVM| {
        let kp = Keypair::new();
        svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();
        let ata = CreateAssociatedTokenAccount::new(svm, &payer, &mint).owner(&kp.pubkey()).token_program_id(&tp).send().unwrap();
        mint_to(svm, &payer, tp, &mint, &ata, 100_000_000_000);
        Party { kp, ata }
    };
    let parties: Vec<Party> = (0..3).map(|_| make(&mut svm)).collect();
    let outsider = make(&mut svm);
    let (counter, _) = Address::find_program_address(&[b"counter", mint.as_ref()], &PROGRAM);
    let (config, _) = Address::find_program_address(&[b"config"], &PROGRAM);
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
    assert!(send(&mut svm, ix, &p, &[]));
    let ix = Instruction {
        program_id: PROGRAM,
        accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config, false), AccountMeta::new_readonly(SYSTEM, false)],
        data: D_INIT_CONFIG.to_vec(),
    };
    assert!(send(&mut svm, ix, &p, &[]));
    W { svm, payer, parties, outsider, mint, counter, config, minted: 4 * 100_000_000_000, tp }
}

fn counter_total(w: &W) -> u64 {
    let acc = w.svm.get_account(&w.counter).unwrap();
    u64::from_le_bytes(acc.data[40..48].try_into().unwrap())
}

fn run(seed: u64, steps: usize, tp: Address) -> (usize, usize) {
    let mut rng = Rng(seed);
    let mut w = world(tp);
    let mut live: Vec<Live> = Vec::new();
    let mut nonce = 0u64;
    let mut settled = 0usize;
    let mut accepted = 0usize;
    for step in 0..steps {
        // Advance time: usually small steps, sometimes days.
        let t = now(&w.svm) + match rng.below(4) { 0 => 0, 1 => rng.range(1, 3_600), 2 => rng.range(3_600, DAY), _ => rng.range(DAY, 9 * DAY) };
        set_time(&mut w.svm, t);
        let op = rng.below(9);
        if op == 0 || live.is_empty() {
            // open, sometimes invalid
            let s = rng.below(3) as usize;
            let mut b = rng.below(3) as usize;
            if rng.below(10) != 0 && b == s {
                b = (s + 1) % 3;
            }
            let price = rng.range(1, 400_000_000) as u64;
            let max_bond = price / 5;
            let terms = model::Terms {
                price,
                seller_bond: if rng.below(8) == 0 { rng.range(0, price as i64) as u64 } else { rng.range(0, max_bond.max(1) as i64) as u64 },
                buyer_deposit: rng.range(0, price as i64 / 2 + 1) as u64,
                deliver_by: t + rng.range(-DAY, 20 * DAY),
                late_window: rng.range(0, 8 * DAY),
                pay_window: rng.range(0, 31 * DAY),
            };
            let caps = model::Caps { per_deal: PER_DEAL, total: TOTAL };
            let expected = if s == b { Err(model::Error::ZeroPrice) } else { model::open(terms, t, &caps, counter_total(&w)) };
            nonce += 1;
            let (sk, bk) = (&w.parties[s], &w.parties[b]);
            let (deal, _) = Address::find_program_address(&[b"deal", sk.kp.pubkey().as_ref(), bk.kp.pubkey().as_ref(), &nonce.to_le_bytes()], &PROGRAM);
            let (vault, _) = Address::find_program_address(&[b"vault", deal.as_ref()], &PROGRAM);
            let mut data = D_OPEN.to_vec();
            data.extend(nonce.to_le_bytes());
            for v in [terms.price, terms.seller_bond, terms.buyer_deposit] {
                data.extend(v.to_le_bytes());
            }
            for v in [terms.deliver_by, terms.late_window, terms.pay_window] {
                data.extend(v.to_le_bytes());
            }
            let ix = Instruction {
                program_id: PROGRAM,
                accounts: vec![
                    AccountMeta::new(sk.kp.pubkey(), true),
                    AccountMeta::new_readonly(bk.kp.pubkey(), true),
                    AccountMeta::new_readonly(w.mint, false),
                    AccountMeta::new(sk.ata, false),
                    AccountMeta::new(bk.ata, false),
                    AccountMeta::new(deal, false),
                    AccountMeta::new(vault, false),
                    AccountMeta::new(w.counter, false),
                    AccountMeta::new_readonly(w.config, false),
                    AccountMeta::new_readonly(w.tp, false),
                    AccountMeta::new_readonly(SYSTEM, false),
                ],
                data,
            };
            let (skp, bkp) = (sk.kp.insecure_clone(), bk.kp.insecure_clone());
            let ok = if s == b { send(&mut w.svm, ix, &skp, &[]) } else { send(&mut w.svm, ix, &skp, &[&bkp]) };
            assert_eq!(ok, expected.is_ok(), "seed {seed} step {step}: open disagreement {:?} terms {:?}", expected, terms);
            if let Ok(m) = expected {
                accepted += 1;
                live.push(Live { seller: s, buyer: b, deal, vault, m, donated: 0 });
            }
        } else {
            let i = rng.below(live.len() as u64) as usize;
            let (s, b, deal, vault) = (live[i].seller, live[i].buyer, live[i].deal, live[i].vault);
            let seller = w.parties[s].kp.insecure_clone();
            let buyer = w.parties[b].kp.insecure_clone();
            let p = w.payer.insecure_clone();
            match op {
                1 | 2 => {
                    // mark / confirm, sometimes by the wrong signer
                    let wrong = rng.below(6) == 0;
                    let (disc, signer) = if op == 1 { (D_MARK, if wrong { buyer.insecure_clone() } else { seller.insecure_clone() }) } else { (D_CONFIRM, if wrong { seller.insecure_clone() } else { buyer.insecure_clone() }) };
                    let mut m2 = live[i].m;
                    let expected = if wrong { Err(model::Error::NotOpen) } else if op == 1 { m2.seller_mark(t) } else { m2.buyer_confirm(t) };
                    let ix = Instruction { program_id: PROGRAM, accounts: vec![AccountMeta::new_readonly(signer.pubkey(), true), AccountMeta::new(deal, false)], data: disc.to_vec() };
                    let ok = send(&mut w.svm, ix, &p, &[&signer]);
                    assert_eq!(ok, expected.is_ok(), "seed {seed} step {step}: mark/confirm disagreement");
                    if ok {
                        live[i].m = m2;
                    }
                }
                3 => {
                    let mut m2 = live[i].m;
                    let expected = m2.pay_balance(t);
                    let (sb, bb) = (bal(&w.svm, &w.parties[s].ata), bal(&w.svm, &w.parties[b].ata));
                    let ix = Instruction {
                        program_id: PROGRAM,
                        accounts: vec![
                            AccountMeta::new_readonly(buyer.pubkey(), true),
                            AccountMeta::new(deal, false),
                            AccountMeta::new_readonly(w.mint, false),
                            AccountMeta::new(w.parties[b].ata, false),
                            AccountMeta::new(w.parties[s].ata, false),
                            AccountMeta::new_readonly(w.tp, false),
                        ],
                        data: D_PAY.to_vec(),
                    };
                    let ok = send(&mut w.svm, ix, &p, &[&buyer]);
                    assert_eq!(ok, expected.is_ok(), "seed {seed} step {step}: pay disagreement");
                    if let Ok(amt) = expected {
                        live[i].m = m2;
                        assert_eq!(bal(&w.svm, &w.parties[s].ata), sb + amt);
                        assert_eq!(bal(&w.svm, &w.parties[b].ata), bb - amt);
                    }
                }
                4 => {
                    let mut m2 = live[i].m;
                    let (d, l, pw) = (t + rng.range(-DAY, 30 * DAY), rng.range(0, 8 * DAY), rng.range(0, 31 * DAY));
                    let expected = m2.extend(d, l, pw, t);
                    let mut data = D_EXTEND.to_vec();
                    for v in [d, l, pw] {
                        data.extend(v.to_le_bytes());
                    }
                    let ix = Instruction {
                        program_id: PROGRAM,
                        accounts: vec![AccountMeta::new_readonly(seller.pubkey(), true), AccountMeta::new_readonly(buyer.pubkey(), true), AccountMeta::new(deal, false)],
                        data,
                    };
                    let ok = send(&mut w.svm, ix, &p, &[&seller, &buyer]);
                    assert_eq!(ok, expected.is_ok(), "seed {seed} step {step}: extend disagreement");
                    if ok {
                        live[i].m = m2;
                    }
                }
                5 => {
                    // donation to the vault by an outsider
                    let amt = rng.range(1, 1_000_000) as u64;
                    let mint = w.mint;
                    let tp = w.tp;
                    mint_to(&mut w.svm, &p, tp, &mint, &vault, amt);
                    w.minted += amt;
                    live[i].donated += amt;
                }
                6 | 7 | 8 => {
                    // settle (anyone) or cancel (both), sometimes with a wrong destination
                    let cancel = op == 6 && rng.below(3) == 0;
                    let evil = rng.below(7) == 0;
                    let mut m2 = live[i].m;
                    let expected = if cancel { m2.cancel() } else { m2.settle(t) };
                    let (sd, bd) = if evil {
                        if rng.below(2) == 0 { (w.outsider.ata, w.parties[b].ata) } else { (w.parties[s].ata, w.outsider.ata) }
                    } else {
                        (w.parties[s].ata, w.parties[b].ata)
                    };
                    let (sb, bb, ob) = (bal(&w.svm, &w.parties[s].ata), bal(&w.svm, &w.parties[b].ata), bal(&w.svm, &w.outsider.ata));
                    let ixs = close_ixs(&w, s, b, deal, vault, sd, bd, cancel);
                    let ok = if cancel { send_all(&mut w.svm, &ixs, &seller, &[&buyer]) } else { send_all(&mut w.svm, &ixs, &p, &[]) };
                    assert_eq!(ok, expected.is_ok() && !evil, "seed {seed} step {step}: finish disagreement evil={evil} {:?}", expected);
                    assert_eq!(bal(&w.svm, &w.outsider.ata), ob, "outsider received funds");
                    if ok {
                        let pay = expected.unwrap();
                        let donated = live[i].donated;
                        if s == b {
                            unreachable!();
                        }
                        assert_eq!(bal(&w.svm, &w.parties[s].ata), sb + pay.to_seller, "seller payout");
                        assert_eq!(bal(&w.svm, &w.parties[b].ata), bb + pay.to_buyer + donated, "buyer payout (extra goes to the buyer)");
                        assert!(closed(&w.svm, &deal) && closed(&w.svm, &vault));
                        live.remove(i);
                        settled += 1;
                    }
                }
                _ => {}
            }
        }
        // Global invariants after every step.
        let locked: u64 = live.iter().map(|d| d.m.terms.seller_bond + d.m.terms.buyer_deposit).sum();
        assert_eq!(counter_total(&w), locked, "seed {seed} step {step}: counter drift");
        for d in &live {
            assert_eq!(bal(&w.svm, &d.vault), d.m.terms.seller_bond + d.m.terms.buyer_deposit + d.donated, "vault drift");
        }
        let held: u64 = w.parties.iter().map(|x| bal(&w.svm, &x.ata)).sum::<u64>() + bal(&w.svm, &w.outsider.ata) + live.iter().map(|d| bal(&w.svm, &d.vault)).sum::<u64>();
        assert_eq!(held, w.minted, "seed {seed} step {step}: conservation");
    }
    // Liveness: far in the future every remaining deal settles.
    let end = now(&w.svm) + 400 * DAY;
    set_time(&mut w.svm, end);
    for d in live.drain(..) {
        let (s, b) = (d.seller, d.buyer);
        let ixs = close_ixs(&w, s, b, d.deal, d.vault, w.parties[s].ata, w.parties[b].ata, false);
        let p = w.payer.insecure_clone();
        assert!(send_all(&mut w.svm, &ixs, &p, &[]), "seed {seed}: deal not settleable at the end");
        settled += 1;
    }
    assert_eq!(counter_total(&w), 0);
    (accepted, settled)
}

#[test]
fn differential_fuzz() {
    let seeds: u64 = std::env::var("FUZZ_SEEDS").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
    let steps: usize = std::env::var("FUZZ_STEPS").ok().and_then(|v| v.parse().ok()).unwrap_or(400);
    let (mut a, mut s) = (0, 0);
    for k in 0..seeds {
        let tp = if k % 2 == 0 { CLASSIC } else { T2022 };
        let (x, y) = run(0x9E37_79B9_7F4A_7C15 ^ (k * 0x1000_0001), steps, tp);
        a += x;
        s += y;
    }
    eprintln!("fuzz: seeds={seeds} steps={steps} deals_opened={a} deals_settled={s}");
    assert!(a > 0 && s == a);
}

/// init_counter refuses mints that could freeze or drain vaults: a freeze
/// authority, or a Token-2022 extension other than the metadata ones.
#[test]
fn risky_mints_are_refused() {
    use spl_token_2022_interface::{extension::ExtensionType, instruction as ti, state::Mint};
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, std::env::var("BOND_SO").expect("BOND_SO")).unwrap();
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 1_000_000_000_000).unwrap();
    let init = |svm: &mut LiteSVM, mint: Address| {
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
        let tx = Transaction::new_signed_with_payer(&[ix], Some(&payer.pubkey()), &[&payer], svm.latest_blockhash());
        let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?}", e.err));
        svm.expire_blockhash();
        r
    };
    let build = |svm: &mut LiteSVM, tp: Address, ext: Option<ExtensionType>, freeze: bool| {
        let mint = Keypair::new();
        let m = mint.pubkey();
        let exts: Vec<ExtensionType> = ext.into_iter().collect();
        let space = if tp == T2022 { ExtensionType::try_calculate_account_len::<Mint>(&exts).unwrap() } else { 82 };
        let mut ixs = vec![solana_system_interface::instruction::create_account(&payer.pubkey(), &m, 100_000_000, space as u64, &tp)];
        match ext {
            Some(ExtensionType::PermanentDelegate) => ixs.push(ti::initialize_permanent_delegate(&tp, &m, &payer.pubkey()).unwrap()),
            Some(ExtensionType::MintCloseAuthority) => ixs.push(ti::initialize_mint_close_authority(&tp, &m, Some(&payer.pubkey())).unwrap()),
            _ => {}
        }
        let fa = payer.pubkey();
        ixs.push(ti::initialize_mint2(&tp, &m, &payer.pubkey(), if freeze { Some(&fa) } else { None }, 6).unwrap());
        let tx = Transaction::new_signed_with_payer(&ixs, Some(&payer.pubkey()), &[&payer, &mint], svm.latest_blockhash());
        svm.send_transaction(tx).expect("mint");
        svm.expire_blockhash();
        m
    };
    let m = build(&mut svm, T2022, Some(ExtensionType::PermanentDelegate), false);
    assert!(init(&mut svm, m).unwrap_err().contains("Custom(6000)"), "permanent delegate accepted");
    let m = build(&mut svm, T2022, Some(ExtensionType::MintCloseAuthority), false);
    assert!(init(&mut svm, m).unwrap_err().contains("Custom(6000)"), "close authority accepted");
    let m = build(&mut svm, CLASSIC, None, true);
    assert!(init(&mut svm, m).unwrap_err().contains("Custom(6000)"), "freeze authority accepted");
    let m = build(&mut svm, CLASSIC, None, false);
    init(&mut svm, m).unwrap();
    let m = make_mint(&mut svm, &payer, T2022);
    init(&mut svm, m).unwrap();
}
