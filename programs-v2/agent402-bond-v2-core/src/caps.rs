//! Per-mint caps on the amount locked: per deal and across open deals. The admin may change them only within
//! hard bounds, by at most 2x (or 1/2) per change, effective 48 hours after the proposal. Open deals are never affected.

pub const CAP_DELAY: i64 = 48 * 3_600;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bounds {
    pub per_deal_min: u64,
    pub per_deal_max: u64,
    pub total_min: u64,
    pub total_max: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Caps {
    pub per_deal: u64,
    pub total: u64,
    pub pending_per_deal: u64,
    pub pending_total: u64,
    /// 0 = no pending change
    pub pending_effective_at: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CapError {
    OutOfBounds,
}

impl Caps {
    pub fn new(per_deal: u64, total: u64) -> Self {
        Caps { per_deal, total, ..Default::default() }
    }
    /// Caps in force at `now`.
    pub fn effective(&self, now: i64) -> (u64, u64) {
        if self.pending_effective_at != 0 && now >= self.pending_effective_at {
            (self.pending_per_deal, self.pending_total)
        } else {
            (self.per_deal, self.total)
        }
    }
    /// Applies a pending change that has taken effect.
    pub fn fold(&mut self, now: i64) {
        let (p, t) = self.effective(now);
        if self.pending_effective_at != 0 && now >= self.pending_effective_at {
            self.per_deal = p;
            self.total = t;
            self.pending_per_deal = 0;
            self.pending_total = 0;
            self.pending_effective_at = 0;
        }
    }
    /// Proposes new caps (replaces a pending proposal not yet in force).
    pub fn propose(&mut self, now: i64, per_deal: u64, total: u64, b: &Bounds) -> Result<(), CapError> {
        self.fold(now);
        let within = |v: u64, cur: u64, lo: u64, hi: u64| {
            v >= lo && v <= hi && (v as u128) * 2 >= cur as u128 && (v as u128) <= (cur as u128) * 2
        };
        if !within(per_deal, self.per_deal, b.per_deal_min, b.per_deal_max)
            || !within(total, self.total, b.total_min, b.total_max)
            || per_deal > total
        {
            return Err(CapError::OutOfBounds);
        }
        self.pending_per_deal = per_deal;
        self.pending_total = total;
        self.pending_effective_at = now + CAP_DELAY;
        Ok(())
    }
}
