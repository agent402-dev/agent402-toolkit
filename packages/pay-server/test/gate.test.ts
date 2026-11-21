// @agent402-dev/pay-server SDK (createPaymentGate): locks in the 5 week-2 design points + the basic flow
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements, SettleResponse, SupportedResponse } from '@x402/core/types';
import {
  A402_DEPRECATION_WARNING, A402_MAINNET, createPaymentGate, isFacilitatorSideFailure, KNOWN_FACILITATORS, PREQ_MAINNET, PREQ_MAINNET_MINT, SOLANA_DEVNET,
  type ChainReader, type ChainTx, type DailyRate, type FacilitatorSpec, type GateConfig,
} from '@agent402-dev/pay-server';
import { clearSupportedCache, presentSignatures } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN, TOKEN_2022 } from '@agent402-dev/pay-server/chain';

const pk = () => Keypair.generate().publicKey.toBase58();
const PAY_TO = pk();
const USDC = { symbol: 'USDC' as const, mint: pk(), decimals: 6, tokenProgram: SPL_TOKEN };
const PREQ = { symbol: 'PREQ' as const, mint: pk(), decimals: 6, tokenProgram: TOKEN_2022 };
/** Only for testing explicit enabling of the deprecated A402 (v1) */
const A402_TEST = { symbol: 'A402' as const, mint: pk(), decimals: 6, tokenProgram: TOKEN_2022 };
const FEE_A = pk();
const FEE_B = pk();
const RATE_ON: DailyRate = { status: 'on', date: '2026-11-20', basedOn: '2026-11-19', tokenUsd: 0.000002, samples: 24, method: 'median' };
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

async function setup(o: { facs?: { spec: Omit<FacilitatorSpec, 'client'>; f: ReturnType<typeof fac> }[]; missing?: ('USDC' | 'PREQ')[]; rate?: DailyRate | null; chain?: ChainTx[]; handler?: (req: Request) => Promise<Response>; timeoutMs?: number; extra?: Partial<GateConfig> } = {}) {
  clearSupportedCache();
  const ev: Ev = [];
  const facs = o.facs ?? [{ spec: { name: 'payai', assets: ['USDC', 'PREQ'] }, f: fac(FEE_A, ev) }];
  const usdcAta = await ataOf(PAY_TO, USDC.mint, SPL_TOKEN);
  const preqAta = await ataOf(PAY_TO, PREQ.mint, TOKEN_2022);
  const a402Ata = await ataOf(PAY_TO, A402_TEST.mint, TOKEN_2022);
  const chainTxs = o.chain ?? [];
  const chain: ChainReader = {
    async loadTx(sig) { return chainTxs.find((t) => t.signature === sig) ?? (sig === 'SETTLED' ? settled(USDC.mint, 20_000n, ['SETTLED']) : null); },
    async recentSignatures() { return chainTxs.map((t) => t.signature); },
    async accounts(addrs) {
      return { slot: 1, accounts: addrs.map((a) => {
        if (a === usdcAta) return o.missing?.includes('USDC') ? null : { owner: SPL_TOKEN, data: new Uint8Array(165) };
        if (a === preqAta) return o.missing?.includes('PREQ') ? null : { owner: TOKEN_2022, data: new Uint8Array(170) };
        if (a === a402Ata) return { owner: TOKEN_2022, data: new Uint8Array(170) };
        return null;
      }) };
    },
  };
  let t = Date.parse('2026-11-20T10:00:00Z');
  const handlerCalls = { n: 0 };
  const cfg: GateConfig = {
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.02, usdc: USDC,
    preq: { asset: PREQ, rate: async () => (o.rate === undefined ? RATE_ON : o.rate) },
    facilitators: facs.map((x) => ({ ...x.spec, client: x.f.client })),
    chain, handlerTimeoutMs: o.timeoutMs ?? 1000, confirmDelaysMs: [], now: () => t,
    ...o.extra,
  };
  const gate = createPaymentGate(cfg);
  const h = gate.withPayment(async (req) => { handlerCalls.n++; ev.push('handler'); return o.handler ? o.handler(req) : new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } }); });
  return { gate, h, ev, facs, handlerCalls, usdcAta, preqAta, advance: (ms: number) => { t += ms; } };
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
const symbols = (accepts: PaymentRequirements[]) => accepts.map((a) => (a.asset === USDC.mint ? 'USDC' : a.asset === PREQ.mint ? 'PREQ' : a.asset === A402_TEST.mint ? 'A402' : '?'));

describe('basic flow: 402 → verify → handler → settle', () => {
  it('offers both USDC and PREQ; on payment, verify → handler → settle in order, 200 + PAYMENT-RESPONSE', async () => {
    const s = await setup();
    const { pr } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC', 'PREQ']);
    expect(pr.accepts[0]).toMatchObject({ amount: '20000', payTo: PAY_TO, extra: { feePayer: FEE_A } });
    expect(pr.accepts[1]).toMatchObject({ amount: '10000000000', extra: { rate: { discountPercent: 0 } } });
    const ok = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(ok.status).toBe(200);
    expect(s.ev).toEqual(['verify:' + FEE_A.slice(0, 4), 'handler', 'settle']);
    expect(decodePaymentResponseHeader(ok.headers.get('payment-response')!).transaction).toBe('SETTLED');
    expect(await ok.json()).toEqual({ ok: true });
  });
  it('no settlement if the handler returns 4xx/5xx (x-payment-status: not-settled)', async () => {
    const s = await setup({ handler: async () => new Response('nope', { status: 500 }) });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(500);
    expect(r.headers.get('x-payment-status')).toBe('not-settled');
    expect(s.facs[0].f.calls.settle).toBe(0);
  });
  it('handler timeout → 504, no settlement', async () => {
    const s = await setup({ handler: () => new Promise((r) => setTimeout(() => r(new Response('late')), 200)), timeoutMs: 20 });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect(r.status).toBe(504);
    expect((await r.json()).message).toContain('No payment was taken');
    expect(s.facs[0].f.calls.settle).toBe(0);
  });
  it('settle success:false but present on-chain → 200 (on-chain decision)', async () => {
    const t = payTx();
    const ev: Ev = [];
    const s = await setup({ facs: [{ spec: { name: 'payai', assets: ['USDC', 'PREQ'] }, f: fac(FEE_A, ev, { settle: 'fail' }) }], chain: [settled(USDC.mint, 20_000n, ['ONCHAIN', t.payerSig])] });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0], t.base64) }));
    expect(r.status).toBe(200);
    expect(decodePaymentResponseHeader(r.headers.get('payment-response')!).transaction).toBe('ONCHAIN');
  });
});

describe('design 1: assets accepted per facilitator', () => {
  it('defaults: PayAI = USDC, PREQ, A402 (deprecated, record of a 2026-11-19 check), Dexter = USDC', () => {
    expect(KNOWN_FACILITATORS.payai.assets).toEqual(['USDC', 'PREQ', 'A402']);
    expect(KNOWN_FACILITATORS.dexter.assets).toEqual(['USDC']);
  });
  it('if the facilitator does not accept PREQ, PREQ is left out of the 402 with a reason', async () => {
    const s = await setup({ facs: [{ spec: { name: 'dexter', assets: ['USDC'] }, f: fac(FEE_B, []) }] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'PREQ', reason: 'facilitator dexter does not accept PREQ' }]);
  });
  it('a PREQ payment sent to a facilitator that does not accept PREQ → not in the requirements, so 402 requirements_mismatch, no verify call', async () => {
    const usdcOnly = fac(FEE_B, []);
    const s = await setup({ facs: [{ spec: { name: 'dexter', assets: ['USDC'] }, f: usdcOnly }] });
    const { pr } = await first402(s.h);
    const forged = { ...pr.accepts[0], asset: PREQ.mint, amount: '10000000000' };
    const r = await s.h(req({ 'payment-signature': sign(forged) }));
    expect(r.status).toBe(402);
    expect((await r.json()).reason).toBe('requirements_mismatch');
    expect(usdcOnly.calls.verify).toBe(0);
  });
});

describe('design 2: drop PREQ when falling back to the backup facilitator', () => {
  it('primary (PayAI) down → backup (Dexter) feePayer, USDC only, PREQ reason shown', async () => {
    const ev: Ev = [];
    const s = await setup({ facs: [
      { spec: { name: 'payai', assets: ['USDC', 'PREQ'] }, f: fac(FEE_A, ev, { down: true }) },
      { spec: { name: 'dexter', assets: ['USDC'] }, f: fac(FEE_B, ev) },
    ] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect((pr.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_B);
    expect(body.notOffered[0]).toMatchObject({ asset: 'PREQ', reason: 'facilitator dexter does not accept PREQ' });
  });
});

describe('design 3: on a facilitator-side problem (fee payer balance too low), move to the next facilitator', () => {
  it('classification: the real Dexter rejection string is facilitator-side, not a buyer-side failure', () => {
    expect(isFacilitatorSideFailure(DEXTER_REASON)).toBe(true);
    expect(isFacilitatorSideFailure('invalid', 'fee payer has insufficient balance')).toBe(true);
    expect(isFacilitatorSideFailure('transaction_simulation_failed: Simulation failed: {"InsufficientFundsForRent":{"account_index":1}}')).toBe(false);
    expect(isFacilitatorSideFailure('invalid_exact_svm_transaction_simulation_failed')).toBe(false);
    expect(isFacilitatorSideFailure('policy:asset_not_allowed: Asset X is not in the allowlist')).toBe(false);
  });
  it('primary facilitator verify fails on a feePayer problem → 402 facilitator_unavailable + backup\'s new requirements, no settlement or handler, later 402s also use the backup, back to primary after the cooldown', async () => {
    const ev: Ev = [];
    const primary = fac(FEE_A, ev, { verify: { isValid: false, invalidReason: DEXTER_REASON } });
    const backup = fac(FEE_B, ev);
    const s = await setup({ facs: [
      { spec: { name: 'primary', assets: ['USDC', 'PREQ'] }, f: primary },
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
    // Pay again with the backup requirements → success
    const ok = await s.h(req({ 'payment-signature': sign(pr2.accepts[0]) }));
    expect(ok.status).toBe(200);
    expect(backup.calls.settle).toBe(1);
    // After the cooldown (5 min), back to the primary
    s.advance(300_001);
    const { pr: pr3 } = await first402(s.h);
    expect((pr3.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_A);
  });
  it('buyer-side failures (insufficient balance, etc.) do not change the facilitator', async () => {
    const ev: Ev = [];
    const primary = fac(FEE_A, ev, { verify: { isValid: false, invalidReason: 'invalid_exact_svm_transaction_simulation_failed' } });
    const s = await setup({ facs: [
      { spec: { name: 'primary', assets: ['USDC', 'PREQ'] }, f: primary },
      { spec: { name: 'backup', assets: ['USDC'] }, f: fac(FEE_B, ev) },
    ] });
    const { pr } = await first402(s.h);
    const r = await s.h(req({ 'payment-signature': sign(pr.accepts[0]) }));
    expect((await r.json()).reason).toBe('invalid_exact_svm_transaction_simulation_failed');
    const { pr: again } = await first402(s.h);
    expect((again.accepts[0].extra as { feePayer: string }).feePayer).toBe(FEE_A);
  });
});

describe('design 4: receiving token account check', () => {
  it('checkReceivingAccounts: addresses and existence of the receiving wallet\'s USDC (SPL) and PREQ (Token-2022) accounts', async () => {
    const s = await setup({ missing: ['PREQ'] });
    const list = await s.gate.checkReceivingAccounts();
    expect(list).toEqual([
      { asset: 'USDC', mint: USDC.mint, tokenAccount: s.usdcAta, exists: true },
      { asset: 'PREQ', mint: PREQ.mint, tokenAccount: s.preqAta, exists: false },
    ]);
  });
  it('without a PREQ receiving account, PREQ is left out of the 402 (with that account address as the reason)', async () => {
    const s = await setup({ missing: ['PREQ'] });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'PREQ', reason: `receiving token account ${s.preqAta} does not exist` }]);
  });
  it('if neither exists, no payment requirements can be offered → 503 (no money taken)', async () => {
    const s = await setup({ missing: ['USDC', 'PREQ'] });
    const r = await s.h(req());
    expect(r.status).toBe(503);
    expect((await r.json()).notOffered).toHaveLength(2);
  });
  it('if the PREQ rate is off, USDC only + the rate reason', async () => {
    const s = await setup({ rate: { status: 'off', date: '2026-11-20', basedOn: '2026-11-19', reason: 'pool depth below threshold', samples: 24 } });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'PREQ', reason: 'pool depth below threshold' }]);
  });
});

describe('design 5: facts stated in the README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  it('states the 4 things it does not do', () => {
    expect(readme).toMatch(/does not operate a facilitator/i);
    expect(readme).toMatch(/does not hold (or custody )?funds/i);
    expect(readme).toMatch(/does not exchange/i);
    expect(readme).toMatch(/does not (accept or send|process) payments on (anyone's|someone else's) behalf/i);
  });
  it('states facilitator check facts with dates (PayAI A402 (v1) worked, Dexter A402 not allowed by policy, PREQ to be checked after launch)', () => {
    expect(readme).toContain('2026-11-19');
    const row = (name: string) => readme.split('\n').find((l) => l.startsWith(`| ${name} `))!.split('|').map((x) => x.trim());
    // Table columns: | facilitator | USDC | A402 |
    expect(row('PayAI')[3]).toMatch(/verify and settle succeeded/);
    expect(row('Dexter')[3]).toContain('policy:asset_not_allowed');
    expect(readme).toMatch(/PREQ has not been checked with any facilitator yet/);
  });
  it('example price is labeled as "example setting"; no discount in the example (default 0)', () => {
    expect(readme).not.toMatch(/discountPercent: \d/);
    expect(readme).toMatch(/priceUsd: 0\.02, \/\/ example setting/);
  });
  it('no rating or recommendation wording', () => {
    expect(readme).not.toMatch(/\b(safe|safest|risky|scam|rug|best|recommend(ed)?|guarantee[ds]?|trustworthy|reliable)\b/i);
  });
});

describe('PREQ switch: empty mint is an error, A402 (v1) only when enabled explicitly + warning, abnormal rates are not offered', () => {
  const base = (extra: Partial<GateConfig>): GateConfig => ({
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.02, usdc: USDC, facilitators: [], chain: { loadTx: async () => null, recentSignatures: async () => [], accounts: async () => ({ slot: 0, accounts: [] }) }, ...extra,
  });
  it('PREQ_MAINNET: symbol PREQ, 6 decimals, Token-2022, mint is the one constant in preq.ts', () => {
    expect(PREQ_MAINNET).toEqual({ symbol: 'PREQ', mint: PREQ_MAINNET_MINT, decimals: 6, tokenProgram: TOKEN_2022 });
  });
  it('with an empty mint, enabling PREQ stops with a clear error (says which value to fill)', () => {
    const rate = async () => RATE_ON;
    expect(() => createPaymentGate(base({ preq: { asset: { ...PREQ_MAINNET, mint: '' }, discountPercent: 30, rate } }))).toThrow(/PREQ mint is not set.*PREQ_MAINNET_MINT/);
    if (!PREQ_MAINNET_MINT) expect(() => createPaymentGate(base({ preq: { asset: PREQ_MAINNET, discountPercent: 30, rate } }))).toThrow(/PREQ_MAINNET_MINT/);
  });
  it('putting the A402 asset in the preq slot is an error (no silent payment in A402)', () => {
    expect(() => createPaymentGate(base({ preq: { asset: A402_MAINNET, discountPercent: 30, rate: async () => RATE_ON } }))).toThrow(/must be PREQ/);
  });
  it('no A402 by default: without a402, no warning and no A402 in the 402', async () => {
    const warns: string[] = [];
    const s = await setup({ facs: [{ spec: { name: 'payai', assets: ['USDC', 'PREQ', 'A402'] }, f: fac(FEE_A, []) }], extra: { warn: (m) => warns.push(m) } });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC', 'PREQ']);
    expect(JSON.stringify(body)).not.toContain('A402');
    expect(warns).toEqual([]);
  });
  it('enabling a402 explicitly prints the deprecation warning (and only then offers A402)', async () => {
    const warns: string[] = [];
    const s = await setup({
      facs: [{ spec: { name: 'payai', assets: ['USDC', 'PREQ', 'A402'] }, f: fac(FEE_A, []) }],
      extra: { a402: { asset: A402_TEST, discountPercent: 30, rate: async () => RATE_ON }, warn: (m) => warns.push(m) },
    });
    expect(warns).toEqual([A402_DEPRECATION_WARNING]);
    expect(A402_DEPRECATION_WARNING).toContain('A402 (v1) is deprecated and no longer supported; use PREQ.');
    const { pr } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC', 'PREQ', 'A402']);
  });
  it('a rate of 0 means PREQ is not offered (no division by zero, USDC unchanged)', async () => {
    const s = await setup({ rate: { ...RATE_ON, tokenUsd: 0 } });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered).toEqual([{ asset: 'PREQ', reason: 'PREQ rate out of range' }]);
  });
  it('same for NaN, infinite or negative rates', async () => {
    for (const tokenUsd of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const s = await setup({ rate: { ...RATE_ON, tokenUsd } });
      const { pr, body } = await first402(s.h);
      expect(symbols(pr.accepts)).toEqual(['USDC']);
      expect(body.notOffered[0]).toMatchObject({ asset: 'PREQ', reason: 'PREQ rate out of range' });
    }
  });
  it('if the price is so small that the amount exceeds u64 (like right after a single-sided pool opens), PREQ is not offered', async () => {
    const s = await setup({ rate: { ...RATE_ON, tokenUsd: 1e-30 } });
    const { pr, body } = await first402(s.h);
    expect(symbols(pr.accepts)).toEqual(['USDC']);
    expect(body.notOffered[0]).toMatchObject({ asset: 'PREQ', reason: 'PREQ rate out of range' });
  });
});