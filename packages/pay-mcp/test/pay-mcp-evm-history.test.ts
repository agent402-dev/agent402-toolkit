// Base (EVM) payments share the existing USD limits: history sums USDC across chains (design docs/design/pay-mcp-evm.md, limits).
// Counting more toward a limit can only refuse more, never less.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonlHistory, type HistoryEntry } from '@agent402-dev/pay-mcp/history';
import { evaluate, policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import type { PaymentRequirements } from '@x402/core/types';
import { spendingReport } from '@agent402-dev/pay-mcp/report';

const SOL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SEPOLIA_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SOL_PAY_TO = 'Seller1111111111111111111111111111111111111';
const EVM_PAY_TO = '0xAbCdEf0000000000000000000000000000000001';
const NOW = new Date('2026-11-26T05:00:00Z');

function make(entries: Partial<HistoryEntry>[]) {
  const h = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'evm-hist-')), 'h.jsonl'), () => ({ USDC: SOL_USDC, PREQ: '', A402: '' }));
  for (const e of entries) h.add({ at: NOW.toISOString(), url: 'https://x.test/a', host: 'x.test', result: 'paid', signed: true, ...e } as HistoryEntry);
  return h;
}

describe('history sums USD across chains', () => {
  it('counts Solana and Base USDC in the same daily USD total', () => {
    const h = make([
      { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', mint: SOL_USDC, amount: '20000', payTo: SOL_PAY_TO },
      { network: 'eip155:8453', mint: BASE_USDC, amount: '30000', payTo: EVM_PAY_TO },
    ]);
    const t = h.today(NOW);
    expect(t.count).toBe(2);
    expect(t.usd).toBeCloseTo(0.05, 9);
  });

  it('matches Base USDC case-insensitively and counts Base Sepolia too (conservative)', () => {
    const h = make([
      { network: 'eip155:8453', mint: BASE_USDC.toLowerCase(), amount: '10000', payTo: EVM_PAY_TO },
      { network: 'eip155:84532', mint: SEPOLIA_USDC, amount: '10000', payTo: EVM_PAY_TO },
    ]);
    expect(h.today(NOW).usd).toBeCloseTo(0.02, 9);
  });

  it('reads old entries without network exactly as before', () => {
    const h = make([{ mint: SOL_USDC, amount: '40000', payTo: SOL_PAY_TO }]);
    expect(h.today(NOW).usd).toBeCloseTo(0.04, 9);
  });

  it('does not count an unknown 0x token as USD, but still counts it as a payment', () => {
    const h = make([{ network: 'eip155:8453', mint: '0x0000000000000000000000000000000000000bad', amount: '999999', payTo: EVM_PAY_TO }]);
    const t = h.today(NOW);
    expect(t.usd).toBe(0);
    expect(t.count).toBe(1);
  });

  it('ignores unsigned and other-day entries for every chain', () => {
    const h = make([
      { network: 'eip155:8453', mint: BASE_USDC, amount: '10000', payTo: EVM_PAY_TO, signed: false, result: 'refused' },
      { network: 'eip155:8453', mint: BASE_USDC, amount: '10000', payTo: EVM_PAY_TO, at: '2026-11-25T23:59:59Z' },
    ]);
    expect(h.today(NOW)).toMatchObject({ count: 0, usd: 0 });
  });

  it('sums per-recipient USD for a 0x payTo case-insensitively', () => {
    const h = make([
      { network: 'eip155:8453', mint: BASE_USDC, amount: '10000', payTo: EVM_PAY_TO },
      { network: 'eip155:8453', mint: BASE_USDC, amount: '15000', payTo: EVM_PAY_TO.toLowerCase() },
      { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', mint: SOL_USDC, amount: '50000', payTo: SOL_PAY_TO },
    ]);
    const r = h.recipientToday(EVM_PAY_TO.toUpperCase().replace('0X', '0x'), NOW);
    expect(r.count).toBe(2);
    expect(r.usd).toBeCloseTo(0.025, 9);
    // Solana addresses stay exact (base58 is case-sensitive)
    expect(h.recipientToday(SOL_PAY_TO.toLowerCase(), NOW).count).toBe(0);
    expect(h.recipientToday(SOL_PAY_TO, NOW).usd).toBeCloseTo(0.05, 9);
  });

  it('Base spending makes a Solana payment hit the daily USD limit', () => {
    const policy = policyFromEnv({ X402_ALLOWED_DOMAINS: 'x.test', X402_TRUSTED_PAY_TO: SOL_PAY_TO, X402_MAX_USD: '0.5', X402_MAX_USD_PER_DAY: '0.1' });
    const h = make([{ network: 'eip155:8453', mint: BASE_USDC, amount: '90000', payTo: EVM_PAY_TO }]);
    const req = { scheme: 'exact', network: policy.network, asset: SOL_USDC, amount: '20000', payTo: SOL_PAY_TO, maxTimeoutSeconds: 60, extra: {} } as PaymentRequirements;
    const ev = evaluate(policy, req, h.today(NOW), h.recipientToday(SOL_PAY_TO, NOW));
    expect(ev.ok).toBe(false);
    expect(ev.reasons.join(' ')).toMatch(/over_daily_usd_limit/);
  });
});

describe('spending_report with Base USDC', () => {
  const policy = policyFromEnv({ X402_MAX_USD_PER_DAY: '1' });
  const at = NOW.toISOString();
  const row = (o: Partial<HistoryEntry>): HistoryEntry => ({ at, url: 'https://x.test/a', host: 'x.test', result: 'paid', signed: true, ...o } as HistoryEntry);

  it('counts Base USDC as USDC, shows the split by network and uses the summed total for today\'s limit', () => {
    const r = spendingReport([
      row({ network: policy.network, mint: SOL_USDC, amount: '100000', payTo: SOL_PAY_TO }),
      row({ network: 'eip155:8453', mint: BASE_USDC, amount: '250000', payTo: EVM_PAY_TO }),
    ], policy, { from: '2026-11-26', to: '2026-11-26' }, NOW);
    expect(r.totals).toEqual({ payments: 2, usdc: '0.35 USDC', preq: '0 PREQ', usdcByNetwork: { solana: '0.1 USDC', base: '0.25 USDC' } });
    expect(r.todayLimits.usdc).toEqual({ used: '0.35 USDC', limit: '1 USDC', left: '0.65 USDC' });
  });

  it('adds no usdcByNetwork when there is no Base payment (output unchanged for Solana-only users)', () => {
    const r = spendingReport([row({ mint: SOL_USDC, amount: '100000', payTo: SOL_PAY_TO })], policy, { from: '2026-11-26', to: '2026-11-26' }, NOW);
    expect(r.totals).toEqual({ payments: 1, usdc: '0.1 USDC', preq: '0 PREQ' });
  });
});
