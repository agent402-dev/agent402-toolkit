import { PublicKey } from '@solana/web3.js';

/**
 * 보유 계정 분류에 쓰는 알려진 프로그램·권한 주소.
 * 모든 값은 공식 SDK 소스에서 확인한 것이고(주석에 출처), PDA 는 시드로 직접 계산합니다.
 * 여기 없는 프로그램은 이름 없이 프로그램 주소만 보여 줍니다.
 */

// @meteora-ag/cp-amm-sdk : CP_AMM_PROGRAM_ID, derivePoolAuthority() = PDA(["pool_authority"])
export const METEORA_DAMM_V2_PROGRAM = new PublicKey('cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG');
// @raydium-io/raydium-sdk-v2 common/programId.ts, cpmm/pda.ts getPdaPoolAuthority = PDA(["vault_and_lp_mint_auth_seed"])
export const RAYDIUM_CPMM_PROGRAM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
export const RAYDIUM_AMM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
// raydium-sdk-v2 liquidity/constant.ts (AMM v4 권한, nonce 기반이라 상수로 둠)
export const RAYDIUM_AMM_V4_AUTHORITY = new PublicKey('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1');
// raydium-sdk-v2 common/programId.ts CLMM_PROGRAM_ID — 금고 권한자는 풀 상태 계정(이 프로그램 소유)
export const RAYDIUM_CLMM_PROGRAM = new PublicKey('CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK');
// @streamflow/stream PROGRAM_ID mainnet, ESCROW_SEED "strm", 계약 레이아웃 offset
export const STREAMFLOW_PROGRAM = new PublicKey('strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m');
export const STREAMFLOW_MINT_OFFSET = 177;
export const STREAMFLOW_ESCROW_OFFSET = 209;

const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey) => PublicKey.findProgramAddressSync(seeds, program)[0];

export const METEORA_DAMM_V2_POOL_AUTHORITY = pda([Buffer.from('pool_authority')], METEORA_DAMM_V2_PROGRAM);
export const RAYDIUM_CPMM_AUTHORITY = pda([Buffer.from('vault_and_lp_mint_auth_seed')], RAYDIUM_CPMM_PROGRAM);

export function streamflowEscrow(contract: PublicKey): PublicKey {
  return pda([Buffer.from('strm'), contract.toBuffer()], STREAMFLOW_PROGRAM);
}

/** 권한자 주소 자체가 알려진 풀 권한 PDA 인 경우 */
export const POOL_AUTHORITIES: Record<string, { label: string; program: string }> = {
  [METEORA_DAMM_V2_POOL_AUTHORITY.toBase58()]: { label: 'meteora-damm-v2', program: METEORA_DAMM_V2_PROGRAM.toBase58() },
  [RAYDIUM_CPMM_AUTHORITY.toBase58()]: { label: 'raydium-cpmm', program: RAYDIUM_CPMM_PROGRAM.toBase58() },
  [RAYDIUM_AMM_V4_AUTHORITY.toBase58()]: { label: 'raydium-amm-v4', program: RAYDIUM_AMM_V4_PROGRAM.toBase58() },
};

/** 권한자가 이 프로그램 소유의 데이터 계정(풀 상태)인 경우 */
export const POOL_STATE_PROGRAMS: Record<string, string> = {
  [RAYDIUM_CLMM_PROGRAM.toBase58()]: 'raydium-clmm',
};
