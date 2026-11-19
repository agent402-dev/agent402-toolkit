import { existsSync, readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { checkHolders, DISCLAIMER_KO, percentOf, type HolderReader } from 'a402-check-engine/index';
import { guardrailViolations } from 'a402-check-engine/guardrail';
import {
  METEORA_DAMM_V2_POOL_AUTHORITY,
  RAYDIUM_CLMM_PROGRAM,
  RAYDIUM_CPMM_AUTHORITY,
  STREAMFLOW_ESCROW_OFFSET,
  STREAMFLOW_MINT_OFFSET,
  STREAMFLOW_PROGRAM,
  streamflowEscrow,
} from 'a402-check-engine/holders/registry';
import { SPL_TOKEN_PROGRAM } from 'a402-check-engine/programs';

describe('registry: PDA 계산값', () => {
  it('Meteora DAMM v2 풀 권한 = A402 풀 금고의 실제 소유자', () => {
    expect(METEORA_DAMM_V2_POOL_AUTHORITY.toBase58()).toBe('HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC');
  });
  it('Raydium CPMM 권한 = SDK 상수 CREATE_CPMM_POOL_AUTH', () => {
    expect(RAYDIUM_CPMM_AUTHORITY.toBase58()).toBe('GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL');
  });
  it('Streamflow 금고 PDA = A402 락업 금고', () => {
    expect(streamflowEscrow(new PublicKey('Bhf28aVfysJk8thruEqm3VW5XTNpysn8TwiwvuAC4rCf')).toBase58())
      .toBe('94a2qJ3upmaoSvmRLdf7FfTKW9f8aKeaKyn57EcCHNzW');
  });
  it('percentOf', () => {
    expect(percentOf(121553880915010n, 1000000000000000n)).toBe(12.155388);
    expect(percentOf(1n, 0n)).toBe(0);
  });
});

// ---------- A402 메인넷 픽스처 ----------
interface Rec {
  mint: string;
  fetches: { addresses: string[]; slot: number; accounts: ({ owner: string; data: string } | null)[] }[];
  largest: { addresses: string[]; method: string };
  memcmp: { program: string; offset: number; address: string; result: { address: string; data: string }[] }[];
}
function replay(rec: Rec): HolderReader {
  const accounts = new Map<string, { owner: string; data: string } | null>();
  let slot = 0;
  for (const f of rec.fetches) { slot = Math.max(slot, f.slot); f.addresses.forEach((a, i) => accounts.set(a, f.accounts[i])); }
  return {
    fetch: async (addrs) => ({
      slot,
      accounts: addrs.map((a) => {
        if (!accounts.has(a)) throw new Error(`fixture missing ${a}`);
        const x = accounts.get(a)!;
        return x ? { owner: x.owner, data: Buffer.from(x.data, 'base64') } : null;
      }),
    }),
    largestTokenAccounts: async () => rec.largest,
    programAccounts: async (program, q) => {
      const { offset, bytes: address } = q.memcmp[0];
      const m = rec.memcmp.find((x) => x.program === program && x.offset === offset && x.address === address);
      if (!m) throw new Error(`fixture missing memcmp ${address}`);
      return m.result.map((r) => ({ address: r.address, data: Buffer.from(r.data, 'base64') }));
    },
  };
}

const a402Path = new URL('./fixtures/holders-A402.json', import.meta.url);
describe.skipIf(!existsSync(a402Path))('A402 fixture', () => {
  it('풀 82.83% / 락업 5.01% (Bhf28…) / J9Hef 12.16%', async () => {
    const rec: Rec = JSON.parse(readFileSync(a402Path, 'utf8'));
    const r = await checkHolders(rec.mint, replay(rec));
    expect(r.top[0]).toMatchObject({ category: 'pool', label: 'meteora-damm-v2', tokenAccount: 'AxhGmD7bRGo8qb2tuC43qFBUeuhpe2ZSR2cxo3NBpbmC' });
    expect(r.top[0].percent).toBeCloseTo(82.83, 2);
    const lock = r.top.find((h) => h.category === 'lock')!;
    expect(lock.reference).toBe('Bhf28aVfysJk8thruEqm3VW5XTNpysn8TwiwvuAC4rCf');
    expect(r.excludingPoolsAndLocksTop5[0]).toMatchObject({ owner: 'J9HefSN1c2yrL9FSwJfvkbKwtHEsZ6SEvCFTxv5UpeHG', category: 'wallet', percent: 12.155388 });
    expect(r.top10Percent).toBe(100);
    expect(r.top.find((h) => h.owner === '2zyhni1ZhBB7WYazd9wqbrVxH7FwpjFZDLjkTNJ1vyRY')?.category).toBe('pda');
    expect(guardrailViolations(r)).toEqual([]);
  });
});

const wifPath = new URL('./fixtures/holders-WIF.json', import.meta.url);
describe.skipIf(!existsSync(wifPath))('WIF fixture', () => {
  it('Raydium AMM v4 금고를 pool 로 판별 (실제 체인 사례)', async () => {
    const rec: Rec = JSON.parse(readFileSync(wifPath, 'utf8'));
    const r = await checkHolders(rec.mint, replay(rec));
    const pools = r.top.filter((h) => h.category === 'pool');
    expect(pools.map((p) => p.label)).toContain('raydium-amm-v4');
    expect(pools.every((p) => p.owner === '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1')).toBe(true);
    expect(guardrailViolations(r)).toEqual([]);
  });
});

// ---------- 합성 ----------
const pk = () => Keypair.generate().publicKey;
/** 온커브(일반 키쌍) 주소 */
const wallet = () => Keypair.generate().publicKey;
/** 오프커브 주소 */
const offCurve = () => PublicKey.findProgramAddressSync([Keypair.generate().publicKey.toBuffer()], pk())[0];

function mintData(supply: bigint): Buffer {
  const b = Buffer.alloc(82);
  b.writeBigUInt64LE(supply, 36);
  b.writeUInt8(6, 44);
  b.writeUInt8(1, 45);
  return b;
}
function tokenAcc(mint: PublicKey, owner: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  b.writeUInt8(1, 108);
  return b;
}

function synthReader(
  accounts: Record<string, { owner: PublicKey; data: Buffer } | null>,
  largest: string[],
  streamflow: { address: string; data: Buffer }[] = [],
): HolderReader {
  return {
    fetch: async (addrs) => ({ slot: 7, accounts: addrs.map((a) => (accounts[a] ? { owner: accounts[a]!.owner.toBase58(), data: accounts[a]!.data } : null)) }),
    largestTokenAccounts: async () => ({ addresses: largest, method: 'test' }),
    programAccounts: async (_p, q) =>
      streamflow.filter((c) => q.memcmp.every((m) => new PublicKey(c.data.subarray(m.offset, m.offset + 32)).toBase58() === m.bytes)),
  };
}

describe('synthetic holders', () => {
  it('CPMM 풀·CLMM 풀 상태·지갑 합산·알 수 없는 프로그램·닫힌 계정', async () => {
    const mint = pk();
    const w = wallet();
    const clmmPool = offCurve();
    const otherProgram = pk();
    const otherOwner = offCurve();
    const [t1, t2, t3, t4, t5, closed] = [pk(), pk(), pk(), pk(), pk(), pk()];
    const r = await checkHolders(mint.toBase58(), synthReader({
      [mint.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: mintData(1000n) },
      [t1.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, RAYDIUM_CPMM_AUTHORITY, 400n) },
      [t2.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, clmmPool, 300n) },
      [t3.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, w, 100n) },
      [t4.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, w, 50n) },
      [t5.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, otherOwner, 120n) },
      [clmmPool.toBase58()]: { owner: RAYDIUM_CLMM_PROGRAM, data: Buffer.alloc(100) },
      [otherOwner.toBase58()]: { owner: otherProgram, data: Buffer.alloc(10) },
      [closed.toBase58()]: null,
    }, [t1, t2, t3, t4, t5, closed].map(String)));

    expect(r.accountsExamined).toBe(5);
    expect(r.top.map((h) => [h.category, h.label])).toEqual([
      ['pool', 'raydium-cpmm'], ['pool', 'raydium-clmm'], ['program', null], ['wallet', null], ['wallet', null],
    ]);
    expect(r.categoryPercent).toEqual({ pool: 70, lock: 0, wallet: 15, program: 12, pda: 0 });
    expect(r.excludingPoolsAndLocksTop5[0]).toMatchObject({ owner: w.toBase58(), percent: 15 });
    expect(r.excludingPoolsAndLocksTop5[0].tokenAccounts).toHaveLength(2);
    // 미지원 프로그램 계정은 상위 5곳에 섞지 않고 따로
    expect(r.excludingPoolsAndLocksTop5).toHaveLength(1);
    expect(r.unsupportedProgramAccounts).toEqual([
      { owner: otherOwner.toBase58(), category: 'program', ownerProgram: otherProgram.toBase58(), percent: 12, tokenAccounts: [t5.toBase58()] },
    ]);
    expect(r.notes).toContain(DISCLAIMER_KO);
    expect(guardrailViolations(r)).toEqual([]);
  });

  it('Streamflow: 계약의 민트가 다르거나 PDA 가 안 맞으면 lock 으로 보지 않음', async () => {
    const mint = pk(), otherMint = pk();
    const contract = pk();
    const escrow = streamflowEscrow(contract);
    const fake = offCurve(); // 계약에 기록돼 있지만 PDA 가 맞지 않는 주소
    const mkContract = (m: PublicKey, esc: PublicKey) => {
      const d = Buffer.alloc(300);
      m.toBuffer().copy(d, STREAMFLOW_MINT_OFFSET);
      esc.toBuffer().copy(d, STREAMFLOW_ESCROW_OFFSET);
      return d;
    };
    const run = (contracts: { address: string; data: Buffer }[], holder: PublicKey) =>
      checkHolders(mint.toBase58(), synthReader({
        [mint.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: mintData(100n) },
        [holder.toBase58()]: { owner: SPL_TOKEN_PROGRAM, data: tokenAcc(mint, holder, 50n) },
      }, [holder.toBase58()], contracts));

    expect((await run([{ address: contract.toBase58(), data: mkContract(mint, escrow) }], escrow)).top[0]).toMatchObject({ category: 'lock', reference: contract.toBase58() });
    expect((await run([{ address: contract.toBase58(), data: mkContract(otherMint, escrow) }], escrow)).top[0].category).toBe('program');
    expect((await run([{ address: contract.toBase58(), data: mkContract(mint, fake) }], fake)).top[0].category).toBe('program');
    void STREAMFLOW_PROGRAM;
  });
});
