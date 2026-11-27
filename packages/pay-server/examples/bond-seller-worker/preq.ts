// Optional: also take PREQ (Token-2022) on Solana for POST /x402/job. Off unless X402_PREQ = "on"; with it off the 402 is unchanged.
// Same USD price as USDC. The PREQ amount comes from pay-server's daily rate: the median of the previous UTC day's hourly samples
// (the cron records one sample per hour in the Durable Object). While that rate is unavailable, or when your seller wallet has no
// PREQ token account, the 402 lists PREQ under `notOffered` and offers USDC only. No payment rule or limit changes.
import { createRateBook, PREQ_MAINNET, type AccountFetcher, type DailyRate, type GateConfig, type PriceSample, type RateBook } from '@agent402-dev/pay-server';

export interface PreqEnv {
  X402_PREQ?: string;
}

/** Only the exact value "on" turns PREQ on */
export const preqOn = (env: PreqEnv): boolean => env.X402_PREQ === 'on';

/** One sample per hour at most (the cron runs every 2 minutes) */
export const RATE_SAMPLE_EVERY_MS = 55 * 60_000;
export const rateSampleDue = (lastMs: number | undefined, nowMs: number): boolean => lastMs === undefined || nowMs - lastMs >= RATE_SAMPLE_EVERY_MS;

/** Rate keys older than three days are dropped: rate:s:<ISO time> (samples) and rate:r:<YYYY-MM-DD> (daily rates) */
export function expiredRateKeys(keys: string[], nowMs: number): string[] {
  const cutoff = new Date(nowMs - 3 * 86_400_000).toISOString().slice(0, 10);
  return keys.filter((k) => /^rate:[sr]:/.test(k) && k.slice(7, 17) < cutoff);
}

/** What the Durable Object provides for the rate book */
export interface RateStorage {
  rateAddSample(s: PriceSample): Promise<void>;
  rateSamples(day: string): Promise<PriceSample[]>;
  rateGet(date: string): Promise<DailyRate | null>;
  ratePut(r: DailyRate): Promise<void>;
}

/** Rate book over the Durable Object (a stub belongs to one request: a new one on every call) */
export function preqRateBook(storage: () => RateStorage, fetcher?: AccountFetcher): RateBook {
  return createRateBook({
    store: { addSample: (x) => storage().rateAddSample(x), samples: (d) => storage().rateSamples(d), getRate: (d) => storage().rateGet(d), putRate: (r) => storage().ratePut(r) },
    ...(fetcher ? { fetcher } : {}),
  });
}

/** Gate settings for paidRouteHandler: {} when off, else the PREQ payment option */
export function preqGate(on: boolean, rates: () => RateBook): Partial<GateConfig> {
  return on ? { preq: { asset: PREQ_MAINNET, rate: () => rates().today() } } : {};
}
