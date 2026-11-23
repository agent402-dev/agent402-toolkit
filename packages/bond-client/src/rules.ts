/**
 * The Agent402 Bond settlement rules, ported one-to-one from the program's
 * pure Rust crate (programs/agent402-bond-core). Use it to show a deal's
 * deadlines, what each side can still do, and what settlement would pay.
 *
 * The program is the source of truth. These functions only predict its
 * answers from a deal's on-chain state; times are the Solana clock (unix seconds).
 */
import type { DealState, Terms } from './index.js';

export const DAY = 86_400n;
export const GRACE = DAY;
export const MAX_TERM = 180n * DAY;
export const MAX_LATE_WINDOW = 7n * DAY;
export const MIN_PAY_WINDOW = DAY;
export const MAX_PAY_WINDOW = 30n * DAY;
export const MAX_BOND_BPS = 2_000n;

export type Outcome = 'delivered' | 'buyer_default' | 'disputed' | 'seller_default' | 'cancelled';
export interface Payout { toSeller: bigint; toBuyer: bigint; outcome: Outcome }

/** The parts of a deal the rules depend on (a subset of `DealState`). */
export interface RuleDeal {
  terms: Terms;
  openedAt: bigint;
  sellerMark: bigint | null;
  buyerConfirm: bigint | null;
  balancePaid: boolean;
}

const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

export const balanceOf = (t: Terms) => t.price - t.buyerDeposit;
export const t1 = (t: Terms) => t.deliverBy + GRACE;
export const t2 = (t: Terms) => t1(t) + t.lateWindow;

/** Delivery time once the buyer has confirmed. */
export function deliveryTime(d: RuleDeal): bigint | null {
  if (d.buyerConfirm === null) return null;
  return d.sellerMark === null ? d.buyerConfirm : min(d.sellerMark, d.buyerConfirm);
}

/** Last moment the buyer may confirm or pay the balance. */
export function buyerDeadline(d: RuleDeal): bigint {
  const t = d.terms;
  const first = d.sellerMark !== null && d.buyerConfirm !== null
    ? min(d.sellerMark, d.buyerConfirm)
    : (d.sellerMark ?? d.buyerConfirm);
  if (first === null) return t2(t);
  const w = max(first, t1(t)) + t.payWindow + GRACE;
  return d.buyerConfirm === null ? max(w, t2(t)) : w;
}

/** Pro-rata late deduction from the seller bond, paid to the buyer. */
export function lateDeduction(d: RuleDeal): bigint {
  const dt = deliveryTime(d);
  if (dt === null) return 0n;
  const start = t1(d.terms);
  if (dt <= start || d.terms.lateWindow === 0n) return 0n;
  const late = min(dt - start, d.terms.lateWindow);
  return (d.terms.sellerBond * late) / d.terms.lateWindow;
}

/** What `settle` would pay at `now`, or null if the program would refuse (not yet settleable). */
export function settlePreview(d: RuleDeal, now: bigint): Payout | null {
  const t = d.terms;
  if (d.buyerConfirm !== null) {
    const deduct = lateDeduction(d);
    let outcome: Outcome;
    if (d.balancePaid) outcome = 'delivered';
    else if (now > buyerDeadline(d)) outcome = 'buyer_default';
    else return null;
    return { toSeller: t.sellerBond - deduct + t.buyerDeposit, toBuyer: deduct, outcome };
  }
  if (d.sellerMark !== null) {
    if (now <= buyerDeadline(d)) return null;
    return { toSeller: t.sellerBond, toBuyer: t.buyerDeposit, outcome: 'disputed' };
  }
  if (now <= t2(t)) return null;
  return { toSeller: 0n, toBuyer: t.sellerBond + t.buyerDeposit, outcome: 'seller_default' };
}

/** Latest time at which `settle` is guaranteed to succeed. */
export const settleBy = (d: RuleDeal) => t2(d.terms) + d.terms.payWindow + GRACE + 1n;

/** Earliest time `settle` succeeds if nobody acts again (null if it already does at `now`). */
export function settleableFrom(d: RuleDeal, now: bigint): bigint | null {
  if (settlePreview(d, now) !== null) return null;
  if (d.buyerConfirm !== null || d.sellerMark !== null) return buyerDeadline(d) + 1n;
  return t2(d.terms) + 1n;
}

export interface Action { action: string; who: 'seller' | 'buyer' | 'both' | 'anyone'; until?: bigint }

/**
 * What can still be done at `now` according to the program's rules.
 * `cancel` and `extend` need both signatures and are listed while the deal is open.
 */
export function possibleActions(d: RuleDeal, now: bigint): Action[] {
  const out: Action[] = [];
  const bd = buyerDeadline(d);
  if (d.sellerMark === null && d.buyerConfirm === null && now <= t2(d.terms)) {
    out.push({ action: 'mark_delivered', who: 'seller', until: t2(d.terms) });
  }
  if (d.buyerConfirm === null && now <= bd) out.push({ action: 'confirm_receipt', who: 'buyer', until: bd });
  if (d.buyerConfirm !== null && !d.balancePaid && now <= bd) out.push({ action: 'pay_balance', who: 'buyer', until: bd });
  if (settlePreview(d, now) !== null) out.push({ action: 'settle_and_claim', who: 'anyone' });
  out.push({ action: 'cancel', who: 'both' }, { action: 'extend', who: 'both' });
  return out;
}

/** Summary of an open deal at `now`: deadlines, possible actions and the settlement that applies now or later. */
export function timeline(d: RuleDeal | DealState, now: bigint) {
  const r: RuleDeal = d;
  return {
    now,
    deliverBy: r.terms.deliverBy,
    lateUntil: t2(r.terms),
    buyerDeadline: buyerDeadline(r),
    settleBy: settleBy(r),
    lateDeduction: lateDeduction(r),
    settleNow: settlePreview(r, now),
    settleableFrom: settleableFrom(r, now),
    possibleActions: possibleActions(r, now),
  };
}
