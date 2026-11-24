// Agent402 Bond v2 instructions and Deal decoding without web3.js (same layout as @agent402-dev/bond-client/v2, checked in tests).
// Every builder takes the v2 program id: it comes from a code constant (or a local test override), never from a server.
import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import type { Ix, Meta } from './bond-tx.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const DISC_V2 = {
  open: [228, 220, 155, 71, 199, 189, 60, 45],
  accept: [65, 150, 70, 216, 133, 6, 107, 4],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  claim_seller: [238, 218, 144, 171, 49, 203, 29, 50],
  claim_buyer: [13, 61, 90, 109, 208, 223, 195, 211],
} as const;
export const DEAL_V2_DISC = [125, 223, 160, 234, 71, 162, 182, 219];
export const DEAL_V2_SIZE = 450;

const enc = new TextEncoder();
const ab = (a: string) => Uint8Array.from(getAddressEncoder().encode(a as Address));
const addr = (b: Uint8Array) => getAddressDecoder().decode(b) as string;
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const i64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, v, true); return b; };
const u16 = (v: number) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return b; };
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const pda = async (program: string, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program as Address, seeds }))[0] as string;
const w = (pubkey: string, isSigner = false): Meta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: string, isSigner = false): Meta => ({ pubkey, isSigner, isWritable: false });

export const configPdaV2 = (program: string) => pda(program, [enc.encode('config')]);
export const counterPdaV2 = (program: string, mint: string) => pda(program, [enc.encode('counter'), ab(mint)]);
export const dealPdaV2 = (program: string, seller: string, buyer: string, nonce: bigint) => pda(program, [enc.encode('deal'), ab(seller), ab(buyer), u64(nonce)]);
export const vaultPdaV2 = (program: string, deal: string) => pda(program, [enc.encode('vault'), ab(deal)]);

export interface TermsV2 {
  price: bigint; sellerBond: bigint; buyerDeposit: bigint; deliverBy: bigint; grace: bigint; reviewWindow: bigint;
  sellerShareBps: number; arbiter: string | null; arbiterWindow: bigint; jobHash: Uint8Array;
}
export interface DealRefV2 { program: string; seller: string; buyer: string; nonce: bigint; mint: string; tokenProgram: string }

const NO_ARBITER = SYSTEM_PROGRAM; // Pubkey::default() is the all-zero key, whose base58 is the system program id

export function openDataV2(nonce: bigint, t: TermsV2): Uint8Array {
  if (t.jobHash.length !== 32) throw new Error('jobHash must be 32 bytes');
  return cat(Uint8Array.from(DISC_V2.open), u64(nonce), u64(t.price), u64(t.sellerBond), u64(t.buyerDeposit), i64(t.deliverBy), i64(t.grace), i64(t.reviewWindow),
    u16(t.sellerShareBps), ab(t.arbiter ?? NO_ARBITER), i64(t.arbiterWindow), t.jobHash);
}
export function decodeOpenDataV2(data: Uint8Array): { nonce: bigint; terms: TermsV2 } | null {
  if (data.length !== 8 + 8 * 7 + 2 + 32 + 8 + 32 || !DISC_V2.open.every((x, i) => data[i] === x)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const arb = addr(data.subarray(66, 98));
  return {
    nonce: v.getBigUint64(8, true),
    terms: {
      price: v.getBigUint64(16, true), sellerBond: v.getBigUint64(24, true), buyerDeposit: v.getBigUint64(32, true),
      deliverBy: v.getBigInt64(40, true), grace: v.getBigInt64(48, true), reviewWindow: v.getBigInt64(56, true),
      sellerShareBps: v.getUint16(64, true), arbiter: arb === NO_ARBITER ? null : arb, arbiterWindow: v.getBigInt64(98, true),
      jobHash: data.slice(106, 138),
    },
  };
}

export async function openIxV2(d: DealRefV2, a: { sellerToken: string; buyerToken: string; sellerPayout: string; buyerPayout: string }, t: TermsV2): Promise<Ix> {
  const deal = await dealPdaV2(d.program, d.seller, d.buyer, d.nonce);
  return { programId: d.program, data: openDataV2(d.nonce, t), keys: [
    w(d.seller, true), r(d.buyer, true), r(d.mint), w(a.sellerToken), w(a.buyerToken), r(a.sellerPayout), r(a.buyerPayout),
    w(deal), w(await vaultPdaV2(d.program, deal)), w(await counterPdaV2(d.program, d.mint)), r(await configPdaV2(d.program)),
    r(d.tokenProgram), r(SYSTEM_PROGRAM),
  ] };
}
export async function acceptIxV2(d: DealRefV2, buyerToken: string, sellerPayout: string): Promise<Ix> {
  const deal = await dealPdaV2(d.program, d.seller, d.buyer, d.nonce);
  return { programId: d.program, data: Uint8Array.from(DISC_V2.accept), keys: [
    r(d.buyer, true), w(deal), r(d.mint), w(buyerToken), w(sellerPayout), r(await vaultPdaV2(d.program, deal)), w(await counterPdaV2(d.program, d.mint)), r(d.tokenProgram),
  ] };
}
export async function settleIxV2(program: string, deal: string, mint: string): Promise<Ix> {
  return { programId: program, data: Uint8Array.from(DISC_V2.settle), keys: [w(deal), r(await vaultPdaV2(program, deal)), w(await counterPdaV2(program, mint))] };
}
export async function claimIxV2(program: string, deal: string, mint: string, tokenProgram: string, rentPayer: string, to: string, buyerSide: boolean): Promise<Ix> {
  return { programId: program, data: Uint8Array.from(buyerSide ? DISC_V2.claim_buyer : DISC_V2.claim_seller), keys: [
    w(rentPayer), w(deal), r(mint), w(await vaultPdaV2(program, deal)), w(to), r(tokenProgram),
  ] };
}

export interface DealV2 {
  seller: string; buyer: string; mint: string; arbiter: string | null; rentPayer: string; sellerPayout: string; buyerPayout: string;
  seq: bigint; nonce: bigint; price: bigint; sellerBond: bigint; buyerDeposit: bigint;
  deliverBy: bigint; grace: bigint; reviewWindow: bigint; arbiterWindow: bigint; sellerShareBps: number;
  openedAt: bigint; markedAt: bigint | null; state: 'Open' | 'Marked' | 'Settled'; outcome: number;
  owedSeller: bigint; owedBuyer: bigint; sellerClaimed: boolean; buyerClaimed: boolean; vaultShort: boolean;
  jobHash: Uint8Array; outputHash: Uint8Array;
}
export function decodeDealV2(data: Uint8Array): DealV2 | null {
  if (data.length < DEAL_V2_SIZE || !DEAL_V2_DISC.every((x, i) => data[i] === x)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pk = (o: number) => addr(data.subarray(o, o + 32));
  const st = data[331];
  const state = st === 1 ? 'Open' : st === 2 ? 'Marked' : st === 3 ? 'Settled' : null;
  if (!state) return null;
  const arb = pk(105);
  const markedAt = v.getBigInt64(315, true);
  return {
    seller: pk(9), buyer: pk(41), mint: pk(73), arbiter: arb === NO_ARBITER ? null : arb, rentPayer: pk(137), sellerPayout: pk(169), buyerPayout: pk(201),
    seq: v.getBigUint64(233, true), nonce: v.getBigUint64(241, true), price: v.getBigUint64(249, true), sellerBond: v.getBigUint64(257, true), buyerDeposit: v.getBigUint64(265, true),
    deliverBy: v.getBigInt64(273, true), grace: v.getBigInt64(281, true), reviewWindow: v.getBigInt64(289, true), arbiterWindow: v.getBigInt64(297, true),
    sellerShareBps: v.getUint16(305, true), openedAt: v.getBigInt64(307, true), markedAt: state === 'Marked' || markedAt !== 0n ? markedAt : null,
    state, outcome: data[332], owedSeller: v.getBigUint64(333, true), owedBuyer: v.getBigUint64(341, true),
    sellerClaimed: data[349] === 1, buyerClaimed: data[350] === 1, vaultShort: data[351] === 1,
    jobHash: data.slice(352, 384), outputHash: data.slice(384, 416),
  };
}

// Rules (same as the core crate)
export const markDeadlineV2 = (d: Pick<DealV2, 'deliverBy' | 'grace'>) => d.deliverBy + d.grace;
export const acceptDeadlineV2 = (d: Pick<DealV2, 'deliverBy' | 'reviewWindow'>, markedAt: bigint) => (markedAt > d.deliverBy ? markedAt : d.deliverBy) + d.reviewWindow;
export function acceptOpenUntil(d: DealV2): bigint | null {
  if (d.state === 'Open') return markDeadlineV2(d);
  if (d.state === 'Marked' && d.markedAt !== null) return acceptDeadlineV2(d, d.markedAt);
  return null;
}
/** What time alone decides at `now` ({toSeller, toBuyer} of the locked amount), or null if settle would fail. */
export function timeOutcomeV2(d: DealV2, now: bigint): { outcome: 'SellerDefault' | 'Unconfirmed'; toSeller: bigint; toBuyer: bigint } | null {
  const l = d.sellerBond + d.buyerDeposit;
  if (d.state === 'Open' && now > markDeadlineV2(d)) return { outcome: 'SellerDefault', toSeller: 0n, toBuyer: l };
  if (d.state === 'Marked' && d.markedAt !== null && now > acceptDeadlineV2(d, d.markedAt) + d.arbiterWindow) {
    const s = d.sellerBond + (d.buyerDeposit * BigInt(d.sellerShareBps)) / 10_000n;
    return { outcome: 'Unconfirmed', toSeller: s, toBuyer: l - s };
  }
  return null;
}
