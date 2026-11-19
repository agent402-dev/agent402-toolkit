import type { AccountFetcher } from './summary.js';
import type { ChainReader, HistoryReader, SignatureInfo, TokenBalanceEntry, TxRecord } from './chain.js';

/**
 * fetch 만 쓰는 RPC 판독기 (Cloudflare Workers 등 web3.js Connection 없이).
 * 오류 메시지에 RPC 주소(키 포함 가능)를 넣지 않습니다.
 */
export class RpcError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface LiteOptions {
  fetchImpl?: typeof fetch;
  retryDelaysMs?: number[];
  commitment?: 'confirmed' | 'finalized';
  /** 바깥으로 나간 HTTP 요청 수를 셉니다 (Workers 요청당 외부 호출 제한 측정용) */
  counter?: { requests: number };
  /**
   * 같은 순간에 나온 호출을 JSON-RPC 일괄 요청 하나로 묶을 최대 개수. 1 이면 묶지 않음.
   * RPC 가 일괄 요청을 지원해야 함 (기본 25)
   */
  batchSize?: number;
  /** RPC 업체의 초당 호출 제한에 맞춰, 묶음 안 호출 수 기준으로 보내는 속도를 늦춤 (기본 10). 0 이면 제한 없음 */
  maxCallsPerSecond?: number;
}

type Pending = { method: string; params: unknown[]; resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** 엔드포인트별 묶음 처리기: 대기열을 batchSize 씩 순서대로 보냄 (한 번에 하나의 HTTP 만 진행) */
class Batcher {
  private queue: Pending[] = [];
  private running = false;
  /** 다음 HTTP 를 보내도 되는 시각 (호출 수 기준 속도 제한) */
  private nextAt = 0;
  constructor(private endpoint: string, private o: LiteOptions) {}

  private async pace(calls: number) {
    const rate = this.o.maxCallsPerSecond ?? 10;
    if (!rate) return;
    const now = Date.now();
    const wait = this.nextAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nextAt = Math.max(now, this.nextAt) + (calls * 1000) / rate;
  }

  enqueue<T>(method: string, params: unknown[]): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ method, params, resolve: resolve as (v: unknown) => void, reject });
      if (!this.running) {
        this.running = true;
        // 같은 틱에 나온 호출이 모두 대기열에 들어온 뒤 보냄
        setTimeout(() => void this.drain(), 0);
      }
    });
  }

  private async drain() {
    try {
      while (this.queue.length) {
        const chunk = this.queue.splice(0, Math.max(1, this.o.batchSize ?? 10));
        await this.send(chunk);
      }
    } finally {
      this.running = false;
      if (this.queue.length) { this.running = true; setTimeout(() => void this.drain(), 0); }
    }
  }

  private async send(chunk: Pending[]) {
    const f = this.o.fetchImpl ?? fetch;
    const single = chunk.length === 1;
    const body = chunk.map((p, i) => ({ jsonrpc: '2.0', id: i, method: p.method, params: p.params }));
    let lastErr: Error = new RpcError(`${chunk[0].method} failed`);
    for (const wait of [0, ...(this.o.retryDelaysMs ?? [500, 1500, 3000])]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      let res: Response;
      try {
        await this.pace(chunk.length);
        if (this.o.counter) this.o.counter.requests++;
        res = await f(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(single ? body[0] : body) });
      } catch {
        lastErr = new RpcError(`${chunk[0].method}: network error`);
        continue;
      }
      if (res.status === 429) { lastErr = new RpcError(`${chunk[0].method}: rate limited`, 429); continue; }
      if (!res.ok) { lastErr = new RpcError(`${chunk[0].method}: HTTP ${res.status}`, res.status); break; }
      const raw = (await res.json()) as unknown;
      const items = (Array.isArray(raw) ? raw : [raw]) as { id: number; result?: unknown; error?: { code: number; message: string } }[];
      // 묶음 안의 일부가 429 면 그 일부만 다시 대기열 앞에 넣음
      const retry: Pending[] = [];
      for (const it of items) {
        const p = chunk[single ? 0 : it.id];
        if (!p) continue;
        if (it.error) {
          if (it.error.code === 429 || /too many/i.test(it.error.message)) retry.push(p);
          else p.reject(Object.assign(new RpcError(`${p.method}: RPC error ${it.error.code}`), { rpcMessage: it.error.message }));
        } else p.resolve(it.result);
      }
      const answered = new Set(items.map((it) => (single ? 0 : it.id)));
      chunk.forEach((p, i) => { if (!answered.has(i)) retry.push(p); });
      if (!retry.length) return;
      chunk = retry;
      lastErr = new RpcError(`${chunk[0].method}: rate limited`, 429);
    }
    for (const p of chunk) p.reject(lastErr);
  }
}

const batchers = new WeakMap<LiteOptions, Map<string, Batcher>>();
function batcherFor(endpoint: string, o: LiteOptions): Batcher {
  let m = batchers.get(o);
  if (!m) { m = new Map(); batchers.set(o, m); }
  let b = m.get(endpoint);
  if (!b) { b = new Batcher(endpoint, o); m.set(endpoint, b); }
  return b;
}

/** JSON-RPC 호출 (자동 묶음 + 429 재시도). 오류에는 method 이름만 남김 */
function call<T>(endpoint: string, method: string, params: unknown[], o: LiteOptions): Promise<T> {
  return batcherFor(endpoint, o).enqueue<T>(method, params);
}

export function fetchAccountFetcher(endpoint: string, o: LiteOptions = {}): AccountFetcher {
  return async (addresses) => {
    let slot = 0;
    const accounts: Awaited<ReturnType<AccountFetcher>>['accounts'] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const r = await call<{ context: { slot: number }; value: ({ owner: string; data: [string, string] } | null)[] }>(
        endpoint, 'getMultipleAccounts', [addresses.slice(i, i + 100), { encoding: 'base64', commitment: o.commitment ?? 'confirmed' }], o,
      );
      slot = Math.max(slot, r.context.slot);
      for (const a of r.value) accounts.push(a ? { owner: a.owner, data: Buffer.from(a.data[0], 'base64') } : null);
    }
    return { slot, accounts };
  };
}

interface RawTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    logMessages?: string[];
  } | null;
  transaction: { signatures?: string[]; message: { accountKeys?: string[]; instructions?: { programIdIndex: number; data: string; accounts: number[] }[] } };
}

/** 결제 검증용으로 명령(instruction)·로그·서명 목록까지 담은 기록 */
export interface TxRecordWithInstructions extends TxRecord {
  instructions: { programId: string; data: string }[];
  logMessages: string[];
  /** 트랜잭션에 들어 있는 모든 서명 (base58) */
  signatures: string[];
}

export function normalizeTx(signature: string, raw: RawTx | null): TxRecordWithInstructions | null {
  if (!raw || !raw.meta || !Array.isArray(raw.transaction?.message?.accountKeys)) return null;
  const la = raw.meta.loadedAddresses ?? { writable: [], readonly: [] };
  const keys = [...raw.transaction.message.accountKeys, ...la.writable, ...la.readonly];
  const tb = (xs: NonNullable<RawTx['meta']>['preTokenBalances']): TokenBalanceEntry[] =>
    (xs ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner ?? null, amount: b.uiTokenAmount.amount }));
  return {
    signature,
    slot: raw.slot,
    blockTime: raw.blockTime,
    err: raw.meta.err !== null,
    accountKeys: keys,
    preTokenBalances: tb(raw.meta.preTokenBalances),
    postTokenBalances: tb(raw.meta.postTokenBalances),
    instructions: (raw.transaction.message.instructions ?? []).map((ix) => ({ programId: keys[ix.programIdIndex], data: ix.data })),
    logMessages: raw.meta.logMessages ?? [],
    signatures: raw.transaction.signatures ?? [signature],
  };
}

/** 주소의 최근 서명 (최신 순) */
export async function fetchRecentSignatures(endpoint: string, address: string, limit: number, o: LiteOptions = {}): Promise<string[]> {
  const r = await call<{ signature: string }[]>(endpoint, 'getSignaturesForAddress', [address, { limit, commitment: 'confirmed' }], o);
  return r.map((s) => s.signature);
}

/** 트랜잭션 하나 (v1 형식까지). 없으면 null */
export async function fetchTransaction(endpoint: string, signature: string, o: LiteOptions = {}): Promise<TxRecordWithInstructions | null> {
  let version = 1;
  for (;;) {
    try {
      const raw = await call<RawTx | null>(endpoint, 'getTransaction',
        [signature, { encoding: 'json', commitment: o.commitment ?? 'confirmed', maxSupportedTransactionVersion: version }], o);
      return normalizeTx(signature, raw);
    } catch (e) {
      const msg = String((e as { rpcMessage?: string }).rpcMessage ?? '');
      if (version === 1 && /maxSupportedTransactionVersion|invalid/i.test(msg)) { version = 0; continue; }
      if (/version .* is not supported/i.test(msg)) return null;
      throw e;
    }
  }
}

/** 점검 엔진 전체(항목 1~8)가 쓰는 판독기를 fetch 만으로 */
export function fetchChainReader(endpoint: string, o: LiteOptions = {}): ChainReader & HistoryReader {
  return {
    fetch: fetchAccountFetcher(endpoint, o),
    async largestTokenAccounts(mint) {
      const r = await call<{ value: { address: string }[] }>(endpoint, 'getTokenLargestAccounts', [mint, { commitment: o.commitment ?? 'confirmed' }], o);
      return { addresses: r.value.map((v) => v.address), method: 'getTokenLargestAccounts' };
    },
    async programAccounts(program, q) {
      const filters: unknown[] = q.memcmp.map((m) => ({ memcmp: { offset: m.offset, bytes: m.bytes } }));
      if (q.dataSize !== undefined) filters.push({ dataSize: q.dataSize });
      const r = await call<{ pubkey: string; account: { data: [string, string] } }[]>(
        endpoint, 'getProgramAccounts', [program, { encoding: 'base64', filters, commitment: o.commitment ?? 'confirmed' }], o,
      );
      return r.map((a) => ({ address: a.pubkey, data: Buffer.from(a.account.data[0], 'base64') }));
    },
    async signaturesForAddress(address, so) {
      const r = await call<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>(
        endpoint, 'getSignaturesForAddress', [address, { limit: so.limit, before: so.before, commitment: 'confirmed' }], o,
      );
      return r.map((s): SignatureInfo => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err !== null }));
    },
    async transactions(signatures) {
      // 한꺼번에 요청 → 묶음 처리기가 batchSize 씩 순서대로 보냄
      return Promise.all(signatures.map((s) => fetchTransaction(endpoint, s, o)));
    },
    blocks: (a, b) => call<number[]>(endpoint, 'getBlocks', [a, b, { commitment: 'confirmed' }], o),
    async blockTime(slot) {
      try {
        return await call<number | null>(endpoint, 'getBlockTime', [slot], o);
      } catch (e) {
        if (/skipped|not available|-3200[47]/i.test(String((e as { rpcMessage?: string }).rpcMessage ?? (e as Error).message))) return null;
        throw e;
      }
    },
  };
}
