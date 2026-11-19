// 결제 기록 (JSONL, 사용자 컴퓨터). 키·결제 서명 헤더·부분 서명 트랜잭션 원문은 남기지 않음.
// 남기는 것: 시각·URL·호스트·자산·금액·수령 주소·결과·이유·정산 tx id(공개 체인 기록)
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PaymentResult = 'paid' | 'refused' | 'declined_by_user' | 'confirmation_required' | 'rejected_by_server' | 'failed' | 'unknown';

export interface HistoryEntry {
  at: string;
  url: string;
  host: string;
  network?: string;
  asset?: string;
  mint?: string;
  amount?: string;
  payTo?: string;
  result: PaymentResult;
  /** 거절·실패 이유 */
  reasons?: string[];
  httpStatus?: number;
  /** 정산 트랜잭션 id (PAYMENT-RESPONSE) */
  settlementTx?: string;
  /** 서명했는지 (이 요청에서 결제 트랜잭션에 서명했으면 true) */
  signed: boolean;
}

export interface History {
  add(e: HistoryEntry): void;
  list(limit?: number): HistoryEntry[];
  /** 오늘(UTC) 서명한 결제 수, USDC 합계(USD), A402 합계(원 단위) — 상한 계산용 */
  today(now?: Date): { count: number; usd: number; a402: bigint };
}

const FORBIDDEN_KEYS = ['secret', 'privateKey', 'keypair', 'paymentSignature', 'transaction', 'payload'];

export function jsonlHistory(path: string, mints: () => { USDC: string; A402: string }): History {
  const read = (): HistoryEntry[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as HistoryEntry; } catch { return null; } }).filter((x): x is HistoryEntry => !!x);
  };
  return {
    add(e) {
      for (const k of FORBIDDEN_KEYS) if (k in (e as object)) throw new Error(`history: refusing to store field ${k}`);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(e) + '\n');
    },
    list(limit = 50) { return read().slice(-limit).reverse(); },
    today(now = new Date()) {
      const day = now.toISOString().slice(0, 10);
      // 서명한 결제는 결과(성공·거절됨·모름)와 상관없이 쓴 것으로 셈 (보수적으로)
      const xs = read().filter((e) => e.signed && e.at.slice(0, 10) === day);
      const m = mints();
      const usd = xs.filter((e) => e.mint === m.USDC && e.amount).reduce((s, e) => s + Number(e.amount) / 1e6, 0);
      const a402 = xs.filter((e) => e.mint === m.A402 && e.amount && /^\d+$/.test(e.amount)).reduce((s, e) => s + BigInt(e.amount!), 0n);
      return { count: xs.length, usd, a402 };
    },
  };
}
