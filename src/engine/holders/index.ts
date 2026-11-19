import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import { decodeMint, programKind } from '../mint.js';
import { DISCLAIMER_EN, DISCLAIMER_KO, MintNotFoundError } from '../summary.js';
import type { ChainReader } from '../chain.js';
import {
  POOL_AUTHORITIES,
  POOL_STATE_PROGRAMS,
  STREAMFLOW_ESCROW_OFFSET,
  STREAMFLOW_MINT_OFFSET,
  STREAMFLOW_PROGRAM,
  streamflowEscrow,
} from './registry.js';

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** @deprecated ChainReader 를 쓰세요 */
export type HolderReader = ChainReader;

export type HolderCategory = 'pool' | 'lock' | 'wallet' | 'program' | 'pda';

export interface HolderEntry {
  rank: number;
  tokenAccount: string;
  /** 토큰 계정의 소유자(전송 권한자) 주소 */
  owner: string;
  amount: string;
  /** 총 공급량 대비 % */
  percent: number;
  category: HolderCategory;
  /** 알려진 프로그램 이름 (pool/lock). 모르면 null */
  label: string | null;
  /** owner 가 데이터 계정이면 그 계정을 소유한 프로그램 */
  ownerProgram: string | null;
  /** 분류 근거가 된 추가 계정 (예: Streamflow 계약 주소) */
  reference: string | null;
  /** 분류 근거 (사실 서술) */
  basis: string;
}

export interface HoldersReport {
  mint: string;
  checkedAt: string;
  slot: number;
  method: string;
  supply: string;
  decimals: number;
  accountsExamined: number;
  top: HolderEntry[];
  /** 잔액 상위 10개 토큰 계정의 공급 대비 합계 % */
  top10Percent: number;
  /** 조사한 계정들의 분류별 합계 % */
  categoryPercent: Record<HolderCategory, number>;
  /** wallet(온커브 주소) 만 소유자 기준으로 합친 상위 5곳. pool·lock·미지원 프로그램 계정은 넣지 않음 */
  excludingPoolsAndLocksTop5: { owner: string; category: HolderCategory; percent: number; tokenAccounts: string[] }[];
  /** 이 판독기가 지원하지 않는 프로그램(DEX·락업·멀티시그 등)이 소유한 계정 — category program·pda, 소유자 기준 합산 */
  unsupportedProgramAccounts: {
    owner: string;
    category: HolderCategory;
    ownerProgram: string | null;
    percent: number;
    tokenAccounts: string[];
  }[];
  evidence: { account: string; role: string }[];
  notes: string[];
}

interface TokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
}

function decodeTokenAccount(address: string, data: Buffer): TokenAccount {
  if (data.length < 165) throw new Error(`token account ${address} too small (${data.length})`);
  const r = new Reader(data);
  const mint = r.pubkey().toBase58();
  const owner = r.pubkey().toBase58();
  const amount = r.u64();
  return { address, mint, owner, amount };
}

/** 공급 대비 % (소수 6자리) */
export function percentOf(amount: bigint, supply: bigint): number {
  if (supply === 0n) return 0;
  return Number((amount * 100_000_000n) / supply) / 1_000_000;
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

export async function checkHolders(
  mintAddress: string,
  reader: ChainReader,
  now: () => Date = () => new Date(),
): Promise<HoldersReport> {
  const mint = new PublicKey(mintAddress).toBase58();
  const notes: string[] = [DISCLAIMER_KO, DISCLAIMER_EN];
  const evidence: HoldersReport['evidence'] = [{ account: mint, role: 'mint' }];

  // 1) 민트 → 토큰 프로그램
  const m0 = (await reader.fetch([mint])).accounts[0];
  if (!m0) throw new MintNotFoundError(`account ${mint} not found`);
  decodeMint(m0.data, new PublicKey(m0.owner));

  // 2) 상위 토큰 계정
  const { addresses, method } = await reader.largestTokenAccounts(mint, m0.owner);

  // 3) 민트 + 토큰 계정을 같은 슬롯에서 다시 읽음 (공급량과 잔액 기준 시점 일치)
  const snap = await reader.fetch([mint, ...addresses]);
  const mintAcc = snap.accounts[0]!;
  const decoded = decodeMint(mintAcc.data, new PublicKey(mintAcc.owner));
  const supply = decoded.supply;
  const tokenAccounts: TokenAccount[] = [];
  addresses.forEach((a, i) => {
    const acc = snap.accounts[i + 1];
    if (!acc || !programKind(new PublicKey(acc.owner))) return; // 그 사이 닫힌 계정
    const ta = decodeTokenAccount(a, acc.data);
    if (ta.mint !== mint) throw new Error(`token account ${a} is for ${ta.mint}`);
    tokenAccounts.push(ta);
  });
  tokenAccounts.sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));

  // 4) 소유자 계정 조회
  const owners = [...new Set(tokenAccounts.map((t) => t.owner))];
  const ownerInfo = new Map<string, { owner: string; dataLen: number } | null>();
  if (owners.length) {
    const res = await reader.fetch(owners);
    owners.forEach((o, i) => {
      const a = res.accounts[i];
      ownerInfo.set(o, a ? { owner: a.owner, dataLen: a.data.length } : null);
    });
  }

  // 5) 분류
  const top: HolderEntry[] = [];
  for (const [i, t] of tokenAccounts.entries()) {
    const info = ownerInfo.get(t.owner) ?? null;
    const ownerProgram = info && info.dataLen > 0 ? info.owner : null;
    const onCurve = PublicKey.isOnCurve(new PublicKey(t.owner).toBuffer());
    const base = {
      rank: i + 1,
      tokenAccount: t.address,
      owner: t.owner,
      amount: t.amount.toString(),
      percent: percentOf(t.amount, supply),
      ownerProgram,
      reference: null as string | null,
    };

    const poolAuth = POOL_AUTHORITIES[t.owner];
    if (poolAuth) {
      top.push({ ...base, category: 'pool', label: poolAuth.label, reference: poolAuth.program,
        basis: `소유자가 ${poolAuth.label} 프로그램(${poolAuth.program})의 풀 권한 주소` });
      continue;
    }
    if (ownerProgram && POOL_STATE_PROGRAMS[ownerProgram]) {
      const label = POOL_STATE_PROGRAMS[ownerProgram];
      top.push({ ...base, category: 'pool', label, basis: `소유자가 ${label} 프로그램(${ownerProgram}) 소유의 풀 상태 계정` });
      continue;
    }
    if (!onCurve && t.owner === t.address) {
      // Streamflow 금고 후보: 금고 주소를 기록한 계약을 찾고, PDA 를 다시 계산해 일치하는지 확인
      const contracts = await reader.programAccounts(STREAMFLOW_PROGRAM.toBase58(), {
        memcmp: [{ offset: STREAMFLOW_ESCROW_OFFSET, bytes: t.address }],
      });
      const hit = contracts.find((c) => {
        const cMint = new PublicKey(c.data.subarray(STREAMFLOW_MINT_OFFSET, STREAMFLOW_MINT_OFFSET + 32)).toBase58();
        return cMint === mint && streamflowEscrow(new PublicKey(c.address)).toBase58() === t.address;
      });
      if (hit) {
        top.push({ ...base, category: 'lock', label: 'streamflow', reference: hit.address,
          basis: `Streamflow 계약 ${hit.address} 의 금고 계정 (PDA ["strm", 계약] 재계산 일치)` });
        evidence.push({ account: hit.address, role: 'streamflow-contract' });
        continue;
      }
    }
    if (onCurve) {
      top.push({ ...base, category: 'wallet', label: null,
        basis: info?.owner === SYSTEM_PROGRAM || !info ? '소유자가 온커브 주소 (개인키로 서명하는 일반 지갑 주소)' : `소유자가 온커브 주소이며 계정 소유 프로그램은 ${info.owner}` });
    } else if (ownerProgram) {
      top.push({ ...base, category: 'program', label: null,
        basis: `소유자가 프로그램 ${ownerProgram} 소유의 데이터 계정 (이 판독기가 이름을 모르는 프로그램)` });
    } else {
      top.push({ ...base, category: 'pda', label: null,
        basis: '소유자가 프로그램 파생 주소(PDA)이며 어느 프로그램인지 판별하지 못함' });
    }
  }

  // 6) 집계
  const categoryPercent: Record<HolderCategory, number> = { pool: 0, lock: 0, wallet: 0, program: 0, pda: 0 };
  const catAmount: Record<HolderCategory, bigint> = { pool: 0n, lock: 0n, wallet: 0n, program: 0n, pda: 0n };
  for (const [i, h] of top.entries()) catAmount[h.category] += tokenAccounts[i].amount;
  for (const k of Object.keys(catAmount) as HolderCategory[]) categoryPercent[k] = percentOf(catAmount[k], supply);

  const top10Amount = tokenAccounts.slice(0, 10).reduce((s, t) => s + t.amount, 0n);

  type Agg = { owner: string; category: HolderCategory; ownerProgram: string | null; amount: bigint; tokenAccounts: string[] };
  const aggregate = (cats: HolderCategory[]): Agg[] => {
    const byOwner = new Map<string, Agg>();
    for (const [i, h] of top.entries()) {
      if (!cats.includes(h.category)) continue;
      const e = byOwner.get(h.owner) ?? { owner: h.owner, category: h.category, ownerProgram: h.ownerProgram, amount: 0n, tokenAccounts: [] };
      e.amount += tokenAccounts[i].amount;
      e.tokenAccounts.push(h.tokenAccount);
      byOwner.set(h.owner, e);
    }
    return [...byOwner.values()]
      .filter((e) => e.amount > 0n)
      .sort((x, y) => (y.amount > x.amount ? 1 : y.amount < x.amount ? -1 : 0));
  };
  const excludingPoolsAndLocksTop5 = aggregate(['wallet'])
    .slice(0, 5)
    .map((e) => ({ owner: e.owner, category: e.category, percent: percentOf(e.amount, supply), tokenAccounts: e.tokenAccounts }));
  const unsupportedProgramAccounts = aggregate(['program', 'pda']).map((e) => ({
    owner: e.owner,
    category: e.category,
    ownerProgram: e.ownerProgram,
    percent: percentOf(e.amount, supply),
    tokenAccounts: e.tokenAccounts,
  }));

  notes.push(
    `잔액 상위 ${tokenAccounts.length}개 토큰 계정만 조사했습니다 (${method}). 그 밖의 계정은 분류에 포함되지 않습니다`,
    '분류는 토큰 계정 소유자 주소의 형태(온커브/PDA)와 소유 프로그램으로 판정한 것이며, 실제 사용자·거래소 여부는 알 수 없습니다',
    'excludingPoolsAndLocksTop5 는 온커브 주소(wallet)만 같은 소유자끼리 합친 값입니다',
  );
  if (unsupportedProgramAccounts.length) {
    notes.push('unsupportedProgramAccounts 는 이 판독기가 지원하지 않는 프로그램(다른 DEX·락업·멀티시그 등)이 소유한 계정으로, 풀·락업 여부를 확인하지 못해 따로 표시합니다 (확인 불가)');
  }

  return {
    mint,
    checkedAt: now().toISOString(),
    slot: snap.slot,
    method,
    supply: supply.toString(),
    decimals: decoded.decimals,
    accountsExamined: tokenAccounts.length,
    top,
    top10Percent: percentOf(top10Amount, supply),
    categoryPercent: Object.fromEntries(Object.entries(categoryPercent).map(([k, v]) => [k, round6(v)])) as Record<HolderCategory, number>,
    excludingPoolsAndLocksTop5,
    unsupportedProgramAccounts,
    evidence,
    notes,
  };
}
