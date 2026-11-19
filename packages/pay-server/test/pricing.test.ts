import BN from 'bn.js';
import { describe, expect, it } from 'vitest';
import { getPriceFromSqrtPrice } from '@meteora-ag/cp-amm-sdk';
import {
  a402Amount, dammV2Price, DEFAULT_GUARDS, decodePythPriceUpdate, fixRate, median, pythPriceAccount, PYTH_SOL_USD_FEED,
  type PriceSample,
} from 'a402-pay-server/pricing';

describe('가격 계산', () => {
  it('DAMM v2 sqrt_price → 가격: Meteora SDK getPriceFromSqrtPrice 와 일치', () => {
    for (const sqrt of [12345678901234567890n, 18446744073709551616n, 98765432109876543210n, 1234567890123n]) {
      const ours = dammV2Price(sqrt, 6, 9);
      const sdk = Number(getPriceFromSqrtPrice(new BN(sqrt.toString()), 6, 9).toString());
      expect(Math.abs(ours - sdk) / sdk).toBeLessThan(1e-9);
    }
  });
  it('Pyth SOL/USD 계정 주소 = PDA([shard 0, feed_id], push oracle) = 7UVimff…', () => {
    expect(pythPriceAccount()).toBe('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
  });
  it('Pyth PriceUpdateV2 해석 (Full / Partial)', () => {
    const make = (partial: boolean) => {
      const d = Buffer.alloc(134);
      d.writeUInt8(partial ? 0 : 1, 40);
      let o = 41 + (partial ? 1 : 0);
      Buffer.from(PYTH_SOL_USD_FEED, 'hex').copy(d, o); o += 32;
      d.writeBigInt64LE(7334515040n, o);
      d.writeBigUInt64LE(2735954n, o + 8);
      d.writeInt32LE(-8, o + 16);
      d.writeBigInt64LE(1795010000n, o + 20);
      return d;
    };
    for (const partial of [false, true]) {
      const p = decodePythPriceUpdate(make(partial));
      expect(p.verification).toBe(partial ? 'partial' : 'full');
      expect(p.feedId).toBe(PYTH_SOL_USD_FEED);
      expect(p.price).toBeCloseTo(73.3451504, 6);
      expect(p.conf).toBeCloseTo(0.02735954, 8);
      expect(p.publishTime).toBe(1795010000);
    }
  });
  it('median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('하루 고정 환율과 안전장치', () => {
  const sample = (hour: number, a402Usd: number, depth = 500): PriceSample => ({
    at: `2026-11-18T${String(hour).padStart(2, '0')}:05:00.000Z`,
    a402Sol: a402Usd / 70, solUsd: 70, solUsdConf: 0.03, a402Usd, poolSolSideUsd: depth, slot: hour, pythPublishTime: 0,
  });
  const day = (f: (h: number) => PriceSample) => Array.from({ length: 24 }, (_, h) => f(h));

  it('전날 기록의 중앙값 (튀는 몇 시간은 영향 없음)', () => {
    const xs = day((h) => sample(h, h < 3 ? 0.000004 : 0.000002)); // 3시간만 2배
    xs.push({ ...sample(1, 0.000002), at: '2026-11-19T01:00:00.000Z' }); // 당일 기록은 무시
    const r = fixRate('2026-11-19', xs);
    expect(r.status).toBe('off'); // 최고/최저 2배 > 1.5배
    const ys = day((h) => sample(h, h < 3 ? 0.0000025 : 0.000002)); // 1.25배
    const r2 = fixRate('2026-11-19', ys);
    expect(r2).toMatchObject({ status: 'on', basedOn: '2026-11-18', a402Usd: 0.000002, samples: 24 });
  });
  it('기록 12개 미만이면 off', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002)).slice(0, 11));
    expect(r).toMatchObject({ status: 'off', samples: 11 });
    expect((r as { reason: string }).reason).toContain('below the minimum of 12');
  });
  it('어느 한 시간이라도 풀 SOL 쪽 깊이가 100 USD 미만이면 off', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002, h === 7 ? 51 : 500)));
    expect(r.status).toBe('off');
    expect((r as { reason: string }).reason).toContain('51 USD');
  });
  it('A402 금액 = 0.02 × 0.7 USD ÷ 환율, 올림', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002)));
    if (r.status !== 'on') throw new Error('expected on');
    // 0.014 / 0.000002 = 7000 A402 → 7000_000000 원 단위
    expect(a402Amount(r)).toBe(7_000_000_000n);
    expect(a402Amount({ ...r, a402Usd: 0.0000030001 })).toBe(BigInt(Math.ceil((0.014 / 0.0000030001) * 1e6)));
  });
  it('기준값 (제안)', () => {
    expect(DEFAULT_GUARDS).toEqual({ minSamples: 12, minPoolSolSideUsd: 100, maxDailyRangeRatio: 1.5, maxOracleConfRatio: 0.01, maxOracleAgeSec: 120 });
  });
});
