import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import type { ChainReader } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, DISCLAIMER_KO, MintNotFoundError } from '../summary.js';
import { percentOf } from '../holders/index.js';
import { STREAMFLOW_MINT_OFFSET } from '../holders/registry.js';
import { decodeStreamflowContract, isGenuineStreamflowContract, STREAMFLOW, type StreamflowContract } from './streamflow.js';

export interface LockContract {
  protocol: 'streamflow';
  contract: string;
  escrow: string;
  sender: string;
  recipient: string;
  name: string;
  /** 계약에 넣은 수량 (수수료 제외, 원 단위) */
  amount: string;
  uiAmount: string;
  percentOfSupply: number;
  withdrawn: string;
  /** 금고에 실제로 남은 토큰 (수수료 포함일 수 있음) */
  escrowBalance: string | null;
  status: 'active' | 'canceled' | 'closed';
  schedule: {
    start: string;
    cliff: string;
    cliffAmount: string;
    /** 해제 간격 (초) */
    periodSeconds: number;
    amountPerPeriod: string;
    /** 처음 토큰이 풀리는 시각 */
    firstUnlock: string;
    end: string;
  };
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  pausable: boolean;
  canUpdateRate: boolean;
  canTopup: boolean;
}

export interface LocksReport {
  mint: string;
  checkedAt: string;
  slot: number;
  decimals: number;
  locks: LockContract[];
  /** 진행 중(active) 계약에 남은 수량 합계의 공급 대비 % */
  activeLockedPercent: number;
  contractsFound: number;
  evidence: { account: string; role: string }[];
  notes: string[];
}

const iso = (sec: bigint) => (sec > 0n && sec < 253402300800n ? new Date(Number(sec) * 1000).toISOString() : '');

export function uiAmount(raw: bigint, decimals: number): string {
  const s = raw.toString().padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, '') : '';
  return frac ? `${int}.${frac}` : int;
}

/** 처음 토큰이 풀리는 시각: cliff_amount 가 있으면 cliff, 없으면 cliff 이후 첫 period */
export function firstUnlock(c: StreamflowContract): bigint {
  const cliff = c.cliff > 0n ? c.cliff : c.startTime;
  if (c.cliffAmount > 0n) return cliff;
  return cliff + c.period;
}

export async function checkLocks(mintAddress: string, reader: ChainReader, now: () => Date = () => new Date()): Promise<LocksReport> {
  const mint = new PublicKey(mintAddress).toBase58();
  const notes: string[] = [DISCLAIMER_KO, DISCLAIMER_EN];
  const evidence: LocksReport['evidence'] = [{ account: mint, role: 'mint' }];

  const m = await reader.fetch([mint]);
  if (!m.accounts[0]) throw new MintNotFoundError(`account ${mint} not found`);
  const decoded = decodeMint(m.accounts[0].data, new PublicKey(m.accounts[0].owner));

  const raw = await reader.programAccounts(STREAMFLOW, { memcmp: [{ offset: STREAMFLOW_MINT_OFFSET, bytes: mint }] });
  const contracts: { address: string; c: StreamflowContract }[] = [];
  for (const a of raw) {
    let c: StreamflowContract;
    try { c = decodeStreamflowContract(a.data); } catch { continue; }
    if (c.mint !== mint || !isGenuineStreamflowContract(a.address, c)) continue;
    contracts.push({ address: a.address, c });
  }

  const escrows = contracts.length ? await reader.fetch(contracts.map((x) => x.c.escrowTokens)) : { slot: m.slot, accounts: [] };
  const locks: LockContract[] = contracts.map(({ address, c }, i) => {
    const e = escrows.accounts[i];
    let escrowBalance: string | null = null;
    if (e && e.data.length >= 165) escrowBalance = new Reader(e.data, 64).u64().toString();
    const status: LockContract['status'] = c.closed ? 'closed' : c.canceledAt > 0n ? 'canceled' : 'active';
    return {
      protocol: 'streamflow',
      contract: address,
      escrow: c.escrowTokens,
      sender: c.sender,
      recipient: c.recipient,
      name: c.name,
      amount: c.netAmountDeposited.toString(),
      uiAmount: uiAmount(c.netAmountDeposited, decoded.decimals),
      percentOfSupply: percentOf(c.netAmountDeposited, decoded.supply),
      withdrawn: c.withdrawnAmount.toString(),
      escrowBalance,
      status,
      schedule: {
        start: iso(c.startTime),
        cliff: iso(c.cliff),
        cliffAmount: c.cliffAmount.toString(),
        periodSeconds: Number(c.period),
        amountPerPeriod: c.amountPerPeriod.toString(),
        firstUnlock: iso(firstUnlock(c)),
        end: iso(c.endTime),
      },
      cancelableBySender: c.cancelableBySender,
      cancelableByRecipient: c.cancelableByRecipient,
      transferableBySender: c.transferableBySender,
      transferableByRecipient: c.transferableByRecipient,
      pausable: c.pausable,
      canUpdateRate: c.canUpdateRate,
      canTopup: c.canTopup,
    };
  });
  locks.sort((x, y) => (BigInt(y.amount) > BigInt(x.amount) ? 1 : BigInt(y.amount) < BigInt(x.amount) ? -1 : 0));
  for (const l of locks) evidence.push({ account: l.contract, role: 'streamflow-contract' });

  const activeRemaining = contracts
    .filter(({ c }) => !c.closed && c.canceledAt === 0n)
    .reduce((s, { c }) => s + (c.netAmountDeposited - c.withdrawnAmount), 0n);

  notes.push(
    'firstUnlock 은 cliff_amount 가 있으면 cliff 시각, 없으면 cliff 이후 첫 해제 간격(period)이 지난 시각으로 계산했습니다',
    'cancelableBySender/Recipient 가 true 이면 해당 주소가 계약을 취소해 남은 토큰을 회수할 수 있습니다. canUpdateRate 가 true 이면 해제 속도를 바꿀 수 있습니다',
    '지원 락업: Streamflow. 다른 락업 프로그램(Jupiter Lock, Meteora 잠금 등)은 이 항목에 포함되지 않습니다 (확인 불가)',
  );

  return {
    mint,
    checkedAt: now().toISOString(),
    slot: Math.max(m.slot, escrows.slot),
    decimals: decoded.decimals,
    locks,
    activeLockedPercent: percentOf(activeRemaining, decoded.supply),
    contractsFound: contracts.length,
    evidence,
    notes,
  };
}
