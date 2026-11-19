import { Reader } from '../bytes.js';
import { METEORA_DAMM_V2_PROGRAM } from '../holders/registry.js';

/**
 * Meteora DAMM v2 (cp-amm) 계정 해석.
 * 오프셋은 @meteora-ag/cp-amm-sdk 1.5.1 에 들어 있는 IDL(src/idl/cp_amm.json, bytemuck) 에서 계산.
 */
export const DAMM_V2_PROGRAM = METEORA_DAMM_V2_PROGRAM.toBase58();
export const DAMM_V2_POOL_SIZE = 1112;
export const DAMM_V2_POSITION_SIZE = 408;
const POOL_DISC = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);
const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

export const DAMM_V2_POOL_OFFSETS = { tokenAMint: 168, tokenBMint: 200 } as const;
export const DAMM_V2_POSITION_POOL_OFFSET = 8;

export interface DammV2Pool {
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  liquidity: bigint;
  activationPoint: bigint;
  activationType: number;
  poolStatus: number;
  permanentLockLiquidity: bigint;
  creator: string;
}

export interface DammV2Position {
  pool: string;
  nftMint: string;
  unlockedLiquidity: bigint;
  vestedLiquidity: bigint;
  permanentLockedLiquidity: bigint;
}

export function decodeDammV2Pool(data: Buffer): DammV2Pool {
  if (data.length !== DAMM_V2_POOL_SIZE || !data.subarray(0, 8).equals(POOL_DISC)) throw new Error('not a DAMM v2 pool account');
  const r = new Reader(data, 168);
  const tokenAMint = r.pubkey().toBase58();
  const tokenBMint = r.pubkey().toBase58();
  const tokenAVault = r.pubkey().toBase58();
  const tokenBVault = r.pubkey().toBase58();
  r.offset = 360;
  const liquidity = r.u128();
  r.offset = 472;
  const activationPoint = r.u64();
  const activationType = r.u8();
  const poolStatus = r.u8();
  r.offset = 552;
  const permanentLockLiquidity = r.u128();
  r.offset = 648;
  const creator = r.pubkey().toBase58();
  return { tokenAMint, tokenBMint, tokenAVault, tokenBVault, liquidity, activationPoint, activationType, poolStatus, permanentLockLiquidity, creator };
}

export function decodeDammV2Position(data: Buffer): DammV2Position {
  if (data.length !== DAMM_V2_POSITION_SIZE || !data.subarray(0, 8).equals(POSITION_DISC)) throw new Error('not a DAMM v2 position account');
  const r = new Reader(data, 8);
  const pool = r.pubkey().toBase58();
  const nftMint = r.pubkey().toBase58();
  r.offset = 152;
  const unlockedLiquidity = r.u128();
  const vestedLiquidity = r.u128();
  const permanentLockedLiquidity = r.u128();
  return { pool, nftMint, unlockedLiquidity, vestedLiquidity, permanentLockedLiquidity };
}
