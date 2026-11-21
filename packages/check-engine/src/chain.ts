import type { AccountFetcher } from './summary.js';

export interface ProgramAccountsQuery {
  /** Accounts whose bytes at offset equal bytes (base58) */
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
  /** Integer string in base units */
  amount: string;
}

/** Normalized record with only the transaction parts needed for checks */
export interface TxRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: boolean;
  /** Order of static keys plus writable/readonly keys loaded from address lookup tables (basis for token balance accountIndex) */
  accountKeys: string[];
  preTokenBalances: TokenBalanceEntry[];
  postTokenBalances: TokenBalanceEntry[];
}

/** Reads transaction history (section 8). */
export interface HistoryReader {
  /** Newest to oldest. If before is set, starts from signatures older than it */
  signaturesForAddress(address: string, opts: { before?: string; limit: number }): Promise<SignatureInfo[]>;
  /** In request order. null if not found or not decodable */
  transactions(signatures: string[]): Promise<(TxRecord | null)[]>;
  /** Confirmed block slots in [startSlot, endSlot] (skipped slots excluded, ascending) */
  blocks(startSlot: number, endSlot: number): Promise<number[]>;
  /** Block time (unix seconds). null if unavailable */
  blockTime(slot: number): Promise<number | null>;
}

/** The only way the check engine reads the chain. Tests swap in fixtures. */
export interface ChainReader {
  fetch: AccountFetcher;
  /** Addresses of the largest token accounts (about 20). method says how they were obtained */
  largestTokenAccounts(mint: string, tokenProgram: string): Promise<{ addresses: string[]; method: string }>;
  programAccounts(program: string, query: ProgramAccountsQuery): Promise<{ address: string; data: Buffer }[]>;
}
