// Optional MCP Tasks support (experimental, off by default): bond_v2_wait_result waits for a Bond v2 delivery in the background.
// It only repeats bond_v2_result, which never pays and changes nothing on chain. Nothing here signs a transaction,
// accepts, settles or touches any payment rule. Turn it on with X402_MCP_TASKS=on; without it the server is unchanged.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTaskStore } from '@modelcontextprotocol/sdk/experimental/tasks';

/** Results that mean "not ready yet, ask again later". Everything else is final. */
const WAITABLE = new Set(['working', 'not_marked']);

export const WAIT_LIMITS = {
  minIntervalMs: 5_000, maxIntervalMs: 300_000, defaultIntervalMs: 30_000,
  maxWaitMs: 3_600_000, defaultWaitMs: 1_800_000,
  /** Plain (non-task) calls: many clients cut a plain tools/call at about 60 s, so answer before that unless the caller sets maxWaitMinutes */
  plainDefaultWaitMs: 50_000, plainDefaultIntervalMs: 10_000,
} as const;

/** Marks the extra of a plain tools/call that the SDK turned into a task internally (automatic polling). */
const PLAIN_CALL = Symbol('agent402.plainCall');

/**
 * The SDK runs a plain call to a taskSupport "optional" tool through handleAutomaticTaskPolling, and a task-augmented call
 * straight through createTask; createTask cannot tell them apart. Wrap that method once per server so the plain path is marked.
 * Returns false when the SDK has no such method; callers then treat every call as plain (the shorter wait).
 */
function markPlainCalls(server: McpServer): boolean {
  const s = server as unknown as { handleAutomaticTaskPolling?: (tool: unknown, req: unknown, extra: object) => Promise<unknown>; [PLAIN_CALL]?: true };
  if (typeof s.handleAutomaticTaskPolling !== 'function') return false;
  if (s[PLAIN_CALL]) return true;
  const orig = s.handleAutomaticTaskPolling.bind(server);
  s.handleAutomaticTaskPolling = (tool, req, extra) => orig(tool, req, { ...extra, [PLAIN_CALL]: true });
  s[PLAIN_CALL] = true;
  return true;
}

export interface WaitOptions {
  intervalMs?: number;
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Stops waiting early (for example the task was cancelled) */
  stopped?: () => boolean | Promise<boolean>;
  /** Called after each check (for progress notifications). Errors are ignored */
  onCheck?: (last: { result: string }, attempts: number) => void | Promise<void>;
}

const clamp = (v: number | undefined, lo: number, hi: number, dflt: number) =>
  v === undefined || !Number.isFinite(v) ? dflt : Math.min(hi, Math.max(lo, Math.floor(v)));

/** Same limits as the tool: interval 5 s..5 min, total wait at most 60 min. */
export function waitLimits(o: { intervalMs?: number; maxWaitMs?: number }) {
  return {
    intervalMs: clamp(o.intervalMs, WAIT_LIMITS.minIntervalMs, WAIT_LIMITS.maxIntervalMs, WAIT_LIMITS.defaultIntervalMs),
    maxWaitMs: clamp(o.maxWaitMs, 0, WAIT_LIMITS.maxWaitMs, WAIT_LIMITS.defaultWaitMs),
  };
}

/**
 * Calls check() until its result is final or the wait runs out. Read-only by construction: check is bond_v2_result.
 * The limits must already be applied (waitLimits); tests pass small values directly.
 */
export async function waitForBondV2Result<T extends { result: string }>(check: () => Promise<T>, o: WaitOptions & { intervalMs: number; maxWaitMs: number }) {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const start = now();
  let attempts = 0;
  for (;;) {
    const last = await check();
    attempts++;
    try { await o.onCheck?.(last, attempts); } catch { /* progress is best effort */ }
    if (!WAITABLE.has(last.result)) return { final: last, attempts, timedOut: false, stopped: false };
    if (await o.stopped?.()) return { final: last, attempts, timedOut: false, stopped: true };
    if (now() - start + o.intervalMs > o.maxWaitMs) return { final: last, attempts, timedOut: true, stopped: false };
    await sleep(o.intervalMs);
    if (await o.stopped?.()) return { final: last, attempts, timedOut: false, stopped: true };
  }
}

/** X402_MCP_TASKS=on|1|true turns the task tool on. Anything else: off. */
export function mcpTasksFromEnv(v: string | undefined): boolean {
  return ['on', '1', 'true'].includes((v ?? '').trim().toLowerCase());
}

/** Server options that enable tasks (tasks/get, tasks/result, tasks/list, tasks/cancel) with an in-memory store. */
export function taskServerOptions(): ServerOptions {
  return {
    capabilities: { tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } },
    taskStore: new InMemoryTaskStore(),
  };
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };
const out = (obj: unknown, isError = false): ToolResult => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], ...(isError ? { isError } : {}) });

export interface WaitToolDeps {
  /** bond_v2_result for one url and deal, or null when bond tools are not configured */
  result: (url: string, deal: string) => Promise<{ result: string }> | null;
  noBond: () => ToolResult;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll interval hint sent to the client (ms). Default 5000 */
  pollIntervalMs?: number;
  /** Interval used when the call gives none. Tests only; default WAIT_LIMITS.defaultIntervalMs */
  defaultIntervalMs?: number;
  /** Tests only: sees the limits chosen for each call */
  onLimits?: (lim: { intervalMs: number; maxWaitMs: number }, plain: boolean) => void;
}

export function registerBondV2WaitTask(server: McpServer, url: z.ZodTypeAny, deal: z.ZodTypeAny, d: WaitToolDeps) {
  const canMark = markPlainCalls(server);
  return server.experimental.tasks.registerToolTask('bond_v2_wait_result', {
    description: 'Agent402 Bond v2, buyer side, read-only. Same checks as bond_v2_result, repeated in the background until the delivery is final ("verified", "failed", "not_verified", "not_delivered" or "refused") or the wait ends (at most 60 minutes). Runs as an MCP task when the client asks for one (default wait 30 minutes); otherwise it is a plain call that answers within 50 seconds by default, because many clients stop plain calls after about 60 seconds, and you call it again if the result is still not final. Never pays and changes nothing on chain: accepting is still a separate bond_v2_accept call with its own checks and human confirmation.',
    inputSchema: {
      url, deal,
      intervalSeconds: z.number().int().min(5).max(300).optional().describe('Seconds between checks (5..300, default 30 as a task, 10 as a plain call).'),
      maxWaitMinutes: z.number().int().min(1).max(60).optional().describe('Stop waiting after this many minutes (1..60). Default: 30 as a task, 50 seconds as a plain call. A long plain wait may be cut off by your client.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    execution: { taskSupport: 'optional' },
  }, {
    createTask: async (args, extra) => {
      const a = args as { url: string; deal: string; intervalSeconds?: number; maxWaitMinutes?: number };
      const lim = waitLimits({ intervalMs: a.intervalSeconds === undefined ? undefined : a.intervalSeconds * 1000, maxWaitMs: a.maxWaitMinutes === undefined ? undefined : a.maxWaitMinutes * 60_000 });
      const plain = !canMark || (extra as object as Record<symbol, unknown>)[PLAIN_CALL] === true;
      if (plain && a.maxWaitMinutes === undefined) lim.maxWaitMs = WAIT_LIMITS.plainDefaultWaitMs;
      if (plain && a.intervalSeconds === undefined) lim.intervalMs = WAIT_LIMITS.plainDefaultIntervalMs;
      if (d.defaultIntervalMs !== undefined && a.intervalSeconds === undefined) lim.intervalMs = d.defaultIntervalMs;
      d.onLimits?.({ ...lim }, plain);
      const task = await extra.taskStore.createTask({ ttl: lim.maxWaitMs + 600_000, pollInterval: d.pollIntervalMs ?? 5_000 });
      const store = extra.taskStore;
      // A plain call ends when its request is cancelled; a task call ends when the task is cancelled
      const cancelled = async () => { if (plain && extra.signal?.aborted) return true; try { return (await store.getTask(task.taskId)).status === 'cancelled'; } catch { return true; } };
      // Plain call with a progress token: one progress notification per check, so clients that reset their time-out on progress keep waiting
      const progressToken = plain ? (extra as { _meta?: { progressToken?: string | number } })._meta?.progressToken : undefined;
      const onCheck = progressToken === undefined ? undefined : async (last: { result: string }, n: number) => {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken, progress: n, message: `check ${n}: ${last.result}` } });
      };
      void (async () => {
        let res: ToolResult;
        try {
          const first = d.result(a.url, a.deal);
          if (!first) res = d.noBond();
          else {
            let pending: Promise<{ result: string }> | null = first;
            const check = () => { const p = pending ?? d.result(a.url, a.deal)!; pending = null; return p; };
            const w = await waitForBondV2Result(check, { ...lim, sleep: d.sleep, now: d.now, stopped: cancelled, onCheck });
            if (w.stopped) return;
            res = out({ ...w.final, attempts: w.attempts, ...(w.timedOut ? { waited: 'timed_out', next: 'Still not final. Call bond_v2_wait_result or bond_v2_result again later.' } : {}) }, w.final.result !== 'verified');
          }
        } catch (e) {
          res = out({ result: 'error', reason: (e as Error).message }, true);
        }
        try { if (!(await cancelled())) await store.storeTaskResult(task.taskId, 'completed', res); } catch { /* cancelled or expired: nothing to store */ }
      })();
      return { task };
    },
    getTask: async (_args, extra) => extra.taskStore.getTask(extra.taskId),
    getTaskResult: async (_args, extra) => (await extra.taskStore.getTaskResult(extra.taskId)) as ToolResult,
  });
}
