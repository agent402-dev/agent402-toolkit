// a402-pay-mcp: 정책(기본 전부 거절)·사람 확인·결제 기록·공격 시나리오 (단위). 실제 서명은 로컬 Surfpool 리허설로 확인 (개발 저장소)
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createAgent, type ConfirmAnswer } from 'a402-pay-mcp/agent';
import { jsonlHistory } from 'a402-pay-mcp/history';
import { domainCheck, evaluate, NETWORKS, policyFromEnv, type PolicyEnv } from 'a402-pay-mcp/policy';
import { createPayServer } from 'a402-pay-mcp/tools';
import { formatUnits, withSmallest } from 'a402-pay-mcp/units';
import type { Wallet } from 'a402-pay-mcp/wallet';

const pk = () => Keypair.generate().publicKey.toBase58();
const TRUSTED = pk();
const EVIL = pk();
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const A402 = '5R2rKmzsNk1S5mFPR99bU1anromo73brwNApghvXeb46';
const HOST = 'api.good.test';
const BASE: PolicyEnv = { X402_NETWORK: 'devnet', X402_ALLOWED_DOMAINS: HOST, X402_TRUSTED_PAY_TO: TRUSTED };

const req = (o: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact', network: NETWORKS.devnet as never, asset: USDC, amount: '20000', payTo: TRUSTED, maxTimeoutSeconds: 60,
  extra: { feePayer: 'FEE', name: 'USDC', decimals: 6 }, ...o,
});
const r402 = (accepts: PaymentRequirements[], resource = `https://${HOST}/paid`) => {
  const pr = { x402Version: 2, resource: { url: resource }, accepts };
  return new Response(JSON.stringify(pr), { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr as never) } });
};
const paidOk = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'payment-response': encodePaymentResponseHeader({ success: true, transaction: 'TXID', network: NETWORKS.devnet as never, payer: 'P' }) } });

/** 가짜 서버: 경로별 응답 함수. 결제 헤더가 붙은 요청 수를 셈 */
function server(routes: Record<string, (r: Request, n: number) => Response>) {
  const seen = { payments: 0, requests: [] as string[] };
  const counts: Record<string, number> = {};
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = new Request(input, init);
    seen.requests.push(r.url);
    if (r.headers.get('payment-signature')) seen.payments++;
    const u = new URL(r.url);
    const key = `${u.host}${u.pathname}`;
    counts[key] = (counts[key] ?? 0) + 1;
    const h = routes[key];
    return h ? h(r, counts[key]) : new Response('nf', { status: 404 });
  }) as typeof fetch;
  return { f, seen };
}
function fakeWallet(): Wallet & { n: number } {
  const w = { address: 'BUYER', network: NETWORKS.devnet, n: 0, get signedCount() { return w.n; }, async sign() { w.n++; return 'SIGNED-PAYLOAD'; }, async balances() { return {}; } };
  return w;
}
function agentWith(env: PolicyEnv, routes: Record<string, (r: Request, n: number) => Response>, confirm: ConfirmAnswer = 'accept') {
  const dir = mkdtempSync(join(tmpdir(), 'paymcp-'));
  const policy = policyFromEnv(env);
  const history = jsonlHistory(join(dir, 'h.jsonl'), () => policy.mints);
  const wallet = fakeWallet();
  const srv = server(routes);
  const confirms: string[] = [];
  const agent = createAgent({ policy, wallet, history, fetch: srv.f, confirm: async (m) => { confirms.push(m); return confirm; } });
  return { agent, wallet, history, srv, confirms, file: join(dir, 'h.jsonl') };
}

describe('정책 기본값: 허용 목록이 비어 있으면 전부 거절', () => {
  it('설정 없음 → 도메인·수령 주소 모두 비어 있음, 자산은 USDC 만, 확인 기준 없음', () => {
    const p = policyFromEnv({});
    expect(p).toMatchObject({ allowedDomains: [], trustedPayTo: [], allowedAssets: ['USDC'], maxUsdPerPayment: 0.05, maxPaymentsPerDay: 20, maxUsdPerDay: 1, confirmAboveUsd: null, network: NETWORKS.mainnet });
    expect(domainCheck(p, 'https://api.good.test/x')).toEqual({ ok: false, reason: expect.stringContaining('allowed domain list is empty') });
    expect(evaluate(p, req({ network: NETWORKS.mainnet as never, asset: p.mints.USDC }), { count: 0, usd: 0, a402: 0n }).reasons.join()).toContain('trusted recipient list is empty');
  });
  it('허용 목록 없이 x402_fetch → 거절, 서명 0, 서버에 요청도 보내지 않음', async () => {
    const t = agentWith({ X402_NETWORK: 'devnet' }, { [`${HOST}/paid`]: () => r402([req()]) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.requests).toEqual([]);
  });
  it('https 만 (http 는 localhost·127.0.0.1 만)', () => {
    const p = policyFromEnv({ X402_ALLOWED_DOMAINS: 'api.good.test,127.0.0.1:8788' });
    expect(domainCheck(p, 'http://api.good.test/x').ok).toBe(false);
    expect(domainCheck(p, 'http://127.0.0.1:8788/x').ok).toBe(true);
    expect(domainCheck(p, 'https://API.GOOD.TEST/x').ok).toBe(true);
    expect(domainCheck(p, 'https://evil.api.good.test/x').ok).toBe(false);
  });
});

describe('정상 결제와 기록', () => {
  it('허용 도메인·신뢰 수령 주소·USDC 0.02 → 서명 1회, 200, 기록에 tx (키·결제 헤더 원문 없음)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r).toMatchObject({ result: 'paid', httpStatus: 200, payment: { asset: 'USDC', amount: '20000', payTo: TRUSTED, settlementTx: 'TXID' } });
    expect(t.wallet.n).toBe(1);
    const h = t.history.list();
    expect(h[0]).toMatchObject({ result: 'paid', asset: 'USDC', amount: '20000', payTo: TRUSTED, settlementTx: 'TXID', signed: true, host: HOST });
    const raw = readFileSync(t.file, 'utf8');
    expect(raw).not.toContain('SIGNED-PAYLOAD');
    expect(raw).not.toMatch(/secret|privateKey|payment-signature/i);
    expect(t.history.today()).toEqual({ count: 1, usd: 0.02, a402: 0n });
  });
  it('결제 뒤 서버가 다시 402 → 다시 서명하지 않음 (rejected_by_server)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req()]) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('rejected_by_server');
    expect(t.wallet.n).toBe(1);
  });
  it('하루 USD 상한·횟수 상한 (기록 기준)', async () => {
    const t = agentWith({ ...BASE, X402_MAX_USD_PER_DAY: '0.03', X402_MAX_PAYMENTS_PER_DAY: '5' }, { [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    const second = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(second.result).toBe('refused');
    expect(second.reasons!.join()).toContain('over_daily_usd_limit');
    expect(t.wallet.n).toBe(1);
  });
});

describe('A402 한도 (결제당·하루 총량, 설정 없으면 A402 거절)', () => {
  const a402Env = { ...BASE, X402_ALLOWED_ASSETS: 'USDC,A402', X402_PAY_WITH: 'A402' };
  const routesFor = (amount: string) => ({ [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req({ asset: A402, amount })])) });
  it('기본값: A402 한도 둘 다 없음 (null)', () => {
    const p = policyFromEnv(a402Env);
    expect(p.maxA402PerPayment).toBeNull();
    expect(p.maxA402PerDay).toBeNull();
    expect(policyFromEnv({ ...a402Env, X402_MAX_A402_ATOMIC: 'abc', X402_MAX_A402_PER_DAY_ATOMIC: '0' })).toMatchObject({ maxA402PerPayment: null, maxA402PerDay: null });
  });
  it('미설정: A402 허용인데 결제당·하루 한도가 없으면 거절 + 설정 안내 (서명 0)', async () => {
    const t = agentWith(a402Env, routesFor('5000000'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_A402_ATOMIC');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_A402_PER_DAY_ATOMIC');
    expect(t.wallet.n).toBe(0);
  });
  it('미설정: 하나만 설정해도 나머지가 없으면 거절', async () => {
    const t = agentWith({ ...a402Env, X402_MAX_A402_ATOMIC: '10000000' }, routesFor('5000000'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_A402_PER_DAY_ATOMIC');
    expect(r.reasons!.join(' ')).not.toContain('set X402_MAX_A402_ATOMIC ');
    expect(t.wallet.n).toBe(0);
  });
  it('결제당 초과 → 거절 (서명 0)', async () => {
    const t = agentWith({ ...a402Env, X402_MAX_A402_ATOMIC: '10000000', X402_MAX_A402_PER_DAY_ATOMIC: '100000000' }, routesFor('10000001'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('over_per_payment_limit: 10000001 > 10000000 (A402 smallest units)');
    expect(t.wallet.n).toBe(0);
  });
  it('정상 범위 결제 → paid, 하루 사용량에 A402 합계 / 하루 총량 초과 → 거절', async () => {
    const t = agentWith({ ...a402Env, X402_MAX_A402_ATOMIC: '10000000', X402_MAX_A402_PER_DAY_ATOMIC: '15000000' }, routesFor('8000000'));
    const ok = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(ok).toMatchObject({ result: 'paid', payment: { asset: 'A402', amount: '8000000' } });
    expect(t.history.today()).toEqual({ count: 1, usd: 0, a402: 8_000_000n });
    const over = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(over.result).toBe('refused');
    expect(over.reasons!.join(' ')).toContain('over_daily_a402_limit: 8000000 + 8000000 > 15000000 (A402 smallest units)');
    expect(t.wallet.n).toBe(1);
  });
  it('USDC 한도는 A402 와 별개 (A402 를 써도 USDC 하루 USD 합계는 0)', async () => {
    const t = agentWith({ ...a402Env, X402_MAX_A402_ATOMIC: '10000000', X402_MAX_A402_PER_DAY_ATOMIC: '100000000' }, routesFor('8000000'));
    await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(t.history.today().usd).toBe(0);
  });
});

describe('README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  it('A402 한도 두 개와 "미설정이면 거절"을 적음, 허용 목록 기본 거절', () => {
    expect(readme).toMatch(/X402_MAX_A402_ATOMIC` \| \*\*not set → A402 payments refused/);
    expect(readme).toMatch(/X402_MAX_A402_PER_DAY_ATOMIC` \| \*\*not set → A402 payments refused/);
    expect(readme).toMatch(/With no configuration, every payment is refused/);
    expect(readme).toMatch(/does not operate a facilitator/);
  });
});

describe('사람 확인 (기준 금액 이상)', () => {
  const env = { ...BASE, X402_CONFIRM_ABOVE_USD: '0.02' };
  const routes = { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) };
  it('클라이언트가 확인을 지원하지 않으면 결제하지 않음 (confirmation_required, 서명 0)', async () => {
    const t = agentWith(env, routes, 'unsupported');
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('confirmation_required');
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.payments).toBe(0);
  });
  it('거절하면 결제 안 함, 승인하면 결제', async () => {
    const d = agentWith(env, routes, 'decline');
    expect((await d.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('declined_by_user');
    expect(d.wallet.n).toBe(0);
    const a = agentWith(env, routes, 'accept');
    expect((await a.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    expect(a.confirms[0]).toContain(`0.02 USDC to ${TRUSTED}`);
  });
  it('기준 미만이면 묻지 않음', async () => {
    const t = agentWith({ ...BASE, X402_CONFIRM_ABOVE_USD: '0.03' }, routes, 'unsupported');
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    expect(t.confirms).toEqual([]);
  });
});

describe('공격 시나리오 5가지 — 서명 전 거절 (서명 0, 결제 헤더 전송 0)', () => {
  const expectRefusedBeforeSigning = (t: ReturnType<typeof agentWith>, r: { result: string; reasons?: string[] }, reason: RegExp) => {
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toMatch(reason);
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.payments).toBe(0);
    expect(t.history.list()[0]).toMatchObject({ result: 'refused', signed: false });
  };
  it('1) 허용 도메인인데 402 가 다른 수령 주소를 요구', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ payTo: EVIL })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /pay_to_not_trusted/);
  });
  it('2) 상한(0.05 USD)보다 큰 금액', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ amount: '1000000' })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /over_per_payment_limit/);
  });
  it('3) 견적 뒤 재요청 때 금액·수령 주소를 바꿈 (quoteId 고정)', async () => {
    const t = agentWith({ ...BASE, X402_TRUSTED_PAY_TO: `${TRUSTED},${EVIL}` }, {
      [`${HOST}/paid`]: (_r, n) => (n === 1 ? r402([req()]) : r402([req({ amount: '40000', payTo: EVIL })])),
    });
    const q = await t.agent.quote({ url: `https://${HOST}/paid` });
    expect(q.quoteId).toBeTruthy();
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid`, quoteId: q.quoteId }), /requirements_changed_since_quote: amount,payTo/);
  });
  it('4) 다른 민트 (허용 목록에 없는 토큰)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ asset: pk() })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /asset_not_allowed: unknown mint/);
  });
  it('4b) A402 를 허용하지 않았는데 A402 만 요구', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ asset: A402, amount: '5' })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /asset_not_allowed: A402/);
  });
  it('5) 허용 도메인에서 허용 안 된 도메인으로 리다이렉트 → 그 도메인에는 요청도 보내지 않음', async () => {
    const t = agentWith(BASE, {
      [`${HOST}/paid`]: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/pay' } }),
      'evil.test/pay': () => r402([req()], 'https://evil.test/pay'),
    });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /redirect_to_disallowed_domain/);
    expect(t.srv.seen.requests.some((u) => u.includes('evil.test'))).toBe(false);
  });
  it('5b) 402 의 resource 가 허용 안 된 도메인을 가리킴', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req()], 'https://evil.test/pay') });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /resource_on_disallowed_domain/);
  });
});

describe('MCP 서버 (도구 4개, elicitation)', () => {
  async function connect(elicit: 'accept' | 'decline' | null) {
    const dir = mkdtempSync(join(tmpdir(), 'paymcp-s-'));
    const policy = policyFromEnv({ ...BASE, X402_CONFIRM_ABOVE_USD: '0.01' });
    const wallet = fakeWallet();
    const srv = server({ [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet, history: jsonlHistory(join(dir, 'h.jsonl'), () => policy.mints), fetch: srv.f }).connect(a);
    const client = new Client({ name: 't', version: '0' }, { capabilities: elicit ? { elicitation: {} } : {} });
    if (elicit) client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { confirm: elicit === 'accept' } }));
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
    };
    return { client, call, wallet };
  }
  it('도구 4개, 설명에 서명 전 규칙', async () => {
    const { client } = await connect(null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['payment_history', 'wallet_status', 'x402_fetch', 'x402_quote']);
    expect(tools.find((t) => t.name === 'x402_fetch')!.description).toMatch(/before signing/);
  });
  it('elicitation 미지원 클라이언트 → 결제 안 함', async () => {
    const s = await connect(null);
    const r = await s.call('x402_fetch', { url: `https://${HOST}/paid` });
    expect(r).toMatchObject({ isError: true, body: { result: 'confirmation_required' } });
    expect(s.wallet.n).toBe(0);
  });
  it('elicitation 승인 → 결제, 거절 → 결제 안 함, wallet_status·payment_history', async () => {
    const yes = await connect('accept');
    expect((await yes.call('x402_fetch', { url: `https://${HOST}/paid` })).body.result).toBe('paid');
    const st = (await yes.call('wallet_status')).body;
    expect(st).toMatchObject({ address: 'BUYER', today: { count: 1, usd: 0.02, a402: '0' }, allowedDomains: [HOST], trustedPayTo: [TRUSTED], allowedAssets: ['USDC'] });
    expect(st.limits.maxA402PerPaymentAtomic).toContain('not set (X402_MAX_A402_ATOMIC)');
    expect(st.limits.maxA402PerDayAtomic).toContain('not set (X402_MAX_A402_PER_DAY_ATOMIC)');
    expect((await yes.call('payment_history')).body[0]).toMatchObject({ result: 'paid', settlementTx: 'TXID' });
    const no = await connect('decline');
    expect((await no.call('x402_fetch', { url: `https://${HOST}/paid` })).body.result).toBe('declined_by_user');
    expect(no.wallet.n).toBe(0);
  });
  it('x402_quote 는 서명하지 않음', async () => {
    const s = await connect(null);
    const q = await s.call('x402_quote', { url: `https://${HOST}/paid` });
    expect(q.body).toMatchObject({ payment: { asset: 'USDC', amount: '20000' }, reasons: ['will_ask_for_confirmation'] });
    expect(s.wallet.n).toBe(0);
  });
  it('금액에 단위 표시: x402_quote·payment_history·wallet_status', async () => {
    const s = await connect('accept');
    const q = await s.call('x402_quote', { url: `https://${HOST}/paid` });
    expect(q.body.payment).toMatchObject({ amountDisplay: '0.02 USDC', amountUnit: 'USDC smallest unit (1 USDC = 1,000,000)' });
    await s.call('x402_fetch', { url: `https://${HOST}/paid` });
    expect((await s.call('payment_history')).body[0]).toMatchObject({ amount: '20000', amountDisplay: '0.02 USDC' });
    const st = (await s.call('wallet_status')).body;
    expect(st.today).toMatchObject({ a402: '0', a402Unit: 'A402 smallest unit (1 A402 = 1,000,000)', a402Display: '0 A402' });
    expect(st.limits.units).toMatch(/Atomic = A402 smallest unit/);
  });
});

describe('단위 표시 formatUnits', () => {
  it('최소 단위 → 토큰 단위 (6자리)', () => {
    expect(formatUnits(140_000_000_000n, 'A402')).toBe('140,000 A402');
    expect(formatUnits('20000', 'USDC')).toBe('0.02 USDC');
    expect(formatUnits('1', 'A402')).toBe('0.000001 A402');
    expect(formatUnits(0n, 'A402')).toBe('0 A402');
    expect(withSmallest('140000000000', 'A402')).toBe('140,000 A402 (140000000000 smallest units)');
  });
  it('wallet_status: A402 한도를 설정하면 단위 붙인 표시도', async () => {
    const policy = policyFromEnv({ ...BASE, X402_ALLOWED_ASSETS: 'USDC,A402', X402_MAX_A402_ATOMIC: '200000000000', X402_MAX_A402_PER_DAY_ATOMIC: '500000000' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet: null, history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'u-')), 'h.jsonl'), () => policy.mints), fetch }).connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const r = (await client.callTool({ name: 'wallet_status', arguments: {} })) as { content: { text: string }[] };
    const st = JSON.parse(r.content[0].text);
    expect(st.limits).toMatchObject({ maxA402PerPaymentAtomic: '200000000000', maxA402PerPaymentDisplay: '200,000 A402', maxA402PerDayDisplay: '500 A402' });
  });
});
