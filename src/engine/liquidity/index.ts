import { PublicKey } from '@solana/web3.js';
import type { ChainReader } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, DISCLAIMER_KO, MintNotFoundError } from '../summary.js';
import { percentOf } from '../holders/index.js';
import {
  DAMM_V2_POSITION_POOL_OFFSET,
  DAMM_V2_POSITION_SIZE,
  DAMM_V2_PROGRAM,
  decodeDammV2Position,
  type DammV2Position,
} from './meteora-damm-v2.js';
import { RAYDIUM_LP_LOCK_AUTHORITY } from './raydium-cpmm.js';
import { findSupportedPools, tokenBalances, type Dex } from './pools.js';

export type { Dex, PoolCandidate } from './pools.js';
export { findSupportedPools } from './pools.js';

export interface PoolLiquidity {
  dex: Dex;
  pool: string;
  /** 짝을 이루는 다른 토큰 */
  pairMint: string;
  /** 이 토큰이 들어 있는 풀 금고와 잔액 */
  tokenVault: string;
  tokenAmount: string;
  tokenPercentOfSupply: number;
  /** 풀 상태 원값 (DAMM v2 pool_status, CPMM status 비트) */
  poolStatus: number;
  /** 풀 유동성 중 지금 출금할 수 없는 비율 (%). 확인하지 못하면 null */
  lockedPercent: number | null;
  /** 이 풀에 든 토큰 중 잠긴 유동성 몫이 공급량에서 차지하는 비율 (%) = tokenPercentOfSupply × lockedPercent. 확인 불가면 null */
  lockedTokenPercentOfSupply: number | null;
  /** 잠김 방식별 비율 (%). 확인하지 못한 값은 null */
  breakdown: Record<string, number | null>;
  lockTypes: string[];
  /** 계산 방법 */
  method: string;
  positions?: {
    position: string;
    nftMint: string;
    /** 포지션 NFT 를 가진 주소 (=출금 가능분을 뺄 수 있는 주소). 조회 못하면 null */
    nftHolder: string | null;
    sharePercent: number;
    unlockedPercent: number;
    vestingPercent: number;
    permanentPercent: number;
  }[];
  positionsTotal?: number;
  lp?: {
    lpMint: string;
    lpRecorded: string;
    lpMintSupply: string;
    lpNotInCirculation: string;
    /** LP 보유 계정 조회에 실패하면 null (확인 불가) */
    lpInRaydiumLock: string | null;
  };
}

export interface LiquidityReport {
  mint: string;
  checkedAt: string;
  slot: number;
  /** 지원 DEX 풀 전체에 들어 있는 이 토큰의 공급 대비 % */
  supportedPoolsTokenPercentOfSupply: number;
  /** 자세히 조사한 풀들의 lockedTokenPercentOfSupply 합계 */
  lockedTokenPercentOfSupply: number;
  pools: PoolLiquidity[];
  poolsFound: Record<Dex, number>;
  evidence: { account: string; role: string }[];
  notes: string[];
}

const MAX_DETAILED_POOLS = 5;
/**
 * Raydium CPMM: 풀 생성 때 lp_supply 에는 기록되지만 발행되지 않는 LP 양.
 * SDK 상수로는 확인되지 않은 관측값 — 2026-11-19 조사한 CPMM 풀 18개 중 12개에서 (lp_supply − LP 민트 공급량) 이 정확히 100.
 * 이 이하의 차이는 소각(burn)으로 표시하지 않음.
 */
export const CPMM_UNMINTED_LP_OBSERVED = 100n;
const MAX_POSITIONS_SHOWN = 5;

const pct = (part: bigint, whole: bigint) => percentOf(part, whole);

/** NFT(또는 LP) 민트의 상위 보유 계정 소유자와 잔액 */
async function topHolders(reader: ChainReader, mint: string) {
  const m = (await reader.fetch([mint])).accounts[0];
  if (!m) return [];
  const { addresses } = await reader.largestTokenAccounts(mint, m.owner);
  const { balances } = await tokenBalances(reader, addresses);
  return addresses.map((a) => ({ account: a, ...balances.get(a)! })).filter((x) => x.owner);
}

export async function checkLiquidity(
  mintAddress: string,
  reader: ChainReader,
  now: () => Date = () => new Date(),
  opts: { maxPositionsShown?: number } = {},
): Promise<LiquidityReport> {
  const maxPositionsShown = opts.maxPositionsShown ?? MAX_POSITIONS_SHOWN;
  const mint = new PublicKey(mintAddress).toBase58();
  const notes: string[] = [DISCLAIMER_KO, DISCLAIMER_EN];
  const evidence: LiquidityReport['evidence'] = [{ account: mint, role: 'mint' }];

  const first = await reader.fetch([mint]);
  if (!first.accounts[0]) throw new MintNotFoundError(`account ${mint} not found`);
  const supply = decodeMint(first.accounts[0].data, new PublicKey(first.accounts[0].owner)).supply;
  let slot = first.slot;

  // 1) 풀 찾기 (이 토큰이 A 쪽이거나 B 쪽인 풀) → 2) 이 토큰 잔액이 큰 순서
  const found = await findSupportedPools(mint, reader);
  const { candidates, amountOf } = found;
  slot = Math.max(slot, found.slot);

  // 풀마다 독립적이므로 동시에 조회 (RPC 일괄 요청과 함께 쓰면 HTTP 수가 줄어듦). 결과 순서는 유지
  const pools: PoolLiquidity[] = await Promise.all(candidates.slice(0, MAX_DETAILED_POOLS).map(async (c): Promise<PoolLiquidity> => {
    const base = {
      pool: c.address,
      pairMint: c.pairMint,
      tokenVault: c.vault,
      tokenAmount: amountOf(c).toString(),
      tokenPercentOfSupply: percentOf(amountOf(c), supply),
    };
    evidence.push({ account: c.address, role: `${c.dex}-pool` });

    if (c.dex === 'meteora-damm-v2') {
      const posRaw = await reader.programAccounts(DAMM_V2_PROGRAM, {
        memcmp: [{ offset: DAMM_V2_POSITION_POOL_OFFSET, bytes: c.address }],
        dataSize: DAMM_V2_POSITION_SIZE,
      });
      const positions = posRaw.map((p) => ({ address: p.address, ...decodeDammV2Position(p.data) }));
      const total = (p: DammV2Position) => p.unlockedLiquidity + p.vestedLiquidity + p.permanentLockedLiquidity;
      const sum = (f: (p: DammV2Position) => bigint) => positions.reduce((s, p) => s + f(p), 0n);
      const L = c.pool.liquidity;
      const perm = c.pool.permanentLockLiquidity;
      const vesting = sum((p) => p.vestedLiquidity);
      const unlocked = sum((p) => p.unlockedLiquidity);
      if (L === 0n) notes.push(`${c.address}: 풀 유동성이 0 입니다 (비율은 0 으로 표시)`);
      if (sum(total) !== L) {
        notes.push(`${c.address}: 포지션 유동성 합계(${sum(total)})가 풀 liquidity(${L})와 다릅니다`);
      }
      if (sum((p) => p.permanentLockedLiquidity) !== perm) {
        notes.push(`${c.address}: 포지션 영구 잠금 합계가 풀 permanent_lock_liquidity 와 다릅니다`);
      }
      positions.sort((x, y) => (total(y) > total(x) ? 1 : total(y) < total(x) ? -1 : 0));
      if (positions.length > maxPositionsShown) {
        notes.push(`${c.address}: 포지션 ${positions.length}개 중 유동성이 큰 ${maxPositionsShown}개만 NFT 보유자를 조회했습니다 (비율 합계는 전체 포지션 기준)`);
      }
      const shown = await Promise.all(positions.slice(0, maxPositionsShown).map(async (p) => {
        let nftHolder: string | null = null;
        try {
          const h = await topHolders(reader, p.nftMint);
          nftHolder = h.find((x) => x.amount > 0n)?.owner ?? null;
        } catch { /* 조회 실패 → null */ }
        return {
          position: p.address,
          nftMint: p.nftMint,
          nftHolder,
          sharePercent: pct(total(p), L),
          unlockedPercent: pct(p.unlockedLiquidity, L),
          vestingPercent: pct(p.vestedLiquidity, L),
          permanentPercent: pct(p.permanentLockedLiquidity, L),
        };
      }));
      const lockTypes = [perm > 0n ? 'permanent' : '', vesting > 0n ? 'vesting' : ''].filter(Boolean);
      return {
        dex: 'meteora-damm-v2',
        ...base,
        poolStatus: c.pool.poolStatus,
        lockedPercent: pct(perm + vesting, L),
        lockedTokenPercentOfSupply: L === 0n ? 0 : percentOf((amountOf(c) * (perm + vesting)) / L, supply),
        breakdown: { permanent: pct(perm, L), vesting: pct(vesting, L), unlocked: pct(unlocked, L) },
        lockTypes,
        method: '풀 liquidity 대비 permanent_lock_liquidity(영구 잠금)와 포지션 vested_liquidity 합계(베스팅 중) 비율. unlocked 는 포지션 NFT 보유자가 출금 가능한 몫',
        positions: shown,
        positionsTotal: positions.length,
      };
    } else {
      const lpMint = c.pool.mintLp;
      const lpAcc = (await reader.fetch([lpMint])).accounts[0];
      const lpSupply = lpAcc ? decodeMint(lpAcc.data, new PublicKey(lpAcc.owner)).supply : 0n;
      const recorded = c.pool.lpAmount;
      const notInCirculation = recorded > lpSupply ? recorded - lpSupply : 0n;
      if (lpSupply > recorded) notes.push(`${c.address}: LP 민트 공급량이 풀 기록 LP 보다 큽니다 (확인 불가)`);
      let inLock: bigint | null = null;
      if (lpSupply > 0n) {
        try {
          const holders = await topHolders(reader, lpMint);
          inLock = holders.filter((h) => h.owner === RAYDIUM_LP_LOCK_AUTHORITY).reduce((s, h) => s + h.amount, 0n);
        } catch {
          notes.push(`${c.address}: LP 보유 계정을 조회하지 못해 Raydium LP 잠금분과 잠김 비율을 확인하지 못했습니다 (확인 불가, null 로 표시)`);
        }
      } else {
        inLock = 0n; // 유통 LP 가 없으면 잠금 프로그램이 가진 LP 도 0
      }
      const lockTypes = [notInCirculation > CPMM_UNMINTED_LP_OBSERVED ? 'burn' : '', inLock && inLock > 0n ? 'raydium-lp-lock' : ''].filter(Boolean);
      const lockedLp = inLock === null ? null : notInCirculation + inLock;
      return {
        dex: 'raydium-cpmm',
        ...base,
        poolStatus: c.pool.status,
        lockedPercent: lockedLp === null ? null : pct(lockedLp, recorded),
        lockedTokenPercentOfSupply:
          lockedLp === null ? null : recorded === 0n ? 0 : percentOf((amountOf(c) * lockedLp) / recorded, supply),
        breakdown: {
          lpNotInCirculation: pct(notInCirculation, recorded),
          raydiumLpLock: inLock === null ? null : pct(inLock, recorded),
          lpCirculating: inLock === null ? null : pct(lpSupply - inLock, recorded),
        },
        lockTypes,
        method:
          '풀이 기록한 LP 총량(lp_supply) 대비 (1) LP 민트 공급량에 없는 양 — 소각되었거나 풀 생성 때 발행되지 않은 몫 — 과 (2) Raydium LP 잠금 프로그램 권한자(3f7GcQ…)가 가진 LP 비율. lpCirculating 은 그 밖의 주소가 가진 LP',
        lp: {
          lpMint,
          lpRecorded: recorded.toString(),
          lpMintSupply: lpSupply.toString(),
          lpNotInCirculation: notInCirculation.toString(),
          lpInRaydiumLock: inLock === null ? null : inLock.toString(),
        },
      };
    }
  }));

  const poolsFound: Record<Dex, number> = {
    'meteora-damm-v2': candidates.filter((c) => c.dex === 'meteora-damm-v2').length,
    'raydium-cpmm': candidates.filter((c) => c.dex === 'raydium-cpmm').length,
  };
  if (candidates.length > MAX_DETAILED_POOLS) {
    notes.push(`풀 ${candidates.length}개 중 이 토큰 잔액이 큰 ${MAX_DETAILED_POOLS}개만 자세히 조사했습니다`);
  }
  if (pools.some((p) => p.dex === 'raydium-cpmm')) {
    notes.push(
      `Raydium CPMM: lpNotInCirculation 이 ${CPMM_UNMINTED_LP_OBSERVED} 단위 이하이면 소각(burn)으로 보지 않습니다. 풀 생성 때 기록만 되고 발행되지 않는 소량으로, 관측된 CPMM 풀 다수에서 정확히 이 값이 나타났습니다 (관측값)`,
    );
  }
  notes.push('lockedTokenPercentOfSupply 는 풀에 든 이 토큰 수량에 잠긴 유동성 비율을 곱한 값입니다 (DAMM v2 포지션은 같은 가격 범위를 공유하고, CPMM LP 는 지분에 비례하므로 유동성 비율 = 토큰 몫 비율)');
  notes.push('지원 DEX: Meteora DAMM v2, Raydium CPMM. 다른 DEX(Raydium AMM v4·CLMM, Orca, Meteora DLMM, pump.fun 등)의 풀은 이 항목에 포함되지 않습니다 (확인 불가)');

  const allPoolTokens = candidates.reduce((s, c) => s + amountOf(c), 0n);
  if (pools.some((p) => p.lockedTokenPercentOfSupply === null)) {
    notes.push('잠김 비율을 확인하지 못한 풀(null)은 lockedTokenPercentOfSupply 합계에 넣지 않았습니다');
  }
  const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
  return {
    mint,
    checkedAt: now().toISOString(),
    slot,
    supportedPoolsTokenPercentOfSupply: percentOf(allPoolTokens, supply),
    lockedTokenPercentOfSupply: round6(pools.reduce((s, p) => s + (p.lockedTokenPercentOfSupply ?? 0), 0)),
    pools,
    poolsFound,
    evidence,
    notes,
  };
}
