// Signed receipts (optional): after a settled payment the seller signs a small JSON record that binds
// the request, the hash of the response body and the payment. Buyers can keep it as evidence for disputes and settlement reports.
// Ed25519 through WebCrypto (Node 20+, Cloudflare Workers). Use a key made only for receipts, never the receiving wallet's key.
import { PublicKey } from '@solana/web3.js';

export const RECEIPT_HEADER = 'x-agent402-receipt';
export const RECEIPT_KIND = 'agent402.x402-receipt';

export interface Receipt {
  v: 1;
  kind: typeof RECEIPT_KIND;
  issuedAt: string;
  /** path is the URL path and query as the server received it */
  request: { method: string; path: string; bodySha256: string | null };
  response: { status: number; bodySha256: string };
  payment: { network: string; asset: string; amount: string; payTo: string; transaction: string | null };
  /** Optional: where the delivered data came from, so a buyer can re-fetch a sample and compare (see sourceFromHeader) */
  source?: ReceiptSource;
  /** Base58 Ed25519 public key of the receipt key */
  signer: string;
}

/**
 * Origin of the delivered data: https URL, when the seller fetched it, SHA-256 hex of the bytes it fetched, and whether
 * the source cannot change later (a past block, a fixed document). Only an immutable source makes a re-fetch mismatch
 * machine-checkable; for live data (prices, stock) a different re-fetch is not proof of an error.
 */
export interface ReceiptSource { url: string; fetchedAt: string; sha256: string; immutable: boolean }
/** Response header a paid handler may set (JSON ReceiptSource); the gate copies a valid one into the signed receipt */
export const SOURCE_HEADER = 'x-agent402-source';

/** A valid ReceiptSource from a header value, or null (bad or missing values are dropped, never guessed) */
export function sourceFromHeader(v: string | null | undefined): ReceiptSource | null {
  if (!v || v.length > 2_000) return null;
  let o: Record<string, unknown>;
  try { o = JSON.parse(v); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const { url, fetchedAt, sha256, immutable } = o;
  if (typeof url !== 'string' || !/^https:\/\/\S+$/.test(url)) return null;
  if (typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) return null;
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  if (typeof immutable !== 'boolean') return null;
  return { url, fetchedAt, sha256, immutable };
}

export interface ReceiptSigner {
  publicKey: string;
  sign(data: Uint8Array): Promise<Uint8Array>;
}

const PKCS8_ED25519_PREFIX = [0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];

export function b64url(u: Uint8Array): string {
  let s = '';
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Receipt key from a Solana CLI key file (64 bytes: seed + public key) or a 32-byte seed */
export async function receiptSignerFromBytes(bytes: Uint8Array): Promise<ReceiptSigner> {
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error('receipt key must be 64 bytes (Solana CLI key file) or a 32-byte seed');
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(PKCS8_ED25519_PREFIX);
  pkcs8.set(bytes.subarray(0, 32), 16);
  try {
    // Exportable copy only to read the public key; the signing key is not exportable
    const tmp = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign']);
    const pub = b64urlDecode(((await crypto.subtle.exportKey('jwk', tmp)) as JsonWebKey).x!);
    if (bytes.length === 64 && b64url(pub) !== b64url(bytes.subarray(32))) throw new Error('receipt key: the public key does not match the secret');
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    return {
      publicKey: new PublicKey(pub).toBase58(),
      async sign(data) { return new Uint8Array(await crypto.subtle.sign('Ed25519', key, data as BufferSource)); },
    };
  } finally {
    pkcs8.fill(0);
  }
}

/** Signs a receipt → header value "<base64url JSON>.<base64url signature>" (the signature covers the exact JSON bytes) */
export async function signReceipt(signer: ReceiptSigner, r: Omit<Receipt, 'v' | 'kind' | 'signer'>): Promise<string> {
  const receipt: Receipt = { v: 1, kind: RECEIPT_KIND, ...r, signer: signer.publicKey };
  const bytes = new TextEncoder().encode(JSON.stringify(receipt));
  return `${b64url(bytes)}.${b64url(await signer.sign(bytes))}`;
}
