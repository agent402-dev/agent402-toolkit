// Payment token (PREQ) rate. The method is documented for the public in docs/pricing.md.
//  - Hourly sample (one RPC call): token/SOL = mainnet Meteora DAMM v2 pool sqrt_price,
//    SOL-side depth = pool SOL vault balance, SOL/USD = Pyth push oracle account (Solana mainnet, USDC treated as ≈ 1 USD)
//  - Fixed per day: median of the previous day's (UTC) samples. If any guard (sample count, liquidity, range) trips, token payments are off that day (USDC only)
//  - Pool and mint addresses are read from preq.ts only. The A402 (v1) pool is deprecated: only when passed explicitly (prints a warning)
import { PublicKey } from '@solana/web3.js';
import type { AccountFetcher } from './chain.js';
import { A402_DEPRECATION_WARNING, PREQ_DECIMALS, PREQ_MAINNET_MINT, PREQ_MAINNET_POOL, requirePreqValue } from './preq.js';

/** Only the parts of a Meteora DAMM v2 pool account needed for the rate (offsets: cp-amm IDL, bytemuck; same values as the check engine's decoder) */
const DAMM_V2_POOL_SIZE = 1112;
const DAMM_V2_POOL_DISC = [241, 154, 109, 4, 17, 177, 109, 188];
export function decodeDammV2PoolForRate(data: Uint8Array) {
  const b = Buffer.from(data);
  if (b.length !== DAMM_V2_POOL_SIZE || !DAMM_V2_POOL_DISC.every((x, i) => b[i] === x)) throw new Error('not a DAMM v2 pool account');
  const key = (o: number) => new PublicKey(b.subarray(o, o + 32)).toBase58();
  return {
    tokenAMint: key(168), tokenBMint: key(200), tokenAVault: key(232), tokenBVault: key(264),
    /** sqrt_price (Q64.64, u128 LE) */
    sqrtPrice: (b.readBigUInt64LE(464) << 64n) | b.readBigUInt64LE(456),
  };
}

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** Meteora DAMM v2 (cp-amm) program */
export const DAMM_V2_PROGRAM = 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG';
/** Pool vault address = PDA(["token_vault", mint, pool], cp-amm); same rule as Meteora SDK deriveTokenVaultAddress */
export function dammV2VaultAddress(mint: string, pool: string): string {
  return PublicKey.findProgramAddressSync([Buffer.from('token_vault'), new PublicKey(mint).toBuffer(), new PublicKey(pool).toBuffer()], new PublicKey(DAMM_V2_PROGRAM))[0].toBase58();
}

/** Token to price and its token/WSOL pool */
export interface PoolTarget {
  symbol: 'PREQ' | 'A402';
  mint: string;
  pool: string;
  decimals: number;
}
/** Default target: PREQ (constants in preq.ts). samplePrice errors if they are empty */
export const PREQ_POOL_TARGET: PoolTarget = { symbol: 'PREQ', mint: PREQ_MAINNET_MINT, pool: PREQ_MAINNET_POOL, decimals: PREQ_DECIMALS };

/** @deprecated A402 (v1) is deprecated. Kept for records only; prints a warning if used */
export const A402_MAINNET_MINT = 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X';
/** @deprecated A402 (v1) is deprecated */
export const A402_MAINNET_POOL = 'DaHBw8dxnZaCaX5HdsiM1Hs1uQNwsW3QW3wcD6P4Z5oZ';
/** @deprecated A402 (v1) is deprecated. Used only when passed explicitly to samplePrice (prints a warning) */
export const A402_POOL_TARGET: PoolTarget = { symbol: 'A402', mint: A402_MAINNET_MINT, pool: A402_MAINNET_POOL, decimals: 6 };

/** Pyth Crypto.SOL/USD feed ID (checked against the hermes.pyth.network /v2/price_feeds list) */
export const PYTH_SOL_USD_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth push oracle program and receiver (account owner) */
export const PYTH_PUSH_ORACLE = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';
export const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
/** SOL/USD price account for shard 0 = PDA([u16 shard=0, feed_id], push oracle); computed and checked by the function below */
export function pythPriceAccount(feedHex = PYTH_SOL_USD_FEED, shard = 0): string {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([s, Buffer.from(feedHex, 'hex')], new PublicKey(PYTH_PUSH_ORACLE))[0].toBase58();
}

export const PRICE_USDC_BASE_UNITS = 20_000n; // 0.02 USDC (6 decimals)
export const TOKEN_DISCOUNT_BPS = 0; // no discount by default

/** Guard thresholds (proposed values, 2026-11-19) */
export interface RateGuards {
  /** Minimum samples in the previous day (out of 24 hours) */
  minSamples: number;
  /** Minimum SOL-side pool depth (USD) across all of the previous day's samples */
  minPoolSolSideUsd: number;
  /** Maximum ratio of the previous day's highest to lowest price */
  maxDailyRangeRatio: number;
  /** Maximum Pyth confidence / price ratio (samples above it are discarded) */
  maxOracleConfRatio: number;
  /** How many seconds before the sample time the Pyth update may be */
  maxOracleAgeSec: number;
}
export const DEFAULT_GUARDS: RateGuards = {
  minSamples: 12,
  minPoolSolSideUsd: 100,
  maxDailyRangeRatio: 1.5,
  maxOracleConfRatio: 0.01,
  maxOracleAgeSec: 120,
};

export interface PriceSample {
  /** ISO time */
  at: string;
  /** Which token the sample is for (missing for old A402 samples) */
  symbol?: 'PREQ' | 'A402';
  /** SOL per token */
  tokenSol: number;
  /** USD per SOL (Pyth) */
  solUsd: number;
  solUsdConf: number;
  /** USD per token */
  tokenUsd: number;
  /** Pool SOL vault balance × SOL/USD */
  poolSolSideUsd: number;
  slot: number;
  pythPublishTime: number;
}

export type DailyRate =
  | { status: 'on'; date: string; basedOn: string; /** USD per token */ tokenUsd: number; samples: number; method: string }
  | { status: 'off'; date: string; basedOn: string; reason: string; samples: number };

/**
  * DAMM v2 sqrt_price (Q64.64) → price of B per A.
 * price = (sqrt_price / 2^64)^2 × 10^(decimalsA − decimalsB)
 */
export function dammV2Price(sqrtPrice: bigint, decimalsA: number, decimalsB: number): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (decimalsA - decimalsB);
}

/** Decodes a Pyth PriceUpdateV2 account (one more byte if verification_level is Partial) */
export function decodePythPriceUpdate(data: Buffer) {
  const tag = data[40];
  let o = 41 + (tag === 0 ? 1 : 0);
  const feedId = data.subarray(o, o + 32).toString('hex');
  o += 32;
  const price = data.readBigInt64LE(o);
  const conf = data.readBigUInt64LE(o + 8);
  const expo = data.readInt32LE(o + 16);
  const publishTime = Number(data.readBigInt64LE(o + 20));
  return { verification: tag === 1 ? 'full' : 'partial', feedId, price: Number(price) * 10 ** expo, conf: Number(conf) * 10 ** expo, publishTime };
}

/**
  * "SOL per token" from the pool's sqrt_price. Handles the token on side A or B.
  * Throws on 0, infinity or NaN (including when a single-sided pool's price sits at the range edge right after trading starts)
 */
export function tokenSolFromPool(sqrtPrice: bigint, tokenIsA: boolean, tokenDecimals: number): number {
  const v = tokenIsA ? dammV2Price(sqrtPrice, tokenDecimals, 9) : 1 / dammV2Price(sqrtPrice, 9, tokenDecimals);
  if (!Number.isFinite(v) || !(v > 0)) throw new Error('non-positive or non-finite pool price');
  return v;
}

/** Reads the pool, SOL vault and Pyth accounts in one RPC call and records one sample. Default target is PREQ (preq.ts). Throws if oracle quality is out of bounds */
export async function samplePrice(fetcher: AccountFetcher, now: () => Date = () => new Date(), guards = DEFAULT_GUARDS, target: PoolTarget = PREQ_POOL_TARGET): Promise<PriceSample> {
  if (target.symbol === 'A402') console.warn(A402_DEPRECATION_WARNING);
  const mint = target.symbol === 'PREQ' ? requirePreqValue('PREQ_MAINNET_MINT', target.mint) : target.mint;
  const poolAddr = target.symbol === 'PREQ' ? requirePreqValue('PREQ_MAINNET_POOL', target.pool) : target.pool;
  if (!mint || !poolAddr) throw new Error(`${target.symbol} mint/pool not set`);
  const solVault = dammV2VaultAddress(WSOL_MINT, poolAddr);
  const pythAcc = pythPriceAccount();
  const { slot, accounts } = await fetcher([poolAddr, solVault, pythAcc]);
  const [poolAcc, vaultAcc, pyth] = accounts;
  if (!poolAcc || !vaultAcc || !pyth) throw new Error('price accounts missing');

  const pool = decodeDammV2PoolForRate(poolAcc.data);
  const tokenIsA = pool.tokenAMint === mint && pool.tokenBMint === WSOL_MINT && pool.tokenBVault === solVault;
  const tokenIsB = pool.tokenBMint === mint && pool.tokenAMint === WSOL_MINT && pool.tokenAVault === solVault;
  if (!tokenIsA && !tokenIsB) throw new Error('unexpected pool layout');
  const tokenSol = tokenSolFromPool(pool.sqrtPrice, tokenIsA, target.decimals);
  const vaultData = Buffer.from(vaultAcc.data);
  if (vaultData.length < 72) throw new Error('unexpected SOL vault account');
  // A single-sided pool may have 0 on the SOL side right after trading starts → record depth 0 (fixRate's depth guard turns off payments that day)
  const solInVault = Number(vaultData.readBigUInt64LE(64)) / 1e9;

  if (pyth.owner !== PYTH_RECEIVER) throw new Error('pyth account owner mismatch');
  const p = decodePythPriceUpdate(Buffer.from(pyth.data));
  if (p.feedId !== PYTH_SOL_USD_FEED) throw new Error('pyth feed mismatch');
  if (p.verification !== 'full') throw new Error('pyth update not fully verified');
  const nowSec = Math.floor(now().getTime() / 1000);
  if (nowSec - p.publishTime > guards.maxOracleAgeSec) throw new Error('pyth price stale');
  if (!(p.price > 0) || p.conf / p.price > guards.maxOracleConfRatio) throw new Error('pyth confidence too wide');

  const tokenUsd = tokenSol * p.price;
  if (!Number.isFinite(tokenUsd) || !(tokenUsd > 0)) throw new Error('non-positive or non-finite token price');
  return {
    at: now().toISOString(), symbol: target.symbol, tokenSol, solUsd: p.price, solUsdConf: p.conf, tokenUsd,
    poolSolSideUsd: solInVault * p.price, slot, pythPublishTime: p.publishTime,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** Fixed rate for date. Computed from the previous day's samples; off if a guard trips */
export function fixRate(date: string, samples: PriceSample[], guards = DEFAULT_GUARDS): DailyRate {
  const basedOn = prevDay(date);
  const ys = samples.filter((s) => s.at.slice(0, 10) === basedOn);
  const off = (reason: string): DailyRate => ({ status: 'off', date, basedOn, reason, samples: ys.length });
  if (ys.length === 0 || ys.length < guards.minSamples) return off(`${basedOn}: ${ys.length} samples, below the minimum of ${Math.max(1, guards.minSamples)}`);
  // If any price is 0, negative, infinite or NaN, turn off that day (avoids division by zero and abnormal amounts)
  if (ys.some((s) => !Number.isFinite(s.tokenUsd) || !(s.tokenUsd > 0))) return off(`${basedOn}: invalid (zero, negative or non-finite) price sample`);
  const depths = ys.map((s) => (Number.isFinite(s.poolSolSideUsd) ? s.poolSolSideUsd : 0));
  const minDepth = Math.min(...depths);
  if (minDepth < guards.minPoolSolSideUsd) {
    return off(`${basedOn}: lowest pool SOL-side depth ${minDepth.toFixed(0)} USD, below the minimum of ${guards.minPoolSolSideUsd} USD`);
  }
  const prices = ys.map((s) => s.tokenUsd);
  const ratio = Math.max(...prices) / Math.min(...prices);
  if (!Number.isFinite(ratio) || ratio > guards.maxDailyRangeRatio) {
    return off(`${basedOn}: max/min price ratio ${ratio.toFixed(2)}, above the limit of ${guards.maxDailyRangeRatio}`);
  }
  return {
    status: 'on', date, basedOn, tokenUsd: median(prices), samples: ys.length,
    method: `median of ${ys.length} hourly samples on ${basedOn} (UTC) (lowest depth ${minDepth.toFixed(0)} USD, max/min ${ratio.toFixed(2)})`,
  };
}

const U64_MAX = (1n << 64n) - 1n;

/**
  * Token amount to pay (base units): priceUsd × (1 − discount) ÷ fixed rate, rounded up.
  * Throws if the rate is 0, negative, infinite or NaN, or if the result exceeds u64 (so that request does not offer token payment)
 */
export function tokenAmountFor(priceUsd: number, discountPercent: number, rate: Extract<DailyRate, { status: 'on' }>, decimals = 6): bigint {
  if (!Number.isFinite(rate.tokenUsd) || !(rate.tokenUsd > 0)) throw new Error('invalid token rate');
  const usd = priceUsd * (1 - discountPercent / 100);
  const units = Math.ceil((usd / rate.tokenUsd) * 10 ** decimals);
  if (!Number.isFinite(units) || units <= 0) throw new Error('token amount out of range');
  const amount = BigInt(units);
  if (amount > U64_MAX) throw new Error('token amount out of range');
  return amount;
}

/** Token amount (base units) at the default price (0.02 USD), no discount */
export function tokenAmount(rate: Extract<DailyRate, { status: 'on' }>, decimals = 6): bigint {
  return tokenAmountFor(Number(PRICE_USDC_BASE_UNITS) / 1e6, TOKEN_DISCOUNT_BPS / 100, rate, decimals);
}
