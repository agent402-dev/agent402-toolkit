import { PublicKey } from '@solana/web3.js';
import { DISCLAIMER_EN } from './summary.js';

/** Judgement and rating terms that must not appear in responses: checks that the engine returns only facts and evidence */
export const FORBIDDEN_TERMS = [
  'safe', 'risk', 'rug', 'scam', 'score', 'grade', 'honeypot',
];

/** Values taken as-is from on-chain data (strings set by the token issuer): not our judgement, so not checked */
const ONCHAIN_TEXT_KEYS = new Set(['name', 'symbol', 'uri']);

function isPubkey(s: string): boolean {
  if (s.length < 32 || s.length > 44) return false;
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

/** base58 identifiers such as addresses and transaction signatures (32 to 90 chars, no spaces): not text we wrote */
function isBase58Id(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,90}$/.test(s);
}

/** Collects only strings the engine wrote (including key names). Addresses and on-chain strings are excluded. */
function authoredStrings(v: unknown, key: string | null, out: string[]): void {
  if (typeof v === 'string') {
    if (key && ONCHAIN_TEXT_KEYS.has(key)) return;
    if (isPubkey(v) || isBase58Id(v)) return;
    out.push(v);
  } else if (Array.isArray(v)) {
    for (const x of v) authoredStrings(x, key, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      authoredStrings(x, k, out);
    }
  }
}

/** Checks whether a response follows the guardrail. Returns the violations (empty array = pass). */
export function guardrailViolations(report: unknown): string[] {
  const strings: string[] = [];
  authoredStrings(report, null, strings);
  const text = strings.join('\n').toLowerCase();
  const v: string[] = [];
  for (const t of FORBIDDEN_TERMS) if (text.includes(t.toLowerCase())) v.push(`forbidden term: ${t}`);
  if (!JSON.stringify(report).includes(DISCLAIMER_EN)) v.push('missing disclaimer');
  return v;
}
