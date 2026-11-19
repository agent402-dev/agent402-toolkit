import type { AccountFetcher } from './summary.js';

export interface ProgramAccountsQuery {
  /** offset 위치의 바이트가 bytes(base58) 와 같은 계정 */
  memcmp: { offset: number; bytes: string }[];
  dataSize?: number;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: boolean;
}

export interface TokenBalanceEntry {
  accountIndex: number;
  mint: string;
  owner: string | null;
  /** 원 단위 정수 문자열 */
  amount: string;
}

/** 트랜잭션에서 점검에 필요한 부분만 정규화한 기록 */
export interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: boolean;
  /** 정적 키 + 주소 조회 테이블로 불러온 쓰기·읽기 키 순서 (토큰 잔액의 accountIndex 기준) */
  accountKeys: string[];
  preTokenBalances: TokenBalanceEntry[];
  postTokenBalances: TokenBalanceEntry[];
}

/** 거래 기록 읽기 (항목 8). */
export interface HistoryReader {
  /** 최신 → 과거 순서. before 가 있으면 그 서명보다 과거부터 */
  signaturesForAddress(address: string, opts: { before?: string; limit: number }): Promise<SignatureInfo[]>;
  /** 요청 순서대로. 찾지 못하거나 해석할 수 없으면 null */
  transactions(signatures: string[]): Promise<(TxRecord | null)[]>;
  /** [startSlot, endSlot] 안의 확정된 블록 슬롯 (건너뛴 슬롯 제외, 오름차순) */
  blocks(startSlot: number, endSlot: number): Promise<number[]>;
  /** 블록 시각 (유닉스 초). 없으면 null */
  blockTime(slot: number): Promise<number | null>;
}

/** 점검 엔진이 체인을 읽는 유일한 통로. 테스트에서는 픽스처로 바꿔 끼웁니다. */
export interface ChainReader {
  fetch: AccountFetcher;
  /** 잔액 상위 토큰 계정 주소 (최대 20개 내외). method 는 어떤 방식으로 얻었는지 */
  largestTokenAccounts(mint: string, tokenProgram: string): Promise<{ addresses: string[]; method: string }>;
  programAccounts(program: string, query: ProgramAccountsQuery): Promise<{ address: string; data: Buffer }[]>;
}
