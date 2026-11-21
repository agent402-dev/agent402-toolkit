// CSV export of the local payment log, for the user's own records. Nothing is sent anywhere.
import type { HistoryEntry } from './history.js';
import { formatUnits } from './units.js';

export const CSV_COLUMNS = [
  'time_utc', 'result', 'signed', 'asset', 'amount_smallest_units', 'amount', 'pay_to', 'host', 'url', 'network', 'mint', 'settlement_tx', 'http_status', 'reasons', 'receipt_signer', 'receipt_verified',
] as const;

/** One CSV field. Values a spreadsheet would run as a formula (=, +, -, @) get a leading apostrophe */
export function csvField(v: unknown): string {
  let s = v === undefined || v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Entries in the order given (pass oldest first for a chronological file) */
export function historyToCsv(entries: HistoryEntry[]): string {
  const rows = entries.map((e) => [
    e.at, e.result, e.signed, e.asset, e.amount,
    e.asset && e.amount && /^\d+$/.test(e.amount) ? formatUnits(e.amount, e.asset) : '',
    e.payTo, e.host, e.url, e.network, e.mint, e.settlementTx, e.httpStatus, (e.reasons ?? []).join('; '), e.receipt?.signer, e.receipt ? e.receipt.verified : '',
  ].map(csvField).join(','));
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n';
}
