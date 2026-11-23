/**
 * Agent402 Bond Job Protocol v1 — the parts both sides share (no dependencies).
 * Spec: docs/bond/JOB-PROTOCOL.md
 *
 *   GET  {base}/quote                      -> JobQuote
 *   POST {base}/open    { buyer, input }   -> JobOpen   (open transaction signed by the seller)
 *   POST {base}/deliver { deal, expires, signature } -> JobDelivery (after the work, delivery marked on chain)
 */

export const JOB_PROTOCOL = 'agent402-bond-job/1';
/** Max input size in bytes (UTF-8). */
export const JOB_MAX_INPUT = 16_384;

export interface JobQuote {
  protocol: typeof JOB_PROTOCOL;
  program: string;
  seller: string;
  mint: string;
  tokenProgram: string;
  /** Amounts in the mint's smallest unit, as decimal strings */
  price: string;
  sellerBond: string;
  buyerDeposit: string;
  /** Seconds after opening the seller promises to deliver */
  deliverSeconds: string;
  lateWindow: string;
  payWindow: string;
  /** Free text: what the job is (plain text, at most 500 characters) */
  description?: string;
}

export interface JobTerms { price: string; sellerBond: string; buyerDeposit: string; deliverBy: string; lateWindow: string; payWindow: string }
export interface JobOpen { deal: string; nonce: string; terms: JobTerms; transaction: string }
export interface JobDelivery { deal: string; result: unknown; markTx: string | null }

const DEC = /^\d{1,20}$/;
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Returns the problems with a quote (empty if it is well formed). Business rules (limits, allowlists) are the buyer's own. */
export function checkJobQuote(q: unknown): string[] {
  const out: string[] = [];
  const o = (q ?? {}) as Record<string, unknown>;
  if (o.protocol !== JOB_PROTOCOL) out.push(`protocol must be ${JOB_PROTOCOL}`);
  for (const k of ['program', 'seller', 'mint', 'tokenProgram']) if (typeof o[k] !== 'string' || !B58.test(o[k] as string)) out.push(`${k} must be a base58 address`);
  for (const k of ['price', 'sellerBond', 'buyerDeposit', 'deliverSeconds', 'lateWindow', 'payWindow']) if (typeof o[k] !== 'string' || !DEC.test(o[k] as string)) out.push(`${k} must be a decimal string`);
  if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 500)) out.push('description must be text up to 500 characters');
  return out;
}

/** Whether the terms of an `open` match a quote (deliverBy within deliverSeconds of `now`, allowing `slack` seconds). */
export function termsMatchQuote(t: JobTerms, q: JobQuote, now: bigint, slack = 120n): string[] {
  const out: string[] = [];
  for (const k of ['price', 'sellerBond', 'buyerDeposit', 'lateWindow', 'payWindow'] as const) if (t[k] !== q[k]) out.push(`${k} differs from the quote`);
  const by = BigInt(t.deliverBy);
  if (by <= now) out.push('deliverBy is in the past');
  if (by > now + BigInt(q.deliverSeconds) + slack) out.push('deliverBy is later than the quote allows');
  return out;
}

const enc = new TextEncoder();
/** A delivery request signature is valid for at most this many seconds. */
export const JOB_DELIVER_MAX_AGE = 600;

/**
 * Bytes the buyer signs to fetch a delivery: bound to the deal, to the seller's origin (scheme://host[:port]) and to an
 * expiry (unix seconds), so a signature given to one server cannot be replayed to another or reused later.
 * They start with 0xff so they can never be read as a Solana transaction message (same idea as Solana off-chain messages).
 */
export function deliverMessage(deal: string, origin: string, expires: number): Uint8Array {
  const body = enc.encode(`${JOB_PROTOCOL}:deliver:${deal}:${origin}:${expires}`);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0xff;
  out.set(body, 1);
  return out;
}

const DEC_TERMS = /^\d{1,20}$/;
/** Shape check for the terms in an /open response (before any arithmetic on them). */
export function checkJobTerms(t: unknown): string[] {
  const o = (t ?? {}) as Record<string, unknown>;
  return ['price', 'sellerBond', 'buyerDeposit', 'deliverBy', 'lateWindow', 'payWindow']
    .filter((k) => typeof o[k] !== 'string' || !DEC_TERMS.test(o[k] as string))
    .map((k) => `terms.${k} must be a decimal string`);
}

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const toBase64 = b64;
export const fromBase64 = unb64;

/**
 * Verifies a delivery request with Web Crypto (Node 20+, Cloudflare Workers, browsers): ed25519 by `publicKey`
 * (32 raw bytes) over deliverMessage(deal, origin, expires), and `expires` between now and now + JOB_DELIVER_MAX_AGE.
 */
export async function verifyDeliverSignature(
  publicKey: Uint8Array, deal: string, origin: string, expires: number, signatureBase64: string, nowSeconds = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(expires) || expires < nowSeconds || expires > nowSeconds + JOB_DELIVER_MAX_AGE) return false;
    const sig = unb64(signatureBase64);
    if (sig.length !== 64 || publicKey.length !== 32) return false;
    const key = await crypto.subtle.importKey('raw', new Uint8Array(publicKey), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, new Uint8Array(sig), new Uint8Array(deliverMessage(deal, origin, expires)));
  } catch {
    return false;
  }
}
