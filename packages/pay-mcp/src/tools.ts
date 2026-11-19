// @agent402-dev/pay-mcp 도구 4개: x402_fetch, x402_quote, wallet_status, payment_history
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createAgent, type ConfirmAnswer } from './agent.js';
import type { History } from './history.js';
import type { PayPolicy } from './policy.js';
import { formatUnits } from './units.js';
import type { Wallet } from './wallet.js';

export interface PayServerDeps {
  policy: PayPolicy;
  wallet: Wallet | null;
  history: History;
  fetch: typeof fetch;
  now?: () => Date;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const out = (obj: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError } : {}) });
const bigintSafe = (o: unknown) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

/** 결과 안의 { asset: 'USDC'|'A402', amount: '<최소 단위>' } 마다 단위 설명과 표시값을 붙임 (A402 금액은 반드시 단위와 함께) */
function withUnits(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(withUnits);
  if (!o || typeof o !== 'object') return o;
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) r[k] = withUnits(v);
  if ((r.asset === 'USDC' || r.asset === 'A402') && typeof r.amount === 'string' && /^\d+$/.test(r.amount)) {
    r.amountUnit = `${r.asset} smallest unit (1 ${r.asset} = 1,000,000)`;
    r.amountDisplay = formatUnits(r.amount, r.asset);
  }
  return r;
}
const atomicLimit = (v: bigint | null, envName: string) =>
  v === null ? `not set (${envName}) — A402 payments refused` : v;

export function createPayServer(d: PayServerDeps): McpServer {
  const server = new McpServer({ name: 'a402-pay', version: '0.1.0' });
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
    'Fetch a URL and, if it answers HTTP 402 (x402), pay from the configured wallet only when every rule passes before signing: allowed domain (X402_ALLOWED_DOMAINS), trusted recipient (X402_TRUSTED_PAY_TO), allowed asset (USDC by default; A402 only if listed), per-payment and daily limits, and human confirmation above the configured amount. Signs at most once per call. Pass quoteId from x402_quote to refuse if the requirements changed. The wallet key never leaves this machine.',
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
    'Payment wallet address, network, USDC and A402 balances, payments signed today, and the configured limits and allowlists.',
    {},
    async () => {
      const today = d.history.today(d.now?.());
      const balances = d.wallet ? await d.wallet.balances() : null;
      return out(bigintSafe({
      address: d.wallet?.address ?? null,
      network: d.policy.network,
      // 잔액은 토큰 단위 (예: "10 A402")
      balances: balances ? Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, /^[\d.]+$/.test(v) ? `${v} ${k}` : v])) : null,
      today: { ...today, usdUnit: 'USD (USDC)', a402Unit: 'A402 smallest unit (1 A402 = 1,000,000)', a402Display: formatUnits(today.a402, 'A402') },
      signedThisSession: d.wallet?.signedCount ?? 0,
      limits: {
        maxUsdPerPayment: d.policy.maxUsdPerPayment, maxUsdPerDay: d.policy.maxUsdPerDay, maxPaymentsPerDay: d.policy.maxPaymentsPerDay,
        maxA402PerPaymentAtomic: atomicLimit(d.policy.maxA402PerPayment, 'X402_MAX_A402_ATOMIC'),
        maxA402PerDayAtomic: atomicLimit(d.policy.maxA402PerDay, 'X402_MAX_A402_PER_DAY_ATOMIC'),
        ...(d.policy.maxA402PerPayment !== null ? { maxA402PerPaymentDisplay: formatUnits(d.policy.maxA402PerPayment, 'A402') } : {}),
        ...(d.policy.maxA402PerDay !== null ? { maxA402PerDayDisplay: formatUnits(d.policy.maxA402PerDay, 'A402') } : {}),
        confirmAboveUsd: d.policy.confirmAboveUsd, confirmAboveA402Atomic: d.policy.confirmAboveA402,
        units: '…Usd = US dollars (USDC); …Atomic = A402 smallest unit (1 A402 = 1,000,000)',
      },
      allowedDomains: d.policy.allowedDomains, trustedPayTo: d.policy.trustedPayTo, allowedAssets: d.policy.allowedAssets,
      ...(d.wallet ? {} : { note: 'No wallet configured (X402_KEYPAIR_PATH): x402_fetch will not pay.' }),
      }));
    },
  );
  server.tool(
    'payment_history',
    'Recent payment records from the local JSONL log (time, URL, asset, amount, recipient, result, settlement transaction id). Keys and signed payment payloads are never stored.',
    { limit: z.number().int().min(1).max(500).optional() },
    async ({ limit }) => out(withUnits(d.history.list(limit ?? 20))),
  );
  return server;
}
