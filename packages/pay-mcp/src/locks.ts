// Reads seller lock accounts on Solana (read-only): Jupiter Lock escrows (program "locker" 0.4.0) and Streamflow contracts.
// Layout: the program's on-chain Anchor IDL (8-byte discriminator + 288-byte struct, little-endian), checked against real mainnet escrows on 2026-11-22.
import { address as address_, getAddressEncoder, getBase58Decoder, getProgramDerivedAddress } from '@solana/kit';

export const JUPITER_LOCK_PROGRAM = 'LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn';
const DISCRIMINATOR = [244, 119, 183, 4, 73, 116, 135, 195];
const SIZE = 296;
const PERMISSION = ['none', 'creator', 'recipient', 'either'] as const;

export interface AccountData { owner: string; data: Uint8Array }
/** getMultipleAccounts: one entry per address, null if missing */
export type AccountsFetcher = (addresses: string[]) => Promise<(AccountData | null)[]>;

export interface JupiterLockInfo {
  recipient: string;
  mint: string;
  cancel: string;
  updateRecipient: string;
  cliffTime: bigint;
  frequency: bigint;
  cliffUnlockAmount: bigint;
  amountPerPeriod: bigint;
  numberOfPeriod: bigint;
  cancelledAt: bigint;
}

export function decodeJupiterLock(data: Uint8Array): JupiterLockInfo | null {
  if (data.length < SIZE || DISCRIMINATOR.some((b, i) => data[i] !== b)) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const b58 = getBase58Decoder();
  const key = (o: number) => b58.decode(data.subarray(o, o + 32));
  const u64 = (o: number) => v.getBigUint64(o, true);
  return {
    recipient: key(8), mint: key(40),
    updateRecipient: PERMISSION[data[137]] ?? 'unknown', cancel: PERMISSION[data[138]] ?? 'unknown',
    cliffTime: u64(144), frequency: u64(152), cliffUnlockAmount: u64(160), amountPerPeriod: u64(168), numberOfPeriod: u64(176),
    cancelledAt: u64(200),
  };
}

/** Amount still locked at Unix time t (not yet released); 0 if cancelled */
export function lockedAt(l: JupiterLockInfo, t: bigint): bigint {
  if (l.cancelledAt !== 0n) return 0n;
  const total = l.cliffUnlockAmount + l.amountPerPeriod * l.numberOfPeriod;
  if (t < l.cliffTime) return total;
  const periods = l.frequency > 0n ? (t - l.cliffTime) / l.frequency : l.numberOfPeriod;
  return total - (l.cliffUnlockAmount + (periods < l.numberOfPeriod ? periods : l.numberOfPeriod) * l.amountPerPeriod);
}

export const isIrrevocable = (l: JupiterLockInfo) => l.cancel === 'none' && l.updateRecipient === 'none' && l.cancelledAt === 0n;

/** getMultipleAccounts over JSON-RPC (read-only) */
export function rpcAccounts(rpcUrl: string, f: typeof fetch = fetch): AccountsFetcher {
  return async (addresses) => {
    if (!addresses.length) return [];
    const r = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [addresses, { encoding: 'base64' }] }) });
    const j = (await r.json()) as { result?: { value: ({ owner: string; data: [string, string] } | null)[] }; error?: { message: string } };
    if (!j.result) throw new Error(`rpc getMultipleAccounts: ${j.error?.message ?? r.status}`);
    return j.result.value.map((a) => (a ? { owner: a.owner, data: new Uint8Array(Buffer.from(a.data[0], 'base64')) } : null));
  };
}

// ---- Streamflow (program strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m): same offsets as the check-engine decoder (@streamflow/stream 13.4.0 layout)
export const STREAMFLOW_PROGRAM = 'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m';
const STREAMFLOW_MIN_SIZE = 819;

export interface StreamflowInfo {
  recipient: string;
  mint: string;
  escrowTokens: string;
  canceledAt: bigint;
  startTime: bigint;
  netAmountDeposited: bigint;
  period: bigint;
  amountPerPeriod: bigint;
  cliff: bigint;
  cliffAmount: bigint;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  canUpdateRate: boolean;
  closed: boolean;
}

export function decodeStreamflow(data: Uint8Array): StreamflowInfo | null {
  if (data.length < STREAMFLOW_MIN_SIZE) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const b58 = getBase58Decoder();
  const key = (o: number) => b58.decode(data.subarray(o, o + 32));
  const u64 = (o: number) => v.getBigUint64(o, true);
  const bool = (o: number) => data[o] !== 0;
  return {
    canceledAt: u64(25), recipient: key(113), mint: key(177), escrowTokens: key(209),
    startTime: u64(409), netAmountDeposited: u64(417), period: u64(425), amountPerPeriod: u64(433), cliff: u64(441), cliffAmount: u64(449),
    cancelableBySender: bool(457), cancelableByRecipient: bool(458), transferableBySender: bool(460), transferableByRecipient: bool(461),
    canUpdateRate: bool(540), closed: bool(671),
  };
}

/** Amount still locked at Unix time t: nothing released before the cliff, then the cliff amount plus one amount per period (capped at the deposit) */
export function streamflowLockedAt(s: StreamflowInfo, t: bigint): bigint {
  if (s.canceledAt !== 0n || s.closed) return 0n;
  if (t < s.cliff) return s.netAmountDeposited;
  const periods = s.period > 0n ? (t - s.cliff) / s.period : 0n;
  const released = s.cliffAmount + periods * s.amountPerPeriod;
  return released >= s.netAmountDeposited ? 0n : s.netAmountDeposited - released;
}

/** Why a Streamflow contract is not a fixed lock (null = fixed) */
export function streamflowNotFixed(s: StreamflowInfo): string | null {
  const why = [
    s.cancelableBySender && 'cancelable by sender', s.cancelableByRecipient && 'cancelable by recipient',
    s.transferableBySender && 'transferable by sender', s.transferableByRecipient && 'transferable by recipient',
    s.canUpdateRate && 'rate can be updated', s.canceledAt !== 0n && 'cancelled', s.closed && 'closed',
  ].filter(Boolean);
  return why.length ? why.join(', ') : null;
}

// ---- One view over both protocols
export type LockProtocol = 'jupiter-lock' | 'streamflow';
export interface LockView { recipient: string; mint: string; notFixed: string | null; lockedAt(t: bigint): bigint }

/** Decodes a lock account of the given protocol; returns the reason as a string if it is not one */
export async function readLock(protocol: LockProtocol, address: string, a: AccountData | null): Promise<LockView | string> {
  if (!a) return 'account_not_found';
  if (protocol === 'jupiter-lock') {
    if (a.owner !== JUPITER_LOCK_PROGRAM) return 'not_a_jupiter_lock_account';
    const j = decodeJupiterLock(a.data);
    if (!j) return 'not_a_jupiter_lock_escrow';
    const notFixed = isIrrevocable(j) ? null : `cancel=${j.cancel}, updateRecipient=${j.updateRecipient}${j.cancelledAt ? ', cancelled' : ''}`;
    return { recipient: j.recipient, mint: j.mint, notFixed, lockedAt: (t) => lockedAt(j, t) };
  }
  if (a.owner !== STREAMFLOW_PROGRAM) return 'not_a_streamflow_account';
  const s = decodeStreamflow(a.data);
  if (!s) return 'not_a_streamflow_contract';
  // A real contract's escrow is PDA(["strm", contract], program)
  const [escrow] = await getProgramDerivedAddress({ programAddress: address_(STREAMFLOW_PROGRAM), seeds: [new TextEncoder().encode('strm'), getAddressEncoder().encode(address_(address))] });
  if (escrow !== s.escrowTokens) return 'streamflow_escrow_mismatch';
  return { recipient: s.recipient, mint: s.mint, notFixed: streamflowNotFixed(s), lockedAt: (t) => streamflowLockedAt(s, t) };
}
