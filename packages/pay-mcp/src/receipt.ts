// Checks a seller's signed receipt (header x-agent402-receipt, made by @agent402-dev/pay-server) against what this client actually sent, received and paid.
// The receipt proves that the holder of the receipt key signed it. Which seller owns that key is up to the seller to publish.
import { getBase58Encoder } from '@solana/kit';

export const RECEIPT_HEADER = 'x-agent402-receipt';

export interface ReceiptCheck {
  /** Base58 public key that signed the receipt (null if unreadable) */
  signer: string | null;
  /** true only if the signature is valid and every field matches */
  verified: boolean;
  /** Why it is not verified */
  reasons: string[];
  /** The receipt as received (keep it as evidence) */
  token: string;
}

export interface ReceiptExpect {
  method: string;
  /** URL the payment request was sent to (only path and query are compared, as the server may see another host behind a proxy) */
  url: string;
  requestBody?: string;
  responseBody: ArrayBuffer;
  payment: { network: string; asset: string; amount: string; payTo: string; transaction?: string };
}

const b64urlDecode = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha256Hex = async (d: ArrayBuffer | Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', d as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('');
const pathOf = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };

export async function checkReceipt(token: string, e: ReceiptExpect): Promise<ReceiptCheck> {
  const fail = (signer: string | null, reasons: string[]): ReceiptCheck => ({ signer, verified: false, reasons, token });
  const parts = token.split('.');
  if (parts.length !== 2 || token.length > 8_000) return fail(null, ['receipt_malformed']);
  let bytes: Uint8Array;
  let r: { v?: number; kind?: string; signer?: string; request?: { method?: string; path?: string; bodySha256?: string | null }; response?: { bodySha256?: string }; payment?: Record<string, string | null> };
  try {
    bytes = b64urlDecode(parts[0]);
    r = JSON.parse(new TextDecoder().decode(bytes));
  } catch { return fail(null, ['receipt_malformed']); }
  const signer = typeof r.signer === 'string' ? r.signer : null;
  if (r.v !== 1 || r.kind !== 'agent402.x402-receipt' || !signer) return fail(signer, ['receipt_unknown_format']);
  let sigOk = false;
  try {
    const pub = getBase58Encoder().encode(signer);
    const key = await crypto.subtle.importKey('raw', pub as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    sigOk = await crypto.subtle.verify('Ed25519', key, b64urlDecode(parts[1]) as BufferSource, bytes as BufferSource);
  } catch { sigOk = false; }
  const reasons: string[] = [];
  if (!sigOk) reasons.push('receipt_bad_signature');
  const p = r.payment ?? {};
  for (const k of ['network', 'asset', 'amount', 'payTo'] as const) if (p[k] !== e.payment[k]) reasons.push(`receipt_payment_mismatch: ${k}`);
  if (e.payment.transaction && p.transaction && p.transaction !== e.payment.transaction) reasons.push('receipt_payment_mismatch: transaction');
  if ((r.request?.method ?? '').toUpperCase() !== e.method.toUpperCase()) reasons.push('receipt_request_mismatch: method');
  if (r.request?.path !== pathOf(e.url)) reasons.push('receipt_request_mismatch: path');
  const reqHash = e.requestBody ? await sha256Hex(new TextEncoder().encode(e.requestBody)) : null;
  if ((r.request?.bodySha256 ?? null) !== reqHash) reasons.push('receipt_request_mismatch: body');
  if (r.response?.bodySha256 !== (await sha256Hex(e.responseBody))) reasons.push('receipt_response_mismatch: body');
  return { signer, verified: reasons.length === 0, reasons, token };
}
