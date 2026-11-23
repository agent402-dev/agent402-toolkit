// @agent402-dev/pay-mcp: policy (reject all by default), human confirmation, payment history, attack scenarios (unit). Real signing is checked in a local Surfpool rehearsal (dev repository)
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createAgent, type ConfirmAnswer } from '@agent402-dev/pay-mcp/agent';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { A402_DEPRECATION_WARNING, domainCheck, evaluate, NETWORKS, policyFromEnv, PREQ_MAINNET_MINT as PAY_MCP_PREQ_MINT, symbolOf, type PolicyEnv } from '@agent402-dev/pay-mcp/policy';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';
import { csvField, historyToCsv, CSV_COLUMNS } from '@agent402-dev/pay-mcp/csv';
import { initWallet } from '@agent402-dev/pay-mcp/init';
import { nearLimits } from '@agent402-dev/pay-mcp/policy';
import { RECEIPT_HEADER } from '@agent402-dev/pay-mcp/receipt';
import { receiptSignerFromBytes, sha256Hex, signReceipt } from '@agent402-dev/pay-server/receipt';
import { signRegistration } from '@agent402-dev/pay-server/registration';
import { decodeStreamflow, JUPITER_LOCK_PROGRAM, readLock, STREAMFLOW_PROGRAM, streamflowLockedAt, streamflowNotFixed, type AccountsFetcher } from '@agent402-dev/pay-mcp/locks';
import { formatUnits, withSmallest } from '@agent402-dev/pay-mcp/units';
import type { Wallet } from '@agent402-dev/pay-mcp/wallet';

const pk = () => Keypair.generate().publicKey.toBase58();
const TRUSTED = pk();
const EVIL = pk();
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
/** devnet A402 (v1, deprecated) mint, for testing deprecated behavior */
const A402 = '5R2rKmzsNk1S5mFPR99bU1anromo73brwNApghvXeb46';
/** devnet has no PREQ mint, so a test mint is passed with X402_PREQ_MINT */
const PREQ = pk();
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

/** Fake server: response function per path. Counts requests carrying a payment header */
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
  const w = { address: 'BUYER', network: NETWORKS.devnet, n: 0, get signedCount() { return w.n; }, async sign() { w.n++; return 'SIGNED-PAYLOAD'; }, async balances() { return {}; }, async signBytes(): Promise<Uint8Array> { throw new Error('bond signing not used here'); } };
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

describe('policy defaults: reject everything when allowlists are empty', () => {
  it('no config → domains and receivers empty, USDC only, no confirmation threshold', () => {
    const p = policyFromEnv({});
    expect(p).toMatchObject({ allowedDomains: [], trustedPayTo: [], allowedAssets: ['USDC'], maxUsdPerPayment: 0.05, maxPaymentsPerDay: 20, maxUsdPerDay: 1, confirmAboveUsd: null, network: NETWORKS.mainnet });
    expect(domainCheck(p, 'https://api.good.test/x')).toEqual({ ok: false, reason: expect.stringContaining('allowed domain list is empty') });
    expect(evaluate(p, req({ network: NETWORKS.mainnet as never, asset: p.mints.USDC }), { count: 0, usd: 0, preq: 0n, a402: 0n }).reasons.join()).toContain('trusted recipient list is empty');
  });
  it('x402_fetch without allowlists → rejected, 0 signatures, no request even sent to the server', async () => {
    const t = agentWith({ X402_NETWORK: 'devnet' }, { [`${HOST}/paid`]: () => r402([req()]) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.requests).toEqual([]);
  });
  it('https only (http only for localhost and 127.0.0.1)', () => {
    const p = policyFromEnv({ X402_ALLOWED_DOMAINS: 'api.good.test,127.0.0.1:8788' });
    expect(domainCheck(p, 'http://api.good.test/x').ok).toBe(false);
    expect(domainCheck(p, 'http://127.0.0.1:8788/x').ok).toBe(true);
    expect(domainCheck(p, 'https://API.GOOD.TEST/x').ok).toBe(true);
    expect(domainCheck(p, 'https://evil.api.good.test/x').ok).toBe(false);
  });
});

describe('normal payment and history', () => {
  it('allowed domain, trusted receiver, USDC 0.02 → 1 signature, 200, tx in history (no key or raw payment header)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r).toMatchObject({ result: 'paid', httpStatus: 200, payment: { asset: 'USDC', amount: '20000', payTo: TRUSTED, settlementTx: 'TXID' } });
    expect(t.wallet.n).toBe(1);
    const h = t.history.list();
    expect(h[0]).toMatchObject({ result: 'paid', asset: 'USDC', amount: '20000', payTo: TRUSTED, settlementTx: 'TXID', signed: true, host: HOST });
    const raw = readFileSync(t.file, 'utf8');
    expect(raw).not.toContain('SIGNED-PAYLOAD');
    expect(raw).not.toMatch(/secret|privateKey|payment-signature/i);
    expect(t.history.today()).toEqual({ count: 1, usd: 0.02, preq: 0n, a402: 0n });
  });
  it('server returns 402 again after payment → does not sign again (rejected_by_server)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req()]) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('rejected_by_server');
    expect(t.wallet.n).toBe(1);
  });
  it('daily USD cap and count cap (based on history)', async () => {
    const t = agentWith({ ...BASE, X402_MAX_USD_PER_DAY: '0.03', X402_MAX_PAYMENTS_PER_DAY: '5' }, { [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    const second = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(second.result).toBe('refused');
    expect(second.reasons!.join()).toContain('over_daily_usd_limit');
    expect(t.wallet.n).toBe(1);
  });
});

describe('PREQ limits (per payment and daily total; PREQ rejected if not set)', () => {
  const preqEnv = { ...BASE, X402_PREQ_MINT: PREQ, X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_PAY_WITH: 'PREQ' };
  const routesFor = (amount: string) => ({ [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req({ asset: PREQ, amount })])) });
  it('defaults: both PREQ limits unset (null)', () => {
    const p = policyFromEnv(preqEnv);
    expect(p.tokenLimits.PREQ).toEqual({ perPayment: null, perDay: null, confirmAbove: null });
    expect(policyFromEnv({ ...preqEnv, X402_MAX_PREQ_ATOMIC: 'abc', X402_MAX_PREQ_PER_DAY_ATOMIC: '0' }).tokenLimits.PREQ).toMatchObject({ perPayment: null, perDay: null });
  });
  it('unset: PREQ allowed but no per-payment and daily limits → rejected + setup hint (0 signatures)', async () => {
    const t = agentWith(preqEnv, routesFor('5000000'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_PREQ_ATOMIC');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_PREQ_PER_DAY_ATOMIC');
    expect(t.wallet.n).toBe(0);
  });
  it('unset: setting only one of them still rejects', async () => {
    const t = agentWith({ ...preqEnv, X402_MAX_PREQ_ATOMIC: '10000000' }, routesFor('5000000'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('set X402_MAX_PREQ_PER_DAY_ATOMIC');
    expect(r.reasons!.join(' ')).not.toContain('set X402_MAX_PREQ_ATOMIC ');
    expect(t.wallet.n).toBe(0);
  });
  it('over the per-payment cap → rejected (0 signatures)', async () => {
    const t = agentWith({ ...preqEnv, X402_MAX_PREQ_ATOMIC: '10000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '100000000' }, routesFor('10000001'));
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('over_per_payment_limit: 10000001 > 10000000 (PREQ smallest units)');
    expect(t.wallet.n).toBe(0);
  });
  it('payment within range → paid, PREQ total in daily usage / over the daily total → rejected', async () => {
    const t = agentWith({ ...preqEnv, X402_MAX_PREQ_ATOMIC: '10000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '15000000' }, routesFor('8000000'));
    const ok = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(ok).toMatchObject({ result: 'paid', payment: { asset: 'PREQ', amount: '8000000' } });
    expect(t.history.today()).toEqual({ count: 1, usd: 0, preq: 8_000_000n, a402: 0n });
    const over = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(over.result).toBe('refused');
    expect(over.reasons!.join(' ')).toContain('over_daily_preq_limit: 8000000 + 8000000 > 15000000 (PREQ smallest units)');
    expect(t.wallet.n).toBe(1);
  });
  it('USDC limits are separate from PREQ (USDC daily USD total stays 0 when paying in PREQ)', async () => {
    const t = agentWith({ ...preqEnv, X402_MAX_PREQ_ATOMIC: '10000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '100000000' }, routesFor('8000000'));
    await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(t.history.today().usd).toBe(0);
  });
});

describe('README', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  it('states the two PREQ limits and "rejected if unset", allowlists reject by default, one line at the top on A402 (v1) deprecation', () => {
    expect(readme).toMatch(/X402_MAX_PREQ_ATOMIC` \| \*\*not set → PREQ payments refused/);
    expect(readme).toMatch(/X402_MAX_PREQ_PER_DAY_ATOMIC` \| \*\*not set → PREQ payments refused/);
    expect(readme.split('\n').slice(0, 4).join('\n')).toContain('A402 (v1) is deprecated.');
    expect(readme).toMatch(/With no configuration, every payment is refused/);
    expect(readme).toMatch(/does not operate a facilitator/);
  });
});

describe('human confirmation (at or above the threshold)', () => {
  const env = { ...BASE, X402_CONFIRM_ABOVE_USD: '0.02' };
  const routes = { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) };
  it('no payment if the client does not support confirmation (confirmation_required, 0 signatures)', async () => {
    const t = agentWith(env, routes, 'unsupported');
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('confirmation_required');
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.payments).toBe(0);
  });
  it('declined → no payment, approved → payment', async () => {
    const d = agentWith(env, routes, 'decline');
    expect((await d.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('declined_by_user');
    expect(d.wallet.n).toBe(0);
    const a = agentWith(env, routes, 'accept');
    expect((await a.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    expect(a.confirms[0]).toContain(`0.02 USDC to ${TRUSTED}`);
  });
  it('below the threshold → does not ask', async () => {
    const t = agentWith({ ...BASE, X402_CONFIRM_ABOVE_USD: '0.03' }, routes, 'unsupported');
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    expect(t.confirms).toEqual([]);
  });
});

describe('5 attack scenarios: rejected before signing (0 signatures, 0 payment headers sent)', () => {
  const expectRefusedBeforeSigning = (t: ReturnType<typeof agentWith>, r: { result: string; reasons?: string[] }, reason: RegExp) => {
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toMatch(reason);
    expect(t.wallet.n).toBe(0);
    expect(t.srv.seen.payments).toBe(0);
    expect(t.history.list()[0]).toMatchObject({ result: 'refused', signed: false });
  };
  it('1) allowed domain, but the 402 asks for another receiver', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ payTo: EVIL })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /pay_to_not_trusted/);
  });
  it('2) amount above the cap (0.05 USD)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ amount: '1000000' })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /over_per_payment_limit/);
  });
  it('3) amount or receiver changed on the re-request after the quote (quoteId fixed)', async () => {
    const t = agentWith({ ...BASE, X402_TRUSTED_PAY_TO: `${TRUSTED},${EVIL}` }, {
      [`${HOST}/paid`]: (_r, n) => (n === 1 ? r402([req()]) : r402([req({ amount: '40000', payTo: EVIL })])),
    });
    const q = await t.agent.quote({ url: `https://${HOST}/paid` });
    expect(q.quoteId).toBeTruthy();
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid`, quoteId: q.quoteId }), /requirements_changed_since_quote: amount,payTo/);
  });
  it('4) a different mint (a token not on the allowlist)', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ asset: pk() })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /asset_not_allowed: unknown mint/);
  });
  it('4b) asks only for A402 when A402 is not allowed', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ asset: A402, amount: '5' })]) });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /asset_not_allowed: A402/);
  });
  it('5) redirect from an allowed domain to a disallowed one → no request is even sent to that domain', async () => {
    const t = agentWith(BASE, {
      [`${HOST}/paid`]: () => new Response(null, { status: 302, headers: { location: 'https://evil.test/pay' } }),
      'evil.test/pay': () => r402([req()], 'https://evil.test/pay'),
    });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /redirect_to_disallowed_domain/);
    expect(t.srv.seen.requests.some((u) => u.includes('evil.test'))).toBe(false);
  });
  it('5b) the 402 resource points to a disallowed domain', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req()], 'https://evil.test/pay') });
    expectRefusedBeforeSigning(t, await t.agent.payAndFetch({ url: `https://${HOST}/paid` }), /resource_on_disallowed_domain/);
  });
});

describe('MCP server (11 tools, elicitation)', () => {
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
  it('11 tools, pre-signing rules in the descriptions', async () => {
    const { client } = await connect(null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['bond_confirm_and_pay', 'bond_deal_status', 'bond_job_quote', 'bond_job_result', 'bond_job_start', 'bond_open', 'bond_settle', 'payment_history', 'wallet_status', 'x402_fetch', 'x402_quote']);
    expect(tools.find((t) => t.name === 'x402_fetch')!.description).toMatch(/before signing/);
  });
  it('client without elicitation support → no payment', async () => {
    const s = await connect(null);
    const r = await s.call('x402_fetch', { url: `https://${HOST}/paid` });
    expect(r).toMatchObject({ isError: true, body: { result: 'confirmation_required' } });
    expect(s.wallet.n).toBe(0);
  });
  it('elicitation approved → payment, declined → no payment, wallet_status and payment_history', async () => {
    const yes = await connect('accept');
    expect((await yes.call('x402_fetch', { url: `https://${HOST}/paid` })).body.result).toBe('paid');
    const st = (await yes.call('wallet_status')).body;
    expect(st).toMatchObject({ address: 'BUYER', today: { count: 1, usd: 0.02, preq: '0' }, allowedDomains: [HOST], trustedPayTo: [TRUSTED], allowedAssets: ['USDC'] });
    expect(st.limits.maxPreqPerPaymentAtomic).toContain('not set (X402_MAX_PREQ_ATOMIC) — PREQ payments refused');
    expect(st.limits.maxPreqPerDayAtomic).toContain('not set (X402_MAX_PREQ_PER_DAY_ATOMIC)');
    // If A402 (v1) is not allowed, no A402 field and no warning
    expect(JSON.stringify(st)).not.toContain('A402');
    expect((await yes.call('payment_history')).body[0]).toMatchObject({ result: 'paid', settlementTx: 'TXID' });
    const no = await connect('decline');
    expect((await no.call('x402_fetch', { url: `https://${HOST}/paid` })).body.result).toBe('declined_by_user');
    expect(no.wallet.n).toBe(0);
  });
  it('x402_quote does not sign', async () => {
    const s = await connect(null);
    const q = await s.call('x402_quote', { url: `https://${HOST}/paid` });
    expect(q.body).toMatchObject({ payment: { asset: 'USDC', amount: '20000' }, reasons: ['will_ask_for_confirmation'] });
    expect(s.wallet.n).toBe(0);
  });
  it('amounts shown with units: x402_quote, payment_history, wallet_status', async () => {
    const s = await connect('accept');
    const q = await s.call('x402_quote', { url: `https://${HOST}/paid` });
    expect(q.body.payment).toMatchObject({ amountDisplay: '0.02 USDC', amountUnit: 'USDC smallest unit (1 USDC = 1,000,000)' });
    await s.call('x402_fetch', { url: `https://${HOST}/paid` });
    expect((await s.call('payment_history')).body[0]).toMatchObject({ amount: '20000', amountDisplay: '0.02 USDC' });
    const st = (await s.call('wallet_status')).body;
    expect(st.today).toMatchObject({ preq: '0', preqUnit: 'PREQ smallest unit (1 PREQ = 1,000,000)', preqDisplay: '0 PREQ' });
    expect(st.limits.units).toMatch(/Atomic = token smallest unit \(1 PREQ = 1,000,000\)/);
  });
});

describe('unit display formatUnits', () => {
  it('base units → token units (6 decimals)', () => {
    expect(formatUnits(140_000_000_000n, 'PREQ')).toBe('140,000 PREQ');
    expect(formatUnits('20000', 'USDC')).toBe('0.02 USDC');
    expect(formatUnits('1', 'PREQ')).toBe('0.000001 PREQ');
    expect(formatUnits(0n, 'PREQ')).toBe('0 PREQ');
    expect(withSmallest('140000000000', 'PREQ')).toBe('140,000 PREQ (140000000000 smallest units)');
  });
  it('wallet_status: with PREQ limits set, also shows unit displays', async () => {
    const policy = policyFromEnv({ ...BASE, X402_PREQ_MINT: PREQ, X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_MAX_PREQ_ATOMIC: '200000000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '500000000' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet: null, history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'u-')), 'h.jsonl'), () => policy.mints), fetch }).connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const r = (await client.callTool({ name: 'wallet_status', arguments: {} })) as { content: { text: string }[] };
    const st = JSON.parse(r.content[0].text);
    expect(st.limits).toMatchObject({ maxPreqPerPaymentAtomic: '200000000000', maxPreqPerPaymentDisplay: '200,000 PREQ', maxPreqPerDayDisplay: '500 PREQ' });
  });
});

describe('PREQ switch: empty mint is an error, A402 (v1) only when enabled explicitly + warning', () => {
  it('allowing PREQ while the mainnet PREQ mint is empty → a clear error at start (X402_PREQ_MINT can supply it)', () => {
    if (!PAY_MCP_PREQ_MINT) expect(() => policyFromEnv({ X402_ALLOWED_ASSETS: 'USDC,PREQ' })).toThrow(/PREQ mint is not set.*PREQ_MAINNET_MINT/);
    expect(() => policyFromEnv({ X402_NETWORK: 'devnet', X402_ALLOWED_ASSETS: 'USDC,PREQ' })).toThrow(/PREQ mint is not set/);
    expect(policyFromEnv({ X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_PREQ_MINT: PREQ }).mints.PREQ).toBe(PREQ);
    // If not allowed, it still starts with an empty mint (USDC only)
    expect(policyFromEnv({}).allowedAssets).toEqual(['USDC']);
  });
  it('an empty mint matches no payment requirement (an empty asset string is not treated as PREQ)', () => {
    const p = policyFromEnv(BASE);
    expect(symbolOf(p, '')).toBeNull();
    expect(evaluate(p, req({ asset: '' }), { count: 0, usd: 0, preq: 0n, a402: 0n }).reasons.join()).toContain('asset_not_allowed: unknown mint');
  });
  it('defaults: A402 not on the allowlist and no warning, X402_PAY_WITH defaults to USDC', () => {
    const p = policyFromEnv(BASE);
    expect(p.allowedAssets).not.toContain('A402');
    expect(p.warnings).toEqual([]);
    expect(p.prefer).toBe('USDC');
  });
  it('allowing A402 explicitly → warning at start + warning in payment results (no silent A402 payment)', async () => {
    const env = { ...BASE, X402_ALLOWED_ASSETS: 'USDC,A402', X402_MAX_A402_ATOMIC: '10000000', X402_MAX_A402_PER_DAY_ATOMIC: '100000000' };
    expect(policyFromEnv(env).warnings).toEqual([A402_DEPRECATION_WARNING]);
    expect(A402_DEPRECATION_WARNING).toContain('A402 (v1) is deprecated and no longer supported; use PREQ.');
    const t = agentWith(env, { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req({ asset: A402, amount: '5000000' })])) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r).toMatchObject({ result: 'paid', payment: { asset: 'A402' }, warnings: [A402_DEPRECATION_WARNING] });
    expect(t.history.today()).toMatchObject({ a402: 5_000_000n, preq: 0n });
  });
  it('if A402 is not allowed, the rejection reason includes the deprecation notice', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: () => r402([req({ asset: A402, amount: '5' })]) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.reasons!.join(' ')).toMatch(/asset_not_allowed: A402 .*deprecated; use PREQ/);
    expect(t.wallet.n).toBe(0);
  });
  it('when both USDC and PREQ are offered, USDC by default; PREQ if X402_PAY_WITH=PREQ', async () => {
    const env = { ...BASE, X402_PREQ_MINT: PREQ, X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_MAX_PREQ_ATOMIC: '10000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '100000000' };
    const routes = { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req(), req({ asset: PREQ, amount: '5000000' })])) };
    expect((await agentWith(env, routes).agent.payAndFetch({ url: `https://${HOST}/paid` })).payment?.asset).toBe('USDC');
    expect((await agentWith({ ...env, X402_PAY_WITH: 'PREQ' }, routes).agent.payAndFetch({ url: `https://${HOST}/paid` })).payment?.asset).toBe('PREQ');
  });
  it('wallet_status: if A402 is enabled, shows the warning and A402 limit fields', async () => {
    const policy = policyFromEnv({ ...BASE, X402_ALLOWED_ASSETS: 'USDC,A402' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet: null, history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'u-')), 'h.jsonl'), () => policy.mints), fetch }).connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const st = JSON.parse(((await client.callTool({ name: 'wallet_status', arguments: {} })) as { content: { text: string }[] }).content[0].text);
    expect(st.warnings).toEqual([A402_DEPRECATION_WARNING]);
    expect(st.limits.maxA402PerPaymentAtomic).toContain('not set (X402_MAX_A402_ATOMIC) — A402 payments refused');
  });
});
describe('spending controls: per-recipient daily caps and near-limit warnings', () => {
  const TRUSTED2 = pk();
  const two = { ...BASE, X402_TRUSTED_PAY_TO: `${TRUSTED},${TRUSTED2}` };
  const routes = { [`${HOST}/a`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req()], `https://${HOST}/a`)),
    [`${HOST}/b`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req({ payTo: TRUSTED2 })], `https://${HOST}/b`)) };
  it('default: no per-recipient cap (null), only the overall caps apply', () => {
    expect(policyFromEnv(BASE)).toMatchObject({ maxUsdPerRecipientPerDay: null, maxPreqPerRecipientPerDay: null });
  });
  it('USDC per-recipient cap: the same recipient is refused once its own daily total would exceed the cap, another recipient still gets paid', async () => {
    const t = agentWith({ ...two, X402_MAX_USD_PER_RECIPIENT_PER_DAY: '0.03' }, routes);
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/a` })).result).toBe('paid');
    const again = await t.agent.payAndFetch({ url: `https://${HOST}/a` });
    expect(again.result).toBe('refused');
    expect(again.reasons!.join(' ')).toContain(`over_daily_recipient_usd_limit: 0.02 + 0.02 > 0.03 USD to ${TRUSTED}`);
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/b` })).result).toBe('paid');
    expect(t.wallet.n).toBe(2);
    expect(t.history.recipientToday(TRUSTED)).toEqual({ count: 1, usd: 0.02, preq: 0n });
  });
  it('PREQ per-recipient cap (smallest units)', async () => {
    const env = { ...BASE, X402_PREQ_MINT: PREQ, X402_ALLOWED_ASSETS: 'PREQ', X402_PAY_WITH: 'PREQ', X402_MAX_PREQ_ATOMIC: '10000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '100000000', X402_MAX_PREQ_PER_RECIPIENT_PER_DAY_ATOMIC: '12000000' };
    const t = agentWith(env, { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req({ asset: PREQ, amount: '8000000' })])) });
    expect((await t.agent.payAndFetch({ url: `https://${HOST}/paid` })).result).toBe('paid');
    const again = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(again.reasons!.join(' ')).toContain('over_daily_recipient_preq_limit: 8000000 + 8000000 > 12000000 (PREQ smallest units)');
    expect(t.wallet.n).toBe(1);
  });
  it('near-limit warning after a payment that reaches 80% of the daily USD cap (payment still made)', async () => {
    const t = agentWith({ ...BASE, X402_MAX_USD_PER_DAY: '0.025' }, { [`${HOST}/paid`]: (r: Request) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.warnings).toEqual(['near_daily_usd_limit: 0.02 of 0.025 USD used today (UTC)']);
  });
  it('nearLimits: below 80% nothing; count and PREQ caps too', () => {
    const p = policyFromEnv({ ...BASE, X402_PREQ_MINT: PREQ, X402_ALLOWED_ASSETS: 'PREQ', X402_MAX_PREQ_ATOMIC: '1', X402_MAX_PREQ_PER_DAY_ATOMIC: '10000000', X402_MAX_PAYMENTS_PER_DAY: '5' });
    expect(nearLimits(p, { count: 1, usd: 0.1, preq: 1_000_000n, a402: 0n })).toEqual([]);
    expect(nearLimits(p, { count: 4, usd: 0, preq: 8_000_000n, a402: 0n })).toEqual([
      'near_daily_count_limit: 4 of 5 payments today (UTC)',
      'near_daily_preq_limit: 8 PREQ of 10 PREQ used today (UTC)',
    ]);
  });
});

describe('payment history CSV export', () => {
  it('header, one row per entry, amounts with units, quoting and formula guard', () => {
    const csv = historyToCsv([
      { at: '2026-11-22T00:00:00.000Z', url: 'https://api.good.test/a?x=1,2', host: HOST, network: NETWORKS.devnet, asset: 'USDC', mint: USDC, amount: '20000', payTo: TRUSTED, result: 'paid', settlementTx: 'TX1', httpStatus: 200, signed: true },
      { at: '2026-11-22T00:01:00.000Z', url: 'https://api.good.test/b', host: HOST, result: 'refused', reasons: ['=cmd()', 'say "hi"'], signed: false },
    ]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('paid,true,USDC,20000,0.02 USDC');
    expect(lines[1]).toContain('"https://api.good.test/a?x=1,2"');
    expect(lines[2]).toContain(`"'=cmd(); say ""hi"""`);
    expect(csvField('-1')).toBe("'-1");
    expect(csvField('+SUM(A1)')).toBe("'+SUM(A1)");
    expect(csvField('@x')).toBe("'@x");
  });
  it('payment_history tool with format csv', async () => {
    const policy = policyFromEnv(BASE);
    const dir = mkdtempSync(join(tmpdir(), 'csv-'));
    const history = jsonlHistory(join(dir, 'h.jsonl'), () => policy.mints);
    history.add({ at: '2026-11-22T00:00:00.000Z', url: `https://${HOST}/a`, host: HOST, asset: 'USDC', mint: USDC, amount: '20000', payTo: TRUSTED, result: 'paid', signed: true });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet: null, history, fetch }).connect(a);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(b);
    const text = ((await client.callTool({ name: 'payment_history', arguments: { format: 'csv' } })) as { content: { text: string }[] }).content[0].text;
    expect(text.split('\r\n')[0]).toBe(CSV_COLUMNS.join(','));
    expect(text).toContain('0.02 USDC');
  });
});

describe('pay-mcp init (local wallet key file)', () => {
  it('creates a 64-byte Solana CLI key file whose public key is the printed address; never overwrites', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'init-')), 'sub', 'w.json');
    const r = await initWallet({ path });
    const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
    expect(bytes).toHaveLength(64);
    expect(Keypair.fromSecretKey(Uint8Array.from(bytes)).publicKey.toBase58()).toBe(r.address);
    expect(r.network).toBe('mainnet');
    expect(r.text).toContain(r.address);
    expect(r.text).toContain('No SOL is needed');
    expect(r.text).toContain(`solana:${r.address}?spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`);
    expect(r.text).toContain('X402_ALLOWED_DOMAINS=<api.example.com>');
    expect(r.text).not.toContain(JSON.stringify(bytes));
    await expect(initWallet({ path })).rejects.toThrow(/already exists .* not changed/);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(bytes);
  });
  it('devnet: devnet USDC mint and X402_NETWORK=devnet in the connect line', async () => {
    const r = await initWallet({ path: join(mkdtempSync(join(tmpdir(), 'init-')), 'w.json'), network: 'devnet' });
    expect(r.text).toContain(`spl-token=${USDC}`);
    expect(r.text).toContain('-e X402_NETWORK=devnet');
  });
});

describe('seller receipts in pay-mcp', () => {
  it('a valid receipt is reported as verified and kept in history; one that does not match the payment is kept as not verified', async () => {
    const signer = await receiptSignerFromBytes(Keypair.generate().secretKey);
    const bodyHash = await sha256Hex(new TextEncoder().encode(JSON.stringify({ ok: true })));
    for (const [amount, verified] of [['20000', true], ['1', false]] as const) {
      const token = await signReceipt(signer, {
        issuedAt: '2026-11-22T00:00:00.000Z',
        request: { method: 'GET', path: '/paid', bodySha256: null },
        response: { status: 200, bodySha256: bodyHash },
        payment: { network: NETWORKS.devnet, asset: USDC, amount, payTo: TRUSTED, transaction: 'TXID' },
      });
      const t = agentWith(BASE, { [`${HOST}/paid`]: (r) => {
        if (!r.headers.get('payment-signature')) return r402([req()]);
        const res = paidOk();
        res.headers.set(RECEIPT_HEADER, token);
        return res;
      } });
      const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
      expect(r.result).toBe('paid');
      expect(r.receipt).toMatchObject({ signer: signer.publicKey, verified });
      if (!verified) expect(r.receipt!.reasons).toContain('receipt_payment_mismatch: amount');
      expect(t.history.list()[0].receipt).toMatchObject({ verified, token });
    }
  });
  it('no receipt header → no receipt field', async () => {
    const t = agentWith(BASE, { [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])) });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.receipt).toBeUndefined();
  });
});

describe('seller lock requirement (asset-neutral registration + on-chain Jupiter Lock)', () => {
  const DAY = 86_400;
  const nowSec = () => Math.floor(Date.now() / 1000);
  function lockBytes(o: { recipient: string; mint: string; cancel?: number; update?: number; cliffInDays: number; amount: bigint }): Uint8Array {
    const b = Buffer.alloc(296);
    Buffer.from([244, 119, 183, 4, 73, 116, 135, 195]).copy(b, 0);
    Buffer.from(bs58(o.recipient)).copy(b, 8);
    Buffer.from(bs58(o.mint)).copy(b, 40);
    b.writeUInt8(o.update ?? 0, 137); b.writeUInt8(o.cancel ?? 0, 138); b.writeUInt8(1, 139);
    b.writeBigUInt64LE(BigInt(nowSec() + o.cliffInDays * DAY), 144); // cliff_time
    b.writeBigUInt64LE(BigInt(30 * DAY), 152); // frequency
    b.writeBigUInt64LE(o.amount, 160); // cliff_unlock_amount (all released at the cliff)
    return b;
  }
  const bs58 = (a: string) => new PublicKey(a).toBytes();
  const LOCK = pk();
  const preqEnv = { ...BASE, X402_PREQ_MINT: PREQ, X402_REQUIRE_LOCK: 'yes', X402_MIN_LOCK_PREQ_ATOMIC: '5000000' };
  async function setup(o: { env?: PolicyEnv; lock?: Partial<Parameters<typeof lockBytes>[0]>; signWith?: Keypair; noDoc?: boolean } = {}) {
    const seller = Keypair.generate();
    const data = lockBytes({ recipient: seller.publicKey.toBase58(), mint: PREQ, cliffInDays: 200, amount: 10_000_000n, ...o.lock });
    const accounts: AccountsFetcher = async (addrs) => addrs.map((a) => (a === LOCK ? { owner: JUPITER_LOCK_PROGRAM, data } : null));
    const signer = await receiptSignerFromBytes((o.signWith ?? seller).secretKey);
    const doc = await signRegistration({ host: HOST, payTo: [TRUSTED], locks: [{ protocol: 'jupiter-lock', account: LOCK }] }, [signer]);
    const dir = mkdtempSync(join(tmpdir(), 'lock-'));
    const policy = policyFromEnv(o.env ?? preqEnv);
    const history = jsonlHistory(join(dir, 'h.jsonl'), () => policy.mints);
    const wallet = fakeWallet();
    const srv = server({
      [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])),
      ...(o.noDoc ? {} : { [`${HOST}/.well-known/agent402.json`]: () => Response.json(doc) }),
    });
    const agent = createAgent({ policy, wallet, history, fetch: srv.f, confirm: async () => 'accept', accounts });
    return { agent, wallet, srv };
  }
  it('irrevocable lock signed by its recipient, enough still locked 90 days from now → paid, facts shown', async () => {
    const t = await setup();
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.lock).toMatchObject({ ok: true, registration: 'ok', totalsAtDeadline: { PREQ: '10 PREQ' }, locks: [{ account: LOCK, asset: 'PREQ', counted: true, lockedAtDeadline: '10 PREQ' }] });
  });
  it('not enough locked → refused before signing', async () => {
    const t = await setup({ env: { ...preqEnv, X402_MIN_LOCK_PREQ_ATOMIC: '20000000' } });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons!.join(' ')).toContain('lock_requirement_not_met');
    expect(r.reasons!.join(' ')).toContain('10 PREQ of 20 PREQ');
    expect(t.wallet.n).toBe(0);
  });
  it('lock released before the deadline (cliff in 30 days, minimum 90 days) → refused', async () => {
    const t = await setup({ lock: { cliffInDays: 30 } });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.lock!.locks[0].lockedAtDeadline).toBe('0 PREQ');
  });
  it('revocable lock does not count', async () => {
    const t = await setup({ lock: { cancel: 1 } });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.lock!.locks[0]).toMatchObject({ counted: false, reason: expect.stringContaining('revocable_lock: cancel=creator') });
  });
  it("someone else's lock (registration not signed by the lock's recipient) does not count", async () => {
    const t = await setup({ signWith: Keypair.generate() });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.lock!.locks[0].reason).toContain('recipient_did_not_sign');
  });
  it('no registration document → refused, 0 signatures', async () => {
    const t = await setup({ noDoc: true });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.reasons!.join(' ')).toContain('lock_registration_missing');
    expect(t.wallet.n).toBe(0);
  });
  it('lock required only above an amount: a 0.02 USDC payment below it does not even fetch the registration', async () => {
    const t = await setup({ env: { ...BASE, X402_PREQ_MINT: PREQ, X402_REQUIRE_LOCK_ABOVE_USD: '0.05', X402_MIN_LOCK_PREQ_ATOMIC: '5000000' } });
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.lock).toBeUndefined();
    expect(t.srv.seen.requests.some((u) => u.includes('.well-known'))).toBe(false);
  });
  it('turning the lock requirement on without any minimum stops at start with a clear error', () => {
    expect(() => policyFromEnv({ ...BASE, X402_REQUIRE_LOCK: 'yes' })).toThrow(/X402_MIN_LOCK_PREQ_ATOMIC/);
    expect(policyFromEnv(BASE).lock).toEqual({ always: false, aboveUsd: null, minDays: 90, min: {} });
  });
});

describe('Streamflow locks (same registration, asset-neutral)', () => {
  const DAY = 86_400n;
  const T = 1_800_000_000n;
  function stream(o: { contract: PublicKey; recipient: PublicKey; mint: string; cancelableBySender?: boolean; canUpdateRate?: boolean; escrow?: PublicKey }): Uint8Array {
    const b = Buffer.alloc(819);
    o.recipient.toBuffer().copy(b, 113);
    new PublicKey(o.mint).toBuffer().copy(b, 177);
    const escrow = o.escrow ?? PublicKey.findProgramAddressSync([Buffer.from('strm'), o.contract.toBuffer()], new PublicKey(STREAMFLOW_PROGRAM))[0];
    escrow.toBuffer().copy(b, 209);
    b.writeBigUInt64LE(T, 409); // start
    b.writeBigUInt64LE(150_000_000n, 417); // net deposited
    b.writeBigUInt64LE(30n * DAY, 425); // period
    b.writeBigUInt64LE(12_500_000n, 433); // per period
    b.writeBigUInt64LE(T + 365n * DAY, 441); // cliff
    b.writeBigUInt64LE(0n, 449); // cliff amount
    b.writeUInt8(o.cancelableBySender ? 1 : 0, 457);
    b.writeUInt8(o.canUpdateRate ? 1 : 0, 540);
    return b;
  }
  it('decodes the fields at the check-engine offsets and computes what is still locked', () => {
    const contract = Keypair.generate().publicKey;
    const s = decodeStreamflow(stream({ contract, recipient: contract, mint: PREQ }))!;
    expect(s).toMatchObject({ mint: PREQ, netAmountDeposited: 150_000_000n, period: 30n * DAY, amountPerPeriod: 12_500_000n, cliff: T + 365n * DAY });
    expect(streamflowNotFixed(s)).toBeNull();
    expect(streamflowLockedAt(s, T)).toBe(150_000_000n);
    expect(streamflowLockedAt(s, T + 365n * DAY + 30n * DAY)).toBe(137_500_000n);
    expect(streamflowLockedAt(s, T + 365n * DAY + 360n * DAY)).toBe(0n);
    expect(streamflowNotFixed(decodeStreamflow(stream({ contract, recipient: contract, mint: PREQ, cancelableBySender: true, canUpdateRate: true }))!)).toBe('cancelable by sender, rate can be updated');
  });
  it('readLock rejects an account whose escrow is not the Streamflow PDA of that contract', async () => {
    const contract = Keypair.generate().publicKey;
    const data = stream({ contract, recipient: contract, mint: PREQ, escrow: Keypair.generate().publicKey });
    expect(await readLock('streamflow', contract.toBase58(), { owner: STREAMFLOW_PROGRAM, data })).toBe('streamflow_escrow_mismatch');
    expect(await readLock('streamflow', contract.toBase58(), { owner: JUPITER_LOCK_PROGRAM, data })).toBe('not_a_streamflow_account');
  });
  it('end to end: a fixed Streamflow lock signed by its recipient satisfies the PREQ minimum', async () => {
    const seller = Keypair.generate();
    const contract = Keypair.generate().publicKey;
    const data = stream({ contract, recipient: seller.publicKey, mint: PREQ });
    // Put the cliff 200 days from now so the whole deposit is still locked at the 90-day deadline
    const cliffLater = BigInt(Math.floor(Date.now() / 1000)) + 200n * DAY;
    (data as Buffer).writeBigUInt64LE(cliffLater, 441);
    const accounts: AccountsFetcher = async (addrs) => addrs.map((a) => (a === contract.toBase58() ? { owner: STREAMFLOW_PROGRAM, data } : null));
    const doc = await signRegistration({ host: HOST, payTo: [TRUSTED], locks: [{ protocol: 'streamflow', account: contract.toBase58() }, { protocol: 'streamflow', account: contract.toBase58() }] }, [await receiptSignerFromBytes(seller.secretKey)]);
    const policy = policyFromEnv({ ...BASE, X402_PREQ_MINT: PREQ, X402_REQUIRE_LOCK: 'yes', X402_MIN_LOCK_PREQ_ATOMIC: '100000000' });
    const srv = server({
      [`${HOST}/paid`]: (r) => (r.headers.get('payment-signature') ? paidOk() : r402([req()])),
      [`${HOST}/.well-known/agent402.json`]: () => Response.json(doc),
    });
    const agent = createAgent({ policy, wallet: fakeWallet(), history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'sf-')), 'h.jsonl'), () => policy.mints), fetch: srv.f, confirm: async () => 'accept', accounts });
    const r = await agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.lock).toMatchObject({ ok: true, totalsAtDeadline: { PREQ: '150 PREQ' } });
    // The same lock listed twice is counted once
    expect(r.lock!.locks[1]).toMatchObject({ counted: false, reason: 'duplicate' });
  });
});
