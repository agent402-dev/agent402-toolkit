// The Rust core tests (programs/agent402-bond-core/src/tests.rs), replayed against the TypeScript port.
// A tiny state machine applies the program's guards using the ported rule functions.
import { describe, expect, it } from 'vitest';
import type { Terms } from '../src/index.js';
import {
  buyerDeadline, DAY, deliveryTime, GRACE, lateDeduction, MAX_BOND_BPS, MAX_LATE_WINDOW, MAX_PAY_WINDOW, MAX_TERM,
  MIN_PAY_WINDOW, type Payout, possibleActions, type RuleDeal, settleBy, settlePreview, t1, t2, timeline,
} from '../src/rules.js';

const NOW = 1_800_000_000n;
const terms = (): Terms => ({
  price: 300_000_000n, sellerBond: 30_000_000n, buyerDeposit: 30_000_000n,
  deliverBy: NOW + 10n * DAY, lateWindow: 2n * DAY, payWindow: 3n * DAY,
});

class Deal implements RuleDeal {
  sellerMark: bigint | null = null;
  buyerConfirm: bigint | null = null;
  balancePaid = false;
  closed = false;
  constructor(public terms: Terms, public openedAt: bigint) {}
  mark(now: bigint) {
    if (this.closed) throw new Error('NotOpen');
    if (this.sellerMark !== null) throw new Error('AlreadyMarked');
    if (this.buyerConfirm !== null) throw new Error('AlreadyConfirmed');
    if (now > t2(this.terms)) throw new Error('MarkTooLate');
    this.sellerMark = now;
  }
  confirm(now: bigint) {
    if (this.closed) throw new Error('NotOpen');
    if (this.buyerConfirm !== null) throw new Error('AlreadyConfirmed');
    if (now > buyerDeadline(this)) throw new Error('ConfirmTooLate');
    this.buyerConfirm = now;
    if (this.terms.price - this.terms.buyerDeposit === 0n) this.balancePaid = true;
  }
  pay(now: bigint) {
    if (this.closed) throw new Error('NotOpen');
    if (this.buyerConfirm === null) throw new Error('NotConfirmed');
    if (this.balancePaid) throw new Error('AlreadyPaid');
    if (now > buyerDeadline(this)) throw new Error('PayTooLate');
    this.balancePaid = true;
    return this.terms.price - this.terms.buyerDeposit;
  }
  settle(now: bigint): Payout {
    if (this.closed) throw new Error('NotOpen');
    const p = settlePreview(this, now);
    if (!p) throw new Error('NotYetSettleable');
    this.closed = true;
    return p;
  }
  cancel(): Payout {
    if (this.closed) throw new Error('NotOpen');
    this.closed = true;
    return { toSeller: this.terms.sellerBond, toBuyer: this.terms.buyerDeposit, outcome: 'cancelled' };
  }
}
const opened = () => new Deal(terms(), NOW);

describe('rules: same results as the Rust core tests', () => {
  it('rule 1: delivered on time and paid', () => {
    const d = opened();
    d.mark(NOW + DAY);
    d.confirm(NOW + 2n * DAY);
    expect(d.pay(NOW + 2n * DAY)).toBe(270_000_000n);
    expect(d.settle(NOW + 2n * DAY)).toEqual({ toSeller: 60_000_000n, toBuyer: 0n, outcome: 'delivered' });
    expect(() => d.settle(NOW + 3n * DAY)).toThrow('NotOpen');
  });

  it('rule 2: late delivery, pro-rata deduction', () => {
    const d = opened();
    const s = t1(d.terms);
    d.mark(s + DAY);
    d.confirm(s + DAY + 100n);
    d.pay(s + DAY + 100n);
    const p = d.settle(s + DAY + 100n);
    expect(p.toBuyer).toBe(15_000_000n);
    expect(p.toSeller).toBe(45_000_000n);
  });

  it('buyer delaying confirm does not increase the deduction', () => {
    const t = { ...terms(), deliverBy: NOW + 2n * DAY, payWindow: 30n * DAY };
    const d = new Deal(t, NOW);
    d.mark(NOW + DAY);
    d.confirm(t1(t) + DAY);
    expect(lateDeduction(d)).toBe(0n);
  });

  it('rule 3: buyer default (pay window runs from T1)', () => {
    const d = opened();
    d.confirm(NOW + DAY);
    const deadline = t1(d.terms) + d.terms.payWindow + GRACE;
    expect(buyerDeadline(d)).toBe(deadline);
    expect(() => d.settle(deadline)).toThrow('NotYetSettleable');
    expect(() => d.pay(deadline + 1n)).toThrow('PayTooLate');
    const p = d.settle(deadline + 1n);
    expect(p.outcome).toBe('buyer_default');
    expect(p.toSeller).toBe(60_000_000n);
  });

  it('rule 4: marked but never confirmed is neutral', () => {
    const d = opened();
    d.mark(NOW + DAY);
    const deadline = t1(d.terms) + d.terms.payWindow + GRACE;
    expect(() => d.settle(deadline)).toThrow('NotYetSettleable');
    expect(() => d.confirm(deadline + 1n)).toThrow('ConfirmTooLate');
    expect(d.settle(deadline + 1n)).toEqual({ toSeller: 30_000_000n, toBuyer: 30_000_000n, outcome: 'disputed' });
  });

  it('rule 5: seller default', () => {
    const d = opened();
    const end = t2(d.terms);
    expect(() => d.settle(end)).toThrow('NotYetSettleable');
    expect(() => d.mark(end + 1n)).toThrow('MarkTooLate');
    expect(() => d.confirm(end + 1n)).toThrow('ConfirmTooLate');
    expect(d.settle(end + 1n)).toEqual({ toSeller: 0n, toBuyer: 60_000_000n, outcome: 'seller_default' });
  });

  it('rule 6: cancel returns each side its own money', () => {
    expect(opened().cancel()).toEqual({ toSeller: 30_000_000n, toBuyer: 30_000_000n, outcome: 'cancelled' });
  });

  it('zero balance is paid on confirm', () => {
    const t = { ...terms(), price: 60_000_000n, buyerDeposit: 60_000_000n, sellerBond: 6_000_000n };
    const d = new Deal(t, NOW);
    d.confirm(NOW + DAY);
    expect(d.balancePaid).toBe(true);
    expect(d.settle(NOW + DAY).outcome).toBe('delivered');
  });
});

describe('timeline and possible actions', () => {
  it('fresh deal: seller may mark, buyer may confirm, nobody may settle yet', () => {
    const d = opened();
    const tl = timeline(d, NOW + DAY);
    expect(tl.settleNow).toBeNull();
    expect(tl.settleableFrom).toBe(t2(d.terms) + 1n);
    expect(tl.possibleActions.map((a) => a.action)).toEqual(['mark_delivered', 'confirm_receipt', 'cancel', 'extend']);
  });
  it('confirmed and paid: settle now, delivered', () => {
    const d = opened();
    d.mark(NOW + DAY); d.confirm(NOW + DAY); d.pay(NOW + DAY);
    const tl = timeline(d, NOW + DAY);
    expect(tl.settleNow?.outcome).toBe('delivered');
    expect(tl.settleableFrom).toBeNull();
    expect(possibleActions(d, NOW + DAY).some((a) => a.action === 'settle_and_claim')).toBe(true);
  });
  it('confirmed, not paid: buyer may still pay until the buyer deadline', () => {
    const d = opened();
    d.confirm(NOW + DAY);
    const acts = possibleActions(d, NOW + DAY);
    expect(acts.find((a) => a.action === 'pay_balance')?.until).toBe(buyerDeadline(d));
    expect(timeline(d, NOW + DAY).settleableFrom).toBe(buyerDeadline(d) + 1n);
  });
});

// ---------- randomized invariants (same generator as the Rust test) ----------
class Rng {
  constructor(private s: bigint) {}
  next(): bigint {
    const M = (1n << 64n) - 1n;
    this.s ^= (this.s << 13n) & M;
    this.s ^= this.s >> 7n;
    this.s ^= (this.s << 17n) & M;
    return this.s;
  }
  range(lo: bigint, hi: bigint) { return lo + (this.next() % (hi - lo + 1n)); }
}

describe('random sequences hold the invariants', () => {
  it('conservation, single settlement, liveness by settleBy', () => {
    const rng = new Rng(0x9e3779b97f4a7c15n);
    let settled = 0;
    for (let i = 0; i < 20_000; i++) {
      const price = rng.range(1n, 1_000_000_000n);
      const maxBond = (price * MAX_BOND_BPS) / 10_000n;
      if (maxBond === 0n) continue;
      const t: Terms = {
        price,
        sellerBond: rng.range(1n, maxBond),
        buyerDeposit: rng.range(0n, price),
        deliverBy: NOW + rng.range(1n, MAX_TERM),
        lateWindow: rng.range(0n, MAX_LATE_WINDOW),
        payWindow: rng.range(MIN_PAY_WINDOW, MAX_PAY_WINDOW),
      };
      const d = new Deal(t, NOW);
      const by = settleBy(d);
      let now = NOW;
      let paid: Payout | null = null;
      for (let k = 0; k < 8; k++) {
        now += rng.range(0n, 60n * DAY);
        const op = rng.next() % 6n;
        try {
          if (op === 0n) d.mark(now);
          else if (op === 1n) d.confirm(now);
          else if (op === 2n) d.pay(now);
          else if (op === 3n) { const p = d.settle(now); expect(paid).toBeNull(); paid = p; }
          else if (op === 4n && rng.next() % 50n === 0n) { const p = d.cancel(); expect(paid).toBeNull(); paid = p; }
        } catch { /* refused, as the program would */ }
        const dt = deliveryTime(d);
        if (dt !== null) expect(dt <= t2(t)).toBe(true);
      }
      if (!paid) paid = d.settle(by > now ? by : now);
      expect(paid.toSeller + paid.toBuyer).toBe(t.sellerBond + t.buyerDeposit);
      if (paid.outcome === 'disputed' || paid.outcome === 'cancelled') {
        expect(paid.toSeller).toBe(t.sellerBond);
        expect(paid.toBuyer).toBe(t.buyerDeposit);
      } else if (paid.outcome === 'seller_default') {
        expect(paid.toSeller).toBe(0n);
      } else {
        expect(paid.toBuyer <= t.sellerBond).toBe(true);
        expect(d.buyerConfirm).not.toBeNull();
      }
      settled++;
    }
    expect(settled).toBeGreaterThan(10_000);
  });
});
