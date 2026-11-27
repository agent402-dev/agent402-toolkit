// @agent402-dev/pay-mcp: optional MCP Tasks support (bond_v2_wait_result). Off by default; read-only; never pays.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';
import { mcpTasksFromEnv, registerBondV2WaitTask, taskServerOptions, waitForBondV2Result, waitLimits, WAIT_LIMITS } from '@agent402-dev/pay-mcp/bond-v2-task';

const seq = (...rs: string[]) => { let i = 0; const calls: number[] = []; return { calls, check: async () => { calls.push(i); return { result: rs[Math.min(i++, rs.length - 1)] }; } }; };
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };

describe('waitForBondV2Result', () => {
  it('stops at the first final result', async () => {
    const s = seq('working', 'not_marked', 'verified', 'working');
    const r = await waitForBondV2Result(s.check, { intervalMs: 10, maxWaitMs: 1000, ...clock() });
    expect(r).toMatchObject({ final: { result: 'verified' }, attempts: 3, timedOut: false, stopped: false });
  });
  it.each(['failed', 'not_verified', 'not_delivered', 'refused'])('"%s" is final (no retry)', async (fin) => {
    const s = seq(fin, 'verified');
    const r = await waitForBondV2Result(s.check, { intervalMs: 10, maxWaitMs: 1000, ...clock() });
    expect(r.final.result).toBe(fin);
    expect(r.attempts).toBe(1);
  });
  it('gives up after maxWaitMs with the last result', async () => {
    const s = seq('working');
    const r = await waitForBondV2Result(s.check, { intervalMs: 100, maxWaitMs: 450, ...clock() });
    expect(r).toMatchObject({ final: { result: 'working' }, timedOut: true });
    expect(r.attempts).toBe(5); // t = 0,100,200,300,400
  });
  it('stops when cancelled', async () => {
    const s = seq('working');
    let n = 0;
    const r = await waitForBondV2Result(s.check, { intervalMs: 10, maxWaitMs: 1000, ...clock(), stopped: async () => ++n > 2 });
    expect(r.stopped).toBe(true);
    expect(r.attempts).toBeLessThanOrEqual(2);
  });
  it('limits are clamped', () => {
    expect(waitLimits({})).toEqual({ intervalMs: WAIT_LIMITS.defaultIntervalMs, maxWaitMs: WAIT_LIMITS.defaultWaitMs });
    expect(waitLimits({ intervalMs: 1, maxWaitMs: 99_999_999 })).toEqual({ intervalMs: 5_000, maxWaitMs: 3_600_000 });
    expect(waitLimits({ intervalMs: Number.NaN, maxWaitMs: -5 })).toEqual({ intervalMs: 30_000, maxWaitMs: 0 });
  });
  it('X402_MCP_TASKS is off unless set to on/1/true', () => {
    expect([undefined, '', 'off', 'no', 'yes'].map(mcpTasksFromEnv)).toEqual([false, false, false, false, false]);
    expect(['on', 'ON', '1', ' true '].map(mcpTasksFromEnv)).toEqual([true, true, true, true]);
  });
});

async function connectPay(mcpTasks: boolean) {
  const policy = policyFromEnv({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const dir = mkdtempSync(join(tmpdir(), 'paymcp-task-'));
  await createPayServer({ policy, wallet: null, history: jsonlHistory(join(dir, 'h.jsonl'), () => policy.mints), fetch, bondV2Program: Keypair.generate().publicKey.toBase58(), mcpTasks,
    taskWait: { pollIntervalMs: 1, defaultIntervalMs: 1 } }).connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  return client;
}

describe('bond_v2_wait_result tool', () => {
  it('is not offered by default, and the server has no tasks capability', async () => {
    const c = await connectPay(false);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name)).not.toContain('bond_v2_wait_result');
    expect(tools.length).toBe(21);
    expect(c.getServerCapabilities()?.tasks).toBeUndefined();
    const w = JSON.parse(((await c.callTool({ name: 'wallet_status', arguments: {} })).content as { text: string }[])[0].text);
    expect(w.mcpTasks).toBe('off (X402_MCP_TASKS)');
  });
  it('X402_MCP_TASKS on: offered as read-only with optional task support; other tools unchanged', async () => {
    const c = await connectPay(true);
    const { tools } = await c.listTools();
    expect(tools.length).toBe(22);
    const t = tools.find((x) => x.name === 'bond_v2_wait_result')!;
    expect(t.execution?.taskSupport).toBe('optional');
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(t.description).toMatch(/Never pays/);
    expect(tools.filter((x) => x.name !== 'bond_v2_wait_result').every((x) => (x.execution?.taskSupport ?? 'forbidden') === 'forbidden')).toBe(true);
    expect(c.getServerCapabilities()?.tasks?.requests).toBeDefined();
    const w = JSON.parse(((await c.callTool({ name: 'wallet_status', arguments: {} })).content as { text: string }[])[0].text);
    expect(w.mcpTasks).toMatch(/^on /);
  });
  it('without bond configuration it refuses like bond_v2_result', async () => {
    const c = await connectPay(true);
    const r = await c.callTool({ name: 'bond_v2_wait_result', arguments: { url: 'https://seller.example/job', deal: Keypair.generate().publicKey.toBase58() } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toMatchObject({ result: 'refused' });
  });
});

describe('registerBondV2WaitTask', () => {
  async function setup(results: string[], opts: { defaultIntervalMs?: null } = {}) {
    let clock = 0;
    const limits: { intervalMs: number; maxWaitMs: number; plain: boolean }[] = [];
    const server = new McpServer({ name: 's', version: '0' }, taskServerOptions());
    const s = seq(...results);
    const seen: [string, string][] = [];
    registerBondV2WaitTask(server, z.string(), z.string(), {
      result: (url, deal) => { seen.push([url, deal]); return s.check(); },
      noBond: () => ({ content: [{ type: 'text', text: '{"result":"refused"}' }], isError: true }),
      sleep: async (ms) => { clock += ms; }, now: () => clock, pollIntervalMs: 1, defaultIntervalMs: opts.defaultIntervalMs === null ? undefined : 1,
      onLimits: (lim, plain) => limits.push({ ...lim, plain }),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 't', version: '0' }, { capabilities: { tasks: { requests: {} } } });
    await client.connect(b);
    return { client, seen, limits };
  }
  it('plain call: waits, then returns the verified result', async () => {
    const { client, seen } = await setup(['working', 'not_marked', 'verified']);
    const r = await client.callTool({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd' } });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toMatchObject({ result: 'verified', attempts: 3 });
    expect(seen).toEqual([['u', 'd'], ['u', 'd'], ['u', 'd']]);
  });
  it('task call: returns a task, then the result through the task', async () => {
    const { client } = await setup(['working', 'not_verified']);
    const msgs: { type: string; task?: { status: string }; result?: { content: { text: string }[]; isError?: boolean } }[] = [];
    for await (const m of client.experimental.tasks.callToolStream({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd' } }, undefined, { task: { ttl: 60_000 } })) msgs.push(m as never);
    expect(msgs[0].type).toBe('taskCreated');
    const last = msgs[msgs.length - 1];
    expect(last.type).toBe('result');
    expect(last.result!.isError).toBe(true);
    expect(JSON.parse(last.result!.content[0].text)).toMatchObject({ result: 'not_verified', attempts: 2 });
  });
  it('plain call: default wait is 50 s with 10 s checks, so it answers before a ~60 s client cut-off', async () => {
    const { client, seen, limits } = await setup(Array(20).fill('working'), { defaultIntervalMs: null });
    const r = await client.callTool({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd' } });
    expect(limits[0]).toEqual({ intervalMs: 10_000, maxWaitMs: 50_000, plain: true });
    const body = JSON.parse((r.content as { text: string }[])[0].text);
    expect(body).toMatchObject({ result: 'working', waited: 'timed_out', attempts: 6 });
    expect(seen.length).toBe(6); // checks at 0, 10, 20, 30, 40 and 50 s of simulated time
    expect(r.isError).toBe(true);
  });
  it('plain call: an explicit maxWaitMinutes is kept', async () => {
    const { client, limits } = await setup(['verified'], { defaultIntervalMs: null });
    await client.callTool({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd', maxWaitMinutes: 5, intervalSeconds: 20 } });
    expect(limits[0]).toEqual({ intervalMs: 20_000, maxWaitMs: 300_000, plain: true });
  });
  it('task call: default wait stays 30 minutes with 30 s checks', async () => {
    const { client, limits } = await setup(['verified'], { defaultIntervalMs: null });
    for await (const _m of client.experimental.tasks.callToolStream({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd' } }, undefined, { task: { ttl: 60_000 } })) { /* drain */ }
    expect(limits[0]).toEqual({ intervalMs: 30_000, maxWaitMs: 1_800_000, plain: false });
  });
  it('plain call with a progress token: one progress notification per check', async () => {
    const { client } = await setup(['working', 'not_marked', 'verified']);
    const got: { progress: number; message?: string }[] = [];
    const r = await client.callTool({ name: 'bond_v2_wait_result', arguments: { url: 'u', deal: 'd' } }, undefined, { onprogress: (p) => { got.push({ progress: p.progress, message: p.message }); } });
    expect(JSON.parse((r.content as { text: string }[])[0].text)).toMatchObject({ result: 'verified', attempts: 3 });
    await new Promise((res) => setTimeout(res, 10));
    expect(got).toEqual([{ progress: 1, message: 'check 1: working' }, { progress: 2, message: 'check 2: not_marked' }, { progress: 3, message: 'check 3: verified' }]);
  });
  it('a failing progress hook does not stop the wait', async () => {
    const s = seq('working', 'verified');
    const r = await waitForBondV2Result(s.check, { intervalMs: 10, maxWaitMs: 1000, ...clock(), onCheck: () => { throw new Error('x'); } });
    expect(r).toMatchObject({ final: { result: 'verified' }, attempts: 2, timedOut: false });
  });
});
