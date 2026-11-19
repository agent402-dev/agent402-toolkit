// @agent402-dev/pay-server SDK (createPaymentGate) — 2주차 설계 5가지 + 기본 흐름 고정
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import {
  createPaymentGate, isFacilitatorSideFailure, KNOWN_FACILITATORS, SOLANA_DEVNET,
  type ChainReader, type ChainTx, type DailyRate, type FacilitatorSpec, type GateConfig,
} from '@agent402-dev/pay-server';
import { clearSupportedCache, presentSignatures } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN, TOKEN_2022 } from '@agent402-dev/pay-server/chain';

const pk = () => Keypair.generate().publicKey.toBase58();
const PAY_TO = pk();
const USDC = { symbol: 'USDC' as const, mint: pk(), decimals: 6, tokenProgram: SPL_TOKEN };
const A402 = { symbol: 'A402' as const, mint: pk(), decimals: 6, tokenProgram: TOKEN_2022 };
const FEE_A = pk();
const FEE_B = pk();
const RATE_ON: DailyRate = { status: 'on', date: '2026-11-20', basedOn: '2026-11-19', a402Usd: 0.000002, samples: 24, method: 'median' };
const DEXTER_REASON = 'transaction_simulation_failed: Simulation failed: {"InsufficientFundsForRent":{"account_index":0}}';

type Ev = string[];
function fac(feePayer: string, ev: Ev, o: { down?: boolean; verify?: { isValid: boolean; invalidReason?: string }; settle?: 'ok' | 'fail' } = {}) {
  const calls = { verify: 0, settle: 0 };
  const client: FacilitatorClient = {
    async getSupported() {
      if (o.down) throw new Error('down');
      return { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET, extra: { feePayer } }], extensions: [], signers: {} } as SupportedResponse;
    },
    async verify() { calls.verify++; ev.push(`verify:${feePayer.slice(0, 4)}`); return (o.verify ?? { isValid: true, payer: 'P' }) as never; },
    async settle(): Promise<SettleResponse> {
      calls.settle++; ev.push('settle');
      if (o.settle === 'fail') return { success: false, errorReason: 'transaction_confirmation_timeout', transaction: '', network: SOLANA_DEVNET as SettleResponse['network'] };
      return { success: true, transaction: 'SETTLED', network: SOLANA_DEVNET as SettleResponse['network'], payer: 'P' };
    },
  };
  return { client, calls };
}

function payTx(): { base64: string; payerSig: string } {
  const sig = Uint8Array.from({ length: 64 }, () => Math.floor(Math.random() * 250) + 1);
  const base64 = btoa(String.fromCharCode(...new Uint8Array([2, ...new Uint8Array(64), ...sig, 9, 9])));
  return { base64, payerSig: presentSignatures(base64)[0] };
}
const settled = (mint: string, amount: bigint, signatures: string[]): ChainTx => ({
  signature: signatures[0], err: false, accountKeys: ['FEE'], signatures,
  preTokenBalances: [{ accountIndex: 1, mint, owner: PAY_TO, amount: '0' }],
  postTokenBalances: [{ accountIndex: 1, mint, owner: PAY_TO, amount: amount.toString() }],
});

async function setup(o: { facs?: { spec: Omit<FacilitatorSpec, 'client'>; f: ReturnType<typeof fac> }[]; missing?: ('USDC' | 'A402')[]; rate?: DailyRate | null; chain?: ChainTx[]; handler?: (req: Request) => Promise<Response>; timeoutMs?: number } = {}) {
  clearSupportedCache();
  const ev: Ev = [];
  const facs = o.facs ?? [{ spec: { name: 'payai', assets: ['USDC', 'A402'] }, f: fac(FEE_A, ev) }];
  const usdcAta = await ataOf(PAY_TO, USDC.mint, SPL_TOKEN);
  const a402Ata = await ataOf(PAY_TO, A402.mint, TOKEN_2022);
  const chainTxs = o.chain ?? [];
  const chain: ChainReader = {
    async loadTx(sig) { return chainTxs.find((t) => t.signature === sig) ?? (sig === 'SETTLED' ? settled(USDC.mint, 20_000n, ['SETTLED']) : null); },
    async recentSignatures() { return chainTxs.map((t) => t.signature); },
    async accounts(addrs) {
      return { slot: 1, accounts: addrs.map((a) => {
        if (a === usdcAta) return o.missing?.includes('USDC') ? null : { owner: SPL_TOKEN, data: new Uint8Array(165) };
        if (a === a402Ata) return o.missing?.includes('A402') ? null : { owner: TOKEN_2022, data: new Uint8Array(170) };
        return null;
      }) };
    },
  };
  let t = Date.parse('2026-11-20T10:00:00Z');
  const handlerCalls = { n: 0 };
  const cfg: GateConfig = {
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.02, usdc: USDC,
    a402: { asset: A402, discountPercent: 30, rate: async () => (o.rate === undefined ? RATE_ON : o.rate) },
    facilitators: facs.map((x) => ({ ...x.spec, client: x.f.client })),
    chain, handlerTimeoutMs: o.timeoutMs ?? 1000, confirmDelaysMs: [], now: () => t,
  };
  const gate = createPaymentGate(cfg);
  const h = gate.withPayment(async (req) => { handlerCalls.n++; ev.push('handler'); return o.handler ? o.handler(req) : new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); });
  return { gate, h, ev, facs, handlerCalls, usdcAta, a402Ata, advance: (ms: number) => { t += ms; } };
}
const URL_ = 'https://api.example/paid/thing';
const req = (headers: Record<string, string> = {}) => new Request(URL_, { headers });
const sign = (accepted: PaymentRequirements, tx = payTx().base64) =>
  encodePaymentSignatureHeader({ x402Version: 2, resource: { url: URL_ }, accepted, payload: { transaction: tx } } as never);
async function first402(h: (r: Request) => Promise<Response>) {
  const r = await h(req());
  expect(r.status).toBe(402);
  return { pr: decodePaymentRequiredHeader(r.headers.get('payment-required')!), body: await r.json() };
}
const symbols = (accepts: PaymentRequirements[]) => accepts.map((a) => (a.asset === USDC.mint ? 'USDC' : a.asset === A402.mint ? 'A402' : '?'));

describe('기본 흐름: 402 → verify → 핸들러 → settle', () => {
  it('USDC·A402 둘 다 제시, 결제하면 verify → handler → settle 순서로 200 + PAYMENT-RESPONSE', async () => {
    const s = await setup();
    const { pr } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC', 'A402']);
    expect(pr.accepts[0]).toMatchObject({ amount: '20000', payTo: PAY_TO, extra: { feePayer: FEE_A } });
    expect(pr.accepts[1]).toMatchObject({ amount: '7000000000', extra: { rate: { discountPercent: 30 } } });
    const ok = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(ok.status).toBe(200);
    expect(s.ev).toEqual(['verify:' + FEE_A.slice(0, 4), 'handler', 'settle']);
    expect(decodePaymentResponseHeader(ok.headers.get('payment-response')!).transaction).toBe('SETTLED');
    expect(await ok.json()).toEqual({ ok: true });
  });
  it('핸들러가 4xx/5xx 를 돌려주면 정산하지 않음 (x-payment-status: not-settled)', async () => {
    const s = await setup({ handler: async () => new Response('nope', { status: 500 }) });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(500);
    expect(r.headers.get('x-payment-status')).toBe('not-settled');
    expect(s.facs[0].f.calls.settle).toBe(0);
  });
  it('핸들러 시간 초과 → 504, 정산 없음', async () => {
    const s = await setup({ handler: () => new Promise((r) => setTimeout(() => r(new Response('late')), 200)), timeoutMs: 20 });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(504);
    expect((await r.json()).message).toContain('No payment was taken');
    expect(s.facs[0].f.calls.settle).toBe(0);
  });
  it('정산 success:false 인데 체인엔 있음 → 200 (체인 판정)', async () => {
    const t = payTx();
    const ev: Ev = [];
    const s = await setup({ facs: [{ spec: { name: 'payai', assets: ['USDC', 'A402'] }, f: fac(FEE_A, ev, { settle: 'fail' }) }], chain: [settled(USDC.mint, 20_000n, ['ONCHAIN', t.payerSig])] });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0], t.base64) }));
    expect(r.status).toBe(200);
    expect(decodePaymentResponseHeader(r.headers.get('payment-response')!).transaction).toBe('ONCHAIN');
  });
});

describe('설계 1: facilitator 별 받는 자산 목록', () => {
  it('기본값: PayAI = USDC·A402, Dexter = USDC (2026-11-19 확인 사실)', () => {
    expect(KNOWN_FACILITATORS.payai.assets).toEqual(['USDC', 'A402']);
    expect(KNOWN_FACILITATORS.dexter.assets).toEqual(['USDC']);
  });
  it('A402 를 받지 않는 facilitator 면 402 에 A402 를 넣지 않고 이유를 적음', async () => {
    const s = await setup({ facs: [{ spec: { name: 'dexter', assets: ['USDC'] }, f: fac(FEE_B, []) }] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'A402', reason: 'facilitator dexter does not accept A402' }]);
  });
  it('A402 를 받지 않는 facilitator 로 A402 결제를 보내도 조건에 없으므로 402 requirements_mismatch, verify 호출 없음', async () => {
    const usdcOnly = fac(FEE_B, []);
    const s = await setup({ facs: [{ spec: { name: 'dexter', assets: ['USDC'] }, f: usdcOnly }] });
    const { pr } = await first402(s.h);
    const forged = { ...pr.accepts[0], asset: A402.mint, amount: '7000000000' };
    const r = await s.h(req({ 'payment-signature': sign(forged) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('requirements_mismatch');
    expect(usdcOnly.calls.verify).toBe(0);
  });
});

describe('설계 2: 예비 facilitator 로 넘어가면 A402 빼기', () => {
  it('기본(PayAI) 장애 → 예비(Dexter) feePayer, USDC 만, A402 이유 표시', async () => {
    const ev: Ev = [];
    const s = await setup({ facs: [
      { spec: { name: 'payai', assets: ['USDC', 'A402'] }, f: fac(FEE_A, ev, { down: true }) },
      { spec: { name: 'dexter', assets: ['USDC'] }, f: fac(FEE_B, ev) },
    ] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect((pr.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_B);
    expect(body.notOffered[0]).toMatchObject({ asset: 'A402', reason: 'facilitator dexter does not accept A402' });
  });
});

describe('설계 3: facilitator 쪽 문제(수수료 대납 주소 잔액 부족)면 다음 facilitator 로', () => {
  it('판정: 실제 Dexter 거절 문자열은 facilitator 쪽, 구매자 쪽 실패는 아님', () => {
    expect(isFacilitatorSideFailure(DEXTER_REASON)).toBe(true);
    expect(isFacilitatorSideFailure('invalid', 'fee payer has insufficient balance')).toBe(true);
    expect(isFacilitatorSideFailure('transaction_simulation_failed: Simulation failed: {"InsufficientFundsForRent":{"account_index":1}}')).toBe(false);
    expect(isFacilitatorSideFailure('invalid_exact_svm_transaction_simulation_failed')).toBe(false);
    expect(isFacilitatorSideFailure('policy:asset_not_allowed: Asset X is not in the allowlist')).toBe(false);
  });
  it('기본 facilitator verify 가 feePayer 문제로 실패 → 402 facilitator_unavailable + 예비의 새 조건, 정산·핸들러 없음, 이후 402 도 예비, 쿨다운 뒤 기본으로 복귀', async () => {
    const ev: Ev = [];
    const primary = fac(FEE_A, ev, { verify: { isValid: false, invalidReason: DEXTER_REASON } });
    const backup = fac(FEE_B, ev);
    const s = await setup({ facs: [
      { spec: { name: 'primary', assets: ['USDC', 'A402'] }, f: primary },
      { spec: { name: 'backup', assets: ['USDC'] }, f: backup },
    ] });
    const { pr } = await first402(s.h);
    expect((pr.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_A);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(402);
    const b = await r.json();
    expect(b.reason).toBe('facilitator_unavailable');
    expect(b.message).toContain('No payment was taken');
    const pr2 = decodePaymentRequiredHeader(r.headers.get('payment-required')!);
    expect((pr2.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_B);
    expect(symbols(pr2.accepts)).toEqual(['USDC']);
    expect(primary.calls.settle + backup.calls.settle).toBe(0);
    expect(s.handlerCalls.n).toBe(0);
    // 예비 조건으로 다시 결제 → 성공
    const ok = await s.h(req({ 'payment-signature': sign(pr2.accepts[0]) }));
    expect(ok.status).toBe(200);
    expect(backup.calls.settle).toBe(1);
    // 쿨다운(5분) 뒤에는 다시 기본
    s.advance(300_001);
    const { pr: pr3 } = await first402(s.h);
    expect((pr3.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_A);
  });
  it('구매자 쪽 실패(잔액 부족 등)는 facilitator 를 바꾸지 않음', async () => {
    const ev: Ev = [];
    const primary = fac(FEE_A, ev, { verify: { isValid: false, invalidReason: 'invalid_exact_svm_transaction_simulation_failed' } });
    const s = await setup({ facs: [
      { spec: { name: 'primary', assets: ['USDC', 'A402'] }, f: primary },
      { spec: { name: 'backup', assets: ['USDC'] }, f: fac(FEE_B, ev) },
    ] });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect((await r.json()).reason).toBe('invalid_exact_svm_transaction_simulation_failed');
    const { pr: again } = await first402(s.h);
    expect((again.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_A);
  });
});

describe('설계 4: 받는 쪽 토큰 계정 확인', () => {
  it('checkReceivingAccounts: 수령 지갑의 USDC(SPL)·A402(Token-2022) 계정 주소와 존재 여부', async () => {
    const s = await setup({ missing: ['A402'] });
    const list = await s.gate.checkReceivingAccounts();
    expect(list).toEqual([
      { asset: 'USDC', mint: USDC.mint, tokenAccount: s.usdcAta, exists: true },
      { asset: 'A402', mint: A402.mint, tokenAccount: s.a402Ata, exists: false },
    ]);
  });
  it('A402 수령 계정이 없으면 A402 를 402 에 넣지 않음 (그 계정 주소를 이유로)', async () => {
    const s = await setup({ missing: ['A402'] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'A402', reason: `receiving token account ${s.a402Ata} does not exist` }]);
  });
  it('둘 다 없으면 결제 조건을 낼 수 없어 503 (돈 받지 않음)', async () => {
    const s = await setup({ missing: ['USDC', 'A402'] });
    const r = await s.h(req());
    expect(r.status).toBe(503);
    expect((await r.json()).notOffered).toHaveLength(2);
  });
  it('A402 환율 off 면 USDC 만 + 환율 이유', async () => {
    const s = await setup({ rate: { status: 'off', date: '2026-11-20', basedOn: '2026-11-19', reason: 'pool depth below threshold', samples: 24 } });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'A402', reason: 'pool depth below threshold' }]);
  });
});

describe('설계 5: README 사실 표기', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  it('하지 않는 것 4가지를 적음', () => {
    expect(readme).toMatch(/does not operate a facilitator/i);
    expect(readme).toMatch(/does not hold (or custody )?funds/i);
    expect(readme).toMatch(/does not exchange/i);
    expect(readme).toMatch(/does not (accept or send|process) payments on (anyone's|someone else's) behalf/i);
  });
  it('facilitator 확인 사실을 날짜와 함께 적음 (PayAI A402 가능, Dexter A402 정책상 불가)', () => {
    expect(readme).toContain('2026-11-19');
    const row = (name: string) => readme.split('\n').find((l) => l.startsWith(`| ${name} `))!.split('|').map((x) => x.trim());
    // 표 열: | facilitator | USDC | A402 |
    expect(row('PayAI')[3]).toMatch(/verify and settle succeeded/);
    expect(row('Dexter')[3]).toContain('policy:asset_not_allowed');
  });
  it('예제의 가격·할인율은 "설정 예시"로 표기', () => {
    expect(readme).toMatch(/discountPercent: 30 \/\* example setting/);
    expect(readme).toMatch(/priceUsd: 0\.02, \/\/ example setting/);
  });
  it('평가·권유 표현 없음', () => {
    expect(readme).not.toMatch(/\b(safe|safest|risky|scam|rug|best|recommend(ed)?|guarantee[ds]?|trustworthy|reliable)\b/i);
  });
});
