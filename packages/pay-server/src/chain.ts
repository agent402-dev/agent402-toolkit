// SDK 가 체인에서 읽는 것 (점검 엔진에 기대지 않는 최소 구현). fetch 만 씀 → Cloudflare Workers·Node 모두.
// - 정산 트랜잭션 읽기 (수령 증가액 확인), 수령 토큰 계정의 최근 서명 (정산 결과를 모를 때 판정)
// - 계정 여러 개 읽기 (환율 기록·받는 쪽 토큰 계정 확인)

/** 정산 확인에 필요한 트랜잭션 정보 */
export interface ChainTx {
  signature: string;
  err: boolean;
  /** 0번 = 수수료 낸 주소 */
  accountKeys: string[];
  preTokenBalances: { accountIndex: number; mint: string; owner?: string | null; amount: string }[];
  postTokenBalances: { accountIndex: number; mint: string; owner?: string | null; amount: string }[];
  /** 트랜잭션의 모든 서명 (구매자 서명 찾기용) */
  signatures: string[];
}

export interface ChainAccount { owner: string; data: Uint8Array; lamports?: number }
export type AccountFetcher = (addresses: string[]) => Promise<{ slot: number; accounts: (ChainAccount | null)[] }>;

export interface ChainReader {
  loadTx(signature: string): Promise<ChainTx | null>;
  recentSignatures(address: string, limit: number): Promise<string[]>;
  accounts: AccountFetcher;
}

/** 이 결제 수단의 수령 주소 증가량 (수령 주소가 소유한 그 민트 토큰 계정 합) */
export function receivedBy(tx: ChainTx, owner: string, mint: string): bigint {
  const sum = (xs: ChainTx['preTokenBalances']) => xs.filter((b) => b.owner === owner && b.mint === mint).reduce((s, b) => s + BigInt(b.amount), 0n);
  return sum(tx.postTokenBalances) - sum(tx.preTokenBalances);
}

export interface RpcOptions {
  fetchImpl?: typeof fetch;
  commitment?: 'confirmed' | 'finalized';
}

/** JSON-RPC 로 ChainReader 만들기. RPC 주소(키 포함일 수 있음)는 오류 메시지에 넣지 않음 */
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

// ---------- 주소 ----------
export const SPL_TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** 연결 토큰 계정(ATA) 주소 */
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
