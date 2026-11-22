use super::*;

const NOW: i64 = 1_800_000_000;

fn caps() -> Caps {
    Caps { per_deal: 100_000_000, total: 2_000_000_000 }
}

fn terms() -> Terms {
    Terms {
        price: 300_000_000,
        seller_bond: 30_000_000,
        buyer_deposit: 30_000_000,
        deliver_by: NOW + 10 * DAY,
        late_window: 2 * DAY,
        pay_window: 3 * DAY,
    }
}

fn opened() -> Deal {
    open(terms(), NOW, &caps(), 0).unwrap()
}

fn conserved(d: &Deal, p: &Payout) {
    assert_eq!(p.to_seller + p.to_buyer, d.terms.seller_bond + d.terms.buyer_deposit);
}

#[test]
fn open_validation() {
    let mut t = terms();
    t.seller_bond = 60_000_001;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::BondTooLarge));
    let mut t = terms();
    t.buyer_deposit = t.price + 1;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::DepositTooLarge));
    let mut t = terms();
    t.deliver_by = NOW;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::DeadlineInPast));
    let mut t = terms();
    t.deliver_by = NOW + MAX_TERM + 1;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::TermTooLong));
    let mut t = terms();
    t.late_window = MAX_LATE_WINDOW + 1;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::LateWindowTooLong));
    let mut t = terms();
    t.pay_window = 0;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::PayWindowOutOfRange));
    let small = Caps { per_deal: 59_999_999, total: 2_000_000_000 };
    assert_eq!(open(terms(), NOW, &small, 0), Err(Error::PerDealCapExceeded));
    assert_eq!(open(terms(), NOW, &caps(), 1_950_000_000), Err(Error::TotalCapExceeded));
    let mut t = terms();
    t.seller_bond = 0;
    assert_eq!(open(t, NOW, &caps(), 0), Err(Error::ZeroBond));
}

#[test]
fn rule1_delivered_on_time_and_paid() {
    let mut d = opened();
    d.seller_mark(NOW + DAY).unwrap();
    d.buyer_confirm(NOW + 2 * DAY).unwrap();
    assert_eq!(d.pay_balance(NOW + 2 * DAY).unwrap(), 270_000_000);
    let p = d.settle(NOW + 2 * DAY).unwrap();
    assert_eq!(p, Payout { to_seller: 60_000_000, to_buyer: 0, outcome: Outcome::Delivered });
    assert_eq!(d.settle(NOW + 3 * DAY), Err(Error::NotOpen));
}

#[test]
fn rule2_late_delivery_pro_rata() {
    let mut d = opened();
    let t1 = d.terms.t1();
    d.seller_mark(t1 + DAY).unwrap(); // half of the 2-day late window
    d.buyer_confirm(t1 + DAY + 100).unwrap();
    d.pay_balance(t1 + DAY + 100).unwrap();
    let p = d.settle(t1 + DAY + 100).unwrap();
    conserved(&d, &p);
    assert_eq!(p.to_buyer, 15_000_000);
    assert_eq!(p.to_seller, 15_000_000 + 30_000_000);
}

#[test]
fn buyer_delaying_confirm_does_not_increase_deduction() {
    let mut t = terms();
    t.deliver_by = NOW + 2 * DAY;
    t.pay_window = 30 * DAY;
    let mut d = open(t, NOW, &caps(), 0).unwrap();
    d.seller_mark(NOW + DAY).unwrap();
    // Buyer confirms after T1 but the seller marked on time.
    d.buyer_confirm(d.terms.t1() + DAY).unwrap();
    assert_eq!(d.late_deduction(), 0);
}

#[test]
fn rule3_buyer_default() {
    let mut d = opened();
    d.buyer_confirm(NOW + DAY).unwrap();
    // Early delivery: the pay window still runs from T1.
    let deadline = d.terms.t1() + d.terms.pay_window + GRACE;
    assert_eq!(d.settle(deadline), Err(Error::NotYetSettleable));
    assert_eq!(d.pay_balance(deadline + 1), Err(Error::PayTooLate));
    let p = d.settle(deadline + 1).unwrap();
    assert_eq!(p.outcome, Outcome::BuyerDefault);
    assert_eq!(p.to_seller, 60_000_000);
}

#[test]
fn rule4_disputed_is_neutral() {
    let mut d = opened();
    d.seller_mark(NOW + DAY).unwrap();
    let deadline = d.terms.t1() + d.terms.pay_window + GRACE;
    assert_eq!(d.settle(deadline), Err(Error::NotYetSettleable));
    assert_eq!(d.buyer_confirm(deadline + 1), Err(Error::ConfirmTooLate));
    let p = d.settle(deadline + 1).unwrap();
    assert_eq!(p, Payout { to_seller: 30_000_000, to_buyer: 30_000_000, outcome: Outcome::Disputed });
}

#[test]
fn rule5_seller_default() {
    let mut d = opened();
    let t2 = d.terms.t2();
    assert_eq!(d.settle(t2), Err(Error::NotYetSettleable));
    assert_eq!(d.seller_mark(t2 + 1), Err(Error::MarkTooLate));
    assert_eq!(d.buyer_confirm(t2 + 1), Err(Error::ConfirmTooLate));
    let p = d.settle(t2 + 1).unwrap();
    assert_eq!(p, Payout { to_seller: 0, to_buyer: 60_000_000, outcome: Outcome::SellerDefault });
}

#[test]
fn rule6_cancel_and_extend() {
    let mut d = opened();
    d.extend(NOW + 20 * DAY, DAY, 2 * DAY, NOW + DAY).unwrap();
    assert_eq!(d.terms.deliver_by, NOW + 20 * DAY);
    assert_eq!(d.extend(NOW, DAY, 2 * DAY, NOW + DAY), Err(Error::DeadlineInPast));
    let p = d.cancel().unwrap();
    assert_eq!(p, Payout { to_seller: 30_000_000, to_buyer: 30_000_000, outcome: Outcome::Cancelled });
    assert_eq!(d.settle(NOW + 400 * DAY), Err(Error::NotOpen));
}

#[test]
fn zero_balance_is_paid_on_confirm() {
    let mut t = terms();
    t.buyer_deposit = t.price / 5; // 60, still within per-deal cap with bond 30
    t.price = t.buyer_deposit;
    t.seller_bond = t.price / 10;
    let mut d = open(t, NOW, &caps(), 0).unwrap();
    d.buyer_confirm(NOW + DAY).unwrap();
    assert!(d.balance_paid);
    assert_eq!(d.settle(NOW + DAY).unwrap().outcome, Outcome::Delivered);
}

#[test]
fn caps_grow_two_percent_per_full_year() {
    assert_eq!(cap_at(100_000_000, NOW, NOW), 100_000_000);
    assert_eq!(cap_at(100_000_000, NOW, NOW + YEAR - 1), 100_000_000);
    assert_eq!(cap_at(100_000_000, NOW, NOW + YEAR), 102_000_000);
    assert_eq!(cap_at(100_000_000, NOW, NOW + 2 * YEAR), 104_040_000);
    assert_eq!(cap_at(100_000_000, NOW, NOW - 5), 100_000_000);
    // Bounded loop, no overflow.
    assert!(cap_at(u64::MAX, NOW, i64::MAX) == u64::MAX);
}

// ---------- randomized invariant checks ----------

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn range(&mut self, lo: i64, hi: i64) -> i64 {
        lo + (self.next() % ((hi - lo + 1) as u64)) as i64
    }
}

#[test]
fn random_sequences_hold_invariants() {
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let mut settled = 0u32;
    for _ in 0..200_000 {
        let price = rng.range(1, 1_000_000_000) as u64;
        let max_bond = price * MAX_BOND_BPS / 10_000;
        if max_bond == 0 {
            continue;
        }
        let t = Terms {
            price,
            seller_bond: rng.range(1, max_bond as i64) as u64,
            buyer_deposit: rng.range(0, price as i64) as u64,
            deliver_by: NOW + rng.range(1, MAX_TERM),
            late_window: rng.range(0, MAX_LATE_WINDOW),
            pay_window: rng.range(MIN_PAY_WINDOW, MAX_PAY_WINDOW),
        };
        let big = Caps { per_deal: u64::MAX, total: u64::MAX };
        let mut d = match open(t, NOW, &big, 0) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let settle_by = d.settle_by();
        let mut now = NOW;
        let mut paid_out: Option<Payout> = None;
        for _ in 0..8 {
            now += rng.range(0, 60 * DAY);
            let r = match rng.next() % 6 {
                0 => d.seller_mark(now).map(|_| None),
                1 => d.buyer_confirm(now).map(|_| None),
                2 => d.pay_balance(now).map(|_| None),
                3 => d.settle(now).map(Some),
                4 if rng.next().is_multiple_of(50) => d.cancel().map(Some),
                _ => Ok(None),
            };
            if let Ok(Some(p)) = r {
                assert!(paid_out.is_none(), "settled twice");
                paid_out = Some(p);
            }
            if let Some(dt) = d.delivery_time() {
                assert!(dt <= d.terms.t2(), "delivery after T2");
            }
        }
        // Liveness: settle always succeeds by settle_by().
        if paid_out.is_none() {
            let p = d.settle(settle_by.max(now)).expect("must be settleable");
            paid_out = Some(p);
        }
        let p = paid_out.unwrap();
        // Conservation and bounds.
        assert_eq!(p.to_seller as u128 + p.to_buyer as u128, t.seller_bond as u128 + t.buyer_deposit as u128);
        assert!(p.to_buyer <= t.seller_bond + t.buyer_deposit);
        match p.outcome {
            Outcome::Disputed | Outcome::Cancelled => {
                assert_eq!(p.to_seller, t.seller_bond);
                assert_eq!(p.to_buyer, t.buyer_deposit);
            }
            Outcome::SellerDefault => assert_eq!(p.to_seller, 0),
            Outcome::Delivered | Outcome::BuyerDefault => {
                assert!(p.to_buyer <= t.seller_bond);
                assert!(d.buyer_confirm.is_some());
            }
        }
        assert_eq!(d.status, Status::Closed);
        settled += 1;
    }
    assert!(settled > 100_000);
}

// ---------- mode A: adjustable caps ----------
mod mode_a {
    use crate::caps::*;
    use crate::{Error, DAY};
    const NOW: i64 = 1_800_000_000;
    const B: Bounds = Bounds { min_per_deal: 10, max_per_deal: 10_000, min_total: 100, max_total: 1_000_000 };

    #[test]
    fn change_waits_48h_and_is_bounded() {
        let mut c = AdjustableCaps::new(1_000, 20_000);
        c.propose(NOW, 2_000, 40_000, &B).unwrap();
        assert_eq!(c.effective(NOW + 2 * DAY - 1), (1_000, 20_000));
        assert_eq!(c.effective(NOW + 2 * DAY), (2_000, 40_000));
        // More than 2x up or below 1/2 is refused (relative to caps in force).
        assert_eq!(c.propose(NOW + 2 * DAY, 4_001, 40_000, &B), Err(Error::CapChangeOutOfBounds));
        assert_eq!(c.propose(NOW + 2 * DAY, 999, 40_000, &B), Err(Error::CapChangeOutOfBounds));
        // Hard bounds.
        let mut c = AdjustableCaps::new(9_000, 900_000);
        assert_eq!(c.propose(NOW, 10_001, 900_000, &B), Err(Error::CapChangeOutOfBounds));
        // per_deal must not exceed total.
        let mut c = AdjustableCaps::new(1_000, 1_000);
        assert_eq!(c.propose(NOW, 2_000, 1_000, &B), Err(Error::CapChangeOutOfBounds));
    }

    #[test]
    fn a_new_proposal_replaces_a_pending_one() {
        let mut c = AdjustableCaps::new(1_000, 20_000);
        c.propose(NOW, 2_000, 40_000, &B).unwrap();
        c.propose(NOW + DAY, 1_500, 30_000, &B).unwrap();
        assert_eq!(c.effective(NOW + 2 * DAY), (1_000, 20_000)); // old one dropped
        assert_eq!(c.effective(NOW + 3 * DAY), (1_500, 30_000));
    }

    #[test]
    fn repeated_changes_cannot_jump_faster_than_2x_per_48h() {
        let mut c = AdjustableCaps::new(1_000, 20_000);
        let mut t = NOW;
        for _ in 0..3 {
            let (p, tot) = c.effective(t);
            c.propose(t, p * 2, tot * 2, &B).unwrap();
            t += 2 * DAY;
        }
        // 1,000 -> 8,000 took 6 days; doubling again would pass the hard max.
        assert_eq!(c.effective(t), (8_000, 160_000));
        assert_eq!(c.propose(t, 16_000, 320_000, &B), Err(Error::CapChangeOutOfBounds));
    }
}

// ---------- mode B: price record and switch ----------
mod mode_b {
    use crate::price::*;
    use crate::DAY;
    const NOW: i64 = 1_800_000_000;
    const ONE: u128 = 1 << 64;

    #[test]
    fn sqrt_price_conversion() {
        // sqrt price 1.0 -> price 1.0 either way.
        assert_eq!(spot_from_sqrt(ONE, true).unwrap(), ONE);
        let inv = spot_from_sqrt(ONE, false).unwrap();
        assert!(inv.abs_diff(ONE) <= 1);
        // sqrt 2.0 -> 4.0 when PREQ is A; 0.25 when PREQ is B.
        assert_eq!(spot_from_sqrt(2 * ONE, true).unwrap(), 4 * ONE);
        assert!(spot_from_sqrt(2 * ONE, false).unwrap().abs_diff(ONE / 4) <= 1);
        assert!(spot_from_sqrt(MIN_SQRT_PRICE - 1, true).is_err());
        assert!(spot_from_sqrt(MAX_SQRT_PRICE + 1, true).is_err());
        assert!(spot_from_sqrt(MIN_SQRT_PRICE, false).is_ok());
        assert!(spot_from_sqrt(MAX_SQRT_PRICE, true).is_ok());
    }

    #[test]
    fn record_moves_at_most_5_percent_per_hour() {
        let mut r = PriceRecord::default();
        r.observe(ONE, NOW);
        // Flash pump to 100x: after 1 hour only +5%.
        r.observe(100 * ONE, NOW + HOUR);
        assert_eq!(r.price_q64, ONE + ONE / 20);
        // Same second: ignored.
        r.observe(100 * ONE, NOW + HOUR);
        assert_eq!(r.price_q64, ONE + ONE / 20);
        // After a long time, a single update moves at most 50%.
        let before = r.price_q64;
        r.observe(100 * ONE, NOW + 5 * HOUR);
        assert_eq!(r.price_q64, before + before / 5); // 4h * 5% = 20%
        let before = r.price_q64;
        r.observe(100 * ONE, NOW + 30 * HOUR);
        assert_eq!(r.price_q64, before + before / 2);
        // Crash: also limited.
        let before = r.price_q64;
        r.observe(1, NOW + 31 * HOUR);
        assert_eq!(r.price_q64, before - before / 20);
    }

    #[test]
    fn spamming_updates_every_second_cannot_freeze_the_price() {
        let mut r = PriceRecord::default();
        r.observe(ONE, NOW);
        for i in 1..=3600 {
            r.observe(100 * ONE, NOW + i);
        }
        // Compounded per-second steps over 1 hour: about +5.1%, not 0.
        let gain = (r.price_q64 - ONE) * 1000 / ONE;
        assert!((50..=52).contains(&gain), "gain per mille = {gain}");
    }

    #[test]
    fn gaps_restart_the_streak() {
        let mut r = PriceRecord::default();
        r.observe(ONE, NOW);
        r.observe(ONE, NOW + MAX_GAP);
        assert_eq!(r.streak_start, NOW);
        r.observe(ONE, NOW + 2 * MAX_GAP + 1);
        assert_eq!(r.streak_start, NOW + 2 * MAX_GAP + 1);
    }

    #[test]
    fn switch_needs_all_conditions() {
        let mut r = PriceRecord::default();
        let mut t = NOW;
        r.observe(ONE, t);
        r.observe_liquidity(true, t);
        while t < NOW + 90 * DAY {
            t += 5 * HOUR;
            r.observe_liquidity(true, t);
            r.observe(ONE, t);
        }
        assert!(switch_ready(&r, 100, 10_000, 10_000, t));
        // One low-liquidity observation resets the liquidity run.
        let mut thin = r;
        thin.observe_liquidity(false, t);
        thin.observe_liquidity(true, t);
        assert!(!switch_ready(&thin, 100, 10_000, 10_000, t));
        assert!(switch_ready(&thin, 100, 10_000, 10_000, t + SWITCH_MIN_LIQUID_FOR) == false); // stale record
        assert!(!switch_ready(&r, 99, 10_000, 10_000, t));
        assert!(!switch_ready(&r, 100, 9_999, 10_000, t));
        assert!(!switch_ready(&r, 100, 10_000, 10_000, t + STALE_AFTER + 1));
        let mut short = r;
        short.streak_start = t - 89 * DAY;
        assert!(!switch_ready(&short, 100, 10_000, 10_000, t));
    }

    #[test]
    fn cap_conversion_and_clamp() {
        let mut r = PriceRecord::default();
        // 1 PREQ unit = 0.5 quote unit -> 100 quote = 200 PREQ.
        r.observe(ONE / 2, NOW);
        assert_eq!(r.preq_cap(100, 1, 1_000), 200);
        assert_eq!(r.preq_cap(100, 1, 150), 150);
        assert_eq!(r.preq_cap(100, 500, 1_000), 500);
    }
}

#[test]
fn early_mark_cannot_end_the_deal_before_the_due_date() {
    // Seller marks one second after opening with a 1-day pay window.
    let mut t = terms();
    t.pay_window = DAY;
    let mut d = open(t, NOW, &caps(), 0).unwrap();
    d.seller_mark(NOW + 1).unwrap();
    // Before the fix the deal could settle as Disputed after about 2 days.
    assert_eq!(d.settle(NOW + 3 * DAY), Err(Error::NotYetSettleable));
    // The buyer can still confirm a delivery made on the due date.
    d.buyer_confirm(d.terms.deliver_by).unwrap();
    d.pay_balance(d.terms.deliver_by).unwrap();
    assert_eq!(d.settle(d.terms.deliver_by).unwrap().outcome, Outcome::Delivered);
}

#[test]
fn extensions_stay_within_max_term_of_opening() {
    let mut d = opened();
    let now = NOW + 100 * DAY;
    // 100 days in, a new due date 100 days later would make the term 200 days.
    assert_eq!(d.extend(now + 100 * DAY, 0, DAY, now), Err(Error::TermTooLong));
    d.extend(NOW + MAX_TERM, 0, DAY, now).unwrap();
    assert!(d.settle_by() <= NOW + MAX_TERM + 7 * DAY + 30 * DAY + 2 * GRACE + 1);
}
