// Machine Payments Protocol (MPP) 402 challenges (WWW-Authenticate: Payment), read only.
// Spec: paymentauth.org draft-httpauth-payment-01 (challenge grammar), draft-payment-intent-charge-00 (charge request),
// draft-solana-charge-00 (Solana method). pay-mcp reads these challenges and runs the same payment rules on them,
// but never signs or pays an MPP challenge: x402_fetch only pays x402. The seller's own text (description, realm) is never repeated.
import type { PaymentRequirements } from '@x402/core/types';
import { NETWORKS } from './policy.js';

export interface MppChallenge {
  /** Auth-param values as sent (id, realm, method, intent, request, expires, ...), lowercase names */
  params: Record<string, string>;
}

/** Refusal code for every MPP challenge: the rules are evaluated, but nothing is signed */
export const MPP_NOT_PAID = 'mpp_payment_not_supported: this 402 uses MPP (WWW-Authenticate: Payment); pay-mcp reads it and checks the rules but pays x402 only';

const TOKEN = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

/** Splits a WWW-Authenticate value into its Payment challenges (other schemes are skipped). Returns [] when there is none */
export function parseMppChallenges(header: string | null | undefined): MppChallenge[] {
  const s = (header ?? '').slice(0, 16_000);
  const out: MppChallenge[] = [];
  let i = 0;
  let current: MppChallenge | null = null;
  const skipWs = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === ',')) i++; };
  const readToken = () => { const st = i; while (i < s.length && TOKEN.test(s[i])) i++; return s.slice(st, i); };
  while (i < s.length) {
    skipWs();
    const name = readToken();
    if (!name) { i++; continue; }
    let j = i;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (s[j] === '=') {
      // auth-param of the current challenge
      i = j + 1;
      while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      let value = '';
      if (s[i] === '"') {
        i++;
        while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && i + 1 < s.length) i++; value += s[i]; i++; }
        i++;
      } else {
        // token68-style or token value (stops at comma)
        const st = i; while (i < s.length && s[i] !== ',' && s[i] !== ' ') i++; value = s.slice(st, i);
      }
      if (current) {
        const k = name.toLowerCase();
        if (!(k in current.params)) current.params[k] = value;
      }
    } else {
      // a new scheme starts
      current = name.toLowerCase() === 'payment' ? { params: {} } : null;
      if (current) out.push(current);
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SAFE = (v: unknown) => (typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,31}$/.test(v) ? v : 'other');

/** Decodes the base64url (no padding) JCS JSON request. null when it is not a JSON object */
export function decodeMppRequest(v: string | undefined): Record<string, unknown> | null {
  if (!v || v.length > 12_000 || !/^[A-Za-z0-9_-]+={0,2}$/.test(v)) return null;
  try {
    const b64 = v.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))));
    return isObj(json) ? json : null;
  } catch { return null; }
}

export interface MppOption {
  /** The challenge read as an x402-like requirement, so the same rules run on it. null when it cannot be read */
  requirement: PaymentRequirements | null;
  /** method/intent as short codes ("solana"/"charge"; anything else is "other") */
  method: string;
  intent: string;
  /** Reasons found while reading the challenge itself (before the payment rules) */
  reasons: string[];
}

/**
 * Reads one challenge. Only method "solana" with intent "charge" maps to a requirement:
 * currency = mint (or "sol"), recipient = payTo, methodDetails.network mainnet (default) / devnet / localnet.
 */
export function mppOption(c: MppChallenge, now: Date): MppOption {
  const p = c.params;
  const method = SAFE(p.method);
  const intent = SAFE(p.intent);
  const reasons: string[] = [];
  for (const k of ['id', 'realm', 'method', 'intent', 'request']) if (!p[k]) reasons.push(`mpp_challenge_missing: ${k}`);
  if (p.expires) {
    const t = Date.parse(p.expires);
    if (Number.isNaN(t)) reasons.push('mpp_challenge_invalid_expires');
    else if (t <= now.getTime()) reasons.push('mpp_challenge_expired');
  }
  if (method !== 'solana' || intent !== 'charge') return { requirement: null, method, intent, reasons: [...reasons, `mpp_method_not_supported: ${method}/${intent} (solana/charge only)`] };
  const r = decodeMppRequest(p.request);
  if (!r) return { requirement: null, method, intent, reasons: [...reasons, 'mpp_invalid_request'] };
  const md = isObj(r.methodDetails) ? r.methodDetails : {};
  const net = md.network === undefined ? 'mainnet' : md.network;
  const network = net === 'mainnet' ? NETWORKS.mainnet : net === 'devnet' ? NETWORKS.devnet : `solana:${SAFE(net)}`;
  const amount = typeof r.amount === 'string' && /^\d{1,20}$/.test(r.amount) ? r.amount : '-1';
  const currency = r.currency === 'sol' ? 'sol' : typeof r.currency === 'string' && BASE58.test(r.currency) ? r.currency : '';
  if (!currency) reasons.push('mpp_invalid_currency');
  const payTo = typeof r.recipient === 'string' && BASE58.test(r.recipient) ? r.recipient : '';
  if (!payTo) reasons.push('mpp_invalid_recipient');
  if (currency && currency !== 'sol' && md.decimals !== 6) reasons.push(`mpp_decimals_mismatch: ${typeof md.decimals === 'number' ? md.decimals : 'missing'} (6 expected)`);
  if (Array.isArray(md.splits) && md.splits.length) reasons.push('mpp_splits_not_supported');
  if (md.confidential === true) reasons.push('mpp_confidential_not_supported');
  const requirement = { scheme: 'exact', network, asset: currency, amount, payTo, maxTimeoutSeconds: 60, extra: {} } as unknown as PaymentRequirements;
  return { requirement, method, intent, reasons };
}
