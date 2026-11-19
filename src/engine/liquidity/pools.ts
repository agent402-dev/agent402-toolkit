import { Reader } from '../bytes.js';
import type { ChainReader } from '../chain.js';
import {
  DAMM_V2_POOL_OFFSETS,
  DAMM_V2_POOL_SIZE,
  DAMM_V2_PROGRAM,
  decodeDammV2Pool,
  type DammV2Pool,
} from './meteora-damm-v2.js';
import { CPMM_POOL_OFFSETS, CPMM_POOL_SIZE, CPMM_PROGRAM, decodeCpmmPool, type CpmmPool } from './raydium-cpmm.js';

export type Dex = 'meteora-damm-v2' | 'raydium-cpmm';

interface CandidateBase {
  address: string;
  /** 이 토큰이 들어 있는 풀 금고 */
  vault: string;
  /** 짝 토큰 금고 */
  pairVault: string;
  pairMint: string;
  /**
   * 풀에 기록된 거래 시작 시점.
   * DAMM v2: activation_point (activation_type 0 = 슬롯, 1 = 유닉스 초). CPMM: open_time (유닉스 초)
   */
  activation: { kind: 'slot' | 'timestamp'; value: bigint };
}
export type PoolCandidate =
  | (CandidateBase & { dex: 'meteora-damm-v2'; pool: DammV2Pool })
  | (CandidateBase & { dex: 'raydium-cpmm'; pool: CpmmPool });

export async function tokenBalances(reader: ChainReader, accounts: string[]) {
  const res = await reader.fetch(accounts);
  const out = new Map<string, { mint: string; owner: string; amount: bigint }>();
  accounts.forEach((a, i) => {
    const acc = res.accounts[i];
    if (!acc || acc.data.length < 165) return;
    const r = new Reader(acc.data);
    const mint = r.pubkey().toBase58();
    const owner = r.pubkey().toBase58();
    out.set(a, { mint, owner, amount: r.u64() });
  });
  return { slot: res.slot, balances: out };
}

/** 지원 DEX(Meteora DAMM v2, Raydium CPMM)에서 이 민트가 들어 있는 풀을 찾아, 이 토큰 잔액이 큰 순서로 돌려줍니다. */
export async function findSupportedPools(mint: string, reader: ChainReader) {
  const find = async (program: string, size: number, offsets: number[]) =>
    (await Promise.all(offsets.map((offset) => reader.programAccounts(program, { memcmp: [{ offset, bytes: mint }], dataSize: size })))).flat();
  const dammRaw = await find(DAMM_V2_PROGRAM, DAMM_V2_POOL_SIZE, [DAMM_V2_POOL_OFFSETS.tokenAMint, DAMM_V2_POOL_OFFSETS.tokenBMint]);
  const cpmmRaw = await find(CPMM_PROGRAM, CPMM_POOL_SIZE, [CPMM_POOL_OFFSETS.mintA, CPMM_POOL_OFFSETS.mintB]);

  const candidates: PoolCandidate[] = [];
  for (const a of dammRaw) {
    const p = decodeDammV2Pool(a.data);
    const isA = p.tokenAMint === mint;
    candidates.push({
      dex: 'meteora-damm-v2', address: a.address, pool: p,
      vault: isA ? p.tokenAVault : p.tokenBVault,
      pairVault: isA ? p.tokenBVault : p.tokenAVault,
      pairMint: isA ? p.tokenBMint : p.tokenAMint,
      activation: { kind: p.activationType === 0 ? 'slot' : 'timestamp', value: p.activationPoint },
    });
  }
  for (const a of cpmmRaw) {
    let p: CpmmPool;
    try { p = decodeCpmmPool(a.data); } catch { continue; } // 같은 크기의 다른 계정
    const isA = p.mintA === mint;
    candidates.push({
      dex: 'raydium-cpmm', address: a.address, pool: p,
      vault: isA ? p.vaultA : p.vaultB,
      pairVault: isA ? p.vaultB : p.vaultA,
      pairMint: isA ? p.mintB : p.mintA,
      activation: { kind: 'timestamp', value: p.openTime },
    });
  }

  const vaults = await tokenBalances(reader, candidates.map((c) => c.vault));
  const amountOf = (c: PoolCandidate) => vaults.balances.get(c.vault)?.amount ?? 0n;
  candidates.sort((x, y) => (amountOf(y) > amountOf(x) ? 1 : amountOf(y) < amountOf(x) ? -1 : 0));
  return { candidates, amountOf, slot: vaults.slot };
}
