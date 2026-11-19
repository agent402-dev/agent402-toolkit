// @agent402-dev/pay-server: 환율 저장소 어댑터(메모리·파일) + RateBook + rpcChain
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { a402AmountFor, createRateBook, memoryRateStore, rpcChain, type PriceSample, type RateStore } from '@agent402-dev/pay-server';
import { fileRateStore } from '@agent402-dev/pay-server/rates-file';

const sample = (at: string, a402Usd: number, depth = 200): PriceSample => ({
  at, a402Sol: a402Usd / 150, solUsd: 150, solUsdConf: 0.05, a402Usd, poolSolSideUsd: depth, slot: 1, pythPublishTime: Date.parse(at) / 1000,
});
const day = (d: string, f: (h: number) => number, depth = 200) =>
  Array.from({ length: 24 }, (_, h) => sample(`${d}T${String(h).padStart(2, '0')}:05:00.000Z`, f(h), depth));

for (const [name, make] of [
  ['memoryRateStore', () => memoryRateStore()],
  ['fileRateStore', () => fileRateStore(join(mkdtempSync(join(tmpdir(), 'rates-')), 'r.json'))],
] as [string, () => RateStore][]) {
  describe(`RateBook + ${name}`, () => {
    it('전날 24개 기록의 중앙값으로 오늘 고정, 한 번 정하면 그날은 그대로', async () => {
      const store = make();
      for (const s of day('2026-11-19', (h) => 0.000002 + h * 0.00000001)) await store.addSample(s);
      let now = new Date('2026-11-20T03:00:00Z');
      const book = createRateBook({ store, now: () => now });
      const r = await book.today();
      expect(r).toMatchObject({ status: 'on', date: '2026-11-20', basedOn: '2026-11-19', samples: 24 });
      expect((r as { a402Usd: number }).a402Usd).toBeCloseTo(0.000002 + 11.5 * 0.00000001, 12);
      await store.addSample(sample('2026-11-19T23:59:00.000Z', 1)); // 늦게 들어온 이상값
      now = new Date('2026-11-20T20:00:00Z');
      expect(await book.today()).toEqual(r);
    });
    it('안전장치: 기록 부족·깊이 미달·변동폭 초과면 off (이유 포함)', async () => {
      const now = () => new Date('2026-11-20T01:00:00Z');
      const few = make();
      for (const s of day('2026-11-19', () => 0.000002).slice(0, 5)) await few.addSample(s);
      expect(await createRateBook({ store: few, now }).today()).toMatchObject({ status: 'off', reason: expect.stringContaining('5 samples') });
      const shallow = make();
      for (const s of day('2026-11-19', () => 0.000002, 51)) await shallow.addSample(s);
      expect(await createRateBook({ store: shallow, now }).today()).toMatchObject({ status: 'off', reason: expect.stringContaining('51 USD') });
      const swing = make();
      for (const s of day('2026-11-19', (h) => (h < 12 ? 0.000001 : 0.000002))) await swing.addSample(s);
      expect(await createRateBook({ store: swing, now }).today()).toMatchObject({ status: 'off', reason: expect.stringContaining('ratio 2.00') });
    });
  });
}

describe('fileRateStore', () => {
  it('파일에 남아 다른 인스턴스에서도 읽힘, 오래된 기록은 정리', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'rates-')), 'sub', 'r.json');
    const a = fileRateStore(path, 2);
    await a.addSample(sample('2026-11-15T00:00:00.000Z', 0.000001));
    for (const s of day('2026-11-19', () => 0.000002)) await a.addSample(s);
    const b = fileRateStore(path, 2);
    expect(await b.samples('2026-11-19')).toHaveLength(24);
    expect(await b.samples('2026-11-15')).toHaveLength(0);
    await b.putRate({ status: 'off', date: '2026-11-20', basedOn: '2026-11-19', reason: 'x', samples: 0 });
    expect(await fileRateStore(path).getRate('2026-11-20')).toMatchObject({ status: 'off' });
    expect(JSON.parse(readFileSync(path, 'utf8')).samples).toHaveLength(24);
  });
});

describe('a402AmountFor', () => {
  it('0.02 USD × 70% ÷ 환율, 올림 (원 단위)', () => {
    const r = { status: 'on' as const, date: 'd', basedOn: 'b', a402Usd: 0.000002, samples: 24, method: 'm' };
    expect(a402AmountFor(0.02, 30, r)).toBe(7_000_000_000n);
    expect(a402AmountFor(0.02, 30, { ...r, a402Usd: 0.0000003 })).toBe(46_666_666_667n);
  });
});

describe('rpcChain', () => {
  const SECRET = 'https://rpc.example/?api-key=SECRET123';
  it('getTransaction → 정산 확인용 모양 (주소 조회 테이블 포함, 서명 목록)', async () => {
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const b = JSON.parse(String(init!.body));
      expect(b.method).toBe('getTransaction');
      return Response.json({ result: {
        meta: { err: null, loadedAddresses: { writable: ['W'], readonly: ['R'] },
          preTokenBalances: [{ accountIndex: 2, mint: 'M', owner: 'O', uiTokenAmount: { amount: '0' } }],
          postTokenBalances: [{ accountIndex: 2, mint: 'M', owner: 'O', uiTokenAmount: { amount: '5' } }] },
        transaction: { signatures: ['S1', 'S2'], message: { accountKeys: ['FEE', 'B'] } },
      } });
    }) as typeof fetch;
    const tx = await rpcChain(SECRET, { fetchImpl: f }).loadTx('S1');
    expect(tx).toEqual({ signature: 'S1', err: false, accountKeys: ['FEE', 'B', 'W', 'R'], signatures: ['S1', 'S2'],
      preTokenBalances: [{ accountIndex: 2, mint: 'M', owner: 'O', amount: '0' }], postTokenBalances: [{ accountIndex: 2, mint: 'M', owner: 'O', amount: '5' }] });
  });
  it('오류 메시지에 RPC 주소(키)를 넣지 않음', async () => {
    const f = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    const e = await rpcChain(SECRET, { fetchImpl: f }).recentSignatures('A', 5).catch((x: Error) => x);
    expect(String((e as Error).message)).not.toContain('SECRET123');
    expect(String((e as Error).message)).not.toContain('rpc.example');
  });
  it('getMultipleAccounts → 소유 프로그램·데이터 (없으면 null)', async () => {
    const f = (async () => Response.json({ result: { context: { slot: 7 }, value: [{ owner: 'P', lamports: 1, data: [btoa('ab'), 'base64'] }, null] } })) as unknown as typeof fetch;
    const r = await rpcChain(SECRET, { fetchImpl: f }).accounts(['X', 'Y']);
    expect(r.slot).toBe(7);
    expect(r.accounts[0]).toMatchObject({ owner: 'P', data: new Uint8Array([97, 98]) });
    expect(r.accounts[1]).toBeNull();
  });
});
