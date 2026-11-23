// Agent402 Bond transactions without web3.js: addresses, instructions, and the legacy wire format (parse, compile, sign).
// Parsing our own bytes lets the buyer check exactly what it signs; nothing is trusted from the counterparty.
import { getAddressEncoder, getBase58Decoder, getBase58Encoder, getProgramDerivedAddress, type Address } from '@solana/kit';
import { BOND_PROGRAM } from './bond.js';

export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** sha256("global:<name>")[..8] — same values as @agent402-dev/bond-client DISC (checked in tests). */
export const BOND_DISC = {
  open: [228, 220, 155, 71, 199, 189, 60, 45],
  confirm_receipt: [203, 36, 80, 115, 249, 12, 141, 170],
  pay_balance: [121, 220, 140, 105, 242, 163, 148, 24],
  settle: [175, 42, 185, 87, 144, 131, 102, 212],
  claim_seller: [238, 218, 144, 171, 49, 203, 29, 50],
  claim_buyer: [13, 61, 90, 109, 208, 223, 195, 211],
} as const;

const enc = new TextEncoder();
const addrBytes = (a: string) => Uint8Array.from(getAddressEncoder().encode(a as Address));
const b58 = { dec: getBase58Decoder(), enc: getBase58Encoder() };
const u64le = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };
const pda = async (program: string, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress: program as Address, seeds }))[0] as string;

export const configPda = () => pda(BOND_PROGRAM, [enc.encode('config')]);
export const counterPda = (mint: string) => pda(BOND_PROGRAM, [enc.encode('counter'), addrBytes(mint)]);
export const dealPda = (seller: string, buyer: string, nonce: bigint) => pda(BOND_PROGRAM, [enc.encode('deal'), addrBytes(seller), addrBytes(buyer), u64le(nonce)]);
export const vaultPda = (deal: string) => pda(BOND_PROGRAM, [enc.encode('vault'), addrBytes(deal)]);
export const ataOf = (owner: string, mint: string, tokenProgram = TOKEN_PROGRAM) => pda(ATA_PROGRAM, [addrBytes(owner), addrBytes(tokenProgram), addrBytes(mint)]);

export interface Meta { pubkey: string; isSigner: boolean; isWritable: boolean }
export interface Ix { programId: string; keys: Meta[]; data: Uint8Array }
const w = (pubkey: string, isSigner = false): Meta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: string, isSigner = false): Meta => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: Meta[], data: Uint8Array): Ix => ({ programId: BOND_PROGRAM, keys, data });

export interface OpenTerms { price: bigint; sellerBond: bigint; buyerDeposit: bigint; deliverBy: bigint; lateWindow: bigint; payWindow: bigint }
export interface DealKeys { seller: string; buyer: string; mint: string; tokenProgram: string; nonce: bigint }

export function openData(nonce: bigint, t: OpenTerms): Uint8Array {
  const b = new Uint8Array(8 + 8 * 7);
  const v = new DataView(b.buffer);
  b.set(BOND_DISC.open, 0);
  [nonce, t.price, t.sellerBond, t.buyerDeposit].forEach((x, i) => v.setBigUint64(8 + 8 * i, x, true));
  [t.deliverBy, t.lateWindow, t.payWindow].forEach((x, i) => v.setBigInt64(40 + 8 * i, x, true));
  return b;
}
export function decodeOpenData(data: Uint8Array): { nonce: bigint; terms: OpenTerms } | null {
  if (data.length !== 64 || BOND_DISC.open.some((x, i) => data[i] !== x)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u = (o: number) => v.getBigUint64(o, true), s = (o: number) => v.getBigInt64(o, true);
  return { nonce: u(8), terms: { price: u(16), sellerBond: u(24), buyerDeposit: u(32), deliverBy: s(40), lateWindow: s(48), payWindow: s(56) } };
}

export async function openIx(d: DealKeys, t: OpenTerms): Promise<Ix> {
  const deal = await dealPda(d.seller, d.buyer, d.nonce);
  return ix([
    w(d.seller, true), r(d.buyer, true), r(d.mint),
    w(await ataOf(d.seller, d.mint, d.tokenProgram)), w(await ataOf(d.buyer, d.mint, d.tokenProgram)),
    w(deal), w(await vaultPda(deal)), w(await counterPda(d.mint)), r(await configPda()), r(d.tokenProgram), r(SYSTEM_PROGRAM),
  ], openData(d.nonce, t));
}
export const confirmIx = (buyer: string, deal: string) => ix([r(buyer, true), w(deal)], Uint8Array.from(BOND_DISC.confirm_receipt));
export async function payIx(d: DealKeys, deal: string): Promise<Ix> {
  return ix([r(d.buyer, true), w(deal), r(d.mint), w(await ataOf(d.buyer, d.mint, d.tokenProgram)), w(await ataOf(d.seller, d.mint, d.tokenProgram)), r(d.tokenProgram)],
    Uint8Array.from(BOND_DISC.pay_balance));
}
/** settle, then claim_buyer, then claim_seller (order matters: claim_seller closes the deal). */
export async function settleAndClaimIxs(d: DealKeys, deal: string): Promise<Ix[]> {
  const vault = await vaultPda(deal);
  const claim = (to: string, disc: readonly number[]) => ix([w(d.seller), w(deal), r(d.mint), w(vault), w(to), r(d.tokenProgram)], Uint8Array.from(disc));
  return [
    ix([w(deal), r(vault), w(await counterPda(d.mint))], Uint8Array.from(BOND_DISC.settle)),
    claim(await ataOf(d.buyer, d.mint, d.tokenProgram), BOND_DISC.claim_buyer),
    claim(await ataOf(d.seller, d.mint, d.tokenProgram), BOND_DISC.claim_seller),
  ];
}

// ---------- legacy wire format ----------
function shortvecEncode(n: number): number[] {
  const out: number[] = [];
  for (;;) { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); if (!n) return out; }
}
/** compact-u16, canonical only (as the runtime accepts it). */
function shortvecDecode(b: Uint8Array, o: number): [number, number] {
  let n = 0, shift = 0;
  for (let i = 0; i < 3; i++) {
    const x = b[o++];
    if (x === undefined) throw new Error('truncated');
    if (i === 2 && x > 3) throw new Error('bad shortvec');
    n |= (x & 0x7f) << shift; shift += 7;
    if (!(x & 0x80)) {
      if (i > 0 && x === 0) throw new Error('non-canonical shortvec');
      return [n, o];
    }
  }
  throw new Error('bad shortvec');
}

export interface ParsedTx {
  signatures: Uint8Array[];
  /** Offset of the message within the transaction bytes */
  messageOffset: number;
  message: Uint8Array;
  header: { numRequiredSignatures: number; numReadonlySigned: number; numReadonlyUnsigned: number };
  keys: string[];
  blockhash: string;
  instructions: { programId: string; keys: Meta[]; data: Uint8Array }[];
}

/** Parses a legacy (non-versioned) transaction. Throws on anything else or on trailing bytes. */
export function parseTx(tx: Uint8Array): ParsedTx {
  let o = 0;
  let n: number;
  [n, o] = shortvecDecode(tx, o);
  const signatures: Uint8Array[] = [];
  if (n > 16 || o + 64 * n > tx.length) throw new Error('bad signature count');
  for (let i = 0; i < n; i++) { signatures.push(tx.slice(o, o + 64)); o += 64; }
  const messageOffset = o;
  if (tx[o] === undefined) throw new Error('truncated');
  if (tx[o] & 0x80) throw new Error('versioned transactions are not accepted');
  const header = { numRequiredSignatures: tx[o], numReadonlySigned: tx[o + 1], numReadonlyUnsigned: tx[o + 2] };
  o += 3;
  [n, o] = shortvecDecode(tx, o);
  const keys: string[] = [];
  for (let i = 0; i < n; i++) { if (o + 32 > tx.length) throw new Error('truncated'); keys.push(b58.dec.decode(tx.subarray(o, o + 32))); o += 32; }
  const blockhash = b58.dec.decode(tx.subarray(o, o + 32)); o += 32;
  const isSigner = (i: number) => i < header.numRequiredSignatures;
  const isWritable = (i: number) => isSigner(i) ? i < header.numRequiredSignatures - header.numReadonlySigned : i < keys.length - header.numReadonlyUnsigned;
  const meta = (i: number): Meta => { if (i >= keys.length) throw new Error('bad account index'); return { pubkey: keys[i], isSigner: isSigner(i), isWritable: isWritable(i) }; };
  [n, o] = shortvecDecode(tx, o);
  const instructions: ParsedTx['instructions'] = [];
  for (let k = 0; k < n; k++) {
    const p = tx[o++];
    let m: number; [m, o] = shortvecDecode(tx, o);
    const idx = Array.from(tx.subarray(o, o + m)); o += m;
    let dl: number; [dl, o] = shortvecDecode(tx, o);
    const data = tx.slice(o, o + dl); o += dl;
    if (o > tx.length) throw new Error('truncated');
    instructions.push({ programId: meta(p).pubkey, keys: idx.map(meta), data });
  }
  if (o !== tx.length) throw new Error('trailing bytes');
  if (signatures.length !== header.numRequiredSignatures) throw new Error('signature count mismatch');
  return { signatures, messageOffset, message: tx.slice(messageOffset), header, keys, blockhash, instructions };
}

/** Compiles a legacy message (fee payer first; signers, then writable before read-only). */
export function compileMessage(feePayer: string, ixs: Ix[], blockhash: string): { message: Uint8Array; signers: string[] } {
  const metas = new Map<string, { s: boolean; w: boolean }>();
  const add = (k: string, s: boolean, wr: boolean) => { const m = metas.get(k); metas.set(k, { s: (m?.s ?? false) || s, w: (m?.w ?? false) || wr }); };
  add(feePayer, true, true);
  for (const i of ixs) { for (const k of i.keys) add(k.pubkey, k.isSigner, k.isWritable); add(i.programId, false, false); }
  const rank = (k: string) => { const m = metas.get(k)!; return k === feePayer ? -1 : (m.s ? 0 : 2) + (m.w ? 0 : 1); };
  const keys = [...metas.keys()].sort((a, b) => rank(a) - rank(b));
  const sig = keys.filter((k) => metas.get(k)!.s);
  const header = [sig.length, sig.filter((k) => !metas.get(k)!.w).length, keys.filter((k) => !metas.get(k)!.s && !metas.get(k)!.w).length];
  const idx = (k: string) => keys.indexOf(k);
  const bytes: number[] = [...header, ...shortvecEncode(keys.length)];
  for (const k of keys) bytes.push(...addrBytes(k));
  bytes.push(...b58.enc.encode(blockhash));
  bytes.push(...shortvecEncode(ixs.length));
  for (const i of ixs) {
    bytes.push(idx(i.programId), ...shortvecEncode(i.keys.length), ...i.keys.map((k) => idx(k.pubkey)), ...shortvecEncode(i.data.length), ...i.data);
  }
  return { message: Uint8Array.from(bytes), signers: sig };
}

/** Wire bytes: signatures in signer order (missing ones zero) followed by the message. */
export function assemble(message: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  const head = shortvecEncode(signatures.length);
  const out = new Uint8Array(head.length + 64 * signatures.length + message.length);
  out.set(head, 0);
  signatures.forEach((s, i) => out.set(s, head.length + 64 * i));
  out.set(message, head.length + 64 * signatures.length);
  return out;
}

/** The transaction id is the first signature (base58). */
export const txId = (sig: Uint8Array) => b58.dec.decode(sig);
