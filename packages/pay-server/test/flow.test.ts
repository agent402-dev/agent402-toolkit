// a402-pay-server 결제 처리 흐름 (이전 test/x402.test.ts 를 Worker 유료 경로 대신 SDK createPaymentGate 로 옮김)
// 검증 → 핸들러 → 정산, 재사용 방지 장부, 정산 실패·결과 모름 시 체인 판정, 결제 조건 변조
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import { createPaymentGate, SETTLE_UNKNOWN_EXPIRY_MS, SOLANA_DEVNET, type ChainReader, type ChainTx } from 'a402-pay-server';
import { clearSupportedCache, presentSignatures } from 'a402-pay-server/x402';
import { ataOf, SPL_TOKEN, TOKEN_2022 } from 'a402-pay-server/chain';

const pk = () => Keypair.generate().publicKey.toBase58();
const PAY_TO = pk();
const USDC = { symbol: 'USDC' as const, mint: pk(), decimals: 6, tokenProgram: SPL_TOKEN };
const A402 = { symbol: 'A402' as const, mint: pk(), decimals: 6, tokenProgram: TOKEN_2022 };
const FEE_A = pk();
const FEE_B = pk();

/** 부분 서명된 트랜잭션 흉내: 서명 2자리 (0번 = 수수료 대납자 자리, 비어 있음 / 1번 = 구매자 서명) */
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
  const atas = new Set([await ataOf(PAY_TO, USDC.mint, SPL_TOKEN), await ataOf(PAY_TO, A402.mint, TOKEN_2022)]);
  const reader: ChainReader = {
    async loadTx(sig) { return chain.find((t) => t.signature === sig) ?? (o.tx === undefined ? (sig === 'SETTLED_TX' ? settled(20_000n) : null) : o.tx); },
    async recentSignatures() { return chain.map((t) => t.signature); },
    async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (atas.has(a) ? { owner: a === [...atas][0] ? SPL_TOKEN : TOKEN_2022, data: new Uint8Array(0) } : null)) }; },
  };
  let t = Date.parse('2026-11-20T10:00:00Z');
  let fails = o.handlerFails ?? 0;
  const gate = createPaymentGate({
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.02, usdc: USDC,
    facilitators: facs.map((f, i) => ({ name: `f${i}`, client: f.client, assets: ['USDC', 'A402'] })),
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

describe('402 PAYMENT-REQUIRED (표준 x402 v2)', () => {
  it('x402Version 2, resource, exact, feePayer = facilitator /supported 값', async () => {
    const { h } = await setup();
    const pr = await first402(h);
    expect(pr.x402Version).toBe(2);
    expect(pr.resource.url).toBe(URL_);
    expect(pr.accepts[0]).toMatchObject({ scheme: 'exact', network: SOLANA_DEVNET, asset: USDC.mint, amount: '20000', payTo: PAY_TO, extra: { feePayer: FEE_A } });
  });
  it('facilitator 가 모두 장애면 503 (결제 조건 없음)', async () => {
    const { h } = await setup({ facs: [fac(FEE_A, [], { down: true })] });
    const r = await h(req());
    expect(r.status).toBe(503);
    expect(r.headers.get('payment-required')).toBeNull();
  });
});

describe('검증 → 핸들러 → 정산', () => {
  it('정상: 순서, 200 + PAYMENT-RESPONSE (체인 확인됨), 같은 결제 재사용은 409', async () => {
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
  it('핸들러 실패 → 정산하지 않음(502), 장부 풀림 → 같은 결제로 다시 → 200', async () => {
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
  it('결제 만료 (facilitator verify 거절) → 402, 핸들러도 정산도 없음', async () => {
    const ev: Ev = [];
    const s = await setup({ facs: [fac(FEE_A, ev, { valid: false, invalidReason: 'invalid_exact_svm_transaction_simulation_failed' })] });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('invalid_exact_svm_transaction_simulation_failed');
    expect(s.facs[0].calls.settle).toBe(0);
    expect(s.ev).not.toContain('handler');
  });
  it('facilitator 가 성공이라 해도 체인에서 덜 받았으면 402 onchain_mismatch', async () => {
    const s = await setup({ tx: settled(19_999n) });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('onchain_mismatch');
  });
  it('facilitator 는 성공, 체인에서 아직 못 찾음 → 리소스는 주고 확인 대기 표시', async () => {
    const s = await setup({ tx: null });
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-payment-confirmation')).toBe('pending');
  });
});

describe('정산이 실패하거나 결과를 모를 때 — 체인에서 먼저 판정', () => {
  for (const mode of ['throw', 'fail', 'reject4xx'] as const) {
    const label = { throw: '응답 없음(예외)', fail: 'success:false', reject4xx: '4xx 실패 응답' }[mode];
    it(`${label} + 체인에 구매자 서명이 든 정산 tx → 200`, async () => {
      const t = payTx();
      const s = await setup({ facs: [fac(FEE_A, [], { settle: mode })], chain: [settled(20_000n, ['ONCHAIN', t.payerSig])] });
      const pr = await first402(s.h);
      const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0], URL_, t.base64) }));
      expect(r.status).toBe(200);
      expect(decodePaymentResponseHeader(r.headers.get('payment-response')!).transaction).toBe('ONCHAIN');
    });
    it(`${label} + 체인에 없음 → 503 결과 모름, 재요청해도 재정산 없음, 유효시간 지나면 402 payment_expired`, async () => {
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
    it(`${label} → 유효시간 안에 늦게 체인에 나타나면 재요청 때 200`, async () => {
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

describe('결제 조건 변조', () => {
  it('금액을 줄인 조건 → 402 requirements_mismatch (facilitator 호출 없음)', async () => {
    const s = await setup();
    const pr = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign({ ...pr.accepts[0], amount: '1' }) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('requirements_mismatch');
    expect(s.facs[0].calls.verify).toBe(0);
  });
  it('수령 주소를 바꾼 조건 / 다른 리소스용 결제 / 다른 facilitator feePayer → 402', async () => {
    const s = await setup();
    const pr = await first402(s.h);
    const reason = async (hd: string) => (await (await s.h(req({ 'payment-signature': hd }))).json()).reason;
    expect(await reason(sign({ ...pr.accepts[0], payTo: pk() }))).toBe('requirements_mismatch');
    expect(await reason(sign({ ...pr.accepts[0], extra: { ...pr.accepts[0].extra, feePayer: FEE_B } }))).toBe('requirements_mismatch');
    expect(await reason(sign(pr.accepts[0], 'https://api.test/paid/other'))).toBe('resource_mismatch');
    expect(s.facs[0].calls.verify).toBe(0);
  });
});
