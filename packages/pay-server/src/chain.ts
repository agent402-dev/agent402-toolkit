// What the SDK reads from the chain (minimal implementation, independent of the check engine). Uses only fetch, so it runs on Cloudflare Workers and Node.
// - Reads settlement transactions (checks the received increase) and recent signatures of receiving token accounts (to decide when the settlement result is unknown)
// - Reads multiple accounts (rate recording, checking the receiver's token account)

/** Transaction info needed to confirm settlement */
export interface ChainTx {
  signature: string;
  err: boolean;
  /** Index 0 = fee payer */
  accountKeys: string[];
  preTokenBalances: { accountIndex: number; mint: string; owner?: string | null; amount: string }[];
  postTokenBalances: { accountIndex: number; mint: string; owner?: string | null; amount: string }[];
  /** All signatures in the transaction (to find the buyer's signature) */
  signatures: string[];
}

export interface ChainAccount { owner: string; data: Uint8Array; lamports?: number }
export type AccountFetcher = (addresses: string[]) => Promise<{ slot: number; accounts: (ChainAccount | null)[] }>;

export interface ChainReader {
  loadTx(signature: string): Promise<ChainTx | null>;
  recentSignatures(address: string, limit: number): Promise<string[]>;
  accounts: AccountFetcher;
}

/** Increase at the receiving address for this payment asset (sum of that mint's token accounts owned by the receiver) */
export function receivedBy(tx: ChainTx, owner: string, mint: string): bigint {
  const sum = (xs: ChainTx['preTokenBalances']) => xs.filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.amount), 0n);
  return sum(tx.postTokenBalances) - sum(tx.preTokenBalances);
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  commitment?: 'confirmed' | 'finalized';
}

/** Builds a ChainReader over JSON-RPC. The RPC address (which may contain a key) is never put in error messages */
export function rpcChain(rpcUrl: string, o: RpcOptions = {}): ChainReader {
  const f = o.fetchImpl ?? fetch;
  const commitment = o.commitment ?? 'confirmed';
  let id = 0;
  async function call<T>(method: string, params: unknown[]): Promise<T> {
    const res = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!res.ok) throw new Error(`rpc ${method}: HTTP ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (j.error) throw new Error(`rpc ${method}: ${j.error.code}`);
    return j.result as T;
  }
  return {
    async loadTx(signature) {
      type Raw = {
        meta: { err: unknown; preTokenBalances?: Raw2[]; postTokenBalances?: Raw2[]; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
        transaction: { signatures: string[]; message: { accountKeys: string[] } };
      } | null;
      type Raw2 = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
      const r = await call<Raw>('getTransaction', [signature, { encoding: 'json', commitment, maxSupportedTransactionVersion: 0 }]);
      if (!r || !r.meta) return null;
      const keys = [...r.transaction.message.accountKeys, ...(r.meta.loadedAddresses?.writable ?? []), ...(r.meta.loadedAddresses?.readonly ?? [])];
      const tb = (xs?: Raw2[]) => (xs ?? []).map((b) => ({ accountIndex: b.accountIndex, mint: b.mint, owner: b.owner, amount: b.uiTokenAmount.amount }));
      return { signature, err: r.meta.err !== null, accountKeys: keys, preTokenBalances: tb(r.meta.preTokenBalances), postTokenBalances: tb(r.meta.postTokenBalances), signatures: r.transaction.signatures };
    },
    async recentSignatures(address, limit) {
      const r = await call<{ signature: string }[]>('getSignaturesForAddress', [address, { limit, commitment }]);
      return r.map((x) => x.signature);
    },
    async accounts(addresses) {
      const r = await call<{ context: { slot: number }; value: ({ owner: string; data: [string, string]; lamports: number } | null)[] }>(
        'getMultipleAccounts', [addresses, { encoding: 'base64', commitment }]);
      return {
        slot: r.context.slot,
        accounts: r.value.map((a) => (a ? { owner: a.owner, lamports: a.lamports, data: Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0)) } : null)),
      };
    },
  };
}

// ---------- Addresses ----------
export const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** Associated token account (ATA) address */
export async function ataOf(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const { PublicKey } = await import('@solana/web3.js');
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), new PublicKey(tokenProgram).toBuffer(), new PublicKey(mint).toBuffer()],
    new PublicKey(ATA_PROGRAM),
  )[0].toBase58();
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b === 0) s = '1' + s; else break; }
  return s;
}
