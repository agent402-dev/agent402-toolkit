// @agent402-dev/check-mcp (free): token_check_summary (hosted) + token_check (local sections 1 to 8 with your RPC)
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ToolDeps } from '@agent402-dev/check-mcp/tools';
import { guardrailViolations } from '@agent402-dev/check-engine/guardrail';
import type { AccountFetcher } from '@agent402-dev/check-engine/summary';

const MINT = 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X';
const fx = JSON.parse(readFileSync(new URL('../../check-engine/test/fixtures/A402.json', import.meta.url), 'utf8')) as {
  slots: number[]; accounts: Record<string, { owner: string; data: string } | null>;
};
const fixtureFetcher: AccountFetcher = async (addrs) => ({
  slot: fx.slots[0],
  accounts: addrs.map((a) => (fx.accounts[a] ? { owner: fx.accounts[a]!.owner, data: Buffer.from(fx.accounts[a]!.data, 'base64') } : null)),
});

async function connect(d: ToolDeps) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(d).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return client;
}
const call = async (c: Client, name: string, mint = MINT) => {
  const r = (await c.callTool({ name, arguments: { mint } })) as { content: { text: string }[]; isError?: boolean };
  return { isError: !!r.isError, body: JSON.parse(r.content[0].text) };
};
const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('MCP tool list (free)', () => {
  it('token_check_summary, token_check: mint input, no judgement or investment advice, no payment or price wording', async () => {
    const c = await connect({ apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}), reader: null });
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['token_check', 'token_check_summary']);
    for (const t of tools) {
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).toEqual(['mint']);
      expect(t.description).toContain('no judgments, ratings, or investment advice');
      expect(t.description).not.toMatch(/safe|risk|scam|rug|score|grade/i);
      expect(t.description).not.toMatch(/USDC|x402|price|pays?\b|coming soon|paid/i);
    }
    expect(tools.find((t) => t.name === 'token_check')!.description).toMatch(/your own Solana RPC/);
  });
  it('the package does not depend on payment code (no pay-mcp or x402 dependency)', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(pkg.dependencies)).not.toContain('@agent402-dev/pay-mcp');
    expect(Object.keys(pkg.dependencies).some((k) => k.startsWith('@x402/'))).toBe(false);
    for (const f of ['tools.ts', 'server.ts']) {
      expect(readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).not.toMatch(/@agent402-dev\/pay-mcp|a402-pay-mcp|@x402\//);
    }
  });
});

describe('token_check_summary (hosted API)', () => {
  it('returns the API response as is (with disclaimer); 429 is an error + remaining count', async () => {
    let n = 0;
    const c = await connect({
      apiBase: 'https://api.test', reader: null,
      fetch: async (u) => {
        expect(String(u)).toBe(`https://api.test/v1/check/${MINT}/summary`);
        return n++ === 0
          ? jsonRes(200, { mint: MINT, notes: ['Factual information from public on-chain data. Not investment advice.'] })
          : jsonRes(429, { error: 'rate_limited' }, { 'x-ratelimit-remaining': '0' });
      },
    });
    const ok = await call(c, 'token_check_summary');
    expect(ok.isError).toBe(false);
    expect(ok.body.mint).toBe(MINT);
    expect(await call(c, 'token_check_summary')).toMatchObject({ isError: true, body: { status: 429, error: 'rate_limited', remainingToday: '0' } });
  });
  it('an invalid mint is rejected by tool input validation', async () => {
    const c = await connect({ apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}), reader: null });
    const r = (await c.callTool({ name: 'token_check_summary', arguments: { mint: 'not-a-mint' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });
});

describe('token_check (runs locally with your RPC, no payment)', () => {
  it('no RPC configured → explains setup (A402_CHECK_RPC_URL), no hosted API call', async () => {
    let called = 0;
    const c = await connect({ apiBase: 'https://api.test', fetch: async () => { called++; return jsonRes(200, {}); }, reader: null });
    const r = await call(c, 'token_check');
    expect(r).toMatchObject({ isError: true, body: { error: 'rpc_not_configured' } });
    expect(r.body.message).toContain('A402_CHECK_RPC_URL');
    expect(called).toBe(0);
    expect(guardrailViolations(r.body)).toEqual([]);
  });
  it('with RPC → checkFull on this computer (sections 1 to 4 decoded, unread sections marked unavailable), disclaimer and guardrail', async () => {
    let apiCalls = 0;
    const c = await connect({
      apiBase: 'https://api.test', fetch: async () => { apiCalls++; return jsonRes(500, {}); },
      reader: () => ({ fetch: fixtureFetcher }) as never, now: () => new Date('2026-11-20T00:00:00Z'),
    });
    const r = await call(c, 'token_check');
    expect(r.isError).toBe(false);
    expect(r.body.ranLocally).toBe(true);
    expect(r.body.report.mint).toBe(MINT);
    expect(r.body.report.limits).toEqual({ maxTransactions: 200, maxSignaturePages: 10, maxPositionsShown: 10 });
    expect(r.body.report.notes).toContain('Factual information from public on-chain data. Not investment advice.');
    expect(r.body.report.unavailable.length).toBeGreaterThan(0);
    expect(guardrailViolations(r.body)).toEqual([]);
    expect(apiCalls).toBe(0);
  });
  it('not-a-mint address / RPC error → reason only (no RPC address)', async () => {
    const SECRET = 'https://rpc.example/?api-key=SECRET123';
    const c = await connect({
      apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}),
      reader: () => ({ fetch: async () => { throw new Error(`fetch failed ${SECRET}`); } }) as never,
    });
    const r = await call(c, 'token_check');
    expect(r).toMatchObject({ isError: true, body: { error: 'upstream_unavailable' } });
    expect(JSON.stringify(r.body)).not.toContain('SECRET123');
  });
});
