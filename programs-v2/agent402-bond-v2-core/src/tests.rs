use super::caps::*;
use super::*;

const NOW: i64 = 1_800_000_000;
const U: u64 = 1_000_000;

fn terms() -> Terms {
    Terms {
        price: 20 * U,
        seller_bond: 2 * U,
        buyer_deposit: 5 * U,
        deliver_by: NOW + HOUR,
        grace: DAY,
        review_window: DAY,
        seller_share_bps: 0,
        has_arbiter: false,
        arbiter_window: 0,
    }
}
fn ok_open(t: &Terms) -> Result<(), Error> {
    check_open(t, NOW, false, false, false, 100 * U, 2_000 * U, 0)
}

#[test]
fn open_checks() {
    assert_eq!(ok_open(&terms()), Ok(()));
    let e = |f: fn(&mut Terms)| { let mut t = terms(); f(&mut t); ok_open(&t) };
    assert_eq!(e(|t| t.price = 0), Err(Error::ZeroPrice));
    assert_eq!(e(|t| t.seller_bond = 0), Err(Error::ZeroBond));
    assert_eq!(e(|t| t.seller_bond = 4 * U + 1), Err(Error::BondTooLarge));
    assert_eq!(e(|t| t.seller_bond = 4 * U), Ok(()));
    assert_eq!(e(|t| t.buyer_deposit = 21 * U), Err(Error::DepositTooLarge));
    assert_eq!(e(|t| t.deliver_by = NOW), Err(Error::DeadlineInPast));
    assert_eq!(e(|t| t.deliver_by = NOW + MAX_DELIVER + 1), Err(Error::TermTooLong));
    assert_eq!(e(|t| t.grace = GRACE_MIN - 1), Err(Error::GraceOutOfRange));
    assert_eq!(e(|t| t.review_window = REVIEW_MAX + 1), Err(Error::ReviewWindowOutOfRange));
    assert_eq!(e(|t| t.seller_share_bps = 10_001), Err(Error::BadShare));
    assert_eq!(e(|t| t.arbiter_window = HOUR), Err(Error::BadArbiter));
    assert_eq!(e(|t| { t.has_arbiter = true; t.arbiter_window = 0 }), Err(Error::BadArbiter));
    let mut t = terms(); t.has_arbiter = true; t.arbiter_window = DAY;
    assert_eq!(check_open(&t, NOW, false, false, true, 100 * U, 2_000 * U, 0), Err(Error::BadArbiter));
    assert_eq!(check_open(&terms(), NOW, true, false, false, 100 * U, 2_000 * U, 0), Err(Error::Paused));
    assert_eq!(check_open(&terms(), NOW, false, true, false, 100 * U, 2_000 * U, 0), Err(Error::SameParty));
    assert_eq!(check_open(&terms(), NOW, false, false, false, 7 * U - 1, 2_000 * U, 0), Err(Error::PerDealCapExceeded));
    assert_eq!(check_open(&terms(), NOW, false, false, false, 100 * U, 2_000 * U, 1_994 * U), Err(Error::TotalCapExceeded));
    assert_eq!(check_open(&terms(), NOW, false, false, false, 100 * U, 2_000 * U, 1_993 * U), Ok(()));
}

#[test]
fn outcomes_table() {
    let t = terms();
    let open = || Deal::open(t, NOW);
    let mut d = open();
    assert_eq!(d.accept(NOW + 10).unwrap(), Decision { outcome: Outcome::Accepted, to_seller: 7 * U, to_buyer: 0 });
    assert_eq!(d.accept(NOW + 11), Err(Error::NotOpen));
    let mut d = open();
    assert_eq!(d.settle(t.m()), Err(Error::NotYetSettleable));
    assert_eq!(d.settle(t.m() + 1).unwrap(), Decision { outcome: Outcome::SellerDefault, to_seller: 0, to_buyer: 7 * U });
    let mut d = open();
    d.mark(NOW + 5).unwrap();
    let a = d.a().unwrap();
    assert_eq!(a, t.deliver_by + t.review_window, "an early mark counts from deliver_by");
    assert_eq!(d.settle(a), Err(Error::NotYetSettleable));
    assert_eq!(d.settle(a + 1).unwrap(), Decision { outcome: Outcome::Unconfirmed, to_seller: 2 * U, to_buyer: 5 * U });
    let mut t2 = t; t2.seller_share_bps = 3_333;
    let mut d = Deal::open(t2, NOW); d.mark(NOW + 5).unwrap();
    // k = floor(5_000_000 * 3333 / 10000) = 1_666_500
    assert_eq!(d.settle(d.a().unwrap() + 1).unwrap().to_seller, 2 * U + 1_666_500);
    assert_eq!(open().cancel().unwrap(), Decision { outcome: Outcome::Cancelled, to_seller: 2 * U, to_buyer: 5 * U });
    assert_eq!(open().settle_agreed(3 * U).unwrap().to_buyer, 4 * U);
    assert_eq!(open().settle_agreed(7 * U + 1), Err(Error::BadSplit));
    assert_eq!(open().seller_release(t.m()).unwrap().outcome, Outcome::Released);
    assert_eq!(open().seller_release(t.m() + 1), Err(Error::ReleaseTooLate));
}

#[test]
fn deadlines_boundaries() {
    let t = terms();
    let mut d = Deal::open(t, NOW);
    assert_eq!(d.mark(t.m() + 1), Err(Error::MarkTooLate));
    d.mark(t.m()).unwrap();
    assert_eq!(d.mark(t.m()), Err(Error::AlreadyMarked));
    let a = d.a().unwrap();
    assert_eq!(a, t.m() + t.review_window);
    let mut x = d;
    assert!(x.accept(a).is_ok());
    let mut y = d;
    assert_eq!(y.accept(a + 1), Err(Error::AcceptTooLate));
    assert!(y.settle(a + 1).is_ok());
    let mut o = Deal::open(t, NOW);
    assert_eq!(o.accept(t.m() + 1), Err(Error::AcceptTooLate), "unmarked: accept closes with the mark deadline");
}

#[test]
fn arbiter_window() {
    let mut t = terms(); t.has_arbiter = true; t.arbiter_window = DAY;
    let mut d = Deal::open(t, NOW);
    assert_eq!(d.seller_release(NOW + 1), Err(Error::ArbiterSet));
    d.mark(NOW + 10).unwrap();
    let (a, r) = (d.a().unwrap(), d.r().unwrap());
    let mut x = d;
    assert_eq!(x.decide(a, true, 1), Err(Error::OutsideArbiterWindow));
    assert_eq!(x.decide(a + 1, false, 1), Err(Error::Unauthorized));
    assert_eq!(x.decide(r + 1, true, 1), Err(Error::OutsideArbiterWindow));
    assert_eq!(x.settle(r), Err(Error::NotYetSettleable));
    assert_eq!(x.decide(r, true, 6 * U).unwrap(), Decision { outcome: Outcome::Arbitrated, to_seller: 6 * U, to_buyer: U });
    let mut y = d;
    assert_eq!(y.settle(r + 1).unwrap().outcome, Outcome::Unconfirmed);
}

#[test]
fn extend_rules() {
    let t = terms();
    let mut d = Deal::open(t, NOW);
    assert_eq!(d.extend(t.deliver_by, t.review_window), Err(Error::ExtendNotLonger));
    assert_eq!(d.extend(t.deliver_by - 1, t.review_window + 1), Err(Error::ExtendNotLonger));
    assert_eq!(d.extend(NOW + MAX_DELIVER + 1, t.review_window), Err(Error::TermTooLong));
    assert_eq!(d.extend(t.deliver_by, REVIEW_MAX + 1), Err(Error::ReviewWindowOutOfRange));
    d.extend(t.deliver_by + DAY, t.review_window).unwrap();
    assert_eq!(d.terms.m(), t.m() + DAY);
}

#[test]
fn finalize_and_claims() {
    let dec = Decision { outcome: Outcome::Unconfirmed, to_seller: 3, to_buyer: 4 };
    assert_eq!(finalize(&dec, 7, 7), Owed { seller: 3, buyer: 4, short: false });
    assert_eq!(finalize(&dec, 7, 9), Owed { seller: 3, buyer: 4, short: false });
    let s = finalize(&dec, 7, 5);
    assert_eq!((s.seller + s.buyer, s.short), (5, true));
    assert_eq!(s.seller, 2); // floor(3 * 5 / 7)
    assert_eq!(claim_seller_amount(3, 9), 3);
    assert_eq!(claim_buyer_amount(3, 9), 6, "surplus goes to the buyer");
    assert_eq!(claim_buyer_amount(0, 9), 9);
}

#[test]
fn caps_rules() {
    let b = Bounds { per_deal_min: 10, per_deal_max: 1_000, total_min: 1_000, total_max: 50_000 };
    let mut c = Caps::new(100, 2_000);
    assert_eq!(c.propose(NOW, 201, 2_000, &b), Err(CapError::OutOfBounds), "more than 2x");
    assert_eq!(c.propose(NOW, 49, 2_000, &b), Err(CapError::OutOfBounds), "less than half");
    assert_eq!(c.propose(NOW, 100, 999, &b), Err(CapError::OutOfBounds), "under the hard minimum");
    c.propose(NOW, 200, 4_000, &b).unwrap();
    assert_eq!(c.effective(NOW + CAP_DELAY - 1), (100, 2_000));
    assert_eq!(c.effective(NOW + CAP_DELAY), (200, 4_000));
    // a new proposal before it takes effect replaces it, measured against the caps in force
    c.propose(NOW + 10, 150, 3_000, &b).unwrap();
    assert_eq!(c.effective(NOW + 10 + CAP_DELAY), (150, 3_000));
    // after it takes effect, the next change is measured from the new values
    c.propose(NOW + 10 + CAP_DELAY, 300, 6_000, &b).unwrap();
}

// ---------- randomized properties ----------
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
    fn range(&mut self, lo: i64, hi: i64) -> i64 { lo + (self.next() % ((hi - lo + 1) as u64)) as i64 }
    fn u(&mut self, hi: u64) -> u64 { self.next() % (hi + 1) }
}
fn random_terms(r: &mut Rng) -> Terms {
    let price = 1 + r.u(1_000 * U);
    let max_bond = price * MAX_BOND_BPS / BPS;
    let seller_bond = if max_bond == 0 { 1 } else { 1 + r.u(max_bond - 1) };
    let has_arbiter = r.u(2) == 0;
    Terms {
        price: price.max(seller_bond * 5),
        seller_bond,
        buyer_deposit: r.u(price),
        deliver_by: NOW + r.range(1, MAX_DELIVER),
        grace: r.range(GRACE_MIN, GRACE_MAX),
        review_window: r.range(REVIEW_MIN, REVIEW_MAX),
        seller_share_bps: r.u(BPS) as u16,
        has_arbiter,
        arbiter_window: if has_arbiter { r.range(ARB_MIN, ARB_MAX) } else { 0 },
    }
}

#[test]
fn property_no_gap_and_conservation() {
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    for _ in 0..20_000 {
        let t = random_terms(&mut r);
        let mut d = Deal::open(t, NOW);
        // maybe mark at a random time inside its window
        if r.u(1) == 0 {
            let at = r.range(NOW, t.m());
            d.mark(at).unwrap();
        }
        // at every probe time: exactly one of {party action window, arbiter window, settle} is open
        for _ in 0..8 {
            let now = r.range(NOW, d.settle_by() + DAY);
            let party = match d.state {
                State::Open => now <= t.m(),
                State::Marked => now <= d.a().unwrap(),
                State::Settled => unreachable!(),
            };
            let arb = d.state == State::Marked && t.has_arbiter && now > d.a().unwrap() && now <= d.r().unwrap();
            let settle_ok = { let mut x = d; x.settle(now).is_ok() };
            let accept_ok = { let mut x = d; x.accept(now).is_ok() };
            assert_eq!(accept_ok, party, "accept is possible exactly in the party window");
            assert_eq!([party, arb, settle_ok].iter().filter(|b| **b).count(), 1, "terms {t:?} state {:?} now {now}", d.state);
            if t.has_arbiter && d.state == State::Marked {
                let dec_ok = { let mut x = d; x.decide(now, true, 0).is_ok() };
                assert_eq!(dec_ok, arb);
            }
        }
        // settle always works from settle_by on, and every terminal path conserves the locked amount
        let mut x = d;
        let dec = x.settle(d.settle_by()).expect("settle_by is always settleable");
        assert_eq!(dec.to_seller + dec.to_buyer, t.locked());
        for dec in [
            { let mut y = d; y.cancel().unwrap() },
            { let mut y = d; let s = r.u(t.locked()); y.settle_agreed(s).unwrap() },
        ] {
            assert_eq!(dec.to_seller + dec.to_buyer, t.locked());
        }
        // seller_release never gives the buyer less than an unaccepted marked deal would
        if !t.has_arbiter {
            let rel = { let mut y = d; y.seller_release(NOW).unwrap() };
            let mut m = Deal::open(t, NOW); m.mark(NOW).unwrap();
            let unc = m.settle(m.r().unwrap() + 1).unwrap();
            assert!(rel.to_buyer >= unc.to_buyer);
        }
        // a short vault still pays exactly what it holds
        let v = r.u(t.locked());
        let o = finalize(&dec, t.locked(), v);
        assert_eq!(o.seller + o.buyer, if v >= t.locked() { t.locked() } else { v });
        assert!(o.seller <= dec.to_seller);
        // claims in either order move everything out of the vault
        for seller_first in [true, false] {
            let mut vault = v.max(t.locked()) + r.u(10);
            let mut owed = finalize(&dec, t.locked(), vault).seller;
            let (mut got_s, mut got_b) = (0, 0);
            let mut step = |seller: bool, vault: &mut u64, owed: &mut u64| {
                if seller { let a = claim_seller_amount(*owed, *vault); *vault -= a; *owed -= a; got_s += a } else { let a = claim_buyer_amount(*owed, *vault); *vault -= a; got_b += a }
            };
            step(seller_first, &mut vault, &mut owed);
            step(!seller_first, &mut vault, &mut owed);
            assert_eq!(vault, 0);
            assert_eq!(got_s, dec.to_seller);
            assert!(got_b >= dec.to_buyer);
        }
    }
}
