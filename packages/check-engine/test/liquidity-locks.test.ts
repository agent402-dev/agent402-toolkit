import { existsSync, readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkLiquidity, checkLocks, firstUnlock, uiAmount, type ChainReader } from '@agent402-dev/check-engine/index';
import { guardrailViolations } from '@agent402-dev/check-engine/guardrail';
import { decodeStreamflowContract, isGenuineStreamflowContract } from '@agent402-dev/check-engine/locks/streamflow';
import { streamflowEscrow } from '@agent402-dev/check-engine/holders/registry';

// ---------- 메인넷 픽스처 재생 ----------
interface Rec {
  mint: string;
  slot: number;
  accounts: Record<string, { owner: string; data: string } | null>;
  largest: Record<string, string[]>;
  programAccounts: { program: string; query: unknown; result: { address: string; data: string }[] }[];
}
const fx = (s: string) => new URL(`./fixtures/w3-${s}.json`, import.meta.url);
function replay(rec: Rec): ChainReader {
  return {
    fetch: async (addrs) => ({
      slot: rec.slot,
      accounts: addrs.map((a) => {
        if (!(a in rec.accounts)) throw new Error(`fixture missing ${a}`);
        const x = rec.accounts[a];
        return x ? { owner: x.owner, data: Buffer.from(x.data, 'base64') } : null;
      }),
    }),
    largestTokenAccounts: async (mint) => {
      if (!(mint in rec.largest)) throw new Error(`fixture missing largest ${mint}`);
      return { addresses: rec.largest[mint], method: 'fixture' };
    },
    programAccounts: async (program, query) => {
      const m = rec.programAccounts.find((p) => p.program === program && JSON.stringify(p.query) === JSON.stringify(query));
      if (!m) throw new Error(`fixture missing programAccounts ${program} ${JSON.stringify(query)}`);
      return m.result.map((r) => ({ address: r.address, data: Buffer.from(r.data, 'base64') }));
    },
  };
}
const load = (s: string): Rec => JSON.parse(readFileSync(fx(s), 'utf8'));
const now = () => new Date('2026-11-19T00:00:00Z');

describe.skipIf(!existsSync(fx('A402')))('A402 (정답 데이터)', () => {
  it('DAMM v2 풀 DaHB…: 영구 잠금 99.4%, 운영자 NFT GGFk… 는 Squads 금고 보유', async () => {
    const rec = load('A402');
    const r = await checkLiquidity(rec.mint, replay(rec), now);
    expect(r.poolsFound).toEqual({ 'meteora-damm-v2': 1, 'raydium-cpmm': 0 });
    const p = r.pools[0];
    expect(p.pool).toBe('DaHBw8dxnZaCaX5HdsiM1Hs1uQNwsW3QW3wcD6P4Z5oZ');
    expect(p.breakdown.permanent).toBeCloseTo(99.4, 1);
    expect(p.lockTypes).toEqual(['permanent']);
    const op = p.positions!.find((x) => x.nftMint === 'GGFkcn6eot2utQpWW7EMvxUh7hnJMzY9pr8WLkwgWLLQ')!;
    expect(op).toMatchObject({ nftHolder: '2zyhni1ZhBB7WYazd9wqbrVxH7FwpjFZDLjkTNJ1vyRY', unlockedPercent: 0, vestingPercent: 0 });
    expect(r.lockedTokenPercentOfSupply).toBeCloseTo(82.83 * 0.994, 1);
    expect(guardrailViolations(r)).toEqual([]);
  });

  it('Streamflow Bhf28…: 5,000만, 취소 불가, 클리프 2027-11-18, 첫 해제 2027-12-18', async () => {
    const rec = load('A402');
    const r = await checkLocks(rec.mint, replay(rec), now);
    expect(r.locks).toHaveLength(1);
    const l = r.locks[0];
    expect(l).toMatchObject({
      contract: 'Bhf28aVfysJk8thruEqm3VW5XTNpysn8TwiwvuAC4rCf',
      uiAmount: '50000000',
      status: 'active',
      cancelableBySender: false,
      cancelableByRecipient: false,
      escrow: '94a2qJ3upmaoSvmRLdf7FfTKW9f8aKeaKyn57EcCHNzW',
    });
    expect(l.schedule.cliff.slice(0, 10)).toBe('2027-11-18');
    expect(l.schedule.firstUnlock.slice(0, 10)).toBe('2027-12-18');
    expect(l.escrowBalance).toBe('50095000000000'); // 5,000만 + 9.5만(수수료)
    expect(r.activeLockedPercent).toBe(5);
    expect(guardrailViolations(r)).toEqual([]);
  });
});

describe.skipIf(!existsSync(fx('CPMM-3')))('Raydium CPMM 실제 풀', () => {
  it('CPMM-3: 소각 90.1% + Raydium LP 잠금 9.9% = 100%', async () => {
    const rec = load('CPMM-3');
    const r = await checkLiquidity(rec.mint, replay(rec), now);
    const p = r.pools.find((x) => x.dex === 'raydium-cpmm')!;
    expect(p.lockTypes).toEqual(['burn', 'raydium-lp-lock']);
    expect(p.breakdown.lpNotInCirculation).toBeCloseTo(90.12, 1);
    expect(p.breakdown.raydiumLpLock).toBeCloseTo(9.88, 1);
    expect(p.lockedPercent).toBe(100);
  });

  it('LP 보유자 조회 실패 → 잠김 비율은 0 이 아니라 null(확인 불가)', async () => {
    const rec = load('CPMM-3');
    const failing: ChainReader = { ...replay(rec), largestTokenAccounts: async () => { throw new Error('429 Too many requests'); } };
    const r = await checkLiquidity(rec.mint, failing, now);
    const p = r.pools.find((x) => x.dex === 'raydium-cpmm')!;
    expect(p.lockedPercent).toBeNull();
    expect(p.lockedTokenPercentOfSupply).toBeNull();
    expect(p.breakdown).toMatchObject({ raydiumLpLock: null, lpCirculating: null });
    expect(p.breakdown.lpNotInCirculation).toBeCloseTo(90.12, 1); // 민트 공급량으로 구한 값은 그대로
    expect(p.lp!.lpInRaydiumLock).toBeNull();
    expect(r.notes.some((n) => n.includes('확인 불가'))).toBe(true);
    expect(guardrailViolations(r)).toEqual([]);
  });

  it('CPMM-2: 차이가 100 단위뿐인 풀은 burn 으로 표시하지 않음 + Streamflow 3개', async () => {
    const rec = load('CPMM-2');
    const r = await checkLiquidity(rec.mint, replay(rec), now);
    const lockOnly = r.pools.find((x) => x.pool === '6Z7ojWGMStUB32DJDRQCmBFw5gzBC4hfg6v4tsuRvpHX')!;
    expect(lockOnly.lp!.lpNotInCirculation).toBe('100');
    expect(lockOnly.lockTypes).toEqual(['raydium-lp-lock']);
    const locks = await checkLocks(rec.mint, replay(rec), now);
    expect(locks.contractsFound).toBe(3);
    expect(locks.locks.map((l) => l.status).sort()).toEqual(['active', 'closed', 'closed']);
  });
});

// ---------- 합성 ----------
describe('Streamflow 판독', () => {
  function contract(opts: { mint: PublicKey; escrow: PublicKey; cliff: bigint; cliffAmount: bigint; period: bigint; start: bigint }) {
    const d = Buffer.alloc(1104);
    opts.mint.toBuffer().copy(d, 177);
    opts.escrow.toBuffer().copy(d, 209);
    d.writeBigUInt64LE(opts.start, 409);
    d.writeBigUInt64LE(1000n, 417);
    d.writeBigUInt64LE(opts.period, 425);
    d.writeBigUInt64LE(100n, 433);
    d.writeBigUInt64LE(opts.cliff, 441);
    d.writeBigUInt64LE(opts.cliffAmount, 449);
    d.writeUInt8(1, 457); // cancelable_by_sender
    d.writeUInt8(1, 539); // pausable
    d.writeUInt8(1, 671); // closed
    return d;
  }
  it('필드 위치, 첫 해제 계산(cliff_amount 유무), 금고 PDA 확인', () => {
    const mint = Keypair.generate().publicKey;
    const addr = Keypair.generate().publicKey;
    const esc = streamflowEscrow(addr);
    const c1 = decodeStreamflowContract(contract({ mint, escrow: esc, cliff: 2000n, cliffAmount: 0n, period: 30n, start: 1000n }));
    expect(c1).toMatchObject({ mint: mint.toBase58(), netAmountDeposited: 1000n, cancelableBySender: true, pausable: true, closed: true });
    expect(firstUnlock(c1)).toBe(2030n);
    const c2 = decodeStreamflowContract(contract({ mint, escrow: esc, cliff: 2000n, cliffAmount: 5n, period: 30n, start: 1000n }));
    expect(firstUnlock(c2)).toBe(2000n);
    expect(isGenuineStreamflowContract(addr.toBase58(), c1)).toBe(true);
    expect(isGenuineStreamflowContract(Keypair.generate().publicKey.toBase58(), c1)).toBe(false);
  });
  it('uiAmount', () => {
    expect(uiAmount(50000000000000n, 6)).toBe('50000000');
    expect(uiAmount(1234500n, 6)).toBe('1.2345');
    expect(uiAmount(5n, 0)).toBe('5');
  });
});
