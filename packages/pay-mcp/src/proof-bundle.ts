// "Proof before payment" bundle (D2): one verifiable JSON per payment that ties together who paid (optional 8004 agent id),
// under which rules (hash of the spending policy), what was checked before paying (402 pre-check result), what was paid
// (network, asset, amount, recipient, transaction) and the seller's signed receipt. Read only: builds and checks records,
// never signs or pays. Internal review only, not independently audited.
import type { PayPolicy } from './policy.js';
import { domainCheck } from './policy.js';
import { decodeReceipt, verifyReceipt, type ChainTx } from './verify-receipt.js';

export const PROOF_KIND = 'agent402.payment-proof';

const sha256Hex = async (s: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), (b) => b.toString(16).padStart(2, '0')).join('');

/** JSON with sorted object keys and bigints as decimal strings, so the same rules always hash the same */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** SHA-256 (hex) of the spending rules; start-up warnings are not rules and are left out */
export async function policyHash(p: PayPolicy): Promise<string> {
  const { warnings: _w, ...rules } = p;
  return sha256Hex(canonicalJson(rules));
}

export interface ProofInput {
  /** Optional 8004 agent identity of the buyer: registry id (CAIP-10 style) and agent asset */
  agent?: { registry: string; asset: string };
  policy: PayPolicy;
  /** What was checked before paying: the resource URL, number of things to fix (0 = clean) and the codes */
  preflight?: { url: string; fixes: number; codes: string[] };
  payment: { resource: string; network: string; asset: string; amount: string; payTo: string; transaction: string | null; at: string };
  /** The seller's X-Agent402-Receipt header value, if it sent one */
  receipt?: string;
}

export async function buildProofBundle(i: ProofInput) {
  if (!/^\d+$/.test(i.payment.amount)) throw new Error('proof bundle: amount must be an integer string (smallest units)');
  if (Number.isNaN(Date.parse(i.payment.at))) throw new Error('proof bundle: at must be an ISO time');
  return {
    v: 1 as const, kind: PROOF_KIND,
    ...(i.agent ? { agent: i.agent } : {}),
    policyHash: await policyHash(i.policy),
    ...(i.preflight ? { preflight: i.preflight } : {}),
    payment: i.payment,
    ...(i.receipt ? { receipt: i.receipt } : {}),
  };
}
export type ProofBundle = Awaited<ReturnType<typeof buildProofBundle>>;

export interface Check { check: string; ok: boolean; detail?: string }

/**
 * Checks a bundle. Always: format and, when present, the receipt signature and that the receipt's payment fields equal the
 * bundle's. With `policy`: the policy hash, and that the resource host and recipient were allowed by it. With `chainTx`
 * (null = not found): that the recipient received the amount in that transaction.
 */
export async function verifyProofBundle(b: unknown, o: { policy?: PayPolicy; chainTx?: ChainTx | null } = {}) {
  const checks: Check[] = [];
  const notChecked: string[] = [];
  const x = b as Partial<ProofBundle> | null;
  const formatOk = !!x && typeof x === 'object' && x.v === 1 && x.kind === PROOF_KIND && typeof x.policyHash === 'string' && !!x.payment
    && typeof x.payment.payTo === 'string' && typeof x.payment.amount === 'string' && typeof x.payment.resource === 'string';
  checks.push({ check: 'format', ok: formatOk });
  if (!formatOk) return { verified: false, checks, reasons: ['format'], notChecked };
  const p = x!.payment!;
  if (o.policy) {
    const h = await policyHash(o.policy);
    checks.push({ check: 'policy_hash', ok: h === x!.policyHash, detail: h === x!.policyHash ? undefined : 'the bundle was made under different rules' });
    const d = domainCheck(o.policy, p.resource);
    checks.push({ check: 'policy_domain', ok: d.ok, detail: d.ok ? undefined : d.reason });
    checks.push({ check: 'policy_recipient', ok: o.policy.trustedPayTo.includes(p.payTo) });
  } else notChecked.push('the spending rules (give policy)');
  if (x!.preflight) checks.push({ check: 'preflight_clean', ok: x!.preflight.fixes === 0, detail: x!.preflight.fixes ? x!.preflight.codes.join(', ') : undefined });
  if (x!.receipt) {
    const r = await verifyReceipt(x!.receipt, { url: p.resource, ...(o.chainTx !== undefined ? { chainTx: o.chainTx } : {}) });
    checks.push({ check: 'receipt', ok: r.verified, detail: r.verified ? undefined : r.reasons.join('; ') });
    const rp = decodeReceipt(x!.receipt)?.fields.payment ?? {};
    const same = rp.network === p.network && rp.asset === p.asset && rp.amount === p.amount && rp.payTo === p.payTo && (rp.transaction ?? null) === p.transaction;
    checks.push({ check: 'receipt_matches_payment', ok: same });
  } else {
    notChecked.push('a seller receipt (none in the bundle)');
    if (o.chainTx !== undefined) notChecked.push('the payment on chain (checked through the receipt only)');
  }
  const failed = checks.filter((c) => !c.ok);
  return { verified: failed.length === 0, checks, reasons: failed.map((c) => `${c.check}${c.detail ? `: ${c.detail}` : ''}`), notChecked };
}
