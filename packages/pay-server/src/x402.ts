// Standard x402 v2 (exact, Solana): resource-server-side processing steps (internal to @agent402-dev/pay-server, used by gate.ts).
//
// Flow: verify → (caller's work) → settle
//  - verifyPaymentHeader: checks the payment's chosen requirement (accepted) equals the current one (official matching), the resource path, claims it in the ledger, facilitator verify
//  - settleVerified: facilitator settle → on-chain recheck. If it fails or the result is unknown, decide on-chain by the buyer's signature;
//    if not found, keep it as "result unknown" and mark "not paid" only when it is still missing after the validity window (150 s)
//
// The server holds only the receiving wallet's public address. The fee payer (feePayer) key belongs to the facilitator.
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
  /** A402 is deprecated (v1). Only when enabled explicitly (prints a warning) */
  symbol: 'USDC' | 'PREQ' | 'A402';
  mint: string;
  decimals: number;
  /** SPL Token or Token-2022 program address */
  tokenProgram: string;
}


export interface Offer {
  asset: Asset;
  amount: bigint;
  /** For tokens (PREQ, etc.), the rate basis (published as extra.rate). tokenUsd = USD per token */
  rate?: { date: string; tokenUsd: number; method: string; discountPercent: number };
}

export interface NamedFacilitator {
  name: string;
  client: FacilitatorClient;
}

export interface X402Config {
  network: string;
  /** Public address of the receiving wallet */
  payTo: string;
  /** First is primary, the rest are fallbacks */
  facilitators: NamedFacilitator[];
  maxTimeoutSeconds: number;
}

// ---------- Facilitator selection (/supported cached briefly) ----------
// Keep one official x402ResourceServer per facilitator (initialized from that facilitator's /supported)
interface Chosen { facilitator: NamedFacilitator; feePayer: string; transactionVersions?: unknown; server: x402ResourceServer }
const supportedCache = new Map<string, { at: number; chosen: Chosen | null }>();
const SUPPORTED_TTL_MS = 10 * 60_000;

/** feePayer for exact (v2) on this network from one facilitator's /supported (cached) */
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
  } catch { /* outage → null (cached briefly, move on to the next facilitator) */ }
  supportedCache.set(key, { at: chosen ? nowMs : nowMs - SUPPORTED_TTL_MS + 30_000, chosen });
  return chosen;
}

/** First facilitator, primary then fallbacks, that supports exact on this network */
export async function chooseFacilitator(cfg: X402Config, nowMs: number): Promise<Chosen | null> {
  for (const f of cfg.facilitators) {
    const c = await supportedFor(f, cfg.network, nowMs);
    if (c) return c;
  }
  return null;
}

/** Facilitator using the feePayer in the payment requirements (settlement must go to that facilitator) */
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
/** Builds payment requirements with the official x402ResourceServer.buildPaymentRequirementsFromOptions (the official SVM server fills feePayer and transactionVersions) */
export function buildRequirements(cfg: X402Config, offers: Offer[], chosen: Chosen): Promise<PaymentRequirements[]> {
  return buildCoreRequirements(chosen.server, cfg.network, cfg.payTo, cfg.maxTimeoutSeconds, offers.map((o) => ({
    asset: o.asset.mint,
    amount: o.amount.toString(),
    extra: { name: o.asset.symbol, decimals: o.asset.decimals, ...(o.rate ? { rate: o.rate } : {}) },
  })));
}

// ---------- Payment processing ----------
export interface X402Ledger {
  /**
    * Claims the payment (key).
    *  new: first time → proceed to settle / settled: settled but the report was not received → skip settlement
    *  in_progress, fulfilled: reject
   */
  claim(key: string, nowMs: number): Promise<
    | { ok: true; state: 'new' }
    /** The result of the previous settle request is unknown; must be decided on-chain */
    | { ok: true; state: 'settle_unknown'; since: number }
    | { ok: false; state: 'in_progress' | 'fulfilled' }
  >;
  /** The settle request result is unknown (timeout, etc.) */
  markSettleUnknown(key: string, nowMs: number): Promise<void>;
  fulfill(key: string, nowMs: number): Promise<void>;
  /** Failed before settlement → release */
  release(key: string): Promise<void>;
}

const IN_PROGRESS_TTL_MS = 120_000;
/**
  * When the settlement result is unknown and the transaction is still not on-chain after this time, it can no longer be processed
  * (blockhash is valid for 150 blocks ≈ 60 to 90 s, with margin)
 */
export const SETTLE_UNKNOWN_EXPIRY_MS = 150_000;

type LedgerEntry =
  | { state: 'in_progress'; at: number }
  | { state: 'settle_unknown'; at: number }
  | { state: 'fulfilled'; at: number };

/** Ledger state transitions (shared by the Durable Object and memory implementations) */
export function ledgerClaim(e: LedgerEntry | undefined, nowMs: number) {
  if (!e) return { next: { state: 'in_progress', at: nowMs } as LedgerEntry, result: { ok: true, state: 'new' } as const };
  if (e.state === 'fulfilled') return { next: e, result: { ok: false, state: 'fulfilled' } as const };
  if (e.state === 'in_progress' && nowMs - e.at < IN_PROGRESS_TTL_MS) return { next: e, result: { ok: false, state: 'in_progress' } as const };
  if (e.state === 'in_progress') return { next: { state: 'in_progress', at: nowMs } as LedgerEntry, result: { ok: true, state: 'new' } as const };
  // settle_unknown: claim as in progress, and also return the original time
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
  /** Reads transactions on the payment network (on-chain recheck) */
  loadTx: (signature: string) => Promise<TxRecordWithInstructions | null>;
  /** Recent signatures for an address on the payment network (to decide when the settlement result is unknown) */
  recentSignatures: (address: string, limit: number) => Promise<string[]>;
  /** Payment asset mint → token program (to compute the receiving token account address) */
  tokenProgramOf: (mint: string) => string;
  nowMs: number;
  /** Retry intervals for the on-chain recheck */
  confirmDelaysMs?: number[];
}

/** A payment that passed verification (no money has moved yet) */
export interface VerifiedPayment {
  key: string;
  payload: PaymentPayload;
  accepted: PaymentRequirements;
  facilitator: NamedFacilitator;
  /** Official resource server wrapping that facilitator (calls verify and settle) */
  server: x402ResourceServer;
  /** If reprocessing a payment whose previous settlement result is unknown, its time */
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
  /** confirmation: confirmed = confirmed on-chain with our RPC / pending = facilitator reported success, not yet confirmed on-chain */
  | { kind: 'paid'; settlement: SettleResponse; confirmation: 'confirmed' | 'pending' };

/** Signatures already filled in a partially signed transaction (base64) (the buyer's signatures). Empty slots (all zeros) are left out */
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


/** Whether the on-chain record satisfies this payment requirement */
function satisfies(tx: TxRecordWithInstructions, accepted: PaymentRequirements) {
  return !tx.err && receivedBy(tx, accepted.payTo, accepted.asset) >= BigInt(accepted.amount);
}

/**
  * Decides on-chain when the settlement result is unknown: finds a transaction containing the buyer's signature among recent records of the receiving token account.
  * Returns that transaction if found, otherwise null
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
  * Step 1: check PAYMENT-SIGNATURE → claim in the ledger → facilitator /verify. No money moves yet.
  * The caller then builds the report and calls settleVerified only on success
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
  // Official matching rules (exact match of scheme, network, asset, amount, payTo, maxTimeoutSeconds + extra containment)
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

  // Payment whose previous settlement result is unknown: do not verify again; decide on-chain in the settle step
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
  * Step 2 (only after the report is built): facilitator /settle → on-chain recheck with our RPC.
  * If the settlement result is unknown (timeout, etc.), decide on-chain by the buyer's signature; if still unknown, leave it as "result unknown"
 */
export async function settleVerified(v: VerifiedPayment, d: ProcessDeps): Promise<SettleOutcome> {
  const { accepted, key } = v;
  /** Not found on-chain → within the validity window, "result unknown" (awaiting recheck); after it, released as "not paid" */
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
    * When settlement failed or its result is unknown (no response, 4xx, 5xx, success:false): don't rely only on the facilitator; look on-chain first
    * (the facilitator may have sent the tx and then returned a failure after timing out on confirmation, so money may have moved)
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

  // Payment with an unknown previous result → decide on-chain only (do not settle again)
  if (v.settleUnknownSince !== null) {
    const tx = await findSettledOnChain(v, d).catch(() => null);
    if (tx && satisfies(tx, accepted)) return fromChain(tx);
    return unknown();
  }

  let settlement: SettleResponse;
  try {
    settlement = await v.server.settlePayment(v.payload, accepted);
  } catch (e) {
    // Whether a 4xx failure response or no response (timeout, 5xx) → decide on-chain first
    return judgeOnChain(settleFailureReason(e) ?? undefined);
  }
  if (!settlement.success) {
    return judgeOnChain(settlement.errorReason ?? 'settle_failed', settlement.transaction || undefined);
  }

  // On-chain recheck (don't trust the facilitator response as is)
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
  // The facilitator reported success but it is not on-chain yet → the buyer may have paid, so deliver the report and mark it "pending confirmation"
  return { kind: 'paid', settlement, confirmation: confirmed ? 'confirmed' : 'pending' };
}

export function paymentResponseHeader(s: SettleResponse): string {
  return encodePaymentResponseHeader(s);
}
