import { Connection, PublicKey, type GetProgramAccountsFilter } from '@solana/web3.js';
import type { AccountFetcher } from './summary.js';
import type { ChainReader, HistoryReader, TokenBalanceEntry, TxRecord } from './chain.js';

export const DEFAULT_MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

export function rpcUrl(): string {
  return process.env.RPC_URL || DEFAULT_MAINNET_RPC;
}

export function makeConnection(url = rpcUrl()): Connection {
  return new Connection(url, 'confirmed');
}

/** Reads accounts at the same slot with getMultipleAccounts (in calls of 100). */
export function rpcFetcher(conn: Connection): AccountFetcher {
  return async (addresses) => {
    let slot = 0;
    const accounts: Awaited<ReturnType<AccountFetcher>>['accounts'] = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const res = await conn.getMultipleAccountsInfoAndContext(addresses.slice(i, i + 100).map((a) => new PublicKey(a)));
      slot = Math.max(slot, res.context.slot);
      for (const a of res.value) accounts.push(a ? { owner: a.owner.toBase58(), data: Buffer.from(a.data) } : null);
    }
    return { slot, accounts };
  };
}

/** @deprecated Use rpcChainReader */
export const rpcHolderReader = (conn: Connection, opts: HolderReaderOptions = {}) => rpcChainReader(conn, opts);

export interface HolderReaderOptions {
  /**
    * If getTokenLargestAccounts fails (rate limits, etc.), scans every token account of the mint with getProgramAccounts
    * and picks the largest. Only practical for tokens with few holder accounts.
   */
  allowScanFallback?: boolean;
  topN?: number;
  /** Retry intervals when getTokenLargestAccounts returns 429 (default 0.8s, 2s, 4s) */
  retryDelaysMs?: number[];
}

export function rpcChainReader(conn: Connection, opts: HolderReaderOptions = {}): ChainReader {
  const topN = opts.topN ?? 20;
  // On rate limits (429), don't retry for long; go straight to the fallback
  const noRetry = new Connection(conn.rpcEndpoint, { commitment: 'confirmed', disableRetryOnRateLimit: true });
  return {
    fetch: rpcFetcher(conn),
    async largestTokenAccounts(mint, tokenProgram) {
      // Retry 429 (rate limit) a few times briefly. Other errors (too many accounts, etc.) fail or fall back right away
      let lastErr: unknown;
      for (const wait of [0, ...(opts.retryDelaysMs ?? [800, 2000, 4000])]) {
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          const res = await noRetry.getTokenLargestAccounts(new PublicKey(mint));
          return { addresses: res.value.map((v) => v.address.toBase58()), method: 'getTokenLargestAccounts' };
        } catch (e) {
          lastErr = e;
          if (!/429|Too many requests/i.test(String((e as Error)?.message ?? e))) break;
        }
      }
      if (!opts.allowScanFallback) throw lastErr;
      const accs = await conn.getProgramAccounts(new PublicKey(tokenProgram), {
        filters: [{ memcmp: { offset: 0, bytes: mint } }],
        dataSlice: { offset: 64, length: 8 },
      });
      const sorted = accs
        .filter((a) => a.account.data.length === 8)
        .map((a) => ({ address: a.pubkey.toBase58(), amount: Buffer.from(a.account.data).readBigUInt64LE(0) }))
        .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
      return {
        addresses: sorted.slice(0, topN).map((a) => a.address),
        method: `getProgramAccounts (top ${Math.min(topN, sorted.length)} of ${sorted.length} token accounts)`,
      };
    },
    async programAccounts(program, query) {
      const filters: GetProgramAccountsFilter[] = query.memcmp.map((m) => ({ memcmp: { offset: m.offset, bytes: m.bytes } }));
      if (query.dataSize !== undefined) filters.push({ dataSize: query.dataSize });
      const accs = await conn.getProgramAccounts(new PublicKey(program), { filters });
      return accs.map((a) => ({ address: a.pubkey.toBase58(), data: Buffer.from(a.account.data) }));
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Direct JSON-RPC call (to receive transaction versions web3.js cannot decode yet). Retries 429 briefly */
async function rpcCall<T>(endpoint: string, method: string, params: unknown[]): Promise<T> {
  let lastErr: unknown;
  for (const wait of [0, 800, 2000, 4000]) {
    if (wait) await sleep(wait);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (res.status === 429) { lastErr = new Error(`${method}: 429 Too many requests`); continue; }
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`); // response body and address are not put in errors (to avoid exposing keys)
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) {
      if (body.error.code === 429 || /too many/i.test(body.error.message)) { lastErr = new Error(`${method}: 429`); continue; }
      throw Object.assign(new Error(`${method}: ${body.error.message}`), { code: body.error.code });
    }
    return body.result as T;
  }
  throw lastErr;
}

interface RawTx {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    preTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances?: { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }[];
  } | null;
  transaction: { message: { accountKeys?: string[] } };
}

function normalizeTx(signature: string, raw: RawTx | null): TxRecord | null {
  if (!raw || !raw.meta || !Array.isArray(raw.transaction?.message?.accountKeys)) return null;
  const la = raw.meta.loadedAddresses ?? { writable: [], readonly: [] };
  const tb = (xs: NonNullable<RawTx['meta']>['preTokenBalances']): TokenBalanceEntry[] =>
    (xs ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner ?? null, amount: b.uiTokenAmount.amount }));
  return {
    signature,
    slot: raw.slot,
    blockTime: raw.blockTime,
    err: raw.meta.err !== null,
    accountKeys: [...raw.transaction.message.accountKeys, ...la.writable, ...la.readonly],
    preTokenBalances: tb(raw.meta.preTokenBalances),
    postTokenBalances: tb(raw.meta.postTokenBalances),
  };
}

export function rpcHistoryReader(conn: Connection, opts: { concurrency?: number } = {}): HistoryReader {
  const endpoint = conn.rpcEndpoint;
  let maxVersion = 1; // drop to 0 if the node rejects 1
  const getTx = async (sig: string): Promise<TxRecord | null> => {
    try {
      const raw = await rpcCall<RawTx | null>(endpoint, 'getTransaction', [sig, { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: maxVersion }]);
      return normalizeTx(sig, raw);
    } catch (e) {
      if (maxVersion === 1 && /maxSupportedTransactionVersion|invalid/i.test(String((e as Error).message))) {
        maxVersion = 0;
        return getTx(sig);
      }
      if (/version .* is not supported/i.test(String((e as Error).message))) return null; // version that cannot be decoded
      throw e;
    }
  };
  return {
    async signaturesForAddress(address, o) {
      const res = await rpcCall<{ signature: string; slot: number; blockTime: number | null; err: unknown }[]>(
        endpoint, 'getSignaturesForAddress', [address, { limit: o.limit, before: o.before, commitment: 'confirmed' }],
      );
      return res.map((s) => ({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, err: s.err !== null }));
    },
    async blocks(startSlot, endSlot) {
      return rpcCall<number[]>(endpoint, 'getBlocks', [startSlot, endSlot, { commitment: 'confirmed' }]);
    },
    async blockTime(slot) {
      try {
        return await rpcCall<number | null>(endpoint, 'getBlockTime', [slot]);
      } catch (e) {
        if (/skipped|not available|-3200[47]/i.test(String((e as Error).message))) return null;
        throw e;
      }
    },
    async transactions(signatures) {
      const out: (TxRecord | null)[] = new Array(signatures.length).fill(null);
      const n = opts.concurrency ?? 2; // kept low because of free RPC rate limits
      let next = 0;
      await Promise.all(Array.from({ length: n }, async () => {
        while (next < signatures.length) {
          const i = next++;
          out[i] = await getTx(signatures[i]);
        }
      }));
      return out;
    },
  };
}
