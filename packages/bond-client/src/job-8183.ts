/**
 * Bonded jobs on Bond v2 with an ERC-8183-style lifecycle (compatible mapping, not the standard itself).
 * A thin client layer: no on-chain change, every instruction is one of the existing Bond v2 builders.
 *
 *   createJob / fund -> open            (seller bond + buyer deposit locked in one instruction, both sign)
 *   submit           -> mark_delivered  (seller, before deliver_by + grace)
 *   complete         -> accept          (buyer as evaluator; pays the balance to the seller)
 *   reject           -> no instruction  (the buyer does not accept; time settles the deal as Unconfirmed)
 *   claimRefund      -> settle + claims (anyone, once time has fixed the outcome)
 *
 * Reasons for reject or dispute are client metadata only (never stored on chain). The default evaluation mode is
 * machine-checkable conditions: missed deadline, not delivered, receipt mismatch, schema mismatch.
 * Internal review only, not independently audited.
 */
import type { PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  acceptDeadlineV2, acceptV2, arbiterEndV2, markDeadlineV2, markDeliveredV2, openV2, settleAndClaimV2, timeOutcomeV2,
  type DealRef, type DealV2, type OpenAccountsV2, type OpenTermsV2, type Outcome,
} from './v2.js';
import { checkDeliveryV2, type JobDeliveryV2 } from './job-v2.js';
import { isMachineReason, matchesJobSchema, normalizeReason, statusOfOutcome, type JobSchema, type JobStatus, type ReasonCode } from './job-8183-core.js';

export * from './job-8183-core.js';

export interface JobState {
  status: JobStatus;
  /** Bond v2 outcome, when settled or fixed by time */
  outcome: Outcome | null;
  /** time has fixed the outcome but nobody has sent settle yet */
  settleable: boolean;
  /** the buyer can still complete (accept) at `now` */
  canComplete: boolean;
  /** the seller can still submit (mark) at `now` */
  canSubmit: boolean;
  /** unix seconds: last moment to submit; last moment to complete (after a submit) */
  submitBy: bigint;
  completeBy: bigint | null;
  /** unix seconds after which anyone can settle, if not settled */
  settleAfter: bigint;
}

/** Reads a decoded deal as an 8183-style job at `now` (chain clock). */
export function jobStatus(deal: DealV2, now: bigint): JobState {
  const submitBy = markDeadlineV2(deal);
  const completeBy = deal.state === 'Marked' && deal.markedAt !== null ? acceptDeadlineV2(deal, deal.markedAt) : deal.state === 'Open' ? submitBy : null;
  const settleAfter = deal.state === 'Marked' && deal.markedAt !== null ? arbiterEndV2(deal, deal.markedAt) : submitBy;
  if (deal.state === 'Settled') {
    return { status: statusOfOutcome(deal.outcome ?? 'Cancelled', deal.owedSeller, deal.sellerBond), outcome: deal.outcome, settleable: false,
      canComplete: false, canSubmit: false, submitBy, completeBy: null, settleAfter };
  }
  const t = timeOutcomeV2(deal, now);
  if (t) return { status: statusOfOutcome(t.outcome, t.toSeller, deal.sellerBond), outcome: t.outcome, settleable: true, canComplete: false, canSubmit: false, submitBy, completeBy, settleAfter };
  return {
    status: deal.state === 'Open' ? 'Funded' : 'Submitted', outcome: null, settleable: false,
    canComplete: completeBy !== null && now <= completeBy, canSubmit: deal.state === 'Open' && now <= submitBy,
    submitBy, completeBy, settleAfter,
  };
}

export interface MachineCheckInput {
  deal: DealV2;
  /** deal address (base58) */
  dealAddress: string;
  now: bigint;
  /** null when the buyer could not fetch a delivery */
  delivery: JobDeliveryV2 | null;
  /** optional schema agreed at quote time */
  schema?: JobSchema;
}
export interface MachineVerdict {
  /** complete = accept now; reject = do not accept (with reasons); wait = nothing to decide yet; settle = time has decided */
  action: 'complete' | 'reject' | 'wait' | 'settle';
  reasons: ReasonCode[];
  problems: string[];
}

/**
 * The default evaluation mode: decide from data only. Never signs anything; the caller sends `complete` or keeps the
 * reject record. A seller-reported `job_failed` is a receipt mismatch for the buyer (the promised document did not come).
 */
export async function machineCheck(p: MachineCheckInput): Promise<MachineVerdict> {
  const st = jobStatus(p.deal, p.now);
  if (st.settleable || p.deal.state === 'Settled') {
    const reasons: ReasonCode[] = st.outcome === 'SellerDefault' ? ['deadline_missed'] : [];
    return { action: p.deal.state === 'Settled' ? 'wait' : 'settle', reasons, problems: [] };
  }
  if (p.deal.state === 'Open') return { action: 'wait', reasons: [], problems: [] };
  // Marked: judge the documents
  if (!p.delivery) {
    // before deliver_by the seller may still serve the result; after it, a missing delivery is a reason
    return p.now > p.deal.deliverBy ? { action: 'reject', reasons: ['not_delivered'], problems: ['no delivery received'] } : { action: 'wait', reasons: [], problems: [] };
  }
  const problems = await checkDeliveryV2({ delivery: p.delivery, deal: p.dealAddress, seller: p.deal.seller.toBase58(), jobHash: p.deal.jobHash, onChainOutputHash: p.deal.outputHash });
  const reasons: ReasonCode[] = [];
  if (problems.length) reasons.push('receipt_mismatch');
  if (!problems.length && p.schema) {
    const s = matchesJobSchema(p.delivery.result, p.schema);
    if (s.length) { reasons.push('schema_mismatch'); problems.push(...s); }
  }
  if (reasons.length) return { action: 'reject', reasons, problems };
  return st.canComplete ? { action: 'complete', reasons: [], problems: [] } : { action: 'wait', reasons: [], problems: ['the review window has ended; complete is no longer possible'] };
}

// ---------------- job API ----------------

/** createJob: the open instruction (seller and buyer both sign; it also funds). */
export const createJob = (d: DealRef, accounts: OpenAccountsV2, terms: OpenTermsV2): TransactionInstruction => openV2(d, accounts, terms);
/** fund: in Bond v2 funding happens at open, so this is the same instruction as createJob. */
export const fund = createJob;
/** submit: the seller marks delivery with the output hash. */
export const submit = (d: DealRef, outputHash: Uint8Array): TransactionInstruction => markDeliveredV2(d, outputHash);
/** complete: the buyer, as evaluator, accepts and pays the balance to the recorded seller payout. */
export const complete = (d: DealRef, buyerToken: PublicKey, sellerPayout: PublicKey): TransactionInstruction => acceptV2(d, buyerToken, sellerPayout);

export interface RejectRecord {
  deal: string;
  reason: ReasonCode;
  machineCheckable: boolean;
  note?: string;
  /** unix seconds */
  at: number;
  /** anyone can settle after this time (unix seconds) */
  settleAfter: string;
  /** what time will decide if nobody else acts */
  expectedOutcome: 'Unconfirmed' | 'SellerDefault';
}

/**
 * reject: Bond v2 has no single-party refund, so a reject sends nothing. The buyer does not accept, and once the
 * review (and arbiter) window ends anyone can settle: the buyer gets the deposit back (less the agreed seller share),
 * the seller keeps its bond. Before submit, the deal ends by the missed deadline instead (seller bond to the buyer).
 * Returns the record to keep; the reason defaults to `other`.
 */
export function reject(deal: DealV2, dealAddress: string, now: bigint, reason?: unknown, note?: string): RejectRecord {
  if (deal.state === 'Settled') throw new Error('the job is already settled');
  const st = jobStatus(deal, now);
  const r = normalizeReason(reason);
  const n = typeof note === 'string' && note.trim() ? [...note.trim()].slice(0, 280).join('') : undefined;
  return {
    deal: dealAddress, reason: r, machineCheckable: isMachineReason(r), ...(n ? { note: n } : {}), at: Number(now),
    settleAfter: st.settleAfter.toString(), expectedOutcome: deal.state === 'Open' ? 'SellerDefault' : 'Unconfirmed',
  };
}

/** claimRefund: settle plus the claims time implies (anyone can send), or null if time has not decided yet. */
export const claimRefund = (d: DealRef, deal: DealV2, now: bigint): TransactionInstruction[] | null => settleAndClaimV2(d, deal, now);
