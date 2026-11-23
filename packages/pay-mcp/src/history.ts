// Payment history (JSONL, on the user's computer). Keys, payment signature headers and raw partially signed transactions are not stored.
// Stored: time, URL, host, asset, amount, receiver, result, reason, settlement tx id (public on-chain record), seller's signed receipt if any
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
  /** Reason for rejection or failure */
  reasons?: string[];
  httpStatus?: number;
  /** Settlement transaction id (PAYMENT-RESPONSE) */
  settlementTx?: string;
  /** Whether it signed (true if it signed a payment transaction in this request) */
  signed: boolean;
  /** Seller's signed receipt (public evidence; contains no keys): signer, check result, and the receipt as received */
  receipt?: { signer: string | null; verified: boolean; reasons: string[]; token: string };
}

export interface History {
  add(e: HistoryEntry): void;
  list(limit?: number): HistoryEntry[];
  /** Today's (UTC) signed payment count, USDC total (USD), PREQ and A402 (v1) totals (base units), for limit checks */
  today(now?: Date): { count: number; usd: number; preq: bigint; a402: bigint };
  /** Today's (UTC) signed payments to one recipient: count, USDC total (USD), PREQ total (base units) */
  recipientToday(payTo: string, now?: Date): { count: number; usd: number; preq: bigint };
}

const FORBIDDEN_KEYS = ['secret', 'privateKey', 'keypair', 'paymentSignature', 'transaction', 'payload'];

export function jsonlHistory(path: string, mints: () => { USDC: string; PREQ: string; A402: string }): History {
  const read = (): HistoryEntry[] => {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as HistoryEntry; } catch { return null; } }).filter((x): x is HistoryEntry => !!x);
  };
  // A signed payment counts as spent regardless of result (succeeded, rejected, unknown), to be conservative
  const signedOn = (now: Date) => {
    const day = now.toISOString().slice(0, 10);
    // Fee-only signatures (amount "0", e.g. settling a bond deal) move no tokens and do not count as payments
    return read().filter((e) => e.signed && e.at.slice(0, 10) === day && e.amount !== '0');
  };
  const usdOf = (xs: HistoryEntry[], usdc: string) => xs.filter((e) => e.mint === usdc && e.amount).reduce((s, e) => s + Number(e.amount) / 1e6, 0);
  const sumOf = (xs: HistoryEntry[], mint: string) => (mint ? xs.filter((e) => e.mint === mint && e.amount && /^\d+$/.test(e.amount)).reduce((s, e) => s + BigInt(e.amount!), 0n) : 0n);
  return {
    add(e) {
      for (const k of FORBIDDEN_KEYS) if (k in (e as object)) throw new Error(`history: refusing to store field ${k}`);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(e) + '\n');
    },
    list(limit = 50) { return read().slice(-limit).reverse(); },
    today(now = new Date()) {
      const xs = signedOn(now);
      const m = mints();
      return { count: xs.length, usd: usdOf(xs, m.USDC), preq: sumOf(xs, m.PREQ), a402: sumOf(xs, m.A402) };
    },
    recipientToday(payTo, now = new Date()) {
      const xs = signedOn(now).filter((e) => e.payTo === payTo);
      const m = mints();
      return { count: xs.length, usd: usdOf(xs, m.USDC), preq: sumOf(xs, m.PREQ) };
    },
  };
}
