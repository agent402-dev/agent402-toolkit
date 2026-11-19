// A402 환율: 매시간 기록 → 전날 기록의 중앙값으로 하루 고정 (안전장치에 걸리면 그날 A402 끔).
// 저장소는 인터페이스 — 메모리(기본·테스트), 파일(Node: rates-file.ts), Durable Object(Workers 예제) 등
import { DEFAULT_GUARDS, fixRate, samplePrice, type DailyRate, type PriceSample, type RateGuards } from './pricing.js';
import type { AccountFetcher } from './chain.js';

export interface RateStore {
  addSample(s: PriceSample): Promise<void>;
  /** UTC 날짜(YYYY-MM-DD) 하루치 기록 */
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
  /** 기록 하나 남기기 (매시간 cron 등에서). 오라클 품질 기준 밖이면 예외 — 기록하지 않음 */
  record(): Promise<PriceSample>;
  /** 오늘(UTC) 고정 환율. 처음 물을 때 전날 기록으로 계산해 저장 */
  today(): Promise<DailyRate>;
}

export function createRateBook(o: { store: RateStore; fetcher?: AccountFetcher; guards?: RateGuards; now?: () => Date }): RateBook {
  const now = o.now ?? (() => new Date());
  const guards = o.guards ?? DEFAULT_GUARDS;
  return {
    async record() {
      if (!o.fetcher) throw new Error('rate book: no account fetcher configured');
      const s = await samplePrice(o.fetcher, now, guards);
      await o.store.addSample(s);
      return s;
    },
    async today() {
      const date = now().toISOString().slice(0, 10);
      const cached = await o.store.getRate(date);
      if (cached) return cached;
      const r = fixRate(date, await o.store.samples(prevDay(date)), guards);
      await o.store.putRate(r);
      return r;
    },
  };
}

/** A402 로 낼 금액 (원 단위): priceUsd × (1 − 할인) ÷ 고정 환율, 올림 */
export function a402AmountFor(priceUsd: number, discountPercent: number, rate: Extract<DailyRate, { status: 'on' }>, decimals = 6): bigint {
  const usd = priceUsd * (1 - discountPercent / 100);
  return BigInt(Math.ceil((usd / rate.a402Usd) * 10 ** decimals));
}
