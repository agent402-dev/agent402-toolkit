// Agent402 Bond v2 as an 8183-style job (compatible mapping, not the standard), buyer side: job status and reject with a reason code.
// Nothing here signs or moves funds. Reject is client metadata only: Bond v2 has no single-party refund, so the buyer simply does not
// accept, and once the review window ends anyone settles (bond_v2_settle). Limits, allowlists and confirmations are unchanged.
import {
  isMachineReason, normalizeReason, OUTCOME_NAMES, statusOfOutcome, type JobStatus, type ReasonCode,
} from '@agent402-dev/bond-client/job-8183-core';
import { record } from './bond-sign.js';
import { readDeal, type BondV2Deps } from './bond-v2.js';
import { acceptDeadlineV2, type DealV2, markDeadlineV2, timeOutcomeV2 } from './bond-v2-tx.js';

const refused = (reasons: string[]) => ({ result: 'refused' as const, reasons });

export interface JobView {
  status: JobStatus;
  outcome: string | null;
  settleable: boolean;
  canComplete: boolean;
  canSubmit: boolean;
  submitBy: string;
  completeBy: string | null;
  settleAfter: string;
}

/** 8183-style view of a Bond v2 deal at `now` (chain clock). Same rules as bond-client/job-8183 jobStatus. */
export function jobView(st: DealV2, now: bigint): JobView {
  const submitBy = markDeadlineV2(st);
  const marked = st.state === 'Marked' && st.markedAt !== null;
  const completeBy = marked ? acceptDeadlineV2(st, st.markedAt!) : st.state === 'Open' ? submitBy : null;
  const settleAfter = marked ? acceptDeadlineV2(st, st.markedAt!) + st.arbiterWindow : submitBy;
  const base = { submitBy: submitBy.toString(), completeBy: completeBy === null ? null : completeBy.toString(), settleAfter: settleAfter.toString() };
  if (st.state === 'Settled') {
    const o = OUTCOME_NAMES[st.outcome] ?? 'Cancelled';
    return { status: statusOfOutcome(o, st.owedSeller, st.sellerBond), outcome: o, settleable: false, canComplete: false, canSubmit: false, ...base, completeBy: null };
  }
  const t = timeOutcomeV2(st, now);
  if (t) return { status: statusOfOutcome(t.outcome, t.toSeller, st.sellerBond), outcome: t.outcome, settleable: true, canComplete: false, canSubmit: false, ...base };
  return {
    status: st.state === 'Open' ? 'Funded' : 'Submitted', outcome: null, settleable: false,
    canComplete: completeBy !== null && now <= completeBy, canSubmit: st.state === 'Open' && now <= submitBy, ...base,
  };
}

/** bond_v2_job_status: read-only. */
export async function bondV2JobStatus(d: BondV2Deps, deal: string) {
  const st = await readDeal(d, deal);
  if (!st) return refused(['not an Agent402 Bond v2 deal (or already closed)']);
  const me = d.signer?.address;
  const role = me === st.buyer ? 'client' : me === st.seller ? 'provider' : st.arbiter && me === st.arbiter ? 'evaluator' : 'observer';
  const v = jobView(st, await d.clock());
  const next = v.settleable ? 'Time has decided the outcome: call bond_v2_settle (anyone can).'
    : v.status === 'Funded' ? 'Waiting for the seller to submit (mark delivery on chain).'
      : v.status === 'Submitted' ? (v.canComplete ? 'Fetch and check the work with bond_v2_result; then bond_v2_accept (complete) or bond_v2_reject with a reason.' : 'The review window has ended; bond_v2_settle works after settleAfter.')
        : 'Settled. bond_v2_settle claims anything still owed.';
  return { result: 'ok' as const, deal, role, ...v, mapping: '8183-style (compatible mapping on Bond v2)', next };
}

/**
 * bond_v2_reject: records that this wallet (the buyer, as evaluator) will not accept, with a reason code. Signs nothing.
 * The reason defaults to `other`. It is kept in this wallet's payment history (not on chain, not sent to the seller).
 */
export async function bondV2Reject(d: BondV2Deps, deal: string, reason?: unknown, note?: string) {
  if (!d.signer) return refused(['no wallet configured (X402_KEYPAIR_PATH)']);
  const st = await readDeal(d, deal);
  if (!st) return refused(['not an Agent402 Bond v2 deal (or already closed)']);
  if (st.buyer !== d.signer.address) return refused(['only the buyer of this deal can reject it']);
  if (st.state === 'Settled') return refused(['the deal is already settled']);
  const code: ReasonCode = normalizeReason(reason);
  const n = typeof note === 'string' && note.trim() ? [...note.trim()].slice(0, 280).join('') : undefined;
  const v = jobView(st, await d.clock());
  record(d, 'v2-reject', deal, { reasons: [`reason:${code}`, ...(n ? [`note:${n}`] : [])] }, st.mint);
  return {
    result: 'rejected' as const, deal, reason: code, machineCheckable: isMachineReason(code), ...(n ? { note: n } : {}),
    expectedOutcome: st.state === 'Open' ? 'SellerDefault' as const : 'Unconfirmed' as const, settleAfter: v.settleAfter,
    signed: false,
    next: st.state === 'Open'
      ? 'Nothing was signed. If the seller does not submit by submitBy, call bond_v2_settle after settleAfter: you get your deposit and the seller bond.'
      : 'Nothing was signed. Do not call bond_v2_accept. After settleAfter call bond_v2_settle: you get your deposit back (less any agreed seller share); the seller keeps its bond and no balance is paid.',
  };
}
