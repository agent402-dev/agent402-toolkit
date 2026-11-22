//! Mode A: operator-adjustable caps for NEW deals only, with hard limits.
//! - each value stays inside code bounds
//! - one change moves a value by at most 2x up or 1/2 down
//! - a change takes effect 48 hours after it is proposed

use crate::{Error, DAY};

pub const CAP_CHANGE_DELAY: i64 = 2 * DAY;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bounds {
    pub min_per_deal: u64,
    pub max_per_deal: u64,
    pub min_total: u64,
    pub max_total: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AdjustableCaps {
    pub per_deal: u64,
    pub total: u64,
    pub pending_per_deal: u64,
    pub pending_total: u64,
    /// 0 = nothing pending.
    pub effective_at: i64,
}

impl AdjustableCaps {
    pub fn new(per_deal: u64, total: u64) -> Self {
        Self { per_deal, total, ..Default::default() }
    }

    /// Caps in force at `now`.
    pub fn effective(&self, now: i64) -> (u64, u64) {
        if self.effective_at != 0 && now >= self.effective_at {
            (self.pending_per_deal, self.pending_total)
        } else {
            (self.per_deal, self.total)
        }
    }

    fn fold(&mut self, now: i64) {
        let (p, t) = self.effective(now);
        self.per_deal = p;
        self.total = t;
        self.pending_per_deal = 0;
        self.pending_total = 0;
        self.effective_at = 0;
    }

    /// Admin proposes new caps. Replaces any change not yet in force.
    pub fn propose(&mut self, now: i64, per_deal: u64, total: u64, b: &Bounds) -> Result<(), Error> {
        self.fold(now);
        let within = |v: u64, cur: u64, lo: u64, hi: u64| -> bool {
            let up = cur.saturating_mul(2);
            let down = cur / 2;
            v >= lo && v <= hi && v <= up && v >= down
        };
        if !within(per_deal, self.per_deal, b.min_per_deal, b.max_per_deal)
            || !within(total, self.total, b.min_total, b.max_total)
            || per_deal > total
        {
            return Err(Error::CapChangeOutOfBounds);
        }
        self.pending_per_deal = per_deal;
        self.pending_total = total;
        self.effective_at = now.saturating_add(CAP_CHANGE_DELAY);
        Ok(())
    }
}
