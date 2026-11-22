/**
 * Agent402 performance bond: instruction builders (beta).
 *
 * The program never judges quality. Outcomes come only from signatures and
 * the on-chain clock. Settlement records the outcome; each side then claims
 * its own share. `settleAndClaim` puts settle + claim_buyer + claim_seller in
 * one transaction, which is the normal path. If one side's token account is
 * frozen, send `settle` and the other side's claim on their own.
 *
 * Never send tokens straight to a deal vault. Anything beyond the locked
 * amount is returned to the buyer.
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

/** Same program id on devnet and mainnet. */
export const BOND_PROGRAM_ID = new PublicKey('9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK');

export const MINTS = {
  mainnet: {
    USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    WSOL: new PublicKey('So11111111111111111111111111111111111111112'),
    PREQ: new PublicKey('aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX'),
  },
  devnet: {
    USDC: new PublicKey('4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
    WSOL: new PublicKey('So11111111111111111111111111111111111111112'),
  },
} as const;

export const PREQ_POOL = new PublicKey('51F34MKDFBLr5GwKiiJMWV9HsHv63dkkP3ZMMxPN71xc');

/** sha256("global:<name>")[..8], checked in test/discriminators.test.ts. */
export const DISC = {
  init_counter: [247, 168, 146, 45, 125, 26, 142, 80],
  init_config: [23, 235, 115, 232, 168, 96, 1, 231],
  set_paused: [91, 60, 125, 192, 176, 225, 166, 218],
  set_admin: [251, 163, 0, 52, 91, 194, 187, 92],
  accept_admin: [112, 42, 45, 90, 116, 181, 13, 170],
  propose_caps: [63, 24, 101, 104, 86, 149, 67, 243],
  observe_price: [147, 178, 4, 21, 14, 213, 81, 159],
  activate_price_mode: [181, 205, 243, 174, 176, 192, 111, 71],
  open: [228, 220, 155, 71, 199, 189, 60, 45],
  mark_delivered: [240, 118, 188, 142, 64, 85, 107, 18],
  confirm_receipt: [203, 36, 80, 115, 249, 12, 141, 170],
  pay_balance: [121, 220, 140, 105, 242, 163, 148, 24],
  extend: [228, 127, 0, 1, 227, 154, 54, 168],
  cancel: [232, 219, 223, 41, 219, 236, 220, 190],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  claim_seller: [238, 218, 144, 171, 49, 203, 29, 50],
  claim_buyer: [13, 61, 90, 109, 208, 223, 195, 211],
} as const;

const enc = new TextEncoder();
const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return b;
};
const i64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, v, true);
  return b;
};
const data = (d: readonly number[], ...parts: Uint8Array[]) => Buffer.concat([Buffer.from(d), ...parts.map((p) => Buffer.from(p))]);
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: AccountMeta[], d: Buffer, programId = BOND_PROGRAM_ID) => new TransactionInstruction({ programId, keys, data: d });

// ---------------- addresses ----------------

export const configPda = (programId = BOND_PROGRAM_ID) => PublicKey.findProgramAddressSync([enc.encode('config')], programId)[0];
export const counterPda = (mint: PublicKey, programId = BOND_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('counter'), mint.toBytes()], programId)[0];
export const dealPda = (seller: PublicKey, buyer: PublicKey, nonce: bigint, programId = BOND_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('deal'), seller.toBytes(), buyer.toBytes(), u64(nonce)], programId)[0];
export const vaultPda = (deal: PublicKey, programId = BOND_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('vault'), deal.toBytes()], programId)[0];

// ---------------- setup (once per cluster) ----------------

export const initConfig = (payer: PublicKey) => ix([w(payer, true), w(configPda()), r(SystemProgram.programId)], data(DISC.init_config));
export const initCounter = (payer: PublicKey, mint: PublicKey) =>
  ix([w(payer, true), r(mint), w(counterPda(mint)), r(SystemProgram.programId)], data(DISC.init_counter));

// ---------------- admin ----------------

export const setPaused = (admin: PublicKey, paused: boolean) => ix([r(admin, true), w(configPda())], data(DISC.set_paused, Uint8Array.of(paused ? 1 : 0)));
export const setAdmin = (admin: PublicKey, next: PublicKey) => ix([r(admin, true), w(configPda())], data(DISC.set_admin, next.toBytes()));
export const acceptAdmin = (next: PublicKey) => ix([r(next, true), w(configPda())], data(DISC.accept_admin));
export const proposeCaps = (admin: PublicKey, mint: PublicKey, perDeal: bigint, total: bigint) =>
  ix([r(admin, true), r(configPda()), w(counterPda(mint))], data(DISC.propose_caps, u64(perDeal), u64(total)));

// ---------------- PREQ price record (anyone) ----------------

export const observePrice = (preqMint: PublicKey, quoteVault: PublicKey) =>
  ix([w(counterPda(preqMint)), r(PREQ_POOL), r(quoteVault)], data(DISC.observe_price));
export const activatePriceMode = (preqMint: PublicKey, quoteVault: PublicKey) =>
  ix([w(counterPda(preqMint)), r(PREQ_POOL), r(quoteVault)], data(DISC.activate_price_mode));

// ---------------- deals ----------------

export interface Terms {
  /** All amounts in the mint's smallest unit. */
  price: bigint;
  sellerBond: bigint;
  buyerDeposit: bigint;
  /** Unix seconds. */
  deliverBy: bigint;
  /** Seconds, 0..=7 days. */
  lateWindow: bigint;
  /** Seconds, 1..=30 days. */
  payWindow: bigint;
}

export interface DealRef {
  seller: PublicKey;
  buyer: PublicKey;
  mint: PublicKey;
  /** SPL Token or Token-2022, matching the mint. */
  tokenProgram: PublicKey;
  nonce: bigint;
}

export const dealOf = (d: DealRef) => dealPda(d.seller, d.buyer, d.nonce);
const ata = (owner: PublicKey, d: DealRef) => getAssociatedTokenAddressSync(d.mint, owner, false, d.tokenProgram);

/** Both seller and buyer must sign. Locks the bond and the deposit. */
export function open(d: DealRef, t: Terms, sellerToken = ata(d.seller, d), buyerToken = ata(d.buyer, d)) {
  const deal = dealOf(d);
  return ix(
    [
      w(d.seller, true),
      r(d.buyer, true),
      r(d.mint),
      w(sellerToken),
      w(buyerToken),
      w(deal),
      w(vaultPda(deal)),
      w(counterPda(d.mint)),
      r(configPda()),
      r(d.tokenProgram),
      r(SystemProgram.programId),
    ],
    data(DISC.open, u64(d.nonce), u64(t.price), u64(t.sellerBond), u64(t.buyerDeposit), i64(t.deliverBy), i64(t.lateWindow), i64(t.payWindow)),
  );
}

export const markDelivered = (d: DealRef) => ix([r(d.seller, true), w(dealOf(d))], data(DISC.mark_delivered));
export const confirmReceipt = (d: DealRef) => ix([r(d.buyer, true), w(dealOf(d))], data(DISC.confirm_receipt));

/** Pays price - deposit straight from buyer to seller. */
export const payBalance = (d: DealRef, buyerToken = ata(d.buyer, d), sellerToken = ata(d.seller, d)) =>
  ix([r(d.buyer, true), w(dealOf(d)), r(d.mint), w(buyerToken), w(sellerToken), r(d.tokenProgram)], data(DISC.pay_balance));

/** Both sign. The whole term must stay within 180 days of opening. */
export const extend = (d: DealRef, deliverBy: bigint, lateWindow: bigint, payWindow: bigint) =>
  ix([r(d.seller, true), r(d.buyer, true), w(dealOf(d))], data(DISC.extend, i64(deliverBy), i64(lateWindow), i64(payWindow)));

const decideAccounts = (d: DealRef) => {
  const deal = dealOf(d);
  return [w(deal), r(vaultPda(deal)), w(counterPda(d.mint))];
};

export const settle = (d: DealRef) => ix(decideAccounts(d), data(DISC.settle));
export const cancel = (d: DealRef) => ix([r(d.seller, true), r(d.buyer, true), ...decideAccounts(d)], data(DISC.cancel));

function claim(d: DealRef, to: PublicKey, side: 'seller' | 'buyer') {
  const deal = dealOf(d);
  return ix(
    [w(d.seller), w(deal), r(d.mint), w(vaultPda(deal)), w(to), r(d.tokenProgram)],
    data(side === 'seller' ? DISC.claim_seller : DISC.claim_buyer),
  );
}
/** Anyone. `to` must be a token account owned by the buyer. */
export const claimBuyer = (d: DealRef, to = ata(d.buyer, d)) => claim(d, to, 'buyer');
/** Anyone. `to` must be a token account owned by the seller. Closes the deal once the vault is empty. */
export const claimSeller = (d: DealRef, to = ata(d.seller, d)) => claim(d, to, 'seller');

/** The normal closing transaction: settle, buyer's claim, then seller's claim (order matters). */
export const settleAndClaim = (d: DealRef) => [settle(d), claimBuyer(d), claimSeller(d)];
/** Both sign: return each side's own money. */
export const cancelAndClaim = (d: DealRef) => [cancel(d), claimBuyer(d), claimSeller(d)];

// ---------------- reading a deal ----------------

export const OUTCOMES = ['open', 'delivered', 'buyer_default', 'disputed', 'seller_default', 'cancelled'] as const;

export interface DealState {
  seller: PublicKey;
  buyer: PublicKey;
  mint: PublicKey;
  nonce: bigint;
  terms: Terms;
  openedAt: bigint;
  sellerMark: bigint | null;
  buyerConfirm: bigint | null;
  balancePaid: boolean;
  outcome: (typeof OUTCOMES)[number];
  owedSeller: bigint;
}

/** Decodes a Deal account (Anchor layout, 8-byte discriminator first). */
export function decodeDeal(raw: Uint8Array): DealState {
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  let o = 8;
  const key = () => new PublicKey(raw.slice(o, (o += 32)));
  const n = () => { const x = v.getBigUint64(o, true); o += 8; return x; };
  const s = () => { const x = v.getBigInt64(o, true); o += 8; return x; };
  const seller = key(), buyer = key(), mint = key();
  const nonce = n(), price = n(), sellerBond = n(), buyerDeposit = n();
  const deliverBy = s(), lateWindow = s(), payWindow = s(), openedAt = s(), mark = s(), conf = s();
  const balancePaid = raw[o++] === 1;
  o += 2; // bump, vault_bump
  const outcome = OUTCOMES[raw[o++]] ?? 'open';
  const owedSeller = n();
  return {
    seller, buyer, mint, nonce,
    terms: { price, sellerBond, buyerDeposit, deliverBy, lateWindow, payWindow },
    openedAt,
    sellerMark: mark === 0n ? null : mark,
    buyerConfirm: conf === 0n ? null : conf,
    balancePaid, outcome, owedSeller,
  };
}
