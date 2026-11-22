// @agent402-dev/pay-mcp's 4 tools: x402_fetch, x402_quote, wallet_status, payment_history
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAgent, type ConfirmAnswer } from './agent.js';
import type { History } from './history.js';
import type { AccountsFetcher } from './locks.js';
import { historyToCsv } from './csv.js';
import { nearLimits, tokenEnv, type PayPolicy, type TokenSymbol } from './policy.js';
import { formatUnits } from './units.js';
import type { Wallet } from './wallet.js';

export interface PayServerDeps {
  policy: PayPolicy;
  wallet: Wallet | null;
  history: History;
  fetch: typeof fetch;
  now?: () => Date;
  /** Read-only account reader for seller lock checks */
  accounts?: AccountsFetcher;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const out = (obj: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError } : {}) });
const bigintSafe = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/** Adds a unit description and display value to each { asset: 'USDC'|'PREQ'|'A402', amount: '<base units>' } in the result (token amounts always with units) */
function withUnits(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(withUnits);
  if (!o || typeof o !== 'object') return o;
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) r[k] = withUnits(v);
  if ((r.asset === 'USDC' || r.asset === 'PREQ' || r.asset === 'A402') && typeof r.amount === 'string' && /^\d+$/.test(r.amount)) {
    r.amountUnit = `${r.asset} smallest unit (1 ${r.asset} = 1,000,000)`;
    r.amountDisplay = formatUnits(r.amount, r.asset);
  }
  return r;
}
const atomicLimit = (v: bigint | null, envName: string, sym: TokenSymbol) =>
  v === null ? `not set (${envName}) — ${sym} payments refused` : v;

/** Token limits in wallet_status (e.g. maxPreqPerPaymentAtomic, maxPreqPerPaymentDisplay …) */
function tokenLimitFields(p: PayPolicy, t: TokenSymbol): Record<string, unknown> {
  const l = p.tokenLimits[t];
  const n = tokenEnv(t);
  const k = t === 'PREQ' ? 'Preq' : 'A402';
  return {
    [`max${k}PerPaymentAtomic`]: atomicLimit(l.perPayment, n.perPayment, t),
    [`max${k}PerDayAtomic`]: atomicLimit(l.perDay, n.perDay, t),
    ...(l.perPayment !== null ? { [`max${k}PerPaymentDisplay`]: formatUnits(l.perPayment, t) } : {}),
    ...(l.perDay !== null ? { [`max${k}PerDayDisplay`]: formatUnits(l.perDay, t) } : {}),
    [`confirmAbove${k}Atomic`]: l.confirmAbove,
  };
}

export function createPayServer(d: PayServerDeps): McpServer {
  const server = new McpServer({ name: 'a402-pay', version: '0.4.0' });
  const confirm = async (message: string): Promise<ConfirmAnswer> => {
    if (!server.server.getClientCapabilities()?.elicitation) return 'unsupported';
    const r = await server.server.elicitInput({
      message,
      requestedSchema: { type: 'object', properties: { confirm: { type: 'boolean', title: 'Pay', description: 'Approve this payment' } }, required: ['confirm'] },
    });
    return r.action === 'accept' && (r.content as { confirm?: boolean } | undefined)?.confirm === true ? 'accept' : 'decline';
  };
  const agent = createAgent({ ...d, confirm });
  const req = { url: z.string().url(), method: z.enum(['GET', 'POST']).optional(), headers: z.record(z.string(), z.string()).optional(), body: z.string().max(100_000).optional() };

  server.tool(
    'x402_fetch',
    'Fetch a URL and, if it answers HTTP 402 (x402), pay from the configured wallet only when every rule passes before signing: allowed domain (X402_ALLOWED_DOMAINS), trusted recipient (X402_TRUSTED_PAY_TO), allowed asset (USDC by default; PREQ only if listed; A402 (v1) is deprecated), per-payment and daily limits, and human confirmation above the configured amount. Signs at most once per call. Pass quoteId from x402_quote to refuse if the requirements changed. The wallet key never leaves this machine.',
    { ...req, quoteId: z.string().optional() },
    async (a) => { const r = await agent.payAndFetch(a); return out(withUnits(r), !['paid', 'not_required'].includes(r.result)); },
  );
  server.tool(
    'x402_quote',
    'Show the x402 payment requirements of a URL and whether each option passes the payment rules. Never signs or pays. Returns a quoteId that x402_fetch can use to pin the amount, asset and recipient.',
    req,
    async (a) => { const r = await agent.quote(a); return out(withUnits(r), r.result === 'refused'); },
  );
  server.tool(
    'wallet_status',
    'Payment wallet address, network, USDC and PREQ balances, payments signed today, and the configured limits and allowlists.',
    {},
    async () => {
      const usage = d.history.today(d.now?.());
      const { preq, a402, ...today } = usage;
      const near = nearLimits(d.policy, usage);
      const balances = d.wallet ? await d.wallet.balances() : null;
      // A402 (v1) is deprecated: shown only if allowed explicitly or if spent today
      const showA402 = d.policy.allowedAssets.includes('A402') || a402 > 0n;
      return out(bigintSafe({
      address: d.wallet?.address ?? null,
      network: d.policy.network,
      // Balances in token units (e.g. "10 PREQ")
      balances: balances ? Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, /^[\d.]+$/.test(v) ? `${v} ${k}` : v])) : null,
      today: {
        ...today, usdUnit: 'USD (USDC)',
        preq, preqUnit: 'PREQ smallest unit (1 PREQ = 1,000,000)', preqDisplay: formatUnits(preq, 'PREQ'),
        ...(showA402 ? { a402, a402Unit: 'A402 smallest unit (1 A402 = 1,000,000)', a402Display: formatUnits(a402, 'A402') } : {}),
      },
      signedThisSession: d.wallet?.signedCount ?? 0,
      limits: {
        maxUsdPerPayment: d.policy.maxUsdPerPayment, maxUsdPerDay: d.policy.maxUsdPerDay, maxPaymentsPerDay: d.policy.maxPaymentsPerDay,
        confirmAboveUsd: d.policy.confirmAboveUsd,
        maxUsdPerRecipientPerDay: d.policy.maxUsdPerRecipientPerDay,
        sellerLock: d.policy.lock.always || d.policy.lock.aboveUsd !== null
          ? { required: d.policy.lock.always ? 'always' : `USDC payments of ${d.policy.lock.aboveUsd} USD or more`, minDays: d.policy.lock.minDays, minimums: d.policy.lock.min }
          : 'off',
        maxPreqPerRecipientPerDayAtomic: d.policy.maxPreqPerRecipientPerDay,
        ...tokenLimitFields(d.policy, 'PREQ'),
        ...(showA402 ? tokenLimitFields(d.policy, 'A402') : {}),
        units: '…Usd = US dollars (USDC); …Atomic = token smallest unit (1 PREQ = 1,000,000)',
      },
      allowedDomains: d.policy.allowedDomains, trustedPayTo: d.policy.trustedPayTo, allowedAssets: d.policy.allowedAssets,
      ...(d.policy.warnings.length || near.length ? { warnings: [...d.policy.warnings, ...near] } : {}),
      ...(d.wallet ? {} : { note: 'No wallet configured (X402_KEYPAIR_PATH): x402_fetch will not pay.' }),
      }));
    },
  );
  server.tool(
    'payment_history',
    'Recent payment records from the local JSONL log (time, URL, asset, amount, recipient, result, settlement transaction id). Keys and signed payment payloads are never stored. format "csv" returns the records as CSV text (oldest first).',
    { limit: z.number().int().min(1).max(500).optional(), format: z.enum(['json', 'csv']).optional() },
    async ({ limit, format }) => {
      const xs = d.history.list(limit ?? 20);
      return format === 'csv' ? { content: [{ type: 'text' as const, text: historyToCsv([...xs].reverse()) }] } : out(withUnits(xs));
    },
  );
  return server;
}
