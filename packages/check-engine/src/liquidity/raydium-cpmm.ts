import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import { RAYDIUM_CPMM_PROGRAM } from '../holders/registry.js';

/**
 * Raydium CPMM (raydium-cp-swap) PoolState 해석.
 * 레이아웃: @raydium-io/raydium-sdk-v2 src/raydium/cpmm/layout.ts CpmmPoolInfoLayout (packed)
 */
export const CPMM_PROGRAM = RAYDIUM_CPMM_PROGRAM.toBase58();
const POOL_DISC = createHash('sha256').update('account:PoolState').digest().subarray(0, 8);
export const CPMM_POOL_OFFSETS = { mintA: 168, mintB: 200 } as const;

// raydium-sdk-v2 common/programId.ts: LOCK_CPMM_PROGRAM, LOCK_CPMM_AUTH (Raydium LP 잠금 "Burn & Earn")
export const RAYDIUM_LP_LOCK_PROGRAM = new PublicKey('LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE').toBase58();
export const RAYDIUM_LP_LOCK_AUTHORITY = new PublicKey('3f7GcQFG397GAaEnv51zR6tsTVihYRydnydDD1cXekxH').toBase58();

export interface CpmmPool {
  configId: string;
  poolCreator: string;
  vaultA: string;
  vaultB: string;
  mintLp: string;
  mintA: string;
  mintB: string;
  status: number;
  lpDecimals: number;
  /** 풀이 기록한 LP 총량 (예치·인출 때만 바뀜) */
  lpAmount: bigint;
  openTime: bigint;
}

/** PoolState 계정 크기 (SDK CpmmPoolInfoLayout.span 과 대조) */
export const CPMM_POOL_SIZE = 637;

export function decodeCpmmPool(data: Buffer): CpmmPool {
  if (!data.subarray(0, 8).equals(POOL_DISC)) throw new Error('not a Raydium CPMM PoolState account');
  const r = new Reader(data, 8);
  const configId = r.pubkey().toBase58();
  const poolCreator = r.pubkey().toBase58();
  const vaultA = r.pubkey().toBase58();
  const vaultB = r.pubkey().toBase58();
  const mintLp = r.pubkey().toBase58();
  const mintA = r.pubkey().toBase58();
  const mintB = r.pubkey().toBase58();
  r.offset = 328; // mintProgramA, mintProgramB, observationId 건너뜀
  r.u8(); // bump
  const status = r.u8();
  const lpDecimals = r.u8();
  r.u8(); // mintDecimalA
  r.u8(); // mintDecimalB
  const lpAmount = r.u64();
  r.u64(); r.u64(); r.u64(); r.u64(); // protocol/fund fees
  const openTime = r.u64();
  return { configId, poolCreator, vaultA, vaultB, mintLp, mintA, mintB, status, lpDecimals, lpAmount, openTime };
}
