// Payment token (PREQ) rate: sampled hourly, then fixed for the day at the median of the previous day's samples (if a guard trips, token payments are off that day).
// Pool and mint addresses are read from preq.ts only (PoolTarget default). A402 (v1) is deprecated: only when passed explicitly (with a warning).
// The store is an interface: memory (default, tests), file (Node: rates-file.ts), Durable Object (Workers example), etc.
import { DEFAULT_GUARDS, fixRate, PREQ_POOL_TARGET, samplePrice, type DailyRate, type PoolTarget, type PriceSample, type RateGuards } from './pricing.js';
import type { AccountFetcher } from './chain.js';

export interface RateStore {
  addSample(s: PriceSample): Promise<void>;
  /** Samples for one UTC date (YYYY-MM-DD) */
  samples(day: string): Promise<PriceSample[]>;
  getRate(date: string): Promise<DailyRate | null>;
  putRate(r: DailyRate): Promise<void>;
}

export function memoryRateStore(): RateStore {
  const samples: PriceSample[] = [];
  const rates = new Map<string, DailyRate>();
  return {
    async addSample(s) { samples.push(s); },
    async samples(day) { return samples.filter((s) => s.at.slice(0, 10) === day); },
    async getRate(date) { return rates.get(date) ?? null; },
    async putRate(r) { rates.set(r.date, r); },
  };
}

const prevDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

export interface RateBook {
  /** Records one sample (e.g. from an hourly cron). Throws if outside the oracle quality bounds; nothing is recorded */
  record(): Promise<PriceSample>;
  /**
   * Today's (UTC) fixed rate. Computed from the previous day's samples on first request and stored.
   * Same-day guard: if any of today's samples so far has a SOL-side depth below the minimum, or a price
   * that differs from the fixed rate by more than the daily range limit, today's rate is returned as off
   * (the stored rate is left as it was). This only turns PREQ off; it never turns it on.
   */
  today(): Promise<DailyRate>;
}

/** Same-day guard on a fixed rate: off if today's samples show low depth or a price far from the fixed rate */
export function intradayCheck(rate: DailyRate, todaySamples: PriceSample[], guards = DEFAULT_GUARDS): DailyRate {
  if (rate.status !== 'on') return rate;
  const off = (reason: string): DailyRate => ({ status: 'off', date: rate.date, basedOn: rate.basedOn, reason, samples: rate.samples });
  for (const s of todaySamples) {
    const depth = Number.isFinite(s.poolSolSideUsd) ? s.poolSolSideUsd : 0;
    if (depth < guards.minPoolSolSideUsd) {
      return off(`${rate.date} (today): pool SOL-side depth ${depth.toFixed(0)} USD at ${s.at}, below the minimum of ${guards.minPoolSolSideUsd} USD`);
    }
    if (!Number.isFinite(s.tokenUsd) || !(s.tokenUsd > 0)) return off(`${rate.date} (today): invalid (zero, negative or non-finite) price sample at ${s.at}`);
    const ratio = Math.max(s.tokenUsd / rate.tokenUsd, rate.tokenUsd / s.tokenUsd);
    if (!Number.isFinite(ratio) || ratio > guards.maxDailyRangeRatio) {
      return off(`${rate.date} (today): price at ${s.at} differs from the fixed rate by ${ratio.toFixed(2)}x, above the limit of ${guards.maxDailyRangeRatio}`);
    }
  }
  return rate;
}

export function createRateBook(o: { store: RateStore; fetcher?: AccountFetcher; guards?: RateGuards; now?: () => Date; target?: PoolTarget }): RateBook {
  const now = o.now ?? (() => new Date());
  const guards = o.guards ?? DEFAULT_GUARDS;
  const target = o.target ?? PREQ_POOL_TARGET;
  return {
    async record() {
      if (!o.fetcher) throw new Error('rate book: no account fetcher configured');
      const s = await samplePrice(o.fetcher, now, guards, target);
      await o.store.addSample(s);
      return s;
    },
    async today() {
      const date = now().toISOString().slice(0, 10);
      // Samples of other tokens (e.g. old A402 samples without symbol) are not mixed in
      const mine = (xs: PriceSample[]) => xs.filter((s) => (s.symbol ?? 'A402') === target.symbol);
      let r = await o.store.getRate(date);
      if (!r) {
        r = fixRate(date, mine(await o.store.samples(prevDay(date))), guards);
        await o.store.putRate(r);
      }
      if (r.status !== 'on') return r;
      return intradayCheck(r, mine(await o.store.samples(date)), guards);
    },
  };
}
