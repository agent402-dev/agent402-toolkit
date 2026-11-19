// 표준 x402 v2 (exact, Solana) — 리소스 서버 쪽 처리 단계 (a402-pay-server 내부, gate.ts 가 씀).
//
// 흐름: 검증 → (호출자의 작업) → 정산
//  - verifyPaymentHeader: 결제가 고른 조건(accepted)이 지금 조건과 같은지(공식 매칭), resource 경로, 장부에서 잡기, facilitator verify
//  - settleVerified: facilitator settle → 체인 재확인. 실패·결과 모름이면 체인에서 구매자 서명으로 판정,
//    없으면 "결과 모름"으로 두고 유효시간(150초)이 지나도 없을 때만 "결제 안 됨"
//
// 서버에는 수령 지갑 공개 주소만 있음. 수수료 대납(feePayer) 키는 facilitator 가 가짐.
import { decodePaymentSignatureHeader, encodePaymentResponseHeader } from '@x402/core/http';
import type { FacilitatorClient, x402ResourceServer } from '@x402/core/server';
import { buildCoreRequirements, createCoreServer, definiteVerifyRejection, matchRequirement, settleFailureReason } from './core.js';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ataOf, base58Encode, receivedBy, SPL_TOKEN, TOKEN_2022, type ChainTx } from './chain.js';
export { SPL_TOKEN, TOKEN_2022 };
type TxRecordWithInstructions = ChainTx;

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';


export interface Asset {
  symbol: 'USDC' | 'A402';
  mint: string;
  decimals: number;
  /** SPL Token 또는 Token-2022 프로그램 주소 */
  tokenProgram: string;
}


export interface Offer {
  asset: Asset;
  amount: bigint;
  /** A402 일 때 환율 근거 (extra.rate 로 공개) */
  rate?: { date: string; a402Usd: number; method: string; discountPercent: number };
}

export interface NamedFacilitator {
  name: string;
  client: FacilitatorClient;
}

export interface X402Config {
  network: string;
  /** 수령 지갑 공개 주소 */
  payTo: string;
  /** 앞쪽이 기본, 뒤쪽이 예비 */
  facilitators: NamedFacilitator[];
  maxTimeoutSeconds: number;
}

// ---------- facilitator 선택 (/supported 를 잠시 캐시) ----------
// facilitator 마다 공식 x402ResourceServer 를 하나씩 만들어 둠 (그 facilitator 의 /supported 로 초기화)
interface Chosen { facilitator: NamedFacilitator; feePayer: string; transactionVersions?: unknown; server: x402ResourceServer }
const supportedCache = new Map<string, { at: number; chosen: Chosen | null }>();
const SUPPORTED_TTL_MS = 10 * 60_000;

/** facilitator 하나의 /supported 에서 이 네트워크 exact(v2) 의 feePayer (캐시) */
async function supportedFor(f: NamedFacilitator, network: string, nowMs: number): Promise<Chosen | null> {
  const key = `${f.name}|${network}`;
  const c = supportedCache.get(key);
  if (c && nowMs - c.at < SUPPORTED_TTL_MS) return c.chosen;
  let chosen: Chosen | null = null;
  try {
    const server = await createCoreServer(f.client, network);
    const kind = server.getSupportedKind(2, network as PaymentRequirements['network'], 'exact');
    const feePayer = kind?.extra && typeof kind.extra.feePayer === 'string' ? kind.extra.feePayer : null;
    if (feePayer) chosen = { facilitator: f, feePayer, transactionVersions: kind?.extra?.transactionVersions, server };
  } catch { /* 장애 → null (짧게 캐시해 다음 facilitator 로) */ }
  supportedCache.set(key, { at: chosen ? nowMs : nowMs - SUPPORTED_TTL_MS + 30_000, chosen });
  return chosen;
}

/** 기본 → 예비 순서로, 이 네트워크 exact 를 지원하는 첫 facilitator */
export async function chooseFacilitator(cfg: X402Config, nowMs: number): Promise<Chosen | null> {
  for (const f of cfg.facilitators) {
    const c = await supportedFor(f, cfg.network, nowMs);
    if (c) return c;
  }
  return null;
}

/** 결제 조건의 feePayer 를 쓰는 facilitator (정산은 반드시 그 facilitator 로) */
export async function facilitatorForFeePayer(cfg: X402Config, feePayer: unknown, nowMs: number): Promise<Chosen | null> {
  if (typeof feePayer !== 'string') return null;
  for (const f of cfg.facilitators) {
    const c = await supportedFor(f, cfg.network, nowMs);
    if (c?.feePayer === feePayer) return c;
  }
  return null;
}
export function clearSupportedCache() { supportedCache.clear(); }

// ---------- 402 ----------
/** 결제 조건 만들기 — 공식 x402ResourceServer.buildPaymentRequirementsFromOptions (feePayer·transactionVersions 는 공식 SVM 서버가 채움) */
export function buildRequirements(cfg: X402Config, offers: Offer[], chosen: Chosen): Promise<PaymentRequirements[]> {
  return buildCoreRequirements(chosen.server, cfg.network, cfg.payTo, cfg.maxTimeoutSeconds, offers.map((o) => ({
    asset: o.asset.mint,
    amount: o.amount.toString(),
    extra: { name: o.asset.symbol, decimals: o.asset.decimals, ...(o.rate ? { rate: o.rate } : {}) },
  })));
}

// ---------- 결제 처리 ----------
export interface X402Ledger {
  /**
   * 결제(키)를 잡음.
   *  new: 처음 → 정산 진행 / settled: 정산은 끝났고 리포트를 못 받은 결제 → 정산 건너뜀
   *  in_progress·fulfilled: 거절
   */
  claim(key: string, nowMs: number): Promise<
    | { ok: true; state: 'new' }
    /** 지난번 정산 요청의 결과를 모름 — 체인에서 판정해야 함 */
    | { ok: true; state: 'settle_unknown'; since: number }
    | { ok: false; state: 'in_progress' | 'fulfilled' }
  >;
  /** 정산 요청 결과를 모름 (시간 초과 등) */
  markSettleUnknown(key: string, nowMs: number): Promise<void>;
  fulfill(key: string, nowMs: number): Promise<void>;
  /** 정산 전 실패 → 풀어 줌 */
  release(key: string): Promise<void>;
}

const IN_PROGRESS_TTL_MS = 120_000;
/**
 * 정산 결과를 모를 때, 이 시간이 지나도 체인에 없으면 그 트랜잭션은 더는 처리될 수 없음
 * (blockhash 유효 150블록 ≈ 60~90초에 여유를 둠)
 */
export const SETTLE_UNKNOWN_EXPIRY_MS = 150_000;

type LedgerEntry =
  | { state: 'in_progress'; at: number }
  | { state: 'settle_unknown'; at: number }
  | { state: 'fulfilled'; at: number };

/** 장부 상태 전이 (Durable Object 와 메모리 구현이 같이 씀) */
export function ledgerClaim(e: LedgerEntry | undefined, nowMs: number) {
  if (!e) return { next: { state: 'in_progress', at: nowMs } as LedgerEntry, result: { ok: true, state: 'new' } as const };
  if (e.state === 'fulfilled') return { next: e, result: { ok: false, state: 'fulfilled' } as const };
  if (e.state === 'in_progress' && nowMs - e.at < IN_PROGRESS_TTL_MS) return { next: e, result: { ok: false, state: 'in_progress' } as const };
  if (e.state === 'in_progress') return { next: { state: 'in_progress', at: nowMs } as LedgerEntry, result: { ok: true, state: 'new' } as const };
  // settle_unknown: 처리 중으로 잡되 원래 시각을 함께 돌려줌
  return { next: { state: 'in_progress', at: nowMs } as LedgerEntry, result: { ok: true, state: 'settle_unknown', since: e.at } as const };
}
export type { LedgerEntry };

export function memoryX402Ledger(): X402Ledger {
  const m = new Map<string, LedgerEntry>();
  return {
    async claim(key, now) { const r = ledgerClaim(m.get(key), now); m.set(key, r.next); return r.result; },
    async markSettleUnknown(key, now) { m.set(key, { state: 'settle_unknown', at: now }); },
    async fulfill(key, now) { m.set(key, { state: 'fulfilled', at: now }); },
    async release(key) { if (m.get(key)?.state === 'in_progress') m.delete(key); },
  };
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface ProcessDeps {
  cfg: X402Config;
  ledger: X402Ledger;
  /** 결제 네트워크에서 트랜잭션 읽기 (체인 재확인) */
  loadTx: (signature: string) => Promise<TxRecordWithInstructions | null>;
  /** 결제 네트워크에서 주소의 최근 서명 (정산 결과를 모를 때 판정용) */
  recentSignatures: (address: string, limit: number) => Promise<string[]>;
  /** 결제 수단 민트 → 토큰 프로그램 (수령 토큰 계정 주소 계산용) */
  tokenProgramOf: (mint: string) => string;
  nowMs: number;
  /** 체인 재확인 재시도 간격 */
  confirmDelaysMs?: number[];
}

/** 검증까지 끝난 결제 (아직 돈은 나가지 않음) */
export interface VerifiedPayment {
  key: string;
  payload: PaymentPayload;
  accepted: PaymentRequirements;
  facilitator: NamedFacilitator;
  /** 그 facilitator 를 감싼 공식 리소스 서버 (verify·settle 호출) */
  server: x402ResourceServer;
  /** 지난번 정산 결과를 모르는 결제를 다시 처리하는 중이면 그 시각 */
  settleUnknownSince: number | null;
}

export type VerifyOutcome =
  | { kind: 'payment_required'; reason: string; message: string }
  | { kind: 'conflict'; state: 'in_progress' | 'fulfilled' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'verified'; payment: VerifiedPayment };

export type SettleOutcome =
  | { kind: 'payment_required'; reason: string; message: string }
  | { kind: 'unavailable'; message: string }
  /** confirmation: confirmed = 우리 RPC 로 체인에서 확인 / pending = facilitator 는 성공, 체인 확인은 아직 */
  | { kind: 'paid'; settlement: SettleResponse; confirmation: 'confirmed' | 'pending' };

/** 부분 서명된 트랜잭션(base64)에서 이미 채워진 서명들 (구매자 서명). 비어 있는 자리(전부 0)는 뺌 */
export function presentSignatures(txBase64: string): string[] {
  const buf = Uint8Array.from(atob(txBase64), (c) => c.charCodeAt(0));
  let n = 0, shift = 0, i = 0;
  for (;;) { const b = buf[i++]; n |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const sig = buf.subarray(i + k * 64, i + (k + 1) * 64);
    if (sig.some((x) => x !== 0)) out.push(base58Encode(sig));
  }
  return out;
}


/** 체인 기록이 이 결제 조건을 만족하는지 */
function satisfies(tx: TxRecordWithInstructions, accepted: PaymentRequirements) {
  return !tx.err && receivedBy(tx, accepted.payTo, accepted.asset) >= BigInt(accepted.amount);
}

/**
 * 정산 결과를 모를 때 체인에서 판정: 수령 토큰 계정의 최근 기록 중 구매자 서명이 들어 있는 트랜잭션을 찾음.
 * 찾으면 그 트랜잭션, 없으면 null
 */
export async function findSettledOnChain(v: VerifiedPayment, d: ProcessDeps): Promise<TxRecordWithInstructions | null> {
  const mine = new Set(presentSignatures((v.payload.payload as { transaction: string }).transaction));
  if (!mine.size) return null;
  const ata = await ataOf(v.accepted.payTo, v.accepted.asset, d.tokenProgramOf(v.accepted.asset));
  for (const sig of await d.recentSignatures(ata, 25)) {
    const tx = await d.loadTx(sig);
    if (tx && tx.signatures.some((s) => mine.has(s))) return tx;
  }
  return null;
}

/**
 * 1단계: PAYMENT-SIGNATURE 확인 → 장부에서 잡기 → facilitator /verify. 돈은 아직 나가지 않음.
 * 호출자는 이 다음에 리포트를 만들고, 성공했을 때만 settleVerified 를 부름
 */
export async function verifyPaymentHeader(header: string, resourcePath: string, current: PaymentRequirements[], d: ProcessDeps): Promise<VerifyOutcome> {
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return { kind: 'payment_required', reason: 'invalid_payload', message: 'Could not decode the PAYMENT-SIGNATURE header. No payment was taken.' };
  }
  if (payload.x402Version !== 2) return { kind: 'payment_required', reason: 'invalid_x402_version', message: 'Only x402Version 2 is accepted. No payment was taken.' };
  try {
    if (payload.resource?.url && new URL(payload.resource.url).pathname !== resourcePath) {
      return { kind: 'payment_required', reason: 'resource_mismatch', message: 'This payment is for a different resource. No payment was taken.' };
    }
  } catch {
    return { kind: 'payment_required', reason: 'resource_mismatch', message: 'Could not parse resource.url. No payment was taken.' };
  }
  // 공식 매칭 규칙 (scheme·network·asset·amount·payTo·maxTimeoutSeconds 완전 일치 + extra 포함 관계)
  const accepted = matchRequirement(current, payload, d.cfg.network);
  if (!accepted) {
    return { kind: 'payment_required', reason: 'requirements_mismatch', message: 'The chosen payment requirements no longer match the current ones (amount, rate, recipient or facilitator may have changed). No payment was taken; pay again with the new requirements.' };
  }
  const tx = (payload.payload as { transaction?: unknown }).transaction;
  if (typeof tx !== 'string' || !tx) return { kind: 'payment_required', reason: 'invalid_payload', message: 'payload.transaction is missing. No payment was taken.' };
  const key = await sha256Hex(`${d.cfg.network}|${tx}`);

  const claim = await d.ledger.claim(key, d.nowMs);
  if (!claim.ok) return { kind: 'conflict', state: claim.state };

  const target = await facilitatorForFeePayer(d.cfg, (accepted.extra as Record<string, unknown>).feePayer, d.nowMs);
  if (!target) { await d.ledger.release(key); return { kind: 'unavailable', message: 'Could not reach the facilitator. No payment was taken.' }; }
  const payment: VerifiedPayment = { key, payload, accepted, facilitator: target.facilitator, server: target.server, settleUnknownSince: claim.state === 'settle_unknown' ? claim.since : null };

  // 지난번 정산 결과를 모르는 결제: 다시 verify 하지 않고 정산 단계에서 체인으로 판정
  if (payment.settleUnknownSince !== null) return { kind: 'verified', payment };

  try {
    const v = await target.server.verifyPayment(payload, accepted);
    if (!v.isValid) {
      await d.ledger.release(key);
      return { kind: 'payment_required', reason: v.invalidReason ?? 'invalid_payment', message: v.invalidMessage ?? 'Payment verification failed. No payment was taken.' };
    }
  } catch (e) {
    await d.ledger.release(key);
    const rejected = definiteVerifyRejection(e);
    if (rejected) return { kind: 'payment_required', reason: rejected.reason, message: rejected.message ?? 'Payment verification failed. No payment was taken.' };
    return { kind: 'unavailable', message: 'The facilitator did not respond. No payment was taken; please try again.' };
  }
  return { kind: 'verified', payment };
}

/**
 * 2단계 (리포트를 만든 뒤에만): facilitator /settle → 우리 RPC 로 체인 재확인.
 * 정산 결과를 모르면(시간 초과 등) 체인에서 구매자 서명으로 판정하고, 그래도 모르면 "결과 모름"으로 남김
 */
export async function settleVerified(v: VerifiedPayment, d: ProcessDeps): Promise<SettleOutcome> {
  const { accepted, key } = v;
  /** 체인에서 못 찾음 → 유효시간 안이면 "결과 모름"(재판정 대기), 지났으면 그때 비로소 "결제 안 됨"으로 풀어 줌 */
  const unknown = async (facilitatorSaid?: string): Promise<SettleOutcome> => {
    const since = v.settleUnknownSince ?? d.nowMs;
    if (d.nowMs - since > SETTLE_UNKNOWN_EXPIRY_MS) {
      await d.ledger.release(key);
      return { kind: 'payment_required', reason: 'payment_expired', message: 'This payment did not land on chain and has expired. No payment was taken; please pay again.' };
    }
    await d.ledger.markSettleUnknown(key, since);
    return {
      kind: 'unavailable',
      message: `${facilitatorSaid ? `The facilitator reported a settlement failure (${facilitatorSaid}), but the result is not final until the chain is checked. ` : 'The settlement result is not known yet. '}Retry later with the same PAYMENT-SIGNATURE and the result is decided from the chain record (if it settled you get the response; if it is still not on chain after it expires, it is treated as not paid).`,
    };
  };
  /**
   * 정산이 실패했거나 결과를 모를 때 (응답 없음·4xx·5xx·success:false 모두): facilitator 말만 믿지 않고 체인에서 먼저 찾음
   * (facilitator 가 tx 를 보낸 뒤 확정 대기 시간 초과로 실패를 돌려주는 경우 — 돈은 나갔을 수 있음)
   */
  const judgeOnChain = async (facilitatorSaid?: string, reportedTx?: string): Promise<SettleOutcome> => {
    if (reportedTx) {
      const t = await d.loadTx(reportedTx).catch(() => null);
      if (t && satisfies(t, accepted)) return fromChain(t);
    }
    const tx = await findSettledOnChain(v, d).catch(() => null);
    if (tx && satisfies(tx, accepted)) return fromChain(tx);
    return unknown(facilitatorSaid);
  };
  const fromChain = (tx: TxRecordWithInstructions): SettleOutcome => ({
    kind: 'paid', confirmation: 'confirmed',
    settlement: { success: true, transaction: tx.signature, network: accepted.network, payer: tx.accountKeys[0] } as SettleResponse,
  });

  // 지난번 결과를 모르는 결제 → 체인으로만 판정 (다시 settle 하지 않음)
  if (v.settleUnknownSince !== null) {
    const tx = await findSettledOnChain(v, d).catch(() => null);
    if (tx && satisfies(tx, accepted)) return fromChain(tx);
    return unknown();
  }

  let settlement: SettleResponse;
  try {
    settlement = await v.server.settlePayment(v.payload, accepted);
  } catch (e) {
    // 4xx 실패 응답이든 응답 없음(시간 초과·5xx)이든 → 체인에서 먼저 판정
    return judgeOnChain(settleFailureReason(e) ?? undefined);
  }
  if (!settlement.success) {
    return judgeOnChain(settlement.errorReason ?? 'settle_failed', settlement.transaction || undefined);
  }

  // 체인 재확인 (facilitator 응답을 그대로 믿지 않음)
  let confirmed: TxRecordWithInstructions | null = null;
  for (const wait of [0, ...(d.confirmDelaysMs ?? [1000, 2000, 4000])]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    confirmed = await d.loadTx(settlement.transaction).catch(() => null);
    if (confirmed) break;
  }
  if (confirmed && !satisfies(confirmed, accepted)) {
    await d.ledger.release(key);
    return { kind: 'payment_required', reason: 'onchain_mismatch', message: 'On-chain record shows the receiving address did not receive the required amount.' };
  }
  // facilitator 는 성공이라 했는데 아직 체인에서 못 찾음 → 구매자가 돈을 냈을 수 있으므로 리포트는 드리고 "확인 대기"로 표시
  return { kind: 'paid', settlement, confirmation: confirmed ? 'confirmed' : 'pending' };
}

export function paymentResponseHeader(s: SettleResponse): string {
  return encodePaymentResponseHeader(s);
}
