// Spending report from the local payment history: totals for a date range (UTC days), by recipient and host, results,
// seller receipts, and what is left of today's limits. Read only. Counts signed payments the same way the daily limits
// do: every signed payment counts as spent whatever its result (to be conservative); fee-only signatures (amount "0") do not.
import type { HistoryEntry, PaymentResult } from './history.js';
import type { PayPolicy } from './policy.js';
import { formatUnits } from './units.js';
import { EVM_USDC } from './evm-policy.js';

const EVM_USDC_ADDRESSES = new Set<string>(Object.values(EVM_USDC).map((u) => u.address));
const isEvmUsdc = (mint?: string) => !!mint && EVM_USDC_ADDRESSES.has(mint.toLowerCase());

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
export const MAX_REPORT_DAYS = 366;

export interface ReportRange { from: string; to: string }

/** Range check: YYYY-MM-DD (UTC), from ≤ to, at most MAX_REPORT_DAYS days. Default: the current UTC month to today. */
export function reportRange(a: { from?: string; to?: string }, now: Date): ReportRange | string {
  const today = now.toISOString().slice(0, 10);
  const from = a.from ?? `${today.slice(0, 8)}01`, to = a.to ?? today;
  const real = (d: string) => DATE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
  if (!real(from) || !real(to)) return 'from and to must be dates (YYYY-MM-DD, UTC)';
  const days = (Date.parse(to) - Date.parse(from)) / DAY + 1;
  if (days < 1) return 'to must not be before from';
  if (days > MAX_REPORT_DAYS) return `the range is at most ${MAX_REPORT_DAYS} days`;
  return { from, to };
}

type Sym = 'USDC' | 'PREQ' | 'A402';
interface Acc { payments: number; atomic: Record<Sym, bigint> }
const acc = (): Acc => ({ payments: 0, atomic: { USDC: 0n, PREQ: 0n, A402: 0n } });
const amounts = (a: Acc, showA402: boolean) => ({
  payments: a.payments,
  usdc: formatUnits(a.atomic.USDC, 'USDC'),
  preq: formatUnits(a.atomic.PREQ, 'PREQ'),
  ...(showA402 || a.atomic.A402 > 0n ? { a402: formatUnits(a.atomic.A402, 'A402') } : {}),
});

export function spendingReport(entries: HistoryEntry[], policy: PayPolicy, range: ReportRange, now: Date) {
  // USDC on Base counts as USDC, as the daily limits count it (summed across chains); usdcByNetwork shows the split
  const sym = (mint?: string): Sym | null => (!mint ? null : mint === policy.mints.USDC || isEvmUsdc(mint) ? 'USDC' : mint === policy.mints.PREQ ? 'PREQ' : mint === policy.mints.A402 ? 'A402' : null);
  const inRange = entries.filter((e) => { const d = e.at.slice(0, 10); return d >= range.from && d <= range.to; });
  const spent = (e: HistoryEntry) => e.signed && !!e.amount && /^\d+$/.test(e.amount) && e.amount !== '0';
  const total = acc(), byRecipient = new Map<string, Acc>(), byHost = new Map<string, Acc>(), byDay = new Map<string, Acc>();
  const results: Partial<Record<PaymentResult, number>> = {};
  let otherAssetPayments = 0, feeOnlySignatures = 0;
  const usdcByNetwork = { solana: 0n, base: 0n };
  const receipts = { verified: 0, notVerified: 0, none: 0, notVerifiedReasons: {} as Record<string, number> };
  for (const e of inRange) {
    results[e.result] = (results[e.result] ?? 0) + 1;
    if (e.signed && e.amount === '0') feeOnlySignatures++;
    if (!spent(e)) continue;
    const s = sym(e.mint);
    if (!s) { otherAssetPayments++; continue; }
    const amt = BigInt(e.amount!);
    for (const [m, k] of [[byRecipient, e.payTo ?? 'unknown'], [byHost, e.host], [byDay, e.at.slice(0, 10)]] as const) {
      const a = m.get(k) ?? acc(); a.payments++; a.atomic[s] += amt; m.set(k, a);
    }
    total.payments++; total.atomic[s] += amt;
    if (s === 'USDC') usdcByNetwork[isEvmUsdc(e.mint) ? 'base' : 'solana'] += amt;
    if (e.result === 'paid') {
      if (!e.receipt) receipts.none++;
      else if (e.receipt.verified) receipts.verified++;
      else { receipts.notVerified++; for (const r of e.receipt.reasons.length ? e.receipt.reasons : ['unknown']) receipts.notVerifiedReasons[r] = (receipts.notVerifiedReasons[r] ?? 0) + 1; }
    }
  }
  const showA402 = policy.allowedAssets.includes('A402');
  const rank = (m: Map<string, Acc>) => [...m].sort(([, a], [, b]) => (a.atomic.USDC === b.atomic.USDC ? b.payments - a.payments : a.atomic.USDC > b.atomic.USDC ? -1 : 1));

  // Today's limits, counted exactly as the payment rules count them
  const today = now.toISOString().slice(0, 10);
  const t = entries.filter((e) => e.at.slice(0, 10) === today && spent(e));
  const tUsd = t.filter((e) => sym(e.mint) === 'USDC').reduce((x, e) => x + BigInt(e.amount!), 0n);
  const tPreq = t.filter((e) => sym(e.mint) === 'PREQ').reduce((x, e) => x + BigInt(e.amount!), 0n);
  const capUsd = BigInt(Math.round(policy.maxUsdPerDay * 1e6));
  const preqCap = policy.tokenLimits.PREQ.perDay;
  const left = (cap: bigint, used: bigint) => (cap > used ? cap - used : 0n);

  return {
    result: 'ok' as const,
    range: { ...range, timezone: 'UTC' },
    note: 'Signed payments count as spent whatever their result, as the daily limits count them. Amounts in token units.',
    totals: { ...amounts(total, showA402), ...(otherAssetPayments ? { otherAssetPayments } : {}), ...(feeOnlySignatures ? { feeOnlySignatures } : {}),
      ...(usdcByNetwork.base > 0n ? { usdcByNetwork: { solana: formatUnits(usdcByNetwork.solana, 'USDC'), base: formatUnits(usdcByNetwork.base, 'USDC') } } : {}) },
    results,
    byRecipient: rank(byRecipient).slice(0, 50).map(([payTo, a]) => ({ payTo, ...amounts(a, showA402) })),
    byHost: rank(byHost).slice(0, 50).map(([host, a]) => ({ host, ...amounts(a, showA402) })),
    byDay: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, a]) => ({ day, ...amounts(a, showA402) })),
    sellerReceipts: { ...receipts, note: 'For paid requests: verified = signed receipt checked; none = the seller sent no receipt.' },
    todayLimits: {
      day: today,
      payments: { used: t.length, limit: policy.maxPaymentsPerDay, left: Math.max(0, policy.maxPaymentsPerDay - t.length) },
      usdc: { used: formatUnits(tUsd, 'USDC'), limit: `${policy.maxUsdPerDay} USDC`, left: formatUnits(left(capUsd, tUsd), 'USDC') },
      preq: preqCap === null ? { used: formatUnits(tPreq, 'PREQ'), limit: 'not set (PREQ payments refused)' }
        : { used: formatUnits(tPreq, 'PREQ'), limit: formatUnits(preqCap, 'PREQ'), left: formatUnits(left(preqCap, tPreq), 'PREQ') },
    },
  };
}
