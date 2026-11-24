//! Bond v2 with Token-2022 mints (as PREQ): full settlement on a Token-2022 mint, mints with only
//! metadata extensions allowed, and every mint that could break settlement refused at init_counter.
//! Build first: cargo-build-sbf --features test-mints, then BOND_V2_SO=<path to agent402_bond_v2.so>.

use agent402_bond_v2_core::DAY;
use litesvm::LiteSVM;
use litesvm_token::{CreateAssociatedTokenAccount, CreateMint, TOKEN_ID};
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use spl_token_2022_interface::extension::ExtensionType;
use spl_token_2022_interface::state::Mint as Mint22;

const PROGRAM: Address = Address::from_str_const("5TotaQm4RbhRfhZzwFwnfoRLMWJ4jn3dpA9gRVsgd5bx");
const T22: Address = Address::from_str_const("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");
const T0: i64 = 1_800_000_000;
const U: u64 = 1_000_000;

const D_INIT_CONFIG: [u8; 8] = [23, 235, 115, 232, 168, 96, 1, 231];
const D_INIT_COUNTER: [u8; 8] = [247, 168, 146, 45, 125, 26, 142, 80];
const D_OPEN: [u8; 8] = [228, 220, 155, 71, 199, 189, 60, 45];
const D_MARK_DELIVERED: [u8; 8] = [240, 118, 188, 142, 64, 85, 107, 18];
const D_ACCEPT: [u8; 8] = [65, 150, 70, 216, 133, 6, 107, 4];
const D_CANCEL: [u8; 8] = [232, 219, 223, 41, 219, 236, 220, 190];
const D_CLAIM_SELLER: [u8; 8] = [238, 218, 144, 171, 49, 203, 29, 50];
const D_CLAIM_BUYER: [u8; 8] = [13, 61, 90, 109, 208, 223, 195, 211];

#[derive(Clone, Copy, Debug)]
enum Ext { MetadataPointer, TransferFee, PermanentDelegate, MintCloseAuthority, TransferHook, DefaultFrozen, NonTransferable }

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
    let r = svm.send_transaction(tx).map(|_| ()).map_err(|e| format!("{:?} {:?}", e.err, e.meta.logs.iter().rev().take(6).collect::<Vec<_>>()));
    svm.expire_blockhash();
    r
}
/// Token amount at bytes 64..72 (same layout for SPL Token and Token-2022 accounts).
fn bal(svm: &LiteSVM, a: &Address) -> u64 {
    svm.get_account(a).filter(|x| x.data.len() >= 72).map(|x| u64::from_le_bytes(x.data[64..72].try_into().unwrap())).unwrap_or(0)
}
fn copt(v: Option<&Address>) -> Vec<u8> {
    match v { None => vec![0], Some(k) => { let mut d = vec![1]; d.extend(k.as_ref()); d } }
}
fn ext_type(x: Ext) -> ExtensionType {
    match x {
        Ext::MetadataPointer => ExtensionType::MetadataPointer,
        Ext::TransferFee => ExtensionType::TransferFeeConfig,
        Ext::PermanentDelegate => ExtensionType::PermanentDelegate,
        Ext::MintCloseAuthority => ExtensionType::MintCloseAuthority,
        Ext::TransferHook => ExtensionType::TransferHook,
        Ext::DefaultFrozen => ExtensionType::DefaultAccountState,
        Ext::NonTransferable => ExtensionType::NonTransferable,
    }
}
/// Token-2022 extension init instruction data (sent before InitializeMint2).
fn ext_ix(x: Ext, mint: &Address, auth: &Address) -> Instruction {
    let data = match x {
        Ext::MetadataPointer => { let mut d = vec![39, 0]; d.extend(auth.as_ref()); d.extend(mint.as_ref()); d }
        Ext::TransferFee => { let mut d = vec![26, 0]; d.extend(copt(Some(auth))); d.extend(copt(Some(auth))); d.extend(100u16.to_le_bytes()); d.extend(u64::MAX.to_le_bytes()); d }
        Ext::PermanentDelegate => { let mut d = vec![35]; d.extend(auth.as_ref()); d }
        Ext::MintCloseAuthority => { let mut d = vec![25]; d.extend(copt(Some(auth))); d }
        Ext::TransferHook => { let mut d = vec![36, 0]; d.extend(auth.as_ref()); d.extend(PROGRAM.as_ref()); d }
        Ext::DefaultFrozen => vec![28, 0, 2],
        Ext::NonTransferable => vec![32],
    };
    Instruction { program_id: T22, accounts: vec![AccountMeta::new(*mint, false)], data }
}
/// Creates a Token-2022 mint (6 decimals, authority = payer) with the given extensions.
fn mint22(svm: &mut LiteSVM, payer: &Keypair, exts: &[Ext], freeze: Option<&Address>) -> Result<Address, String> {
    let kp = Keypair::new();
    let types: Vec<ExtensionType> = exts.iter().map(|x| ext_type(*x)).collect();
    let space = ExtensionType::try_calculate_account_len::<Mint22>(&types).unwrap();
    let lamports = svm.minimum_balance_for_rent_exemption(space);
    // system create_account: [0u32 LE, lamports u64, space u64, owner 32]
    let mut d = 0u32.to_le_bytes().to_vec();
    d.extend(lamports.to_le_bytes());
    d.extend((space as u64).to_le_bytes());
    d.extend(T22.as_ref());
    let mut ixs = vec![Instruction { program_id: SYSTEM, accounts: vec![AccountMeta::new(payer.pubkey(), true), AccountMeta::new(kp.pubkey(), true)], data: d }];
    for x in exts { ixs.push(ext_ix(*x, &kp.pubkey(), &payer.pubkey())); }
    let mut im = vec![20u8, 6];
    im.extend(payer.pubkey().as_ref());
    im.extend(copt(freeze));
    ixs.push(Instruction { program_id: T22, accounts: vec![AccountMeta::new(kp.pubkey(), false)], data: im });
    send(svm, &ixs, payer, &[&kp])?;
    Ok(kp.pubkey())
}

fn config_pda() -> Address { Address::find_program_address(&[b"config"], &PROGRAM).0 }
fn counter_pda(mint: &Address) -> Address { Address::find_program_address(&[b"counter", mint.as_ref()], &PROGRAM).0 }

fn base() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    svm.add_program_from_file(PROGRAM, std::env::var("BOND_V2_SO").expect("set BOND_V2_SO")).unwrap();
    set_time(&mut svm, T0);
    let payer = Keypair::new();
    svm.airdrop(&payer.pubkey(), 10_000_000_000).unwrap();
    send(&mut svm, &[Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new(config_pda(), false), AccountMeta::new_readonly(SYSTEM, false),
    ], data: D_INIT_CONFIG.to_vec() }], &payer, &[]).unwrap();
    (svm, payer)
}
fn init_counter(svm: &mut LiteSVM, payer: &Keypair, mint: &Address) -> Result<(), String> {
    send(svm, &[Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(payer.pubkey(), true), AccountMeta::new_readonly(*mint, false), AccountMeta::new(counter_pda(mint), false), AccountMeta::new_readonly(SYSTEM, false),
    ], data: D_INIT_COUNTER.to_vec() }], payer, &[])
}

struct Env { svm: LiteSVM, payer: Keypair, seller: Keypair, buyer: Keypair, mint: Address, tok: Address, seller_ata: Address, buyer_ata: Address }

fn env22(exts: &[Ext]) -> Env {
    let (mut svm, payer) = base();
    let (seller, buyer) = (Keypair::new(), Keypair::new());
    for k in [&seller, &buyer] { svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap(); }
    let mint = mint22(&mut svm, &payer, exts, None).unwrap();
    let seller_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&seller.pubkey()).token_program_id(&T22).send().unwrap();
    let buyer_ata = CreateAssociatedTokenAccount::new(&mut svm, &payer, &mint).owner(&buyer.pubkey()).token_program_id(&T22).send().unwrap();
    for to in [seller_ata, buyer_ata] {
        let mut d = vec![7u8];
        d.extend((1_000 * U).to_le_bytes());
        let ix = Instruction { program_id: T22, accounts: vec![AccountMeta::new(mint, false), AccountMeta::new(to, false), AccountMeta::new_readonly(payer.pubkey(), true)], data: d };
        send(&mut svm, &[ix], &payer, &[]).unwrap();
    }
    init_counter(&mut svm, &payer, &mint).unwrap();
    Env { svm, payer, seller, buyer, mint, tok: T22, seller_ata, buyer_ata }
}

fn open(e: &mut Env, nonce: u64, tok: Address) -> Result<(Address, Address), String> {
    let deal = Address::find_program_address(&[b"deal", e.seller.pubkey().as_ref(), e.buyer.pubkey().as_ref(), &nonce.to_le_bytes()], &PROGRAM).0;
    let vault = Address::find_program_address(&[b"vault", deal.as_ref()], &PROGRAM).0;
    let mut data = D_OPEN.to_vec();
    data.extend(nonce.to_le_bytes());
    for v in [30 * U, 3 * U, 5 * U] { data.extend(v.to_le_bytes()); }
    for v in [T0 + DAY, DAY, DAY] { data.extend(v.to_le_bytes()); }
    data.extend(0u16.to_le_bytes());
    data.extend([0u8; 32]);
    data.extend(0i64.to_le_bytes());
    data.extend([9u8; 32]);
    let ix = Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(e.seller.pubkey(), true), AccountMeta::new_readonly(e.buyer.pubkey(), true), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(e.seller_ata, false), AccountMeta::new(e.buyer_ata, false),
        AccountMeta::new_readonly(e.seller_ata, false), AccountMeta::new_readonly(e.buyer_ata, false),
        AccountMeta::new(deal, false), AccountMeta::new(vault, false), AccountMeta::new(counter_pda(&e.mint), false), AccountMeta::new_readonly(config_pda(), false),
        AccountMeta::new_readonly(tok, false), AccountMeta::new_readonly(SYSTEM, false),
    ], data };
    let (s, b) = (e.seller.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, &[ix], &s, &[&b])?;
    Ok((deal, vault))
}
fn claims(e: &mut Env, deal: Address, vault: Address) -> Result<(), String> {
    let ix = |to: Address, buyer: bool| Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new(e.seller.pubkey(), false), AccountMeta::new(deal, false), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(vault, false), AccountMeta::new(to, false), AccountMeta::new_readonly(e.tok, false),
    ], data: if buyer { D_CLAIM_BUYER.to_vec() } else { D_CLAIM_SELLER.to_vec() } };
    let p = e.payer.insecure_clone();
    for (to, buyer) in [(e.seller_ata, false), (e.buyer_ata, true)] {
        if e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0) { break; }
        let i = ix(to, buyer);
        send(&mut e.svm, &[i], &p, &[])?;
    }
    Ok(())
}

#[test]
fn token2022_accept_flow_settles_and_closes() {
    let mut e = env22(&[]);
    let (s0, b0) = (bal(&e.svm, &e.seller_ata), bal(&e.svm, &e.buyer_ata));
    let (deal, vault) = open(&mut e, 1, T22).unwrap();
    assert_eq!(bal(&e.svm, &vault), 8 * U);
    assert_eq!(e.svm.get_account(&vault).unwrap().owner, T22, "vault is a Token-2022 account");
    let mut d = D_MARK_DELIVERED.to_vec();
    d.extend([5u8; 32]);
    let (p, s, b) = (e.payer.insecure_clone(), e.seller.insecure_clone(), e.buyer.insecure_clone());
    send(&mut e.svm, &[Instruction { program_id: PROGRAM, accounts: vec![AccountMeta::new_readonly(s.pubkey(), true), AccountMeta::new(deal, false)], data: d }], &p, &[&s]).unwrap();
    let acc = Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new_readonly(b.pubkey(), true), AccountMeta::new(deal, false), AccountMeta::new_readonly(e.mint, false),
        AccountMeta::new(e.buyer_ata, false), AccountMeta::new(e.seller_ata, false), AccountMeta::new_readonly(vault, false),
        AccountMeta::new(counter_pda(&e.mint), false), AccountMeta::new_readonly(T22, false),
    ], data: D_ACCEPT.to_vec() };
    send(&mut e.svm, &[acc], &p, &[&b]).unwrap();
    claims(&mut e, deal, vault).unwrap();
    assert_eq!(bal(&e.svm, &e.seller_ata), s0 + 30 * U);
    assert_eq!(bal(&e.svm, &e.buyer_ata), b0 - 30 * U);
    assert!(e.svm.get_account(&vault).map_or(true, |a| a.lamports == 0), "vault closed");
    assert!(e.svm.get_account(&deal).map_or(true, |a| a.lamports == 0), "deal closed");
}

#[test]
fn token2022_metadata_pointer_mint_is_allowed_and_cancel_refunds() {
    let mut e = env22(&[Ext::MetadataPointer]);
    let (s0, b0) = (bal(&e.svm, &e.seller_ata), bal(&e.svm, &e.buyer_ata));
    let (deal, vault) = open(&mut e, 7, T22).unwrap();
    let (p, s, b) = (e.payer.insecure_clone(), e.seller.insecure_clone(), e.buyer.insecure_clone());
    let cancel = Instruction { program_id: PROGRAM, accounts: vec![
        AccountMeta::new_readonly(s.pubkey(), true), AccountMeta::new_readonly(b.pubkey(), true),
        AccountMeta::new(deal, false), AccountMeta::new_readonly(vault, false), AccountMeta::new(counter_pda(&e.mint), false),
    ], data: D_CANCEL.to_vec() };
    send(&mut e.svm, &[cancel], &p, &[&s, &b]).unwrap();
    claims(&mut e, deal, vault).unwrap();
    assert_eq!((bal(&e.svm, &e.seller_ata), bal(&e.svm, &e.buyer_ata)), (s0, b0), "cancel returns bond and deposit");
}

#[test]
fn token2022_mint_with_wrong_token_program_is_refused() {
    let mut e = env22(&[]);
    assert!(open(&mut e, 2, TOKEN_ID).is_err(), "Token-2022 mint with the classic token program");
}

#[test]
fn risky_mints_are_refused_at_init_counter() {
    let cases = [Ext::TransferFee, Ext::PermanentDelegate, Ext::MintCloseAuthority, Ext::TransferHook, Ext::DefaultFrozen, Ext::NonTransferable];
    for x in cases {
        let (mut svm, payer) = base();
        let f = payer.pubkey();
        let freeze = if matches!(x, Ext::DefaultFrozen) { Some(&f) } else { None }; // a default-frozen mint needs a freeze authority
        let mint = mint22(&mut svm, &payer, &[x], freeze).unwrap_or_else(|err| panic!("mint {:?}: {}", x, err));
        assert!(init_counter(&mut svm, &payer, &mint).is_err(), "{:?} must be refused", x);
    }
    // metadata pointer plus a risky extension is still refused
    let (mut svm, payer) = base();
    let mint = mint22(&mut svm, &payer, &[Ext::MetadataPointer, Ext::PermanentDelegate], None).unwrap();
    assert!(init_counter(&mut svm, &payer, &mint).is_err(), "metadata pointer + permanent delegate");
    // freeze authority on a Token-2022 mint and on a classic mint
    let (mut svm, payer) = base();
    let f = payer.pubkey();
    let mint = mint22(&mut svm, &payer, &[], Some(&f)).unwrap();
    assert!(init_counter(&mut svm, &payer, &mint).is_err(), "Token-2022 freeze authority");
    let classic = CreateMint::new(&mut svm, &payer).decimals(6).freeze_authority(&f).send().unwrap();
    assert!(init_counter(&mut svm, &payer, &classic).is_err(), "classic freeze authority");
}
