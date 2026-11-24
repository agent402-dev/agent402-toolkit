/**
 * Agent402 performance bond v2: instruction builders, account decoders and the deadline rules (beta, not deployed).
 *
 * v2 in one paragraph: seller and buyer open a deal together; the seller locks a bond, the buyer a deposit, and
 * both payout accounts are recorded. The seller marks delivery; the buyer accepts and pays the balance in the same
 * instruction. If nobody acts, time decides (`settle`, anyone). Both together may cancel or agree any split; the
 * seller alone may release; a named arbiter may decide inside its window. Each side then claims its share to its
 * recorded payout account (owner checked at payment). The deal and vault close when both sides are done; the rent
 * goes back to the payer. The program never judges quality.
 *
 * Mirrors programs-v2/agent402-bond-v2 (account order, data layout) and agent402-bond-v2-core (rules).
 */
import { PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from '@solana/web3.js';

/** The Bond v2 program address (mainnet build). Builders default to it. Not usable until BOND_V2_DEPLOYED is set. */
export const BOND_V2_PROGRAM_ID = new PublicKey('Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev');
/** Address of the test-mints build (local tests only: any mint, a test admin). Never deployed. */
export const BOND_V2_TEST_PROGRAM_ID = new PublicKey('5TotaQm4RbhRfhZzwFwnfoRLMWJ4jn3dpA9gRVsgd5bx');
/** The deployed mainnet program, set only after deploy, verification and upgrade-authority removal. null = not deployed. */
export const BOND_V2_DEPLOYED: PublicKey | null = null;

/** sha256("global:<name>")[..8], checked in test/v2.test.ts. */
export const DISC_V2 = {
  init_config: [23, 235, 115, 232, 168, 96, 1, 231],
  init_counter: [247, 168, 146, 45, 125, 26, 142, 80],
  set_paused: [91, 60, 125, 192, 176, 225, 166, 218],
  propose_admin: [121, 214, 199, 212, 87, 39, 117, 234],
  accept_admin: [112, 42, 45, 90, 116, 181, 13, 170],
  propose_caps: [63, 24, 101, 104, 86, 149, 67, 243],
  open: [228, 220, 155, 71, 199, 189, 60, 45],
  mark_delivered: [240, 118, 188, 142, 64, 85, 107, 18],
  accept: [65, 150, 70, 216, 133, 6, 107, 4],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  cancel: [232, 219, 223, 41, 219, 236, 220, 190],
  settle_agreed: [231, 63, 88, 124, 88, 192, 159, 78],
  seller_release: [76, 135, 77, 213, 145, 225, 24, 194],
  decide: [123, 125, 184, 125, 249, 43, 113, 15],
  extend: [228, 127, 0, 1, 227, 154, 54, 168],
  set_payout: [55, 43, 132, 51, 227, 169, 242, 195],
  claim_seller: [238, 218, 144, 171, 49, 203, 29, 50],
  claim_buyer: [13, 61, 90, 109, 208, 223, 195, 211],
} as const;

/** sha256("account:<Name>")[..8]. */
export const ACCOUNT_DISC_V2 = {
  Config: [155, 12, 170, 224, 30, 250, 204, 130],
  Counter: [255, 176, 4, 245, 188, 253, 124, 25],
  Deal: [125, 223, 160, 234, 71, 162, 182, 219],
} as const;

/** Anchor custom error codes (6000 + index), in program order. */
export const ERRORS_V2 = [
  'MintNotAllowed', 'Paused', 'SameParty', 'ZeroPrice', 'ZeroBond', 'BondTooLarge', 'DepositTooLarge', 'DeadlineInPast',
  'TermTooLong', 'GraceOutOfRange', 'ReviewWindowOutOfRange', 'BadShare', 'BadArbiter', 'PerDealCapExceeded',
  'TotalCapExceeded', 'NotOpen', 'AlreadyMarked', 'MarkTooLate', 'AcceptTooLate', 'NotYetSettleable', 'BadSplit',
  'ArbiterSet', 'ReleaseTooLate', 'Unauthorized', 'OutsideArbiterWindow', 'ExtendNotLonger', 'Overflow', 'BadPayout',
  'NotSettled', 'BadRentPayer', 'CapChangeOutOfBounds',
] as const;
export const errorNameV2 = (code: number): string | undefined => ERRORS_V2[code - 6000];

// ---------------- rule constants (core crate) ----------------

export const HOUR = 3_600n;
export const DAY = 86_400n;
export const LIMITS_V2 = {
  graceMin: HOUR, graceMax: DAY,
  reviewMin: HOUR, reviewMax: 7n * DAY,
  arbiterMin: HOUR, arbiterMax: 7n * DAY,
  maxDeliver: 30n * DAY,
  maxBondBps: 2_000n,
} as const;

export const STATE = { Open: 1, Marked: 2, Settled: 3 } as const;
/** `Deal.outcome` is meaningful only when `state === STATE.Settled`. */
export const OUTCOMES = ['Accepted', 'Unconfirmed', 'SellerDefault', 'Cancelled', 'Agreed', 'Arbitrated', 'Released'] as const;
export type Outcome = (typeof OUTCOMES)[number];

// ---------------- encoding ----------------

const enc = new TextEncoder();
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const i64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return b; };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const data = (d: readonly number[], ...parts: (Buffer | Uint8Array)[]) => Buffer.concat([Buffer.from(d), ...parts.map((p) => Buffer.from(p))]);
const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });

// ---------------- addresses ----------------

export const configPdaV2 = (programId = BOND_V2_PROGRAM_ID) => PublicKey.findProgramAddressSync([enc.encode('config')], programId)[0];
export const counterPdaV2 = (mint: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('counter'), mint.toBytes()], programId)[0];
export const dealPdaV2 = (seller: PublicKey, buyer: PublicKey, nonce: bigint, programId = BOND_V2_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('deal'), seller.toBytes(), buyer.toBytes(), u64(nonce)], programId)[0];
export const vaultPdaV2 = (deal: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  PublicKey.findProgramAddressSync([enc.encode('vault'), deal.toBytes()], programId)[0];

/** What every deal instruction needs to find its accounts. */
export interface DealRef {
  seller: PublicKey;
  buyer: PublicKey;
  nonce: bigint;
  mint: PublicKey;
  /** SPL Token or Token-2022 program that owns `mint`. */
  tokenProgram: PublicKey;
  programId?: PublicKey;
}
const pid = (d: { programId?: PublicKey }) => d.programId ?? BOND_V2_PROGRAM_ID;
export const dealOfV2 = (d: DealRef) => dealPdaV2(d.seller, d.buyer, d.nonce, pid(d));
const ix = (d: { programId?: PublicKey }, keys: AccountMeta[], bytes: Buffer) => new TransactionInstruction({ programId: pid(d), keys, data: bytes });

// ---------------- setup and admin ----------------

export const initConfigV2 = (payer: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [w(payer, true), w(configPdaV2(programId)), r(SystemProgram.programId)], data(DISC_V2.init_config));
export const initCounterV2 = (payer: PublicKey, mint: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [w(payer, true), r(mint), w(counterPdaV2(mint, programId)), r(SystemProgram.programId)], data(DISC_V2.init_counter));
export const setPausedV2 = (admin: PublicKey, paused: boolean, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [r(admin, true), w(configPdaV2(programId))], data(DISC_V2.set_paused, Buffer.from([paused ? 1 : 0])));
export const proposeAdminV2 = (admin: PublicKey, newAdmin: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [r(admin, true), w(configPdaV2(programId))], data(DISC_V2.propose_admin, newAdmin.toBytes()));
export const acceptAdminV2 = (newAdmin: PublicKey, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [r(newAdmin, true), w(configPdaV2(programId))], data(DISC_V2.accept_admin));
export const proposeCapsV2 = (admin: PublicKey, mint: PublicKey, perDeal: bigint, total: bigint, programId = BOND_V2_PROGRAM_ID) =>
  ix({ programId }, [r(admin, true), r(configPdaV2(programId)), w(counterPdaV2(mint, programId))], data(DISC_V2.propose_caps, u64(perDeal), u64(total)));

// ---------------- deal lifecycle ----------------

export interface OpenTermsV2 {
  price: bigint;
  sellerBond: bigint;
  buyerDeposit: bigint;
  /** unix seconds */
  deliverBy: bigint;
  grace: bigint;
  reviewWindow: bigint;
  /** share of the buyer deposit the seller gets if a marked deal is never accepted (0..10000, 0 = neutral) */
  sellerShareBps: number;
  /** omit for no arbiter */
  arbiter?: PublicKey;
  /** 0 when there is no arbiter */
  arbiterWindow: bigint;
  /** sha256 of the canonical job description */
  jobHash: Uint8Array;
}

export interface OpenAccountsV2 {
  /** pays the bond (signer, also pays rent) */
  sellerToken: PublicKey;
  /** pays the deposit (signer) */
  buyerToken: PublicKey;
  /** token account owned by the seller */
  sellerPayout: PublicKey;
  /** token account owned by the buyer */
  buyerPayout: PublicKey;
}

export function openV2(d: DealRef, a: OpenAccountsV2, t: OpenTermsV2): TransactionInstruction {
  if (t.jobHash.length !== 32) throw new Error('jobHash must be 32 bytes');
  const deal = dealOfV2(d);
  return ix(d, [
    w(d.seller, true), r(d.buyer, true), r(d.mint),
    w(a.sellerToken), w(a.buyerToken), r(a.sellerPayout), r(a.buyerPayout),
    w(deal), w(vaultPdaV2(deal, pid(d))), w(counterPdaV2(d.mint, pid(d))), r(configPdaV2(pid(d))),
    r(d.tokenProgram), r(SystemProgram.programId),
  ], data(DISC_V2.open, u64(d.nonce), u64(t.price), u64(t.sellerBond), u64(t.buyerDeposit), i64(t.deliverBy), i64(t.grace), i64(t.reviewWindow),
    u16(t.sellerShareBps), (t.arbiter ?? PublicKey.default).toBytes(), i64(t.arbiterWindow), t.jobHash));
}

export const markDeliveredV2 = (d: DealRef, outputHash: Uint8Array) => {
  if (outputHash.length !== 32) throw new Error('outputHash must be 32 bytes');
  return ix(d, [r(d.seller, true), w(dealOfV2(d))], data(DISC_V2.mark_delivered, outputHash));
};

/** Buyer accepts and pays `price - buyerDeposit` from `buyerToken` to the recorded seller payout. */
export function acceptV2(d: DealRef, buyerToken: PublicKey, sellerPayout: PublicKey): TransactionInstruction {
  const deal = dealOfV2(d);
  return ix(d, [
    r(d.buyer, true), w(deal), r(d.mint), w(buyerToken), w(sellerPayout), r(vaultPdaV2(deal, pid(d))), w(counterPdaV2(d.mint, pid(d))), r(d.tokenProgram),
  ], data(DISC_V2.accept));
}

const decideKeys = (d: DealRef, signers: PublicKey[]) => {
  const deal = dealOfV2(d);
  return [...signers.map((s) => r(s, true)), w(deal), r(vaultPdaV2(deal, pid(d))), w(counterPdaV2(d.mint, pid(d)))];
};
/** Anyone, once time has fixed the outcome. */
export const settleV2 = (d: DealRef) => ix(d, decideKeys(d, []), data(DISC_V2.settle));
/** Seller and buyer: each side gets its own money back. */
export const cancelV2 = (d: DealRef) => ix(d, decideKeys(d, [d.seller, d.buyer]), data(DISC_V2.cancel));
/** Seller and buyer: any split of the locked amount (`toSeller` of `sellerBond + buyerDeposit`). */
export const settleAgreedV2 = (d: DealRef, toSeller: bigint) => ix(d, decideKeys(d, [d.seller, d.buyer]), data(DISC_V2.settle_agreed, u64(toSeller)));
/** Seller alone, neutral end (not with an arbiter, not after the mark deadline of an unmarked deal). */
export const sellerReleaseV2 = (d: DealRef) => ix(d, decideKeys(d, [d.seller]), data(DISC_V2.seller_release));
/** The named arbiter, inside its window. */
export const decideV2 = (d: DealRef, arbiter: PublicKey, toSeller: bigint) => ix(d, decideKeys(d, [arbiter]), data(DISC_V2.decide, u64(toSeller)));
/** Seller and buyer: longer deadlines only. */
export const extendV2 = (d: DealRef, deliverBy: bigint, reviewWindow: bigint) =>
  ix(d, [r(d.seller, true), r(d.buyer, true), w(dealOfV2(d))], data(DISC_V2.extend, i64(deliverBy), i64(reviewWindow)));
/** A party replaces its own payout account (same mint, owned by that party). */
export const setPayoutV2 = (d: DealRef, party: PublicKey, newPayout: PublicKey) =>
  ix(d, [r(party, true), w(dealOfV2(d)), r(d.mint), r(newPayout), r(d.tokenProgram)], data(DISC_V2.set_payout));

const claimKeys = (d: DealRef, rentPayer: PublicKey, to: PublicKey) => {
  const deal = dealOfV2(d);
  return [w(rentPayer), w(deal), r(d.mint), w(vaultPdaV2(deal, pid(d))), w(to), r(d.tokenProgram)];
};
/** Anyone: pays the seller what it is owed, to the recorded seller payout. */
export const claimSellerV2 = (d: DealRef, rentPayer: PublicKey, sellerPayout: PublicKey) => ix(d, claimKeys(d, rentPayer, sellerPayout), data(DISC_V2.claim_seller));
/** Anyone: pays the buyer everything beyond what the seller is still owed (also sweeps tokens sent to the vault). */
export const claimBuyerV2 = (d: DealRef, rentPayer: PublicKey, buyerPayout: PublicKey) => ix(d, claimKeys(d, rentPayer, buyerPayout), data(DISC_V2.claim_buyer));

// ---------------- accounts ----------------

export interface DealV2 {
  version: number;
  seller: PublicKey; buyer: PublicKey; mint: PublicKey; arbiter: PublicKey | null;
  rentPayer: PublicKey; sellerPayout: PublicKey; buyerPayout: PublicKey;
  seq: bigint; nonce: bigint;
  price: bigint; sellerBond: bigint; buyerDeposit: bigint;
  deliverBy: bigint; grace: bigint; reviewWindow: bigint; arbiterWindow: bigint; sellerShareBps: number;
  openedAt: bigint; markedAt: bigint | null; settledAt: bigint | null;
  state: 'Open' | 'Marked' | 'Settled';
  outcome: Outcome | null;
  owedSeller: bigint; owedBuyer: bigint;
  sellerClaimed: boolean; buyerClaimed: boolean; vaultShort: boolean;
  jobHash: Uint8Array; outputHash: Uint8Array;
}

/** Deal account size (8-byte discriminator included). */
export const DEAL_V2_SIZE = 450;

const hasDisc = (b: Uint8Array, d: readonly number[]) => d.every((x, i) => b[i] === x);

export function decodeDealV2(raw: Uint8Array): DealV2 {
  if (raw.length < DEAL_V2_SIZE || !hasDisc(raw, ACCOUNT_DISC_V2.Deal)) throw new Error('not a Bond v2 Deal account');
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const pk = (o: number) => new PublicKey(b.subarray(o, o + 32));
  const st = b[331];
  const state = st === STATE.Open ? 'Open' : st === STATE.Marked ? 'Marked' : st === STATE.Settled ? 'Settled' : null;
  if (!state) throw new Error(`unknown deal state ${st}`);
  const arbiter = pk(105);
  const markedAt = b.readBigInt64LE(315);
  const settledAt = b.readBigInt64LE(323);
  return {
    version: b[8],
    seller: pk(9), buyer: pk(41), mint: pk(73), arbiter: arbiter.equals(PublicKey.default) ? null : arbiter,
    rentPayer: pk(137), sellerPayout: pk(169), buyerPayout: pk(201),
    seq: b.readBigUInt64LE(233), nonce: b.readBigUInt64LE(241),
    price: b.readBigUInt64LE(249), sellerBond: b.readBigUInt64LE(257), buyerDeposit: b.readBigUInt64LE(265),
    deliverBy: b.readBigInt64LE(273), grace: b.readBigInt64LE(281), reviewWindow: b.readBigInt64LE(289), arbiterWindow: b.readBigInt64LE(297),
    sellerShareBps: b.readUInt16LE(305),
    openedAt: b.readBigInt64LE(307),
    markedAt: state === 'Marked' || markedAt !== 0n ? markedAt : null,
    settledAt: state === 'Settled' ? settledAt : null,
    state,
    outcome: state === 'Settled' ? OUTCOMES[b[332]] ?? null : null,
    owedSeller: b.readBigUInt64LE(333), owedBuyer: b.readBigUInt64LE(341),
    sellerClaimed: b[349] === 1, buyerClaimed: b[350] === 1, vaultShort: b[351] === 1,
    jobHash: new Uint8Array(b.subarray(352, 384)), outputHash: new Uint8Array(b.subarray(384, 416)),
  };
}

export interface CounterV2 {
  mint: PublicKey; totalLocked: bigint; openDeals: bigint; settledDeals: bigint; nextSeq: bigint;
  capPerDeal: bigint; capTotal: bigint; pendingPerDeal: bigint; pendingTotal: bigint; pendingEffectiveAt: bigint;
}
export function decodeCounterV2(raw: Uint8Array): CounterV2 {
  if (raw.length < 114 || !hasDisc(raw, ACCOUNT_DISC_V2.Counter)) throw new Error('not a Bond v2 Counter account');
  const b = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return {
    mint: new PublicKey(b.subarray(9, 41)), totalLocked: b.readBigUInt64LE(41), openDeals: b.readBigUInt64LE(49), settledDeals: b.readBigUInt64LE(57),
    nextSeq: b.readBigUInt64LE(65), capPerDeal: b.readBigUInt64LE(73), capTotal: b.readBigUInt64LE(81),
    pendingPerDeal: b.readBigUInt64LE(89), pendingTotal: b.readBigUInt64LE(97), pendingEffectiveAt: b.readBigInt64LE(105),
  };
}
/** Caps in force at `now` (a pending change takes effect at `pendingEffectiveAt`). */
export const effectiveCapsV2 = (c: CounterV2, now: bigint) =>
  c.pendingEffectiveAt !== 0n && now >= c.pendingEffectiveAt ? { perDeal: c.pendingPerDeal, total: c.pendingTotal } : { perDeal: c.capPerDeal, total: c.capTotal };

// ---------------- rules (same as the core crate) ----------------

type Terms = Pick<DealV2, 'price' | 'sellerBond' | 'buyerDeposit' | 'deliverBy' | 'grace' | 'reviewWindow' | 'arbiterWindow' | 'sellerShareBps'>;
const max = (a: bigint, b: bigint) => (a > b ? a : b);

export const lockedV2 = (t: Terms) => t.sellerBond + t.buyerDeposit;
/** Mark deadline (and accept deadline of an unmarked deal). */
export const markDeadlineV2 = (t: Terms) => t.deliverBy + t.grace;
/** Accept deadline after a mark: counts from `deliverBy` at the earliest. */
export const acceptDeadlineV2 = (t: Terms, markedAt: bigint) => max(markedAt, t.deliverBy) + t.reviewWindow;
/** End of the arbiter window (equal to the accept deadline without an arbiter). */
export const arbiterEndV2 = (t: Terms, markedAt: bigint) => acceptDeadlineV2(t, markedAt) + t.arbiterWindow;
/** From this time `settle` always succeeds, whatever the parties do. */
export const settleByV2 = (t: Terms) => t.deliverBy + t.grace + t.reviewWindow + t.arbiterWindow + 1n;

/** What time alone decides at `now`, or null if `settle` would fail. Amounts are of the locked total. */
export function timeOutcomeV2(d: Pick<DealV2, keyof Terms | 'state' | 'markedAt'>, now: bigint): { outcome: Outcome; toSeller: bigint; toBuyer: bigint } | null {
  const l = lockedV2(d);
  if (d.state === 'Open' && now > markDeadlineV2(d)) return { outcome: 'SellerDefault', toSeller: 0n, toBuyer: l };
  if (d.state === 'Marked' && d.markedAt !== null && now > arbiterEndV2(d, d.markedAt)) {
    const k = (d.buyerDeposit * BigInt(d.sellerShareBps)) / 10_000n;
    const s = d.sellerBond + k;
    return { outcome: 'Unconfirmed', toSeller: s, toBuyer: l - s };
  }
  return null;
}

/** Checks open terms like the program does (caps and pause excluded). Returns the error name or null. */
export function checkTermsV2(t: OpenTermsV2, now: bigint, seller: PublicKey, buyer: PublicKey): (typeof ERRORS_V2)[number] | null {
  if (seller.equals(buyer)) return 'SameParty';
  if (t.price === 0n) return 'ZeroPrice';
  if (t.sellerBond === 0n) return 'ZeroBond';
  if (t.sellerBond > (t.price * LIMITS_V2.maxBondBps) / 10_000n) return 'BondTooLarge';
  if (t.buyerDeposit > t.price) return 'DepositTooLarge';
  if (t.deliverBy <= now) return 'DeadlineInPast';
  if (t.deliverBy - now > LIMITS_V2.maxDeliver) return 'TermTooLong';
  if (t.grace < LIMITS_V2.graceMin || t.grace > LIMITS_V2.graceMax) return 'GraceOutOfRange';
  if (t.reviewWindow < LIMITS_V2.reviewMin || t.reviewWindow > LIMITS_V2.reviewMax) return 'ReviewWindowOutOfRange';
  if (t.sellerShareBps < 0 || t.sellerShareBps > 10_000) return 'BadShare';
  if (t.arbiter && !t.arbiter.equals(PublicKey.default)) {
    if (t.arbiter.equals(seller) || t.arbiter.equals(buyer)) return 'BadArbiter';
    if (t.arbiterWindow < LIMITS_V2.arbiterMin || t.arbiterWindow > LIMITS_V2.arbiterMax) return 'BadArbiter';
  } else if (t.arbiterWindow !== 0n) return 'BadArbiter';
  return null;
}

/**
 * Claims still needed for a settled deal, in a safe order. When both sides are owed, the buyer claim goes first
 * (it never closes the deal while the seller is owed); the seller claim then closes it. Send them in one
 * transaction, or one by one if a payout account is frozen or closed (the other side is not blocked).
 */
export function claimsV2(
  d: DealRef,
  deal: Pick<DealV2, 'rentPayer' | 'sellerPayout' | 'buyerPayout' | 'sellerClaimed' | 'buyerClaimed' | 'state'>,
  /** vault token balance; when both sides are done but tokens were sent to the vault, a buyer claim sweeps them and closes the deal */
  vaultAmount?: bigint,
): TransactionInstruction[] {
  if (deal.state !== 'Settled') return [];
  const out: TransactionInstruction[] = [];
  if (!deal.buyerClaimed) out.push(claimBuyerV2(d, deal.rentPayer, deal.buyerPayout));
  if (!deal.sellerClaimed) out.push(claimSellerV2(d, deal.rentPayer, deal.sellerPayout));
  if (out.length === 0 && (vaultAmount ?? 0n) > 0n) out.push(claimBuyerV2(d, deal.rentPayer, deal.buyerPayout));
  return out;
}

/**
 * settle plus the claims time implies, for a deal that is not settled yet (anyone can send this). Uses the
 * same rules as the program to predict what is owed; returns null if time has not fixed the outcome at `now`.
 */
export function settleAndClaimV2(d: DealRef, deal: DealV2, now: bigint): TransactionInstruction[] | null {
  const o = timeOutcomeV2(deal, now);
  if (!o) return null;
  const ixs = [settleV2(d)];
  if (o.toBuyer > 0n) ixs.push(claimBuyerV2(d, deal.rentPayer, deal.buyerPayout));
  if (o.toSeller > 0n) ixs.push(claimSellerV2(d, deal.rentPayer, deal.sellerPayout));
  return ixs;
}

// ---------------- events ----------------

type F = 'pk' | 'u64' | 'i64' | 'u16' | 'u8' | 'bool' | 'h32';
/** Event layouts in program field order (Borsh). Discriminator = sha256("event:<Name>")[..8]. */
export const EVENTS_V2 = {
  ConfigInitialized: { disc: [181, 49, 200, 156, 19, 167, 178, 91], fields: [['admin', 'pk']] },
  CounterInitialized: { disc: [115, 205, 233, 189, 129, 219, 117, 64], fields: [['mint', 'pk'], ['capPerDeal', 'u64'], ['capTotal', 'u64']] },
  Opened: {
    disc: [166, 172, 97, 9, 77, 76, 189, 109],
    fields: [['deal', 'pk'], ['seq', 'u64'], ['seller', 'pk'], ['buyer', 'pk'], ['mint', 'pk'], ['price', 'u64'], ['sellerBond', 'u64'], ['buyerDeposit', 'u64'],
      ['deliverBy', 'i64'], ['grace', 'i64'], ['reviewWindow', 'i64'], ['sellerShareBps', 'u16'], ['arbiter', 'pk'], ['arbiterWindow', 'i64'], ['jobHash', 'h32'],
      ['rentPayer', 'pk'], ['sellerPayout', 'pk'], ['buyerPayout', 'pk'], ['openedAt', 'i64']],
  },
  Delivered: { disc: [148, 178, 60, 250, 87, 49, 149, 65], fields: [['deal', 'pk'], ['seq', 'u64'], ['markedAt', 'i64'], ['outputHash', 'h32'], ['acceptDeadline', 'i64']] },
  Settled: {
    disc: [232, 210, 40, 17, 142, 124, 145, 238],
    fields: [['deal', 'pk'], ['seq', 'u64'], ['seller', 'pk'], ['buyer', 'pk'], ['mint', 'pk'], ['outcome', 'u8'], ['toSeller', 'u64'], ['toBuyer', 'u64'],
      ['balancePaid', 'u64'], ['vaultShort', 'bool'], ['at', 'i64']],
  },
  Claimed: { disc: [217, 192, 123, 72, 108, 150, 248, 33], fields: [['deal', 'pk'], ['seq', 'u64'], ['side', 'u8'], ['amount', 'u64'], ['to', 'pk']] },
  Closed: { disc: [50, 31, 87, 155, 135, 220, 195, 239], fields: [['deal', 'pk'], ['seq', 'u64'], ['rentPayer', 'pk']] },
  Extended: { disc: [5, 76, 91, 44, 187, 214, 114, 165], fields: [['deal', 'pk'], ['seq', 'u64'], ['deliverBy', 'i64'], ['reviewWindow', 'i64']] },
  PayoutChanged: { disc: [174, 152, 48, 114, 25, 63, 230, 39], fields: [['deal', 'pk'], ['seq', 'u64'], ['side', 'u8'], ['payout', 'pk']] },
  CapsProposed: { disc: [138, 37, 24, 220, 174, 20, 251, 244], fields: [['mint', 'pk'], ['perDeal', 'u64'], ['total', 'u64'], ['effectiveAt', 'i64']] },
  PauseChanged: { disc: [238, 188, 213, 78, 134, 209, 178, 218], fields: [['paused', 'bool'], ['at', 'i64']] },
  AdminProposed: { disc: [129, 249, 226, 227, 199, 82, 110, 243], fields: [['admin', 'pk'], ['pendingAdmin', 'pk']] },
  AdminChanged: { disc: [232, 34, 31, 226, 62, 18, 19, 114], fields: [['oldAdmin', 'pk'], ['newAdmin', 'pk']] },
} as const satisfies Record<string, { disc: readonly number[]; fields: readonly (readonly [string, F])[] }>;

export type EventNameV2 = keyof typeof EVENTS_V2;
export interface EventV2 { name: EventNameV2; data: Record<string, PublicKey | bigint | number | boolean | Uint8Array> }

/** Decodes one event payload (discriminator + Borsh fields). Returns null for anything else. */
export function decodeEventV2(bytes: Uint8Array): EventV2 | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [name, ev] of Object.entries(EVENTS_V2) as [EventNameV2, (typeof EVENTS_V2)[EventNameV2]][]) {
    if (b.length < 8 || !hasDisc(b, ev.disc)) continue;
    const out: EventV2['data'] = {};
    let o = 8;
    try {
      for (const [k, t] of ev.fields as readonly (readonly [string, F])[]) {
        if (t === 'pk') { out[k] = new PublicKey(b.subarray(o, o + 32)); o += 32; }
        else if (t === 'h32') { if (o + 32 > b.length) throw new RangeError(); out[k] = new Uint8Array(b.subarray(o, o + 32)); o += 32; }
        else if (t === 'u64') { out[k] = b.readBigUInt64LE(o); o += 8; }
        else if (t === 'i64') { out[k] = b.readBigInt64LE(o); o += 8; }
        else if (t === 'u16') { out[k] = b.readUInt16LE(o); o += 2; }
        else if (t === 'u8') { out[k] = b.readUInt8(o); o += 1; }
        else { out[k] = b.readUInt8(o) === 1; o += 1; }
      }
    } catch { return null; }
    if (o !== b.length) return null;
    if (name === 'Settled') out.outcomeName = OUTCOMES[out.outcome as number] as unknown as Uint8Array;
    return { name, data: out };
  }
  return null;
}

/**
 * Bond v2 events in a transaction's log messages ("Program data: <base64>" lines emitted while the bond
 * program is the innermost running program). Logs can be truncated; an indexer should also read accounts.
 */
export function eventsFromLogsV2(logs: readonly string[], programId = BOND_V2_PROGRAM_ID): EventV2[] {
  const stack: string[] = [];
  const out: EventV2[] = [];
  const id = programId.toBase58();
  for (const line of logs) {
    const inv = /^Program (\S+) invoke \[\d+\]$/.exec(line);
    if (inv) { stack.push(inv[1]); continue; }
    if (/^Program (\S+) (success|failed)/.test(line)) { stack.pop(); continue; }
    const m = /^Program data: (\S+)$/.exec(line);
    if (m && stack[stack.length - 1] === id) {
      const e = decodeEventV2(Buffer.from(m[1], 'base64'));
      if (e) out.push(e);
    }
  }
  return out;
}
