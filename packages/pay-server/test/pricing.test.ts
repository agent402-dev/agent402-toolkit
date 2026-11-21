import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { getPriceFromSqrtPrice } from '@meteora-ag/cp-amm-sdk';
import {
  A402_POOL_TARGET, dammV2Price, dammV2VaultAddress, DEFAULT_GUARDS, decodePythPriceUpdate, fixRate, median, PREQ_POOL_TARGET, pythPriceAccount, PYTH_RECEIVER,
  PYTH_SOL_USD_FEED, samplePrice, tokenAmount, tokenAmountFor, tokenSolFromPool, WSOL_MINT, type PriceSample,
} from '@agent402-dev/pay-server/pricing';

describe('price calculation', () => {
  it('DAMM v2 sqrt_price → price: matches Meteora SDK getPriceFromSqrtPrice', () => {
    for (const sqrt of [12345678901234567890n, 18446744073709551616n, 98765432109876543210n, 1234567890123n]) {
      const ours = dammV2Price(sqrt, 6, 9);
      const sdk = Number(getPriceFromSqrtPrice(new BN(sqrt.toString()), 6, 9).toString());
      expect(Math.abs(ours - sdk) / sdk).toBeLessThan(1e-9);
    }
  });
  it('Pyth SOL/USD account address = PDA([shard 0, feed_id], push oracle) = 7UVimff…', () => {
    expect(pythPriceAccount()).toBe('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
  });
  it('decodes Pyth PriceUpdateV2 (Full / Partial)', () => {
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

describe('daily fixed rate and guards', () => {
  const sample = (hour: number, tokenUsd: number, depth = 500): PriceSample => ({
    at: `2026-11-18T${String(hour).padStart(2, '0')}:05:00.000Z`,
    symbol: 'PREQ', tokenSol: tokenUsd / 70, solUsd: 70, solUsdConf: 0.03, tokenUsd, poolSolSideUsd: depth, slot: hour, pythPublishTime: 0,
  });
  const day = (f: (h: number) => PriceSample) => Array.from({ length: 24 }, (_, h) => f(h));

  it('median of the previous day\'s samples (a few spiky hours have no effect)', () => {
    const xs = day((h) => sample(h, h < 3 ? 0.000004 : 0.000002)); // 2x for only 3 hours
    xs.push({ ...sample(1, 0.000002), at: '2026-11-19T01:00:00.000Z' }); // same-day samples are ignored
    const r = fixRate('2026-11-19', xs);
    expect(r.status).toBe('off'); // high/low 2x > 1.5x
    const ys = day((h) => sample(h, h < 3 ? 0.0000025 : 0.000002)); // 1.25x
    const r2 = fixRate('2026-11-19', ys);
    expect(r2).toMatchObject({ status: 'on', basedOn: '2026-11-18', tokenUsd: 0.000002, samples: 24 });
  });
  it('off if fewer than 12 samples', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002)).slice(0, 11));
    expect(r).toMatchObject({ status: 'off', samples: 11 });
    expect((r as { reason: string }).reason).toContain('below the minimum of 12');
  });
  it('off if the SOL-side pool depth is below 100 USD in any hour', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002, h === 7 ? 51 : 500)));
    expect(r.status).toBe('off');
    expect((r as { reason: string }).reason).toContain('51 USD');
  });
  it('token (PREQ) amount = 0.02 USD ÷ rate, rounded up (no discount by default)', () => {
    const r = fixRate('2026-11-19', day((h) => sample(h, 0.000002)));
    if (r.status !== 'on') throw new Error('expected on');
    // 0.02 / 0.000002 = 10000 PREQ → 10000_000000 base units
    expect(tokenAmount(r)).toBe(10_000_000_000n);
    expect(tokenAmount({ ...r, tokenUsd: 0.0000030001 })).toBe(BigInt(Math.ceil((0.02 / 0.0000030001) * 1e6)));
  });
  it('thresholds (proposed)', () => {
    expect(DEFAULT_GUARDS).toEqual({ minSamples: 12, minPoolSolSideUsd: 100, maxDailyRangeRatio: 1.5, maxOracleConfRatio: 0.01, maxOracleAgeSec: 120 });
  });
});

// ---- PREQ switch: pool address from one constant; no division by zero or abnormal values even in a single-sided pool (SOL side nearly empty right after trading starts) ----
describe('PREQ price calculation (fake accounts, no network)', () => {
  const key = () => Keypair.generate().publicKey;
  const poolData = (o: { a: string; b: string; va: string; vb: string; sqrt: bigint }) => {
    const d = Buffer.alloc(1112);
    Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(d, 0);
    new PublicKey(o.a).toBuffer().copy(d, 168);
    new PublicKey(o.b).toBuffer().copy(d, 200);
    new PublicKey(o.va).toBuffer().copy(d, 232);
    new PublicKey(o.vb).toBuffer().copy(d, 264);
    d.writeBigUInt64LE(o.sqrt & ((1n << 64n) - 1n), 456);
    d.writeBigUInt64LE(o.sqrt >> 64n, 464);
    return new Uint8Array(d);
  };
  const vaultData = (lamports: bigint) => { const d = Buffer.alloc(165); d.writeBigUInt64LE(lamports, 64); return new Uint8Array(d); };
  const NOW = new Date('2026-12-01T00:05:00Z');
  const pythData = () => {
    const d = Buffer.alloc(134);
    d.writeUInt8(1, 40);
    let o = 41;
    Buffer.from(PYTH_SOL_USD_FEED, 'hex').copy(d, o); o += 32;
    d.writeBigInt64LE(15_000_000_000n, o); // 150 USD (expo -8)
    d.writeBigUInt64LE(5_000_000n, o + 8);
    d.writeInt32LE(-8, o + 16);
    d.writeBigInt64LE(BigInt(Math.floor(NOW.getTime() / 1000) - 10), o + 20);
    return new Uint8Array(d);
  };
  /** One token (PREQ test mint)/WSOL pool over a fake RPC */
  function world(o: { sqrt: bigint; solLamports: bigint; tokenIsA?: boolean }) {
    const mint = key().toBase58();
    const pool = key().toBase58();
    const solVault = dammV2VaultAddress(WSOL_MINT, pool);
    const tokVault = key().toBase58();
    const tokenIsA = o.tokenIsA ?? true;
    const accounts: Record<string, { owner: string; data: Uint8Array }> = {
      [pool]: { owner: 'cp', data: poolData(tokenIsA ? { a: mint, b: WSOL_MINT, va: tokVault, vb: solVault, sqrt: o.sqrt } : { a: WSOL_MINT, b: mint, va: solVault, vb: tokVault, sqrt: o.sqrt }) },
      [solVault]: { owner: 'tk', data: vaultData(o.solLamports) },
      [pythPriceAccount()]: { owner: PYTH_RECEIVER, data: pythData() },
    };
    const calls: string[][] = [];
    const fetcher = async (addrs: string[]) => { calls.push(addrs); return { slot: 9, accounts: addrs.map((a) => accounts[a] ?? null) }; };
    return { target: { symbol: 'PREQ' as const, mint, pool, decimals: 6 }, fetcher, calls };
  }
  const sqrtFor = (x: number) => BigInt(Math.round(Math.sqrt(x) * 2 ** 64));

  it('SOL vault address = PDA(["token_vault", mint, pool], cp-amm): matches the real SOL vault of the A402 pool (offline calculation)', () => {
    expect(dammV2VaultAddress(WSOL_MINT, A402_POOL_TARGET.pool)).toBe('FXf9X8exSSZCSe7h14vK4xpcXsdbdNP7nR8myo1MBaMq');
  });
  it('PREQ default target is the constants in preq.ts (symbol PREQ, 6 decimals)', () => {
    expect(PREQ_POOL_TARGET).toMatchObject({ symbol: 'PREQ', decimals: 6 });
  });
  it('with an empty mint or pool, errors with which value to fill before calling the RPC', async () => {
    const calls: string[][] = [];
    const fetcher = async (a: string[]) => { calls.push(a); return { slot: 0, accounts: [] }; };
    await expect(samplePrice(fetcher, () => NOW, DEFAULT_GUARDS, { symbol: 'PREQ', mint: '', pool: '', decimals: 6 })).rejects.toThrow(/PREQ_MAINNET_MINT is not set/);
    await expect(samplePrice(fetcher, () => NOW, DEFAULT_GUARDS, { symbol: 'PREQ', mint: key().toBase58(), pool: '', decimals: 6 })).rejects.toThrow(/PREQ_MAINNET_POOL is not set/);
    if (!PREQ_POOL_TARGET.mint) await expect(samplePrice(fetcher)).rejects.toThrow(/PREQ_MAINNET_MINT/);
    expect(calls).toEqual([]);
  });
  it('right after a single-sided pool opens: SOL vault 0 → recorded as depth 0, price positive and finite → that day\'s rate is off (no division by zero)', async () => {
    const w = world({ sqrt: sqrtFor(1e-9 * 1e3), solLamports: 0n }); // 1e-9 SOL per token
    const s = await samplePrice(w.fetcher, () => NOW, DEFAULT_GUARDS, w.target);
    expect(w.calls).toHaveLength(1); // one RPC call
    expect(s.symbol).toBe('PREQ');
    expect(s.poolSolSideUsd).toBe(0);
    expect(Number.isFinite(s.tokenUsd) && s.tokenUsd > 0).toBe(true);
    expect(s.tokenSol).toBeCloseTo(1e-9, 15);
    const day = Array.from({ length: 24 }, (_, h) => ({ ...s, at: `2026-12-01T${String(h).padStart(2, '0')}:05:00.000Z` }));
    const r = fixRate('2026-12-02', day);
    expect(r).toMatchObject({ status: 'off', reason: expect.stringContaining('depth 0 USD') });
  });
  it('off for insufficient depth even with a tiny SOL side (1 lamport)', async () => {
    const w = world({ sqrt: sqrtFor(1e-6 * 1e3), solLamports: 1n });
    const s = await samplePrice(w.fetcher, () => NOW, DEFAULT_GUARDS, w.target);
    expect(s.poolSolSideUsd).toBeCloseTo(1.5e-7, 12);
    const day = Array.from({ length: 24 }, (_, h) => ({ ...s, at: `2026-12-01T${String(h).padStart(2, '0')}:05:00.000Z` }));
    expect(fixRate('2026-12-02', day).status).toBe('off');
  });
  it('sqrt_price 0 is not recorded (0 price → exception)', async () => {
    const w = world({ sqrt: 0n, solLamports: 0n });
    await expect(samplePrice(w.fetcher, () => NOW, DEFAULT_GUARDS, w.target)).rejects.toThrow(/non-positive or non-finite/);
    const wb = world({ sqrt: 0n, solLamports: 0n, tokenIsA: false }); // with the token on side B, 1/0 = infinity → exception
    await expect(samplePrice(wb.fetcher, () => NOW, DEFAULT_GUARDS, wb.target)).rejects.toThrow(/non-positive or non-finite/);
  });
  it('a pool with the token on side B (WSOL/PREQ) gives the same SOL price', async () => {
    const wa = world({ sqrt: sqrtFor(1e-6 * 1e3), solLamports: 5_000_000_000n });
    const wb = world({ sqrt: sqrtFor(1e6 / 1e3), solLamports: 5_000_000_000n, tokenIsA: false });
    const sa = await samplePrice(wa.fetcher, () => NOW, DEFAULT_GUARDS, wa.target);
    const sb = await samplePrice(wb.fetcher, () => NOW, DEFAULT_GUARDS, wb.target);
    expect(sa.tokenSol).toBeCloseTo(1e-6, 12);
    expect(Math.abs(sb.tokenSol - sa.tokenSol) / sa.tokenSol).toBeLessThan(1e-9);
    expect(sb.poolSolSideUsd).toBeCloseTo(750, 6);
  });
  it('throws if the pool\'s SOL vault differs from the PDA (does not use another pool\'s data)', async () => {
    const w = world({ sqrt: sqrtFor(1e-3), solLamports: 0n });
    await expect(samplePrice(w.fetcher, () => NOW, DEFAULT_GUARDS, { ...w.target, mint: key().toBase58() })).rejects.toThrow(/unexpected pool layout/);
  });
  it('A402 (v1) target only when passed explicitly, with the deprecation warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await samplePrice(async () => ({ slot: 0, accounts: [null, null, null] }), () => NOW, DEFAULT_GUARDS, A402_POOL_TARGET).catch(() => undefined);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('A402 (v1) is deprecated and no longer supported; use PREQ.'));
    } finally { warn.mockRestore(); }
  });
  it('tokenSolFromPool: 0 and infinity throw', () => {
    expect(() => tokenSolFromPool(0n, true, 6)).toThrow();
    expect(() => tokenSolFromPool(0n, false, 6)).toThrow();
    expect(tokenSolFromPool(sqrtFor(1e-3), true, 6)).toBeCloseTo(1e-6, 12);
  });
});

describe('fixRate and tokenAmountFor: defense against abnormal values', () => {
  const s = (h: number, tokenUsd: number, depth = 500): PriceSample => ({
    at: `2026-11-18T${String(h).padStart(2, '0')}:05:00.000Z`, symbol: 'PREQ', tokenSol: tokenUsd / 70, solUsd: 70, solUsdConf: 0.03, tokenUsd, poolSolSideUsd: depth, slot: h, pythPublishTime: 0,
  });
  const day = (f: (h: number) => PriceSample) => Array.from({ length: 24 }, (_, h) => f(h));
  it('off if any price sample is 0, NaN, infinite or negative', () => {
    for (const bad of [0, Number.NaN, Number.POSITIVE_INFINITY, -0.000002]) {
      const r = fixRate('2026-11-19', day((h) => s(h, h === 5 ? bad : 0.000002)));
      expect(r).toMatchObject({ status: 'off', reason: expect.stringContaining('invalid') });
    }
  });
  it('a NaN depth is treated as 0 and off', () => {
    expect(fixRate('2026-11-19', day((h) => s(h, 0.000002, h === 3 ? Number.NaN : 500))).status).toBe('off');
  });
  it('off with 0 samples even if minSamples is set to 0 (no empty array calculation)', () => {
    expect(fixRate('2026-11-19', [], { ...DEFAULT_GUARDS, minSamples: 0 })).toMatchObject({ status: 'off', samples: 0 });
  });
  it('tokenAmountFor: throws on 0, NaN, infinite or negative rates and on u64 overflow / normal values round up', () => {
    const r = { status: 'on' as const, date: 'd', basedOn: 'b', tokenUsd: 0.000002, samples: 24, method: 'm' };
    for (const tokenUsd of [0, Number.NaN, Number.POSITIVE_INFINITY, -1]) expect(() => tokenAmountFor(0.02, 30, { ...r, tokenUsd })).toThrow(/invalid token rate/);
    expect(() => tokenAmountFor(0.02, 30, { ...r, tokenUsd: 1e-30 })).toThrow(/out of range/);
    expect(() => tokenAmountFor(0.02, 100, r)).toThrow(/out of range/); // 100% discount → 0 base units
    expect(tokenAmountFor(0.02, 30, r)).toBe(7_000_000_000n);
  });
});