import { PublicKey } from '@solana/web3.js';
import type { ChainReader } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, MintNotFoundError } from '../summary.js';
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
  /** The other token in the pair */
  pairMint: string;
  /** Pool vault holding this token, and its balance */
  tokenVault: string;
  tokenAmount: string;
  tokenPercentOfSupply: number;
  /** Raw pool status (DAMM v2 pool_status, CPMM status bits) */
  poolStatus: number;
  /** Share of pool liquidity that cannot be withdrawn now (%). null if not checked */
  lockedPercent: number | null;
  /** Share of supply that is locked liquidity's portion of this token in the pool (%) = tokenPercentOfSupply × lockedPercent. null if unavailable */
  lockedTokenPercentOfSupply: number | null;
  /** Share by lock type (%). Values not checked are null */
  breakdown: Record<string, number | null>;
  lockTypes: string[];
  /** How it was calculated */
  method: string;
  positions?: {
    position: string;
    nftMint: string;
    /** Address holding the position NFT (= the address that can withdraw the withdrawable part). null if not checked */
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
    /** null if LP holder accounts could not be read (unavailable) */
    lpInRaydiumLock: string | null;
  };
}

export interface LiquidityReport {
  mint: string;
  checkedAt: string;
  slot: number;
  /** This token in all supported DEX pools, as % of supply */
  supportedPoolsTokenPercentOfSupply: number;
  /** Sum of lockedTokenPercentOfSupply for the pools examined in detail */
  lockedTokenPercentOfSupply: number;
  pools: PoolLiquidity[];
  poolsFound: Record<Dex, number>;
  evidence: { account: string; role: string }[];
  notes: string[];
}

const MAX_DETAILED_POOLS = 5;
/**
  * Raydium CPMM: LP amount recorded in lp_supply at pool creation but never minted.
  * Observed value, not confirmed by an SDK constant: in 12 of 18 CPMM pools examined on 2026-11-19, (lp_supply − LP mint supply) was exactly 100.
  * Differences at or below this are not shown as burned.
 */
export const CPMM_UNMINTED_LP_OBSERVED = 100n;
const MAX_POSITIONS_SHOWN = 5;

const pct = (part: bigint, whole: bigint) => percentOf(part, whole);

/** Owners and balances of the largest holder accounts of an NFT (or LP) mint */
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
  const notes: string[] = [DISCLAIMER_EN];
  const evidence: LiquidityReport['evidence'] = [{ account: mint, role: 'mint' }];

  const first = await reader.fetch([mint]);
  if (!first.accounts[0]) throw new MintNotFoundError(`account ${mint} not found`);
  const supply = decodeMint(first.accounts[0].data, new PublicKey(first.accounts[0].owner)).supply;
  let slot = first.slot;

  // 1) Find pools (this token on side A or B) → 2) order by this token's balance, largest first
  const found = await findSupportedPools(mint, reader);
  const { candidates, amountOf } = found;
  slot = Math.max(slot, found.slot);

  // Pools are independent, so query them concurrently (fewer HTTP requests with RPC batching). Result order is kept
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
      if (L === 0n) notes.push(`${c.address}: pool liquidity is 0 (shares shown as 0)`);
      if (sum(total) !== L) {
        notes.push(`${c.address}: total position liquidity (${sum(total)}) differs from pool liquidity (${L})`);
      }
      if (sum((p) => p.permanentLockedLiquidity) !== perm) {
        notes.push(`${c.address}: total permanently locked position liquidity differs from pool permanent_lock_liquidity`);
      }
      positions.sort((x, y) => (total(y) > total(x) ? 1 : total(y) < total(x) ? -1 : 0));
      if (positions.length > maxPositionsShown) {
        notes.push(`${c.address}: NFT holders were looked up only for the ${maxPositionsShown} largest of ${positions.length} positions (share totals cover all positions)`);
      }
      const shown = await Promise.all(positions.slice(0, maxPositionsShown).map(async (p) => {
        let nftHolder: string | null = null;
        try {
          const h = await topHolders(reader, p.nftMint);
          nftHolder = h.find((x) => x.amount > 0n)?.owner ?? null;
        } catch { /* lookup failed → null */ }
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
        method: 'Share of pool liquidity that is permanent_lock_liquidity (permanently locked) and the sum of position vested_liquidity (vesting). unlocked is the part the position NFT holder can withdraw',
        positions: shown,
        positionsTotal: positions.length,
      };
    } else {
      const lpMint = c.pool.mintLp;
      const lpAcc = (await reader.fetch([lpMint])).accounts[0];
      const lpSupply = lpAcc ? decodeMint(lpAcc.data, new PublicKey(lpAcc.owner)).supply : 0n;
      const recorded = c.pool.lpAmount;
      const notInCirculation = recorded > lpSupply ? recorded - lpSupply : 0n;
      if (lpSupply > recorded) notes.push(`${c.address}: LP mint supply is larger than the LP recorded by the pool (unavailable)`);
      let inLock: bigint | null = null;
      if (lpSupply > 0n) {
        try {
          const holders = await topHolders(reader, lpMint);
          inLock = holders.filter((h) => h.owner === RAYDIUM_LP_LOCK_AUTHORITY).reduce((s, h) => s + h.amount, 0n);
        } catch {
          notes.push(`${c.address}: could not read LP holder accounts, so the Raydium LP lock amount and locked share were not checked (unavailable, shown as null)`);
        }
      } else {
        inLock = 0n; // with no circulating LP, the lock program also holds 0 LP
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
          'Against the total LP recorded by the pool (lp_supply): (1) the amount not in LP mint supply (burned, or never minted at pool creation) and (2) the share held by the Raydium LP lock program authority (3f7GcQ…). lpCirculating is LP held by other addresses',
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
    notes.push(`Only the ${MAX_DETAILED_POOLS} of ${candidates.length} pools with the largest balance of this token were examined in detail`);
  }
  if (pools.some((p) => p.dex === 'raydium-cpmm')) {
    notes.push(
      `Raydium CPMM: lpNotInCirculation of ${CPMM_UNMINTED_LP_OBSERVED} units or less is not treated as burned. It is a small amount recorded but never minted at pool creation, and exactly this value appeared in many observed CPMM pools (observed value)`,
    );
  }
  notes.push('lockedTokenPercentOfSupply is the amount of this token in the pool multiplied by the locked liquidity share (DAMM v2 positions share the same price range and CPMM LP is proportional to share, so the liquidity share equals the token share)');
  notes.push('Supported DEXes: Meteora DAMM v2, Raydium CPMM. Pools on other DEXes (Raydium AMM v4 and CLMM, Orca, Meteora DLMM, pump.fun, etc.) are not included in this section (unavailable)');

  const allPoolTokens = candidates.reduce((s, c) => s + amountOf(c), 0n);
  if (pools.some((p) => p.lockedTokenPercentOfSupply === null)) {
    notes.push('Pools whose locked share could not be checked (null) are not included in the lockedTokenPercentOfSupply total');
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
