// @agent402-dev/pay-server/route: one paid route with the real gate, a fake facilitator and a fake chain.
// Locks in: input checked before any 402, no settlement when the work fails, one use per payment.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import { SOLANA_MAINNET, USDC_MAINNET, type ChainReader, type ChainTx, type LedgerEntry } from '@agent402-dev/pay-server';
import { clearSupportedCache } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN } from '@agent402-dev/pay-server/chain';
import { type PaidRoute, paidRouteHandler, RequestRefused, storageLedger } from '@agent402-dev/pay-server/route';

/** A tiny input rule for the tests: {"signatures":[...]} with base58 strings, 1 to 20 */
function check(input: string): string | null {
  let o: unknown;
  try { o = JSON.parse(input); } catch { return 'input must be JSON'; }
  const s = (o as { signatures?: unknown })?.signatures;
  if (!Array.isArray(s) || s.length < 1 || s.length > 20 || !s.every((x) => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(x))) return 'signatures must be 1 to 20 base58 signatures';
  return null;
}

const pk = () => Keypair.generate().publicKey.toBase58();
const PAY_TO = pk();
const FEE = pk();
const SIG = '5'.repeat(87);
const URL_ = 'https://receipts.example/x402/receipts';

function fac() {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET, extra: { feePayer: FEE } }], extensions: [], signers: {} } as SupportedResponse; },
    async verify() { calls.verify++; return { isValid: true, payer: 'P' } as never; },
    async settle(): Promise<SettleResponse> { calls.settle++; return { success: true, transaction: 'SETTLED', network: SOLANA_MAINNET as SettleResponse['network'], payer: 'P' }; },
  };
  return { client, calls };
}
const payTx = () => btoa(String.fromCharCode(...new Uint8Array([2, ...new Uint8Array(64), ...Array.from({ length: 64 }, () => Math.floor(Math.random() * 250) + 1), 9, 9])));

async function setup(run: PaidRoute['run'] = async () => ({ receipts: ['ok'] })) {
  clearSupportedCache();
  const f = fac();
  const usdcAta = await ataOf(PAY_TO, USDC_MAINNET.mint, SPL_TOKEN);
  const settled: ChainTx = {
    signature: 'SETTLED', err: false, accountKeys: ['FEE'], signatures: ['SETTLED'],
    preTokenBalances: [{ accountIndex: 1, mint: USDC_MAINNET.mint, owner: PAY_TO, amount: '0' }],
    postTokenBalances: [{ accountIndex: 1, mint: USDC_MAINNET.mint, owner: PAY_TO, amount: '50000' }],
  };
  const chain: ChainReader = {
    async loadTx(s) { return s === 'SETTLED' ? settled : null; },
    async recentSignatures() { return []; },
    async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (a === usdcAta ? { owner: SPL_TOKEN, data: new Uint8Array(165) } : null)) }; },
  };
  const store = new Map<string, LedgerEntry>();
  const runs = { n: 0 };
  const route: PaidRoute = {
    path: '/x402/receipts', priceUsd: 0.05, description: 'receipts',
    fromQuery: (q) => { const v = q.get('signatures'); return v === null ? null : JSON.stringify({ signatures: v.split(',') }); },
    check,
    run: async (input) => { runs.n++; return run(input); },
  };
  const h = paidRouteHandler(route, () => ({
    payTo: PAY_TO, rpcUrl: 'http://unused', serviceName: 'test',
    ledger: storageLedger({ get: async (k) => store.get(k), put: async (k, e) => { store.set(k, e); }, delete: async (k) => { store.delete(k); } }),
    facilitators: [{ name: 'fake', assets: ['USDC'], client: f.client }],
    chain, gate: { confirmDelaysMs: [], handlerTimeoutMs: 1000 },
  }));
  return { h, f, runs, store };
}
const sign = (accepted: PaymentRequirements, tx = payTx()) =>
  encodePaymentSignatureHeader({ x402Version: 2, resource: { url: URL_ }, accepted, payload: { transaction: tx } } as never);
const post = (body: string, headers: Record<string, string> = {}) => new Request(URL_, { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } });
const valid = JSON.stringify({ signatures: [SIG] });
async function accepted(h: Awaited<ReturnType<typeof setup>>['h']) {
  const r = (await h(new Request(URL_)))!;
  expect(r.status).toBe(402);
  return decodePaymentRequiredHeader(r.headers.get('payment-required')!).accepts[0];
}

describe('paid route', () => {
  it('ignores other paths', async () => {
    const { h } = await setup();
    expect(await h(new Request('https://receipts.example/quote'))).toBeNull();
  });
  it('answers 402 with the USDC price (0.05 USD = 50000) to the seller wallet when there is no input', async () => {
    const { h } = await setup();
    const a = await accepted(h);
    expect(a).toMatchObject({ amount: '50000', payTo: PAY_TO, asset: USDC_MAINNET.mint, network: SOLANA_MAINNET });
  });
  it('refuses malformed input with 400 before asking for payment', async () => {
    const { h, f } = await setup();
    const r = (await h(post('{"signatures":["nope"]}')))!;
    expect(r.status).toBe(400);
    expect(r.headers.get('payment-required')).toBeNull();
    const q = (await h(new Request(`${URL_}?signatures=bad`)))!;
    expect(q.status).toBe(400);
    expect(f.calls.verify).toBe(0);
  });
  it('a valid request without payment gets the 402; with payment: verify → work → settle, 200', async () => {
    const { h, f, runs } = await setup();
    expect((await h(post(valid)))!.status).toBe(402);
    expect(runs.n).toBe(0);
    const r = (await h(post(valid, { 'payment-signature': sign(await accepted(h)) })))!;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ receipts: ['ok'] });
    expect(f.calls).toEqual({ verify: 1, settle: 1 });
  });
  it('GET with ?signatures= works the same', async () => {
    const { h, f } = await setup();
    const r = (await h(new Request(`${URL_}?signatures=${SIG}`, { headers: { 'payment-signature': sign(await accepted(h)) } })))!;
    expect(r.status).toBe(200);
    expect(f.calls.settle).toBe(1);
  });
  it('work that cannot be done → 422 and the payment is not settled', async () => {
    const { h, f } = await setup(async () => { throw new RequestRefused('none found'); });
    const r = (await h(post(valid, { 'payment-signature': sign(await accepted(h)) })))!;
    expect(r.status).toBe(422);
    expect(r.headers.get('x-payment-status')).toBe('not-settled');
    expect(f.calls.settle).toBe(0);
  });
  it('an RPC failure during the work → 502, not settled', async () => {
    const { h, f } = await setup(async () => { throw new Error('rpc down'); });
    const r = (await h(post(valid, { 'payment-signature': sign(await accepted(h)) })))!;
    expect(r.status).toBe(502);
    expect(f.calls.settle).toBe(0);
  });
  it('the same payment cannot be used twice (ledger in storage)', async () => {
    const { h, f, store } = await setup();
    const header = sign(await accepted(h));
    expect((await h(post(valid, { 'payment-signature': header })))!.status).toBe(200);
    const again = (await h(post(valid, { 'payment-signature': header })))!;
    expect(again.status).toBe(409);
    expect(f.calls.settle).toBe(1);
    expect([...store.values()].map((e) => e.state)).toEqual(['fulfilled']);
  });
  it('a payment header without any input → 400, nothing verified', async () => {
    const { h, f } = await setup();
    const r = (await h(new Request(URL_, { method: 'POST', headers: { 'payment-signature': sign(await accepted(h)) } })))!;
    expect(r.status).toBe(400);
    expect(f.calls.verify).toBe(0);
  });
  it('other methods → 405', async () => {
    const { h } = await setup();
    expect((await h(new Request(URL_, { method: 'PUT', body: valid })))!.status).toBe(405);
  });
});

describe('options', () => {
  it('refuses to start without rpcUrl or chain (on the first paid request)', async () => {
    const h = paidRouteHandler({ path: '/p', priceUsd: 0.01, description: 'd', check: () => null, run: async () => ({}) }, () => ({ payTo: PAY_TO }));
    await expect(h(new Request('https://x.example/p'))).rejects.toThrow(/rpcUrl or chain/);
  });
  it('POST-only routes (no fromQuery) answer 405 for other methods and list POST', async () => {
    const h = paidRouteHandler({ path: '/p', priceUsd: 0.01, description: 'd', check: () => null, run: async () => ({}) }, () => ({ payTo: PAY_TO, rpcUrl: 'http://unused' }));
    const r = (await h(new Request('https://x.example/p', { method: 'PUT' })))!;
    expect(r.status).toBe(405);
    expect((await r.json()).allow).toBe('POST');
  });
});

describe('signed receipts through the route', () => {
  it('a POST receipt binds the method and body the buyer sent (pay-mcp verifies it)', async () => {
    const { receiptSignerFromBytes, RECEIPT_HEADER } = await import('@agent402-dev/pay-server');
    const { checkReceipt } = await import('@agent402-dev/pay-mcp/receipt');
    const signer = await receiptSignerFromBytes(Keypair.generate().secretKey);
    clearSupportedCache();
    const f = fac();
    const usdcAta = await ataOf(PAY_TO, USDC_MAINNET.mint, SPL_TOKEN);
    const chain: ChainReader = {
      async loadTx(s) { return s === 'SETTLED' ? { signature: 'SETTLED', err: false, accountKeys: ['FEE'], signatures: ['SETTLED'], preTokenBalances: [{ accountIndex: 1, mint: USDC_MAINNET.mint, owner: PAY_TO, amount: '0' }], postTokenBalances: [{ accountIndex: 1, mint: USDC_MAINNET.mint, owner: PAY_TO, amount: '50000' }] } : null; },
      async recentSignatures() { return []; },
      async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (a === usdcAta ? { owner: SPL_TOKEN, data: new Uint8Array(165) } : null)) }; },
    };
    const h = paidRouteHandler({ path: '/x402/receipts', priceUsd: 0.05, description: 'r', check, run: async () => ({ ok: 1 }) }, () => ({
      payTo: PAY_TO, chain, facilitators: [{ name: 'fake', assets: ['USDC'], client: f.client }], gate: { confirmDelaysMs: [], receipts: { signer } },
    }));
    const a = await accepted(h);
    const res = (await h(post(valid, { 'payment-signature': sign(a) })))!;
    expect(res.status).toBe(200);
    const token = res.headers.get(RECEIPT_HEADER)!;
    const body = await res.arrayBuffer();
    const rc = await checkReceipt(token, { method: 'POST', url: URL_, requestBody: valid, responseBody: body, payment: { network: a.network, asset: a.asset, amount: a.amount, payTo: a.payTo, transaction: 'SETTLED' } });
    expect(rc).toMatchObject({ verified: true, signer: signer.publicKey, reasons: [] });
  });
});
