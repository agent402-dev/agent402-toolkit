import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import type { ChainReader } from '../chain.js';
import { decodeMint } from '../mint.js';
import { DISCLAIMER_EN, MintNotFoundError } from '../summary.js';
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
  /** Amount deposited in the contract (excluding fees, base units) */
  amount: string;
  uiAmount: string;
  percentOfSupply: number;
  withdrawn: string;
  /** Tokens actually left in the escrow (may include fees) */
  escrowBalance: string | null;
  status: 'active' | 'canceled' | 'closed';
  schedule: {
    start: string;
    cliff: string;
    cliffAmount: string;
    /** Release interval (seconds) */
    periodSeconds: number;
    amountPerPeriod: string;
    /** Time when tokens first unlock */
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
  /** Sum of amounts left in active contracts, as % of supply */
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

/** Time when tokens first unlock: the cliff if cliff_amount is set, otherwise the first period after the cliff */
export function firstUnlock(c: StreamflowContract): bigint {
  const cliff = c.cliff > 0n ? c.cliff : c.startTime;
  if (c.cliffAmount > 0n) return cliff;
  return cliff + c.period;
}

export async function checkLocks(mintAddress: string, reader: ChainReader, now: () => Date = () => new Date()): Promise<LocksReport> {
  const mint = new PublicKey(mintAddress).toBase58();
  const notes: string[] = [DISCLAIMER_EN];
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
    'firstUnlock is the cliff time if cliff_amount is set, otherwise the time one release interval (period) after the cliff',
    'If cancelableBySender/Recipient is true, that address can cancel the contract and recover the remaining tokens. If canUpdateRate is true, the release rate can be changed',
    'Supported lockups: Streamflow. Other lockup programs (Jupiter Lock, Meteora lock, etc.) are not included in this section (unavailable)',
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
