/**
 * Agent402 Bond Job Protocol v2 — shared by buyer and seller tools (spec: Bond v2 spec section 9).
 *
 *   GET  {base}/quote                       -> JobQuoteV2
 *   POST {base}/open    { buyer, input }    -> JobOpenV2   (open transaction signed by the seller)
 *   POST {base}/deliver { deal, expires, signature } -> JobDeliveryV2
 *
 * Commitments: `job_hash` (stored at open) binds the program, both parties, the nonce, the deadline, the exact input
 * and the description. `output_hash` (stored at mark) binds the deal, the job hash, a status and the exact result.
 * The seller also signs the output hash off chain. The buyer accepts only when all three agree.
 * Hashes use Web Crypto (Node 20+, Workers, browsers). No JSON canonicalisation: strings are hashed as UTF-8 bytes.
 * No dependencies: addresses are base58 strings or 32 raw bytes.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Base58 decode (Bitcoin alphabet). Throws on a bad character. */
export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET.indexOf(c);
    if (v < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
/** 32 raw bytes of an address, or throws. */
export function addrBytes(a: string | Uint8Array): Uint8Array {
  const b = typeof a === 'string' ? b58decode(a) : a;
  if (b.length !== 32) throw new Error('address must be 32 bytes');
  return b;
}

export const JOB_PROTOCOL_V2 = 'agent402-bond-job/2';
export const JOB_MAX_INPUT_V2 = 16_384;
export const JOB_DELIVER_MAX_AGE_V2 = 600;
export type JobStatusV2 = 'ok' | 'job_failed';

export interface JobQuoteV2 {
  protocol: typeof JOB_PROTOCOL_V2;
  program: string;
  seller: string;
  /** token account owned by the seller where it is paid */
  sellerPayout: string;
  mint: string;
  tokenProgram: string;
  /** smallest units, decimal strings */
  price: string;
  sellerBond: string;
  buyerDeposit: string;
  /** seconds, decimal strings */
  deliverSeconds: string;
  grace: string;
  reviewWindow: string;
  /** 0..10000 */
  sellerShareBps: number;
  arbiter: string | null;
  arbiterWindow: string;
  description?: string;
}

export interface JobTermsV2 {
  price: string; sellerBond: string; buyerDeposit: string; deliverBy: string; grace: string; reviewWindow: string;
  sellerShareBps: number; arbiter: string | null; arbiterWindow: string;
}
export interface JobOpenV2 { deal: string; nonce: string; terms: JobTermsV2; jobHash: string; transaction: string }
export interface JobDeliveryV2 { deal: string; status: JobStatusV2; result: string; outputHash: string; sellerSignature: string; markTx: string | null }

const DEC = /^\d{1,20}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HEX32 = /^[0-9a-f]{64}$/;

const isAddr = (v: unknown) => {
  if (typeof v !== 'string' || !B58.test(v)) return false;
  try { addrBytes(v); return true; } catch { return false; }
};

/** Shape problems of a v2 quote (empty if well formed). Business rules are the buyer's own. */
export function checkJobQuoteV2(q: unknown): string[] {
  const out: string[] = [];
  const o = (q ?? {}) as Record<string, unknown>;
  if (o.protocol !== JOB_PROTOCOL_V2) out.push(`protocol must be ${JOB_PROTOCOL_V2}`);
  for (const k of ['program', 'seller', 'sellerPayout', 'mint', 'tokenProgram']) if (!isAddr(o[k])) out.push(`${k} must be a base58 address`);
  for (const k of ['price', 'sellerBond', 'buyerDeposit', 'deliverSeconds', 'grace', 'reviewWindow', 'arbiterWindow']) {
    if (typeof o[k] !== 'string' || !DEC.test(o[k] as string)) out.push(`${k} must be a decimal string`);
  }
  if (!Number.isInteger(o.sellerShareBps) || (o.sellerShareBps as number) < 0 || (o.sellerShareBps as number) > 10_000) out.push('sellerShareBps must be an integer 0..10000');
  if (o.arbiter !== null && !isAddr(o.arbiter)) out.push('arbiter must be a base58 address or null');
  if (o.description !== undefined && (typeof o.description !== 'string' || [...o.description].length > 500)) out.push('description must be text up to 500 characters');
  return out;
}

/** Shape problems of the terms in an /open response. */
export function checkJobTermsV2(t: unknown): string[] {
  const o = (t ?? {}) as Record<string, unknown>;
  const out = ['price', 'sellerBond', 'buyerDeposit', 'deliverBy', 'grace', 'reviewWindow', 'arbiterWindow']
    .filter((k) => typeof o[k] !== 'string' || !DEC.test(o[k] as string))
    .map((k) => `terms.${k} must be a decimal string`);
  if (!Number.isInteger(o.sellerShareBps)) out.push('terms.sellerShareBps must be an integer');
  if (o.arbiter !== null && !isAddr(o.arbiter)) out.push('terms.arbiter must be a base58 address or null');
  return out;
}

/** Terms of an /open response against the quote: every field equal, deliverBy within deliverSeconds of `now` (+ slack). */
export function termsMatchQuoteV2(t: JobTermsV2, q: JobQuoteV2, now: bigint, slack = 120n): string[] {
  const out: string[] = [];
  for (const k of ['price', 'sellerBond', 'buyerDeposit', 'grace', 'reviewWindow', 'arbiterWindow'] as const) if (t[k] !== q[k]) out.push(`${k} differs from the quote`);
  if (t.sellerShareBps !== q.sellerShareBps) out.push('sellerShareBps differs from the quote');
  if ((t.arbiter ?? null) !== (q.arbiter ?? null)) out.push('arbiter differs from the quote');
  const by = BigInt(t.deliverBy);
  if (by <= now) out.push('deliverBy is in the past');
  if (by > now + BigInt(q.deliverSeconds) + slack) out.push('deliverBy is later than the quote allows');
  return out;
}

// ---------------- hashes ----------------

const enc = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const le64 = (v: bigint, signed: boolean) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  if (signed) dv.setBigInt64(0, v, true); else dv.setBigUint64(0, v, true);
  return b;
};
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
}
export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string) => {
  if (!HEX32.test(h)) throw new Error('expected 32 bytes as lowercase hex');
  return Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
};

export interface JobHashInput {
  program: string | Uint8Array; seller: string | Uint8Array; buyer: string | Uint8Array; nonce: bigint; deliverBy: bigint;
  /** the buyer's input exactly as sent */
  input: string;
  /** the quote's description ('' if none) */
  description?: string;
}
/** job_hash = SHA256("agent402-bond-job/2:job" 0x00 program seller buyer nonce(u64 LE) deliver_by(i64 LE) sha256(input) sha256(description)). */
export async function jobHashV2(j: JobHashInput): Promise<Uint8Array> {
  return sha256(cat(
    enc.encode(`${JOB_PROTOCOL_V2}:job`), new Uint8Array([0]),
    addrBytes(j.program), addrBytes(j.seller), addrBytes(j.buyer), le64(j.nonce, false), le64(j.deliverBy, true),
    await sha256(enc.encode(j.input)), await sha256(enc.encode(j.description ?? '')),
  ));
}
/** output_hash = SHA256("agent402-bond-job/2:out" 0x00 deal job_hash status(0 ok, 1 job_failed) sha256(result)). */
export async function outputHashV2(deal: string | Uint8Array, jobHash: Uint8Array, status: JobStatusV2, result: string): Promise<Uint8Array> {
  if (jobHash.length !== 32) throw new Error('jobHash must be 32 bytes');
  return sha256(cat(enc.encode(`${JOB_PROTOCOL_V2}:out`), new Uint8Array([0]), addrBytes(deal), jobHash, new Uint8Array([status === 'ok' ? 0 : 1]), await sha256(enc.encode(result))));
}

/** Bytes the seller signs for a delivery (0xff prefix: never a Solana transaction message). */
export function outputMessageV2(deal: string, outputHash: Uint8Array): Uint8Array {
  return cat(new Uint8Array([0xff]), enc.encode(`${JOB_PROTOCOL_V2}:output:${deal}:${toHex(outputHash)}`));
}
/** Bytes the buyer signs to fetch a delivery (bound to deal, seller origin and expiry). */
export function deliverMessageV2(deal: string, origin: string, expires: number): Uint8Array {
  return cat(new Uint8Array([0xff]), enc.encode(`${JOB_PROTOCOL_V2}:deliver:${deal}:${origin}:${expires}`));
}

const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

async function ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signatureBase64: string): Promise<boolean> {
  try {
    const sig = unb64(signatureBase64);
    if (sig.length !== 64 || publicKey.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, new Uint8Array(sig), new Uint8Array(message));
  } catch { return false; }
}
export const verifyOutputSignatureV2 = (seller: string | Uint8Array, deal: string, outputHash: Uint8Array, signatureBase64: string) =>
  ed25519Verify(addrBytes(seller), outputMessageV2(deal, outputHash), signatureBase64);
export async function verifyDeliverSignatureV2(buyer: string | Uint8Array, deal: string, origin: string, expires: number, signatureBase64: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!Number.isSafeInteger(expires) || expires < nowSeconds || expires > nowSeconds + JOB_DELIVER_MAX_AGE_V2) return false;
  return ed25519Verify(addrBytes(buyer), deliverMessageV2(deal, origin, expires), signatureBase64);
}

/**
 * Everything the buyer checks before `accept` (spec 9): the delivery is well formed and ok, the output hash recomputed
 * from the received result matches the one in the delivery and the one stored on chain, and the seller signed it.
 * Returns the problems (empty = accept may proceed).
 */
export async function checkDeliveryV2(p: {
  delivery: JobDeliveryV2; deal: string; seller: string; jobHash: Uint8Array; onChainOutputHash: Uint8Array;
}): Promise<string[]> {
  const d = p.delivery;
  const out: string[] = [];
  if (d.deal !== p.deal) out.push('delivery is for another deal');
  if (d.status !== 'ok' && d.status !== 'job_failed') out.push('unknown delivery status');
  if (d.status === 'job_failed') out.push('the seller reports the job failed');
  if (typeof d.result !== 'string') out.push('result must be a string');
  if (typeof d.outputHash !== 'string' || !HEX32.test(d.outputHash)) out.push('outputHash must be 32 bytes as lowercase hex');
  if (out.length) return out;
  const h = await outputHashV2(p.deal, p.jobHash, d.status, d.result);
  if (toHex(h) !== d.outputHash) out.push('output hash does not match the received result');
  if (toHex(p.onChainOutputHash) !== toHex(h)) out.push('output hash on chain does not match the received result');
  if (!(await verifyOutputSignatureV2(p.seller, d.deal, h, d.sellerSignature))) out.push('seller signature over the output hash is not valid');
  return out;
}
