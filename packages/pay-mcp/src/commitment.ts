// Seller lock check before paying (asset-neutral): reads the seller's registration, verifies signatures, reads each lock on-chain
// and checks how much is still locked minDays from now. Only irrevocable locks signed by their recipient count.
import { readLock, type AccountsFetcher, type LockProtocol } from './locks.js';
import { type LockAsset, type PayPolicy, WSOL_MINT } from './policy.js';
import { REGISTRATION_PATH, verifyRegistration } from './registration.js';
import { formatUnits as fmt } from './units.js';

/** SOL (wrapped) has 9 decimals; USDC and PREQ have 6 */
const formatUnits = (v: bigint, unit: string) => fmt(v, unit, unit === 'SOL' ? 9 : 6);

export interface LockFact {
  account: string;
  protocol: LockProtocol;
  asset: LockAsset | null;
  /** Counted toward the requirement */
  counted: boolean;
  /** Why it is not counted */
  reason?: string;
  lockedNow?: string;
  lockedAtDeadline?: string;
}

export interface CommitmentResult {
  ok: boolean;
  reasons: string[];
  /** Facts shown to the user whatever the result */
  facts: { registration: string; deadline: string; locks: LockFact[]; totalsAtDeadline: Partial<Record<LockAsset, string>> };
}

export async function checkCommitment(o: { origin: string; payTo: string; policy: PayPolicy; fetch: typeof fetch; accounts?: AccountsFetcher; now: Date }): Promise<CommitmentResult> {
  const deadlineSec = BigInt(Math.floor(o.now.getTime() / 1000)) + BigInt(Math.round(o.policy.lock.minDays * 86_400));
  const deadline = new Date(Number(deadlineSec) * 1000).toISOString();
  const facts: CommitmentResult['facts'] = { registration: 'not_checked', deadline, locks: [], totalsAtDeadline: {} };
  const fail = (reason: string): CommitmentResult => ({ ok: false, reasons: [reason], facts });
  const host = new URL(o.origin).host;

  let doc: unknown;
  try {
    const res = await o.fetch(`${o.origin}${REGISTRATION_PATH}`, { redirect: 'manual' });
    if (res.status !== 200) { facts.registration = `missing (http ${res.status})`; return fail(`lock_registration_missing: ${host}${REGISTRATION_PATH}`); }
    const text = (await res.text()).slice(0, 65_536);
    doc = JSON.parse(text);
  } catch { facts.registration = 'unreadable'; return fail(`lock_registration_unreadable: ${host}${REGISTRATION_PATH}`); }
  const v = await verifyRegistration(doc, host, o.now);
  if (!v.ok) { facts.registration = v.reason; return fail(`lock_${v.reason}`); }
  facts.registration = 'ok';
  if (!v.payload.payTo.includes(o.payTo)) return fail(`lock_registration_pay_to_not_listed: ${o.payTo}`);
  if (!o.accounts) return fail('lock_check_unavailable: no RPC to read locks');

  const locks = v.payload.locks.filter((l) => (l?.protocol === 'jupiter-lock' || l?.protocol === 'streamflow') && typeof l.account === 'string').slice(0, 20);
  let accounts: Awaited<ReturnType<AccountsFetcher>>;
  try { accounts = await o.accounts(locks.map((l) => l.account)); } catch (e) { return fail(`lock_check_unavailable: ${(e as Error).message}`); }
  const mints: Record<LockAsset, string> = { PREQ: o.policy.mints.PREQ, USDC: o.policy.mints.USDC, SOL: WSOL_MINT };
  const totals: Partial<Record<LockAsset, bigint>> = {};
  const nowSec = BigInt(Math.floor(o.now.getTime() / 1000));
  const seen = new Set<string>();
  for (const [i, l] of locks.entries()) {
    const fact: LockFact = { account: l.account, protocol: l.protocol, asset: null, counted: false };
    facts.locks.push(fact);
    if (seen.has(l.account)) { fact.reason = 'duplicate'; continue; }
    seen.add(l.account);
    const j = await readLock(l.protocol, l.account, accounts[i]);
    if (typeof j === 'string') { fact.reason = j; continue; }
    fact.asset = (Object.keys(mints) as LockAsset[]).find((k) => mints[k] && mints[k] === j.mint) ?? null;
    const unit = fact.asset ?? 'tokens';
    fact.lockedNow = formatUnits(j.lockedAt(nowSec), unit);
    fact.lockedAtDeadline = formatUnits(j.lockedAt(deadlineSec), unit);
    if (!fact.asset) { fact.reason = `asset_not_counted: ${j.mint}`; continue; }
    if (j.notFixed) { fact.reason = `revocable_lock: ${j.notFixed}`; continue; }
    if (!v.signers.has(j.recipient)) { fact.reason = `recipient_did_not_sign: ${j.recipient}`; continue; }
    fact.counted = true;
    totals[fact.asset] = (totals[fact.asset] ?? 0n) + j.lockedAt(deadlineSec);
  }
  for (const [k, t] of Object.entries(totals)) facts.totalsAtDeadline[k as LockAsset] = formatUnits(t, k);
  const met = (Object.entries(o.policy.lock.min) as [LockAsset, bigint][]).find(([k, min]) => (totals[k] ?? 0n) >= min);
  if (met) return { ok: true, reasons: [], facts };
  const need = (Object.entries(o.policy.lock.min) as [LockAsset, bigint][]).map(([k, min]) => `${formatUnits(totals[k] ?? 0n, k)} of ${formatUnits(min, k)}`).join(' or ');
  return { ok: false, reasons: [`lock_requirement_not_met: locked until ${deadline}: ${need}`], facts };
}
