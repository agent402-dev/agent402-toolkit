import type { ChainReader, HistoryReader } from './chain.js';
import { checkSummary, DISCLAIMER_EN, DISCLAIMER_KO, type SummaryReport } from './summary.js';
import { checkHolders, type HoldersReport } from './holders/index.js';
import { checkLiquidity, type LiquidityReport } from './liquidity/index.js';
import { checkLocks, type LocksReport } from './locks/index.js';
import { checkEarlyBuys, type EarlyBuysReport } from './earlybuys/index.js';

/** 전체 리포트 (항목 1~8). 한 항목이 실패해도 나머지는 돌려주고, 실패한 항목은 "확인 불가"로 */
export interface FullReport {
  mint: string;
  checkedAt: string;
  summary: SummaryReport | null;
  holders: HoldersReport | null;
  liquidity: LiquidityReport | null;
  locks: LocksReport | null;
  earlyBuys: EarlyBuysReport | null;
  /** 실패한 항목과 이유 (내부 오류 내용·RPC 주소는 넣지 않음) */
  unavailable: { section: string; reason: string }[];
  /** 이 리포트에 적용한 조사 깊이 상한 */
  limits: FullReportLimits;
  notes: string[];
}

export interface FullReportLimits {
  /** 항목 8: 창 안에서 읽을 최대 트랜잭션 수 */
  maxTransactions: number;
  /** 항목 8: 풀 기록을 거슬러 갈 최대 쪽수 (1쪽 = 1000건) */
  maxSignaturePages: number;
  /** 항목 6: DAMM v2 풀마다 NFT 보유자를 조회할 최대 포지션 수 */
  maxPositionsShown: number;
}

/**
 * 유료 API 기본 상한 (2026-11-19 사용자 결정: Workers 무료 플랜 요청당 외부 호출 50개 안에 결제까지 들어가도록 깊이 축소)
 */
export const API_LIMITS: FullReportLimits = { maxTransactions: 50, maxSignaturePages: 3, maxPositionsShown: 2 };
/** @deprecated API_LIMITS 를 쓰세요 */
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
  // 항목 1~4 가 실패하면(민트 아님·없음) 그대로 던져서 호출자가 4xx 로 처리
  const summary = await checkSummary(mint, reader.fetch, now);
  const holders = await run('holders', () => checkHolders(mint, reader, now));
  const liquidity = await run('liquidity', () => checkLiquidity(mint, reader, now, { maxPositionsShown: limits.maxPositionsShown }));
  const locks = await run('locks', () => checkLocks(mint, reader, now));
  const earlyBuys = await run('earlyBuys', () =>
    checkEarlyBuys(mint, reader, { now, maxTransactions: limits.maxTransactions, maxSignaturePages: limits.maxSignaturePages }));
  const notes = [DISCLAIMER_KO, DISCLAIMER_EN];
  if (unavailable.length) notes.push(`확인하지 못한 항목: ${unavailable.map((u) => u.section).join(', ')} (확인 불가)`);
  if (earlyBuys && earlyBuys.status !== 'complete') {
    const c = earlyBuys.coverage;
    notes.push(
      earlyBuys.status === 'partial'
        ? `항목 8 은 일부만 조회했습니다: 창 안 거래 ${c.transactionsInWindow}건 중 ${c.transactionsRead}건 (상한 ${c.maxTransactions}건)`
        : `항목 8 은 확인하지 못했습니다: 풀 거래 기록을 ${c.signaturesScanned}건(상한 ${c.maxSignatures}건)까지 거슬러 갔지만 시작 시점에 닿지 못함`,
    );
  }
  return { mint, checkedAt: now().toISOString(), summary, holders, liquidity, locks, earlyBuys, unavailable, limits, notes };
}
