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

describe('Skills over MCP: token-facts', async () => {
  const { z } = await import('zod');
  const { createHash } = await import('node:crypto');
  it('lists the skill with a manifest matching the served bytes, names only real tools and keeps the wording rules', async () => {
    const c = await connect({ apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}), reader: null });
    expect((c.getServerCapabilities() as { extensions?: Record<string, unknown> }).extensions).toHaveProperty(['io.modelcontextprotocol/skills']);
    const list = await c.request({ method: 'skills/list', params: {} } as never, z.object({ skills: z.array(z.any()) }).passthrough());
    const s = list.skills[0];
    expect(s.uri).toBe('skill://token-facts/SKILL.md');
    const text = ((await c.readResource({ uri: s.uri })).contents[0] as { text: string }).text;
    const bytes = Buffer.from(text, 'utf8');
    expect(s.resources).toEqual([{ uri: s.uri, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length }]);
    expect(guardrailViolations({ text })).toEqual([]);
    expect(text).not.toMatch(/\b(safe|risky|rug|scam)\b/i);
    const names = new Set((await c.listTools()).tools.map((t) => t.name));
    const mentioned = [...new Set((text.match(/`(token_[a-z_]+)`/g) ?? []).map((m) => m.slice(1, -1)))];
    expect(mentioned.sort()).toEqual(['token_check', 'token_check_summary']);
    expect(mentioned.filter((n) => !names.has(n))).toEqual([]);
  });
});

describe('check-mcp README matches the server', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = (h: string) => md.split(/^## /m).find((s) => s.startsWith(h)) ?? '';
  const server = () => connect({ apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}), reader: null });
  it('Tools table lists exactly the tools the server registers', async () => {
    const rows = [...section('Tools').matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    const names = (await (await server()).listTools()).tools.map((t) => t.name);
    expect(rows.sort()).toEqual(names.sort());
  });
  it('Try it in one minute: no key or RPC in the command, and the named tool exists', async () => {
    const tryIt = section('Try it in one minute');
    const cmd = tryIt.match(/^claude mcp add .+$/m)?.[0] ?? '';
    expect(cmd).toBe('claude mcp add a402-check -- npx -y @agent402-dev/check-mcp');
    expect(cmd).not.toMatch(/-e |RPC|KEY/);
    const asked = tryIt.match(/\*\*"Run (\w+) on (\w+)"\*\*/);
    const names = new Set((await (await server()).listTools()).tools.map((t) => t.name));
    expect(asked && names.has(asked[1])).toBe(true);
    expect(asked![2]).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });
  it('Skill section names every served skill URI and no other', async () => {
    const uris = [...new Set(section('Skill:').match(/skill:\/\/[a-z0-9-]+\/SKILL\.md/g) ?? [])].sort();
    const served = (await (await server()).listResources()).resources.map((r) => r.uri).filter((u) => u.startsWith('skill://')).sort();
    expect(uris.length).toBeGreaterThan(0);
    expect(uris).toEqual(served);
    expect(section('Skill:').startsWith(`Skill: ${served.map((u) => u.split('/')[2]).join(', ')} `)).toBe(true);
  });
});

describe('check-mcp llms-install.md (install guide for agents)', () => {
  const guide = readFileSync(new URL('../llms-install.md', import.meta.url), 'utf8');
  const src = ['tools.ts', 'server.ts'].map((f) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')).join('\n');
  it('names only tools the server registers, both of them', async () => {
    const c = await connect({ apiBase: 'https://api.test', fetch: async () => jsonRes(200, {}), reader: null });
    const names = new Set((await c.listTools()).tools.map((t) => t.name));
    const mentioned = [...new Set((guide.match(/`(token_[a-z_]+)`/g) ?? []).map((m) => m.slice(1, -1)))].sort();
    expect(mentioned).toEqual([...names].sort());
  });
  it('server entry has no key or RPC; env names and error codes exist in the code', () => {
    const blocks = [...guide.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(JSON.parse(blocks[0]).mcpServers['a402-check']).toEqual({ command: 'npx', args: ['-y', '@agent402-dev/check-mcp'] });
    for (const v of guide.match(/\bA402_[A-Z_]+/g) ?? []) expect(src).toContain(v);
    for (const code of ['rpc_not_configured', 'upstream_unavailable']) expect(src).toContain(code);
  });
  it('disclaimer, no rating wording, English only', () => {
    expect(guide).toContain('Not investment advice.');
    expect(guide).not.toMatch(/\b(safe|risky|rug|scam)\b/i);
    expect(guide).not.toMatch(/[가-힣]/);
  });
});
