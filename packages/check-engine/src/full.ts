import type { ChainReader, HistoryReader } from './chain.js';
import { checkSummary, DISCLAIMER_EN, type SummaryReport } from './summary.js';
import { checkHolders, type HoldersReport } from './holders/index.js';
import { checkLiquidity, type LiquidityReport } from './liquidity/index.js';
import { checkLocks, type LocksReport } from './locks/index.js';
import { checkEarlyBuys, type EarlyBuysReport } from './earlybuys/index.js';

/** Full report (sections 1 to 8). If one section fails, the rest are still returned and the failed section is marked "unavailable" */
export interface FullReport {
  mint: string;
  checkedAt: string;
  summary: SummaryReport | null;
  holders: HoldersReport | null;
  liquidity: LiquidityReport | null;
  locks: LocksReport | null;
  earlyBuys: EarlyBuysReport | null;
  /** Failed sections and reasons (no internal error details or RPC addresses) */
  unavailable: { section: string; reason: string }[];
  /** Depth limits applied to this report */
  limits: FullReportLimits;
  notes: string[];
}

export interface FullReportLimits {
  /** Section 8: maximum transactions to read in the window */
  maxTransactions: number;
  /** Section 8: maximum pages to walk back through pool history (1 page = 1000 entries) */
  maxSignaturePages: number;
  /** Section 6: maximum positions per DAMM v2 pool to look up NFT holders for */
  maxPositionsShown: number;
}

/**
  * Shallow limits for environments with few outbound calls per request (e.g. Workers free plan, 50). Default
 */
export const API_LIMITS: FullReportLimits = { maxTransactions: 50, maxSignaturePages: 3, maxPositionsShown: 2 };
/**
  * Local limits for running with the user's own RPC (@agent402-dev/check-mcp token_check). Deeper, but bounded
 */
export const LOCAL_LIMITS: FullReportLimits = { maxTransactions: 200, maxSignaturePages: 10, maxPositionsShown: 10 };
/** @deprecated Use API_LIMITS */
export const API_EARLYBUYS_LIMITS = { maxTransactions: API_LIMITS.maxTransactions, maxSignaturePages: API_LIMITS.maxSignaturePages } as const;

export async function checkFull(
  mint: string,
  reader: ChainReader & HistoryReader,
  now: () => Date = () => new Date(),
  limits: FullReportLimits = API_LIMITS,
): Promise<FullReport> {
  const unavailable: FullReport['unavailable'] = [];
  const run = async <T>(section: string, f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch (e) {
      unavailable.push({ section, reason: (e as Error)?.name === 'RpcError' ? 'upstream_unavailable' : 'check_failed' });
      return null;
    }
  };
  // If sections 1 to 4 fail (not a mint, or missing), rethrow so the caller can return 4xx
  const summary = await checkSummary(mint, reader.fetch, now);
  const holders = await run('holders', () => checkHolders(mint, reader, now));
  const liquidity = await run('liquidity', () => checkLiquidity(mint, reader, now, { maxPositionsShown: limits.maxPositionsShown }));
  const locks = await run('locks', () => checkLocks(mint, reader, now));
  const earlyBuys = await run('earlyBuys', () =>
    checkEarlyBuys(mint, reader, { now, maxTransactions: limits.maxTransactions, maxSignaturePages: limits.maxSignaturePages }));
  const notes = [DISCLAIMER_EN];
  if (unavailable.length) notes.push(`Sections not checked: ${unavailable.map((u) => u.section).join(', ')} (unavailable)`);
  if (earlyBuys && earlyBuys.status !== 'complete') {
    const c = earlyBuys.coverage;
    notes.push(
      earlyBuys.status === 'partial'
        ? `Section 8 was only partly read: ${c.transactionsRead} of ${c.transactionsInWindow} transactions in the window (limit ${c.maxTransactions})`
        : `Section 8 was not checked: walked back ${c.signaturesScanned} pool transactions (limit ${c.maxSignatures}) without reaching the start`,
    );
  }
  return { mint, checkedAt: now().toISOString(), summary, holders, liquidity, locks, earlyBuys, unavailable, limits, notes };
}
