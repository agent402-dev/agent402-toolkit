// A402 결제 환율 (30% 할인). 비공개 영역(API 서버). 방식은 docs/pricing.md 에 공개용으로 정리.
//  - 매시간 기록 (RPC 한 번): A402/SOL = 메인넷 Meteora DAMM v2 풀 sqrt_price,
//    SOL 쪽 깊이 = 풀 SOL 금고 잔액, SOL/USD = Pyth 푸시 오라클 계정 (Solana 메인넷, USDC ≈ 1 USD 로 봄)
//  - 하루 고정: 전날(UTC) 기록의 중앙값. 안전장치(기록 수·유동성·변동폭) 중 하나라도 걸리면 그날 A402 결제 끔 (USDC 만)
import { PublicKey } from '@solana/web3.js';
import type { AccountFetcher } from './chain.js';

/** Meteora DAMM v2 풀 계정에서 환율에 필요한 부분만 (오프셋: cp-amm IDL, bytemuck — 점검 엔진의 해석과 같은 값) */
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

export const A402_MAINNET_MINT = 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X';
export const A402_MAINNET_POOL = 'DaHBw8dxnZaCaX5HdsiM1Hs1uQNwsW3QW3wcD6P4Z5oZ';
export const A402_POOL_SOL_VAULT = 'FXf9X8exSSZCSe7h14vK4xpcXsdbdNP7nR8myo1MBaMq';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** Pyth Crypto.SOL/USD 피드 ID (hermes.pyth.network /v2/price_feeds 목록에서 확인) */
export const PYTH_SOL_USD_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
/** Pyth 푸시 오라클 프로그램과 receiver(계정 소유자) */
export const PYTH_PUSH_ORACLE = 'pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT';
export const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
/** 샤드 0 의 SOL/USD 가격 계정 = PDA([u16 shard=0, feed_id], push oracle) — 아래 함수로 계산해 대조 */
export function pythPriceAccount(feedHex = PYTH_SOL_USD_FEED, shard = 0): string {
  const s = Buffer.alloc(2);
  s.writeUInt16LE(shard);
  return PublicKey.findProgramAddressSync([s, Buffer.from(feedHex, 'hex')], new PublicKey(PYTH_PUSH_ORACLE))[0].toBase58();
}

export const PRICE_USDC_BASE_UNITS = 20_000n; // 0.02 USDC (소수 6자리)
export const A402_DISCOUNT_BPS = 3000; // 30%

/** 안전장치 기준 (제안값, 2026-11-19) */
export interface RateGuards {
  /** 전날 기록 최소 개수 (24시간 중) */
  minSamples: number;
  /** 전날 모든 기록에서 풀 SOL 쪽 깊이(USD) 최소값 */
  minPoolSolSideUsd: number;
  /** 전날 기록의 최고가 / 최저가 최대 비율 */
  maxDailyRangeRatio: number;
  /** Pyth 신뢰구간 / 가격 최대 비율 (넘으면 그 기록을 버림) */
  maxOracleConfRatio: number;
  /** Pyth 갱신 시각이 기록 시각보다 최대 몇 초 전까지 허용 */
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
  /** ISO 시각 */
  at: string;
  /** SOL per A402 */
  a402Sol: number;
  /** USD per SOL (Pyth) */
  solUsd: number;
  solUsdConf: number;
  /** USD per A402 */
  a402Usd: number;
  /** 풀 SOL 금고 잔액 × SOL/USD */
  poolSolSideUsd: number;
  slot: number;
  pythPublishTime: number;
}

export type DailyRate =
  | { status: 'on'; date: string; basedOn: string; a402Usd: number; samples: number; method: string }
  | { status: 'off'; date: string; basedOn: string; reason: string; samples: number };

/**
 * DAMM v2 sqrt_price(Q64.64) → B per A 가격.
 * price = (sqrt_price / 2^64)^2 × 10^(decimalsA − decimalsB)
 */
export function dammV2Price(sqrtPrice: bigint, decimalsA: number, decimalsB: number): number {
  const s = Number(sqrtPrice) / 2 ** 64;
  return s * s * 10 ** (decimalsA - decimalsB);
}

/** Pyth PriceUpdateV2 계정 해석 (verification_level 이 Partial 이면 1바이트 더) */
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

/** 풀·SOL 금고·Pyth 계정을 RPC 한 번으로 읽어 기록 하나. 오라클 품질이 기준 밖이면 예외 */
export async function samplePrice(fetcher: AccountFetcher, now: () => Date = () => new Date(), guards = DEFAULT_GUARDS): Promise<PriceSample> {
  const pythAcc = pythPriceAccount();
  const { slot, accounts } = await fetcher([A402_MAINNET_POOL, A402_POOL_SOL_VAULT, pythAcc]);
  const [poolAcc, vaultAcc, pyth] = accounts;
  if (!poolAcc || !vaultAcc || !pyth) throw new Error('price accounts missing');

  const pool = decodeDammV2PoolForRate(poolAcc.data);
  if (pool.tokenAMint !== A402_MAINNET_MINT || pool.tokenBMint !== WSOL_MINT || pool.tokenBVault !== A402_POOL_SOL_VAULT) {
    throw new Error('unexpected pool layout');
  }
  const a402Sol = dammV2Price(pool.sqrtPrice, 6, 9);
  const solInVault = Number(Buffer.from(vaultAcc.data).readBigUInt64LE(64)) / 1e9;

  if (pyth.owner !== PYTH_RECEIVER) throw new Error('pyth account owner mismatch');
  const p = decodePythPriceUpdate(Buffer.from(pyth.data));
  if (p.feedId !== PYTH_SOL_USD_FEED) throw new Error('pyth feed mismatch');
  if (p.verification !== 'full') throw new Error('pyth update not fully verified');
  const nowSec = Math.floor(now().getTime() / 1000);
  if (nowSec - p.publishTime > guards.maxOracleAgeSec) throw new Error('pyth price stale');
  if (!(p.price > 0) || p.conf / p.price > guards.maxOracleConfRatio) throw new Error('pyth confidence too wide');
  if (!(a402Sol > 0)) throw new Error('non-positive pool price');

  return {
    at: now().toISOString(), a402Sol, solUsd: p.price, solUsdConf: p.conf, a402Usd: a402Sol * p.price,
    poolSolSideUsd: solInVault * p.price, slot, pythPublishTime: p.publishTime,
  };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** date 에 쓸 고정 환율. 전날 기록으로 계산하고, 안전장치에 걸리면 off */
export function fixRate(date: string, samples: PriceSample[], guards = DEFAULT_GUARDS): DailyRate {
  const basedOn = prevDay(date);
  const ys = samples.filter((s) => s.at.slice(0, 10) === basedOn);
  const off = (reason: string): DailyRate => ({ status: 'off', date, basedOn, reason, samples: ys.length });
  if (ys.length < guards.minSamples) return off(`${basedOn}: ${ys.length} samples, below the minimum of ${guards.minSamples}`);
  const minDepth = Math.min(...ys.map((s) => s.poolSolSideUsd));
  if (minDepth < guards.minPoolSolSideUsd) {
    return off(`${basedOn}: lowest pool SOL-side depth ${minDepth.toFixed(0)} USD, below the minimum of ${guards.minPoolSolSideUsd} USD`);
  }
  const prices = ys.map((s) => s.a402Usd);
  const ratio = Math.max(...prices) / Math.min(...prices);
  if (ratio > guards.maxDailyRangeRatio) {
    return off(`${basedOn}: max/min price ratio ${ratio.toFixed(2)}, above the limit of ${guards.maxDailyRangeRatio}`);
  }
  return {
    status: 'on', date, basedOn, a402Usd: median(prices), samples: ys.length,
    method: `median of ${ys.length} hourly samples on ${basedOn} (UTC) (lowest depth ${minDepth.toFixed(0)} USD, max/min ${ratio.toFixed(2)})`,
  };
}

/** A402 로 낼 금액 (원 단위). 0.02 USD × (1 − 30%) 를 고정 환율로 나누고 올림 */
export function a402Amount(rate: Extract<DailyRate, { status: 'on' }>, decimals = 6): bigint {
  const usd = (Number(PRICE_USDC_BASE_UNITS) / 1e6) * (1 - A402_DISCOUNT_BPS / 10_000);
  return BigInt(Math.ceil((usd / rate.a402Usd) * 10 ** decimals));
}
