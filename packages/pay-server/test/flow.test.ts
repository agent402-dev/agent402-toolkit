// @agent402-dev/pay-server payment processing flow (moved from the old test/x402.test.ts, using the SDK createPaymentGate instead of the Worker paid route)
// verify → handler → settle, replay-protection ledger, on-chain decision when settlement fails or is unknown, tampered payment requirements
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import { createPaymentGate, SETTLE_UNKNOWN_EXPIRY_MS, SOLANA_DEVNET, type ChainReader, type ChainTx } from '@agent402-dev/pay-server';
import { clearSupportedCache, presentSignatures } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN, TOKEN_2022 } from '@agent402-dev/pay-server/chain';

const pk = () => Keypair.generate().publicKey.toBase58();
const PAY_TO = pk();
const USDC = { symbol: 'USDC' as const, mint: pk(), decimals: 6, tokenProgram: SPL_TOKEN };
const PREQ = { symbol: 'PREQ' as const, mint: pk(), decimals: 6, tokenProgram: TOKEN_2022 };
const FEE_A = pk();
const FEE_B = pk();

/** Imitates a partially signed transaction: 2 signature slots (0 = fee payer slot, empty / 1 = buyer signature) */
function payTx(): { base64: string; payerSig: string } {
  const sig = Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 250) + 1);
  const base64 = btoa(String.fromCharCode(...new Uint8Array([2, ...new Uint8Array(64), ...sig, 1, 2, 3])));
  return { base64, payerSig: presentSignatures(base64)[0] };
}
type Ev = string[];
type SettleMode = 'ok' | 'fail' | 'throw' | 'reject4xx';
function fac(feePayer: string, ev: Ev, o: { down?: boolean; valid?: boolean; invalidReason?: string; settle?: SettleMode } = {}) {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      if (o.down) throw new Error('down');
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET, extra: { feePayer } }], extensions: [], signers: {} } as SupportedResponse;
    },
    async verify() {
      calls.verify++; ev.push('verify');
      return (o.valid === false ? { isValid: false, invalidReason: o.invalidReason ?? 'invalid_exact_svm_payload_transaction' } : { isValid: true, payer: 'P' }) as never;
    },
    async settle(): Promise<SettleResponse> {
      calls.settle++; ev.push('settle');
      if (o.settle === 'throw') throw new Error('settle timeout');
      if (o.settle === 'reject4xx') throw Object.assign(new Error('transaction_confirmation_timeout'), { name: 'SettleError', statusCode: 400, errorReason: 'transaction_confirmation_timeout' });
      if (o.settle === 'fail') return { success: false, errorReason: 'transaction_failed', transaction: '', network: SOLANA_DEVNET as SettleResponse['network'] };
      return { success: true, transaction: 'SETTLED_TX', network: SOLANA_DEVNET as SettleResponse['network'], payer: 'P' };
    },
  };
  return { client, calls };
}
const settled = (amount: bigint, signatures: string[] = ['SETTLED_TX']): ChainTx => ({
  signature: signatures[0], err: false, accountKeys: ['FEE'], signatures,
  preTokenBalances: [{ accountIndex: 1, mint: USDC.mint, owner: PAY_TO, amount: '0' }],
  postTokenBalances: [{ accountIndex: 1, mint: USDC.mint, owner: PAY_TO, amount: amount.toString() }],
});

async function setup(o: { facs?: ReturnType<typeof fac>[]; tx?: ChainTx | null; chain?: ChainTx[]; handlerFails?: number } = {}) {
  clearSupportedCache();
  const ev: Ev = [];
  const facs = o.facs ?? [fac(FEE_A, ev)];
  const chain = o.chain ?? [];
  const atas = new Set([await ataOf(PAY_TO, USDC.mint, SPL_TOKEN), await ataOf(PAY_TO, PREQ.mint, TOKEN_2022)]);
  const reader: ChainReader = {
    async loadTx(sig) { return chain.find((t) => t.signature === sig) ?? (o.tx === undefined ? (sig === 'SETTLED_TX' ? settled(20_000n) : null) : o.tx); },
    async recentSignatures() { return chain.map((t) => t.signature); },
    async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (atas.has(a) ? { owner: a === [...atas][0] ? SPL_TOKEN : TOKEN_2022, data: new Uint8Array(0) } : null)) }; },
  };
  let t = Date.parse('2026-11-20T10:00:00Z');
  let fails = o.handlerFails ?? 0;
  const gate = createPaymentGate({
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.02, usdc: USDC,
    facilitators: facs.map((f, i) => ({ name: `f${i}`, client: f.client, assets: ['USDC', 'PREQ'] })),
    chain: reader, confirmDelaysMs: [], now: () => t, handlerTimeoutMs: 1000,
  });
  const h = gate.withPayment(async () => {
    ev.push('handler');
    if (fails-- > 0) throw new Error('resource failed');
    return Response.json({ ok: true });
  });
  return { h, ev, facs, chain, advance: (ms: number) => { t += ms; } };
}
const URL_ = 'https://api.test/paid/a';
const req = (headers: Record<string, string> = {}) => new Request(URL_, { headers });
const sign = (accepted: PaymentRequirements, resource = URL_, tx = payTx().base64) =>
  encodePaymentSignatureHeader({ x402Version: 2, resource: { url: resource }, accepted, payload: { transaction: tx } } as never);
async function first402(h: (r: Request) => Promise<Response>) {
  const r = await h(req());
  expect(r.status).toBe(402);
  return decodePaymentRequiredHeader(r.headers.get('payment-required')!);
}

describe('402 PAYMENT-REQUIRED (standard x402 v2)', () => {
  it('x402Version 2, resource, exact, feePayer = value from facilitator /supported', async () => {
    const { h } = await setup();
    const pr = await first402(h);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(URL_);
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: SOLANA_DEVNET, asset: USDC.mint, amount: '20000', payTo: PAY_TO, extra: { feePayer: FEE_A } });
  });
  it('503 when all facilitators are down (no payment requirements)', async () => {
    const { h } = await setup({ facs: [fac(FEE_A, [], { down: true })] });
    const r = await h(req());
    expect(r.status).toBe(503);
    expect(r.headers.get('payment-required')).toBeNull();
  });
});

describe('verify → handler → settle', () => {
  it('normal: order, 200 + PAYMENT-RESPONSE (confirmed on-chain), reusing the same payment is 409', async () => {
    const s = await setup();
    const pr = await first402(s.h);
    const hd = sign(pr.accepts[0]);
    const ok = await s.h(req({ 'payment-signature': hd }));
    expect(ok.status).toBe(200);
    expect(s.ev).toEqual(['verify', 'handler', 'settle']);
    expect(decodePaymentResponseHeader(ok.headers.get('payment-response')!)).toMatchObject({ success: true, transaction: 'SETTLED_TX' });
    expect(ok.headers.get('x-payment-confirmation')).toBe('confirmed');
    expect((await s.h(req({ 'payment-signature': hd }))).status).toBe(409);
    expect(s.facs[0].calls.settle).toBe(1);
  });
  it('handler fails → no settlement (502), ledger released → same payment again → 200', async () => {
    const s = await setup({ handlerFails: 1 });
    const pr = await first402(s.h);
    const hd = sign(pr.accepts[0]);
    const fail = await s.h(req({ 'payment-signature': hd }));
    expect(fail.status).toBe(502);
    expect((await fail.json()).message).toContain('No payment was taken');
    expect(fail.headers.get('payment-response')).toBeNull();
    expect(s.facs[0].calls.settle).toBe(0);
    expect((await s.h(req({ 'payment-signature': hd }))).status).toBe(200);
    expect(s.facs[0].calls.settle).toBe(1);
  });
  it('expired payment (facilitator verify rejects) → 402, no handler and no settlement', async () => {
    const ev: Ev = [];
    const s = await setup({ facs: [fac(FEE_A, ev, { valid: false, invalidReason: 'invalid_exact_svm_transaction_simulation_failed' })] });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('invalid_exact_svm_transaction_simulation_failed');
    expect(s.facs[0].calls.settle).toBe(0);
    expect(s.ev).not.toContain('handler');
  });
  it('402 onchain_mismatch if less was received on-chain even though the facilitator reported success', async () => {
    const s = await setup({ tx: settled(19_999n) });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('onchain_mismatch');
  });
  it('facilitator success, not found on-chain yet → deliver the resource and mark pending confirmation', async () => {
    const s = await setup({ tx: null });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-payment-confirmation')).toBe('pending');
  });
});

describe('when settlement fails or its result is unknown: decide on-chain first', () => {
  for (const mode of ['throw', 'fail', 'reject4xx'] as const) {
    const label = { throw: 'no response (exception)', fail: 'success:false', reject4xx: '4xx failure response' }[mode];
    it(`${label} + settlement tx with the buyer signature on-chain → 200`, async () => {
      const t = payTx();
      const s = await setup({ facs: [fac(FEE_A, [], { settle: mode })], chain: [settled(20_000n, ['ONCHAIN', t.payerSig])] });
      const pr = await first402(s.h);
      const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0], URL_, t.base64) }));
      expect(r.status).toBe(200);
      expect(decodePaymentResponseHeader(r.headers.get('payment-response')!).transaction).toBe('ONCHAIN');
    });
    it(`${label} + not on-chain → 503 result unknown, no resettlement on retry, 402 payment_expired after the validity window`, async () => {
      const s = await setup({ facs: [fac(FEE_A, [], { settle: mode })] });
      const pr = await first402(s.h);
      const hd = sign(pr.accepts[0]);
      const r1 = await s.h(req({ 'payment-signature': hd }));
      expect(r1.status).toBe(503);
      expect(r1.headers.get('payment-response')).toBeNull();
      s.advance(30_000);
      expect((await s.h(req({ 'payment-signature': hd }))).status).toBe(503);
      expect(s.facs[0].calls.settle).toBe(1);
      s.advance(SETTLE_UNKNOWN_EXPIRY_MS);
      const late = await s.h(req({ 'payment-signature': hd }));
      expect(late.status).toBe(402);
      expect((await late.json()).reason).toBe('payment_expired');
      expect(s.facs[0].calls.settle).toBe(1);
    });
    it(`${label} → appears on-chain late within the validity window → 200 on retry`, async () => {
      const t = payTx();
      const s = await setup({ facs: [fac(FEE_A, [], { settle: mode })] });
      const pr = await first402(s.h);
      const hd = sign(pr.accepts[0], URL_, t.base64);
      expect((await s.h(req({ 'payment-signature': hd }))).status).toBe(503);
      s.chain.push(settled(20_000n, ['LATE', t.payerSig]));
      s.advance(20_000);
      expect((await s.h(req({ 'payment-signature': hd }))).status).toBe(200);
      expect(s.facs[0].calls.settle).toBe(1);
    });
  }
});

describe('tampered payment requirements', () => {
  it('requirement with a reduced amount → 402 requirements_mismatch (no facilitator call)', async () => {
    const s = await setup();
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign({ ...pr.accepts[0], amount: '1' }) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('requirements_mismatch');
    expect(s.facs[0].calls.verify).toBe(0);
  });
  it('changed receiver / payment for another resource / another facilitator feePayer → 402', async () => {
    const s = await setup();
    const pr = await first402(s.h);
    const reason = async (hd: string) => (await (await s.h(req({ 'payment-signature': hd }))).json()).reason;
    expect(await reason(sign({ ...pr.accepts[0], payTo: pk() }))).toBe('requirements_mismatch');
    expect(await reason(sign({ ...pr.accepts[0], extra: { ...pr.accepts[0].extra, feePayer: FEE_B } }))).toBe('requirements_mismatch');
    expect(await reason(sign(pr.accepts[0], 'https://api.test/paid/other'))).toBe('resource_mismatch');
    expect(s.facs[0].calls.verify).toBe(0);
  });
});
