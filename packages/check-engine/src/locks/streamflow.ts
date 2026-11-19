import { PublicKey } from '@solana/web3.js';
import { Reader } from '../bytes.js';
import { STREAMFLOW_PROGRAM, streamflowEscrow } from '../holders/registry.js';

/**
 * Streamflow 계약(스트림 메타데이터) 해석.
 * 레이아웃: @streamflow/stream 13.4.0 solana/layout.ts streamLayout (packed, little-endian)
 * SDK 에 적힌 오프셋(sender 49, recipient 113, mint 177, closed 671, old_metadata 714)과 일치함.
 */
export const STREAMFLOW = STREAMFLOW_PROGRAM.toBase58();
export const STREAMFLOW_CONTRACT_MIN_SIZE = 819;

export interface StreamflowContract {
  createdAt: bigint;
  withdrawnAmount: bigint;
  canceledAt: bigint;
  endTime: bigint;
  sender: string;
  recipient: string;
  mint: string;
  escrowTokens: string;
  streamflowFeeTotal: bigint;
  partnerFeeTotal: bigint;
  startTime: bigint;
  netAmountDeposited: bigint;
  period: bigint;
  amountPerPeriod: bigint;
  cliff: bigint;
  cliffAmount: bigint;
  cancelableBySender: boolean;
  cancelableByRecipient: boolean;
  automaticWithdrawal: boolean;
  transferableBySender: boolean;
  transferableByRecipient: boolean;
  canTopup: boolean;
  name: string;
  pausable: boolean;
  canUpdateRate: boolean;
  closed: boolean;
  currentPauseStart: bigint;
}

export function decodeStreamflowContract(data: Buffer): StreamflowContract {
  if (data.length < STREAMFLOW_CONTRACT_MIN_SIZE) throw new Error(`streamflow contract too small (${data.length})`);
  const r = new Reader(data, 9); // magic(8) + version(1)
  const createdAt = r.u64();
  const withdrawnAmount = r.u64();
  const canceledAt = r.u64();
  const endTime = r.u64();
  r.u64(); // last_withdrawn_at
  const sender = r.pubkey().toBase58();
  r.pubkey(); // sender_tokens
  const recipient = r.pubkey().toBase58();
  r.pubkey(); // recipient_tokens
  const mint = r.pubkey().toBase58();
  const escrowTokens = r.pubkey().toBase58();
  r.pubkey(); r.pubkey(); // streamflow_treasury, _tokens
  const streamflowFeeTotal = r.u64();
  r.u64(); // streamflow_fee_withdrawn
  r.bytes(4); // streamflow_fee_percent f32
  r.pubkey(); r.pubkey(); // partner, partner_tokens
  const partnerFeeTotal = r.u64();
  r.u64(); // partner_fee_withdrawn
  r.bytes(4); // partner_fee_percent
  const startTime = r.u64();
  const netAmountDeposited = r.u64();
  const period = r.u64();
  const amountPerPeriod = r.u64();
  const cliff = r.u64();
  const cliffAmount = r.u64();
  const cancelableBySender = r.bool();
  const cancelableByRecipient = r.bool();
  const automaticWithdrawal = r.bool();
  const transferableBySender = r.bool();
  const transferableByRecipient = r.bool();
  const canTopup = r.bool();
  const name = r.bytes(64).toString('utf8').replace(/\0+$/, '');
  r.u64(); // withdraw_frequency
  r.bytes(4); // ghost
  const pausable = r.bool();
  const canUpdateRate = r.bool();
  r.bytes(4); // ghost2
  r.u8(); // is_pda
  r.u32(); // nonce
  r.bytes(121); // create_params_padding
  const closed = r.bool(); // offset 671
  const currentPauseStart = r.u64();
  return {
    createdAt, withdrawnAmount, canceledAt, endTime, sender, recipient, mint, escrowTokens,
    streamflowFeeTotal, partnerFeeTotal, startTime, netAmountDeposited, period, amountPerPeriod, cliff, cliffAmount,
    cancelableBySender, cancelableByRecipient, automaticWithdrawal, transferableBySender, transferableByRecipient,
    canTopup, name, pausable, canUpdateRate, closed, currentPauseStart,
  };
}

/** 계약 주소로 금고 PDA 를 다시 계산해 계약에 기록된 금고와 같은지 (진짜 Streamflow 계약인지) 확인 */
export function isGenuineStreamflowContract(address: string, c: StreamflowContract): boolean {
  return streamflowEscrow(new PublicKey(address)).toBase58() === c.escrowTokens;
}
