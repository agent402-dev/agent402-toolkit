// pay-mcp spending_report: totals, grouping, receipts, today's limits, range checks, and the MCP tool.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { jsonlHistory, type HistoryEntry } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { reportRange, spendingReport } from '@agent402-dev/pay-mcp/report';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';

const policy = policyFromEnv({ X402_MAX_USD_PER_DAY: '1', X402_MAX_PAYMENTS_PER_DAY: '20', X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_MAX_PREQ_ATOMIC: '5000000', X402_MAX_PREQ_PER_DAY_ATOMIC: '10000000' });
const USDC = policy.mints.USDC, PREQ = policy.mints.PREQ;
const NOW = new Date('2026-11-24T05:00:00Z');
const e = (at: string, o: Partial<HistoryEntry>): HistoryEntry => ({ at, url: 'https://a.example/x', host: 'a.example', result: 'paid', signed: true, mint: USDC, amount: '50000', payTo: 'SellerA', ...o });
const log: HistoryEntry[] = [
  e('2026-10-31T23:00:00Z', {}), // outside the range
  e('2026-11-02T10:00:00Z', { receipt: { signer: 'R', verified: true, reasons: [], token: 't' } }),
  e('2026-11-24T01:00:00Z', { receipt: { signer: 'R', verified: false, reasons: ['receipt_request_mismatch'], token: 't' } }),
  e('2026-11-24T02:00:00Z', { host: 'b.example', payTo: 'SellerB', amount: '200000' }),
  e('2026-11-24T03:00:00Z', { host: 'b.example', payTo: 'SellerB', mint: PREQ, amount: '3000000', result: 'unknown' }),
  e('2026-11-24T04:00:00Z', { result: 'refused', signed: false }),
  e('2026-11-24T04:30:00Z', { amount: '0', result: 'paid' }), // fee-only (bond settle)
];

describe('spending_report', () => {
  it('range: default this month; checks', () => {
    expect(reportRange({}, NOW)).toEqual({ from: '2026-11-01', to: '2026-11-24' });
    expect(reportRange({ from: '2026-11-30', to: '2026-11-01' }, NOW)).toMatch(/before/);
    expect(reportRange({ from: '2026-02-30' }, NOW)).toMatch(/dates/);
    expect(reportRange({ from: '2025-01-01', to: '2026-11-24' }, NOW)).toMatch(/366/);
  });
  it('totals, grouping, receipts and today\'s limits', () => {
    const r = spendingReport(log, policy, { from: '2026-11-01', to: '2026-11-24' }, NOW);
    expect(r.totals).toEqual({ payments: 4, usdc: '0.3 USDC', preq: '3 PREQ', feeOnlySignatures: 1 });
    expect(r.results).toEqual({ paid: 4, unknown: 1, refused: 1 });
    expect(r.byRecipient.map((x) => [x.payTo, x.payments, x.usdc, x.preq])).toEqual([['SellerB', 2, '0.2 USDC', '3 PREQ'], ['SellerA', 2, '0.1 USDC', '0 PREQ']]);
    expect(r.byDay.map((x) => x.day)).toEqual(['2026-11-02', '2026-11-24']);
    expect(r.sellerReceipts).toMatchObject({ verified: 1, notVerified: 1, none: 1, notVerifiedReasons: { receipt_request_mismatch: 1 } });
    expect(r.todayLimits).toEqual({
      day: '2026-11-24',
      payments: { used: 3, limit: 20, left: 17 },
      usdc: { used: '0.25 USDC', limit: '1 USDC', left: '0.75 USDC' },
      preq: { used: '3 PREQ', limit: '10 PREQ', left: '7 PREQ' },
    });
  });
  it('MCP tool: reads the JSONL log, refuses a bad range', async () => {
    const h = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'rep-')), 'h.jsonl'), () => policy.mints);
    for (const x of log) h.add(x);
    const server = createPayServer({ policy, wallet: null, history: h, fetch, now: () => NOW });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const ok = await client.callTool({ name: 'spending_report', arguments: {} });
    expect(ok.isError).toBeFalsy();
    const body = JSON.parse((ok.content as { text: string }[])[0].text);
    expect(body.totals.payments).toBe(4);
    expect(body.range).toEqual({ from: '2026-11-01', to: '2026-11-24', timezone: 'UTC' });
    const bad = await client.callTool({ name: 'spending_report', arguments: { from: 'yesterday' } });
    expect(bad.isError).toBe(true);
  });
});
