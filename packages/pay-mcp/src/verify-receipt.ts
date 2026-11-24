// Standalone check of a seller's signed x402 receipt (header x-agent402-receipt from @agent402-dev/pay-server), for anyone
// holding one: a buyer later, a seller, or a third party in a dispute. Always checks the signature; checks the request,
// response, signer and on-chain payment only for what is given. Read only: never signs or pays.
import { getBase58Encoder } from '@solana/kit';

export interface ReceiptFields {
  v: number; kind: string; issuedAt?: string; signer: string;
  request?: { method?: string; path?: string; bodySha256?: string | null };
  response?: { status?: number; bodySha256?: string };
  payment?: { network?: string; asset?: string; amount?: string; payTo?: string; transaction?: string | null };
}
interface TokenBal { mint: string; owner?: string; uiTokenAmount: { amount: string } }
export interface ChainTx { meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null }
export interface VerifyOptions {
  /** Base58 key the receipt must be signed by (e.g. the key the seller publishes) */
  expectedSigner?: string;
  /** The seller's published receipt key, read from its GET / (x402.receiptSigner). null = the seller publishes none */
  sellerPublishedSigner?: string | null;
  method?: string;
  /** Request URL or path (only path and query are compared) */
  url?: string;
  /** Request body as sent (omit for no body; pass "" only if an empty body was sent) */
  requestBody?: string;
  /** Response body as received (text), or its SHA-256 hex */
  responseBody?: string;
  responseBodySha256?: string;
  /** The settlement transaction read from chain (null = not found) */
  chainTx?: ChainTx | null;
}
export interface Check { check: string; ok: boolean; detail?: string }

const b64urlDecode = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const sha256Hex = async (d: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', d as BufferSource)), (b) => b.toString(16).padStart(2, '0')).join('');
const pathOf = (u: string) => { try { const x = new URL(u); return `${x.pathname}${x.search}`; } catch { return u; } };

export function decodeReceipt(token: string): { fields: ReceiptFields; bytes: Uint8Array; sig: Uint8Array } | null {
  const parts = token.trim().split('.');
  if (parts.length !== 2 || token.length > 8_000) return null;
  try {
    const bytes = b64urlDecode(parts[0]);
    const fields = JSON.parse(new TextDecoder().decode(bytes)) as ReceiptFields;
    if (!fields || typeof fields !== 'object') return null;
    return { fields, bytes, sig: b64urlDecode(parts[1]) };
  } catch { return null; }
}

/** Amount of `mint` that `owner` received in a transaction (post − pre over all its token accounts), base units */
export function receivedIn(tx: ChainTx, owner: string, mint: string): bigint {
  let d = 0n;
  for (const b of tx.meta?.preTokenBalances ?? []) if (b.owner === owner && b.mint === mint) d -= BigInt(b.uiTokenAmount.amount);
  for (const b of tx.meta?.postTokenBalances ?? []) if (b.owner === owner && b.mint === mint) d += BigInt(b.uiTokenAmount.amount);
  return d;
}

export async function verifyReceipt(token: string, o: VerifyOptions = {}) {
  const dec = decodeReceipt(token);
  if (!dec) return { result: 'malformed' as const, verified: false, reasons: ['receipt_malformed: expected "<base64url JSON>.<base64url signature>"'] };
  const r = dec.fields;
  if (r.v !== 1 || r.kind !== 'agent402.x402-receipt' || typeof r.signer !== 'string') {
    return { result: 'malformed' as const, verified: false, reasons: ['receipt_unknown_format'], receipt: r };
  }
  const checks: Check[] = [];
  let sigOk = false;
  try {
    const key = await crypto.subtle.importKey('raw', getBase58Encoder().encode(r.signer) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    sigOk = await crypto.subtle.verify('Ed25519', key, dec.sig as BufferSource, dec.bytes as BufferSource);
  } catch { sigOk = false; }
  checks.push({ check: 'signature', ok: sigOk, detail: sigOk ? `signed by ${r.signer}` : 'the signature does not match the receipt and its signer' });
  const notChecked: string[] = [];

  if (o.expectedSigner !== undefined) checks.push({ check: 'signer_expected', ok: o.expectedSigner === r.signer, detail: `expected ${o.expectedSigner}` });
  if (o.sellerPublishedSigner !== undefined) {
    checks.push(o.sellerPublishedSigner === null
      ? { check: 'signer_published_by_seller', ok: false, detail: 'the seller publishes no receipt key at GET / (x402.receiptSigner)' }
      : { check: 'signer_published_by_seller', ok: o.sellerPublishedSigner === r.signer, detail: `seller publishes ${o.sellerPublishedSigner}` });
  }
  if (o.expectedSigner === undefined && o.sellerPublishedSigner === undefined) notChecked.push('who owns the signing key (give expectedSigner or sellerUrl)');

  if (o.method !== undefined) checks.push({ check: 'request_method', ok: (r.request?.method ?? '').toUpperCase() === o.method.toUpperCase(), detail: `receipt ${r.request?.method ?? 'none'}` });
  if (o.url !== undefined) checks.push({ check: 'request_path', ok: r.request?.path === pathOf(o.url), detail: `receipt ${r.request?.path ?? 'none'}` });
  if (o.requestBody !== undefined) {
    const h = await sha256Hex(new TextEncoder().encode(o.requestBody));
    checks.push({ check: 'request_body', ok: (r.request?.bodySha256 ?? null) === h });
  }
  if (o.method === undefined && o.url === undefined && o.requestBody === undefined) notChecked.push('the request (give method, url, requestBody)');

  const respHash = o.responseBody !== undefined ? await sha256Hex(new TextEncoder().encode(o.responseBody)) : o.responseBodySha256?.toLowerCase();
  if (respHash !== undefined) checks.push({ check: 'response_body', ok: r.response?.bodySha256 === respHash });
  else notChecked.push('the response body (give responseBody or responseBodySha256)');

  const p = r.payment ?? {};
  if (o.chainTx !== undefined) {
    if (!p.transaction) checks.push({ check: 'payment_on_chain', ok: false, detail: 'the receipt names no settlement transaction' });
    else if (o.chainTx === null) checks.push({ check: 'payment_on_chain', ok: false, detail: `transaction ${p.transaction} not found on the configured RPC` });
    else if (o.chainTx.meta?.err) checks.push({ check: 'payment_on_chain', ok: false, detail: 'the settlement transaction failed on chain' });
    else {
      const got = p.payTo && p.asset ? receivedIn(o.chainTx, p.payTo, p.asset) : 0n;
      const want = /^\d+$/.test(p.amount ?? '') ? BigInt(p.amount!) : -1n;
      checks.push({ check: 'payment_on_chain', ok: got === want, detail: `payTo received ${got} base units of the asset in that transaction; receipt says ${p.amount}` });
    }
  } else notChecked.push('the payment on chain (needs an RPC and a settlement transaction in the receipt)');

  const failed = checks.filter((c) => !c.ok);
  return {
    result: (failed.length ? 'not_verified' : 'verified') as 'verified' | 'not_verified',
    verified: failed.length === 0,
    signer: r.signer,
    receipt: r,
    checks,
    reasons: failed.map((c) => `${c.check}${c.detail ? `: ${c.detail}` : ''}`),
    notChecked,
    note: 'A valid signature proves the holder of the signing key signed this record. Which seller owns that key is what the seller publishes (GET / x402.receiptSigner).',
  };
}

/** getTransaction over JSON-RPC (encoding json: only the token balances are used); null when not found. Read only */
export function rpcReadTx(rpc: string) {
  return async (signature: string): Promise<ChainTx | null> => {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }] }) });
    const j = (await r.json()) as { result?: ChainTx | null; error?: { message: string } };
    if (j.error) throw new Error(`rpc getTransaction: ${String(j.error.message).replace(/https?:\/\/\S+/g, '[address]').slice(0, 200)}`);
    return j.result ?? null;
  };
}

