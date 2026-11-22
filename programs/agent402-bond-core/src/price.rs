//! Mode B: an on-chain price record with a speed limit, and the automatic
//! switch from mode A to mode B once enough data exists.
//!
//! Price unit: quote base units per 1 PREQ base unit, Q64.64.

use crate::{Error, DAY};

pub const HOUR: i64 = 3_600;
/// The recorded price may move at most 5% per hour toward the pool price...
pub const MAX_MOVE_BPS_PER_HOUR: u128 = 500;
/// ...and at most 50% in a single update.
pub const MAX_MOVE_BPS_PER_UPDATE: u128 = 5_000;
/// A gap longer than this restarts the continuity streak.
pub const MAX_GAP: i64 = 6 * HOUR;
/// Mode B refuses new PREQ deals if the record is older than this.
pub const STALE_AFTER: i64 = 6 * HOUR;

/// Automatic switch thresholds (all must hold).
pub const SWITCH_MIN_STREAK: i64 = 90 * DAY;
pub const SWITCH_MIN_SETTLED_DEALS: u64 = 100;
/// The pool must have held the minimum quote liquidity at every observation
/// for this long (one-transaction deposits cannot fake it).
pub const SWITCH_MIN_LIQUID_FOR: i64 = 30 * DAY;

/// DAMM v2 sqrt price bounds (Q64.64).
pub const MIN_SQRT_PRICE: u128 = 4_295_048_016;
pub const MAX_SQRT_PRICE: u128 = 79_226_673_521_066_979_257_578_248_091;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PriceRecord {
    pub price_q64: u128,
    pub last_update: i64,
    pub streak_start: i64,
    pub updates: u64,
    /// Start of the current run of observations with enough liquidity; 0 = none.
    pub liquid_since: i64,
}

/// x * num / den without overflow (num * den must fit in u128).
fn mul_div(x: u128, num: u128, den: u128) -> u128 {
    (x / den) * num + (x % den) * num / den
}

/// Spot price of PREQ in quote units (Q64.64) from a DAMM v2 sqrt price.
/// The pool price is token B per token A.
pub fn spot_from_sqrt(sqrt_q64: u128, preq_is_a: bool) -> Result<u128, Error> {
    if !(MIN_SQRT_PRICE..=MAX_SQRT_PRICE).contains(&sqrt_q64) {
        return Err(Error::BadPoolPrice);
    }
    // sqrt < 2^96, so (sqrt >> 32)^2 < 2^128: price of A in B as Q64.64.
    let s = sqrt_q64 >> 32;
    let a_in_b = s * s;
    if a_in_b == 0 {
        return Err(Error::BadPoolPrice);
    }
    Ok(if preq_is_a { a_in_b } else { u128::MAX / a_in_b })
}

impl PriceRecord {
    /// Records liquidity first (every call, even within the same second),
    /// then the price.
    pub fn observe_liquidity(&mut self, liquid: bool, now: i64) {
        if !liquid {
            self.liquid_since = 0;
        } else if self.liquid_since == 0 {
            self.liquid_since = now;
        }
    }

    pub fn observe(&mut self, spot: u128, now: i64) {
        if self.updates == 0 {
            let liquid_since = self.liquid_since;
            *self = Self { price_q64: spot, last_update: now, streak_start: now, updates: 1, liquid_since };
            return;
        }
        if now <= self.last_update {
            return;
        }
        let dt = (now - self.last_update) as u128;
        if now - self.last_update > MAX_GAP {
            self.streak_start = now;
        }
        // Allowed move = price * 5% * dt / 1h, capped at 50%, computed exactly
        // so frequent updates cannot round the move down to zero.
        let num = (MAX_MOVE_BPS_PER_HOUR * dt).min(MAX_MOVE_BPS_PER_UPDATE * HOUR as u128);
        let step = mul_div(self.price_q64, num, 10_000 * HOUR as u128);
        let hi = self.price_q64.saturating_add(step);
        let lo = self.price_q64.saturating_sub(step).max(1);
        self.price_q64 = spot.clamp(lo, hi);
        self.last_update = now;
        self.updates += 1;
    }

    pub fn is_fresh(&self, now: i64) -> bool {
        self.updates > 0 && now - self.last_update <= STALE_AFTER
    }

    /// Convert a cap in quote units into PREQ units, clamped to bounds.
    pub fn preq_cap(&self, quote_cap: u64, lo: u64, hi: u64) -> u64 {
        if self.price_q64 == 0 {
            return lo;
        }
        let v = ((quote_cap as u128) << 64) / self.price_q64;
        (v.min(u64::MAX as u128) as u64).clamp(lo, hi)
    }
}

/// True when mode B may replace mode A for good.
pub fn switch_ready(rec: &PriceRecord, settled_deals: u64, quote_reserve: u64, min_quote_reserve: u64, now: i64) -> bool {
    rec.is_fresh(now)
        && now - rec.streak_start >= SWITCH_MIN_STREAK
        && settled_deals >= SWITCH_MIN_SETTLED_DEALS
        && quote_reserve >= min_quote_reserve
        && rec.liquid_since != 0
        && now - rec.liquid_since >= SWITCH_MIN_LIQUID_FOR
}
