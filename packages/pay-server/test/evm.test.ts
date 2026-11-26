// @agent402-dev/pay-server/evm: Base (EIP-3009) payments with a fake facilitator and a fake chain, alone and beside Solana in one route.
// Locks in: local checks before verify, one use per authorization, no settlement when the work fails,
// unknown settlements decided on chain (used → paid, unused after validBefore → not paid), Solana 402 first when both are on.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import { SOLANA_MAINNET, USDC_MAINNET, type ChainReader, type LedgerEntry } from '@agent402-dev/pay-server';
import { clearSupportedCache } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN } from '@agent402-dev/pay-server/chain';
import { type PaidRoute, paidRouteHandler, storageLedger } from '@agent402-dev/pay-server/route';
import {
  BASE_MAINNET, BASE_SEPOLIA, BASE_USDC, createEvmPaymentGate, eip3009Authorization, rpcEvmChain, type EvmChainReader,
} from '@agent402-dev/pay-server/evm';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const URL_ = 'https://seller.example/x402/csv';
const NOW = 1_800_000_000_000;

function fac(opts: { settle?: 'ok' | 'throw' | 'fail' } = {}) {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE_MAINNET }, { x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET, extra: { feePayer: Keypair.generate().publicKey.toBase58() } }], extensions: [], signers: {} } as SupportedResponse;
    },
    async verify() { calls.verify++; return { isValid: true, payer: BUYER } as never; },
    async settle(): Promise<SettleResponse> {
      calls.settle++;
      if (opts.settle === 'throw') throw new Error('timeout');
      if (opts.settle === 'fail') return { success: false, errorReason: 'unexpected', transaction: '', network: BASE_MAINNET as SettleResponse['network'] } as SettleResponse;
      return { success: true, transaction: '0xabc', network: BASE_MAINNET as SettleResponse['network'], payer: BUYER };
    },
  };
  return { client, calls };
}

function fakeChain() {
  const used = new Set<string>();
  const chain: EvmChainReader = { async authorizationUsed(_a, from, nonce) { return used.has(`${from.toLowerCase()}|${nonce}`); } };
  return { chain, used };
}

let n = 0;
const nonce = () => `0x${(++n).toString(16).padStart(64, '0')}`;
function pay(accepted: PaymentRequirements, o: Partial<{ to: string; value: string; validBefore: string; nonce: string; permit2: boolean }> = {}) {
  const authorization = { from: BUYER, to: o.to ?? accepted.payTo, value: o.value ?? accepted.amount, validAfter: '0', validBefore: o.validBefore ?? String(NOW / 1000 + 300), nonce: o.nonce ?? nonce() };
  const payload = o.permit2 ? { signature: '0x' + '1'.repeat(130), permit2Authorization: {} } : { signature: '0x' + '1'.repeat(130), authorization };
  return { header: encodePaymentSignatureHeader({ x402Version: 2, resource: { url: URL_ }, accepted, payload } as never), authorization };
}

function setup(o: { settle?: 'ok' | 'throw' | 'fail'; fail?: boolean; clock?: { t: number } } = {}) {
  const f = fac(o);
  const c = fakeChain();
  const store = new Map<string, LedgerEntry>();
  const clock = o.clock ?? { t: NOW };
  const runs = { n: 0 };
  const gate = createEvmPaymentGate({
    network: BASE_MAINNET, payTo: PAY_TO, priceUsd: 0.01, facilitators: [{ name: 'fake', client: f.client }], chain: c.chain,
    ledger: storageLedger({ get: async (k) => store.get(k), put: async (k, e) => { store.set(k, e); }, delete: async (k) => { store.delete(k); } }),
    now: () => clock.t, confirmDelaysMs: [], handlerTimeoutMs: 1000, resource: { description: 'csv' },
  });
  const h = gate.withPayment(async () => { runs.n++; if (o.fail) return Response.json({ error: 'x' }, { status: 500 }); return Response.json({ ok: true }); });
  return { h, f, c, store, runs, clock };
}
const get = (headers: Record<string, string> = {}) => new Request(URL_, { headers });
async function accepted(h: (r: Request) => Promise<Response>) {
  const r = await h(get());
  expect(r.status).toBe(402);
  return decodePaymentRequiredHeader(r.headers.get('payment-required')!).accepts[0];
}

describe('pay-server evm gate (Base, EIP-3009)', () => {
  it('402 offers Base USDC with the EIP-712 domain', async () => {
    const { h } = setup();
    const a = await accepted(h);
    expect(a).toMatchObject({ scheme: 'exact', network: BASE_MAINNET, asset: BASE_USDC[BASE_MAINNET].address, amount: '10000', payTo: PAY_TO, extra: { name: 'USD Coin', version: '2' } });
  });

  it('pays once, settles after the work, rejects a replay', async () => {
    const s = setup();
    const p = pay(await accepted(s.h));
    s.c.used.add(`${BUYER.toLowerCase()}|${p.authorization.nonce}`); // the facilitator's settlement lands
    const r = await s.h(get({ 'payment-signature': p.header }));
    expect(r.status).toBe(200);
    expect(r.headers.get('payment-response')).toBeTruthy();
    expect(r.headers.get('x-payment-confirmation')).toBe('confirmed');
    expect(s.f.calls).toEqual({ verify: 1, settle: 1 });
    const again = await s.h(get({ 'payment-signature': p.header }));
    expect(again.status).toBe(409);
    expect(s.f.calls.settle).toBe(1);
    expect(s.runs.n).toBe(1);
  });

  it('marks pending when the chain does not show it yet', async () => {
    const s = setup();
    const r = await s.h(get({ 'payment-signature': pay(await accepted(s.h)).header }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-payment-confirmation')).toBe('pending');
  });

  it('refuses another recipient, another amount, an expired or permit2 payload before verify', async () => {
    const s = setup();
    const a = await accepted(s.h);
    const cases: [ReturnType<typeof pay>, string][] = [
      [pay(a, { to: '0x3333333333333333333333333333333333333333' }), 'recipient_mismatch'],
      [pay(a, { value: '9999' }), 'amount_mismatch'],
      [pay(a, { validBefore: String(NOW / 1000 - 1) }), 'payment_expired'],
      [pay(a, { permit2: true }), 'invalid_payload'],
    ];
    for (const [p, reason] of cases) {
      const r = await s.h(get({ 'payment-signature': p.header }));
      expect(r.status).toBe(402);
      expect((await r.json()).reason).toBe(reason);
    }
    expect(s.f.calls).toEqual({ verify: 0, settle: 0 });
    expect(s.runs.n).toBe(0);
  });

  it('refuses requirements that do not match (other network)', async () => {
    const s = setup();
    const a = await accepted(s.h);
    const r = await s.h(get({ 'payment-signature': pay({ ...a, network: BASE_SEPOLIA as never }).header }));
    expect((await r.json()).reason).toBe('requirements_mismatch');
  });

  it('does not settle when the work fails, and the authorization can be used again', async () => {
    const s = setup({ fail: true });
    const p = pay(await accepted(s.h));
    const r = await s.h(get({ 'payment-signature': p.header }));
    expect(r.status).toBe(500);
    expect(r.headers.get('x-payment-status')).toBe('not-settled');
    expect(s.f.calls.settle).toBe(0);
    expect(s.store.size).toBe(0);
  });

  it('settle error but used on chain → paid (confirmed)', async () => {
    const s = setup({ settle: 'throw' });
    const p = pay(await accepted(s.h));
    s.c.used.add(`${BUYER.toLowerCase()}|${p.authorization.nonce}`);
    const r = await s.h(get({ 'payment-signature': p.header }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-payment-confirmation')).toBe('confirmed');
  });

  it('settle failure not on chain → pending; later on chain → delivered without a second settle; unused after expiry → not paid', async () => {
    const s = setup({ settle: 'fail' });
    const a = await accepted(s.h);
    const p = pay(a);
    const r1 = await s.h(get({ 'payment-signature': p.header }));
    expect(r1.status).toBe(503);
    expect((await r1.json()).error).toBe('settlement_pending');
    s.c.used.add(`${BUYER.toLowerCase()}|${p.authorization.nonce}`);
    const r2 = await s.h(get({ 'payment-signature': p.header }));
    expect(r2.status).toBe(200);
    expect(s.f.calls.settle).toBe(1);

    const q = pay(a, { validBefore: String(NOW / 1000 + 10) });
    expect((await s.h(get({ 'payment-signature': q.header }))).status).toBe(503);
    s.clock.t = NOW + 11_000;
    const r3 = await s.h(get({ 'payment-signature': q.header }));
    expect(r3.status).toBe(402);
    expect((await r3.json()).reason).toBe('payment_expired');
    expect(s.f.calls.settle).toBe(2);
  });

  it('a facilitator that advertises permit2 for Base does not change the 402: it still asks for EIP-3009 (name/version, no assetTransferMethod)', async () => {
    // Shape seen in a public /supported on 2026-11-26: the exact eip155:8453 kind carries extra.assetTransferMethod = 'permit2'.
    const client: FacilitatorClient = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE_MAINNET, extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } }], extensions: [], signers: {} } as SupportedResponse;
      },
      async verify() { throw new Error('not called'); },
      async settle() { throw new Error('not called'); },
    };
    const gate = createEvmPaymentGate({ network: BASE_MAINNET, payTo: PAY_TO, priceUsd: 0.01, facilitators: [{ name: 'permit2-hint', client }], chain: fakeChain().chain, now: () => NOW, resource: { description: 'csv' } });
    const h = gate.withPayment(async () => Response.json({ ok: true }));
    const a = await accepted(h);
    expect(a.extra).toEqual({ name: 'USD Coin', version: '2' });
    expect(a.extra).not.toHaveProperty('assetTransferMethod');
    const { header } = pay(a, { permit2: true });
    expect((await h(get({ 'payment-signature': header }))).status).toBe(402);
  });

  it('config errors: mainnet needs facilitators, payTo must be 0x, a chain reader is needed', () => {
    const chain = fakeChain().chain;
    expect(() => createEvmPaymentGate({ network: BASE_MAINNET, payTo: PAY_TO, priceUsd: 0.01, chain })).toThrow(/facilitators/);
    expect(() => createEvmPaymentGate({ network: BASE_SEPOLIA, payTo: 'So1ana', priceUsd: 0.01, chain })).toThrow(/0x address/);
    expect(() => createEvmPaymentGate({ network: BASE_SEPOLIA, payTo: '0x' + '0'.repeat(40), priceUsd: 0.01, chain })).toThrow(/0x address/);
    expect(() => createEvmPaymentGate({ network: BASE_SEPOLIA, payTo: PAY_TO, priceUsd: 0.01 })).toThrow(/rpcUrl or chain/);
    expect(() => createEvmPaymentGate({ network: BASE_SEPOLIA, payTo: PAY_TO, priceUsd: 0.01, chain })).not.toThrow();
  });

  it('rpcEvmChain calls authorizationState(from, nonce) with eth_call', async () => {
    let sent: { params: [{ to: string; data: string }, string] } | null = null;
    const f = (async (_u: string, init: RequestInit) => { sent = JSON.parse(init.body as string); return Response.json({ result: '0x' + '0'.repeat(63) + '1' }); }) as typeof fetch;
    const nn = nonce();
    expect(await rpcEvmChain('http://rpc', f).authorizationUsed(BASE_USDC[BASE_MAINNET].address, BUYER, nn)).toBe(true);
    expect(sent!.params[0].to).toBe(BASE_USDC[BASE_MAINNET].address);
    expect(sent!.params[0].data).toBe('0xe94a0102' + BUYER.slice(2).padStart(64, '0') + nn.slice(2));
    expect(await rpcEvmChain('http://rpc', (async () => Response.json({ error: {} })) as typeof fetch).authorizationUsed(BASE_USDC[BASE_MAINNET].address, BUYER, nn)).toBeNull();
    expect(await rpcEvmChain('http://rpc', f).authorizationUsed('bad', BUYER, nn)).toBeNull();
  });

  it('eip3009Authorization reads only well-formed authorizations', () => {
    expect(eip3009Authorization({ payload: { signature: '0x1', authorization: { from: BUYER, to: PAY_TO, value: '1', validAfter: '0', validBefore: '9', nonce: nonce() } } } as never)).not.toBeNull();
    expect(eip3009Authorization({ payload: { signature: '0x1', authorization: { from: 'x', to: PAY_TO, value: '1', validAfter: '0', validBefore: '9', nonce: nonce() } } } as never)).toBeNull();
    expect(eip3009Authorization({ payload: { transaction: 'abc' } } as never)).toBeNull();
  });
});

describe('paid route with Solana and Base', () => {
  async function both(baseOnly = false) {
    clearSupportedCache();
    const f = fac();
    const solPayTo = Keypair.generate().publicKey.toBase58();
    const usdcAta = await ataOf(solPayTo, USDC_MAINNET.mint, SPL_TOKEN);
    const chain: ChainReader = {
      async loadTx() { return null; },
      async recentSignatures() { return []; },
      async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (a === usdcAta ? { owner: SPL_TOKEN, data: new Uint8Array(165) } : null)) }; },
    };
    const c = fakeChain();
    const route: PaidRoute = { path: '/x402/csv', priceUsd: 0.01, description: 'csv', fromQuery: (q) => q.get('a'), check: () => null, run: async () => ({ ok: true }) };
    const h = paidRouteHandler(route, () => ({
      ...(baseOnly ? {} : { payTo: solPayTo, chain, facilitators: [{ name: 'fake', assets: ['USDC' as const], client: f.client }] }),
      base: { payTo: PAY_TO, facilitators: [{ name: 'fake', client: f.client }], chain: c.chain },
      gate: { confirmDelaysMs: [], handlerTimeoutMs: 1000 },
    }));
    return { h, f, c };
  }

  it('lists Solana first, then Base; a Base payment goes to the Base gate', async () => {
    const { h, f } = await both();
    const r = (await h(new Request(`${URL_}?a=1`)))!;
    expect(r.status).toBe(402);
    const accepts = decodePaymentRequiredHeader(r.headers.get('payment-required')!).accepts;
    expect(accepts.map((x) => x.network)).toEqual([SOLANA_MAINNET, BASE_MAINNET]);
    expect((await r.json()).accepts).toHaveLength(2);
    const paid = (await h(new Request(`${URL_}?a=1`, { headers: { 'payment-signature': pay(accepts[1]).header } })))!;
    expect(paid.status).toBe(200);
    expect(f.calls).toEqual({ verify: 1, settle: 1 });
  });

  it('works on Base only (no Solana payTo)', async () => {
    const { h } = await both(true);
    const r = (await h(new Request(`${URL_}?a=1`)))!;
    expect(decodePaymentRequiredHeader(r.headers.get('payment-required')!).accepts.map((x) => x.network)).toEqual([BASE_MAINNET]);
  });

  it('needs at least one network', async () => {
    const route: PaidRoute = { path: '/x', priceUsd: 0.01, description: 'x', check: () => null, run: async () => ({}) };
    await expect(paidRouteHandler(route, () => ({}))(new Request('https://s.example/x', { method: 'POST', body: '{}' }))).rejects.toThrow(/payTo/);
  });
});
