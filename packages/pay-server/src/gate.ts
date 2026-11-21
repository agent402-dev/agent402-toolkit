// External API of @agent402-dev/pay-server: createPaymentGate(config).withPayment(handler)
// Standard Request → Response. Works as is on Cloudflare Workers, Node 20+ (fetch API), Hono, etc.
//
// Order: 402 → (payment header) match requirements and verify with the official server → handler (time limit) → settle only on success (<400) → recheck on-chain
// If settlement fails or its result is unknown, decide on-chain first (x402.ts settleVerified)
//
// Does not: operate a facilitator, hold funds, exchange currencies, or process payments for others. The server only takes the receiving wallet's public address (no API takes a private key)
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements } from '@x402/core/types';
import { ataOf, type ChainReader } from './chain.js';
import { tokenAmountFor, type DailyRate } from './pricing.js';
import { A402_DEPRECATION_WARNING, PREQ_DECIMALS, PREQ_MAINNET_MINT, PREQ_TOKEN_PROGRAM } from './preq.js';
import {
  buildRequirements, chooseFacilitator, memoryX402Ledger, paymentResponseHeader, settleVerified, verifyPaymentHeader,
  type Asset, type NamedFacilitator, type Offer, type ProcessDeps, type X402Config, type X402Ledger,
} from './x402.js';

/** A402 is deprecated (v1) */
export type AssetSymbol = 'USDC' | 'PREQ' | 'A402';

/** Settings for a token accepted in addition to USDC */
export interface TokenPayment {
  asset: Asset;
  /** Optional. Default 0: the token is charged the same USD price as USDC */
  discountPercent?: number;
  /** Today's fixed rate. If off or failing, that request does not offer this token */
  rate: () => Promise<DailyRate | null>;
}

export interface FacilitatorSpec {
  name: string;
  /** Either url or client */
  url?: string;
  client?: FacilitatorClient;
  /** Payment assets this facilitator accepts. Assets it does not accept are not put in the 402 */
  assets: AssetSymbol[];
}

/**
  * Facilitator defaults. Policies and status can change, so these are only defaults and can be overridden in config.
  *  - USDC: confirmed with mainnet verify and settle on 2026-11-19 (PayAI, Dexter)
  *  - A402 (v1, deprecated): record of a check on PayAI on 2026-11-19
  *  - PREQ: listed for PayAI (no asset restriction for Solana exact in /supported). Verified and settled in a local mainnet-fork rehearsal on 2026-11-22; not yet checked on a hosted facilitator
 */
export const KNOWN_FACILITATORS = {
  payai: { name: 'payai', url: 'https://facilitator.payai.network', assets: ['USDC', 'PREQ', 'A402'] as AssetSymbol[] },
  dexter: { name: 'dexter', url: 'https://x402.dexter.cash', assets: ['USDC'] as AssetSymbol[] },
} as const;

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const USDC_MAINNET: Asset = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
/** PREQ (Token-2022, 6 decimals). The mint is PREQ_MAINNET_MINT in preq.ts; if empty, createPaymentGate stops with an error */
export const PREQ_MAINNET: Asset = { symbol: 'PREQ', mint: PREQ_MAINNET_MINT, decimals: PREQ_DECIMALS, tokenProgram: PREQ_TOKEN_PROGRAM };
/** @deprecated A402 (v1) is deprecated. Use PREQ_MAINNET. Enabling it explicitly with config.a402 prints a warning */
export const A402_MAINNET: Asset = { symbol: 'A402', mint: 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };

export interface GateConfig {
  network: string;
  /** Public address of the receiving wallet */
  payTo: string;
  /** USDC price (USD) */
  priceUsd: number;
  usdc: Asset;
  /** Only when accepting PREQ. If rate() is off or fails, that request does not offer PREQ. Errors if asset.mint is empty */
  preq?: TokenPayment;
  /**
    * @deprecated A402 (v1) is deprecated; use PREQ. Not in the defaults.
    * Accepted only when set explicitly, and createPaymentGate prints a warning ("A402 (v1) is deprecated and no longer supported; use PREQ.")
   */
  a402?: TokenPayment;
  /** Warning output (default console.warn) */
  warn?: (message: string) => void;
  /** First is primary, the rest are fallbacks */
  facilitators: FacilitatorSpec[];
  /** Chain reader (settlement recheck, deciding unknown results, checking receiving token accounts) */
  chain: ChainReader;
  ledger?: X402Ledger;
  /** Handler time limit: if exceeded, no settlement (default 40 s, shorter than the payment transaction's validity) */
  handlerTimeoutMs?: number;
  maxTimeoutSeconds?: number;
  /** If verify fails because of the facilitator (e.g. fee payer balance too low), skip that facilitator for this long (default 5 min) */
  facilitatorCooldownMs?: number;
  /** Cache for the receiving token account check (default 10 min) */
  receivingCheckTtlMs?: number;
  resource?: { description?: string; mimeType?: string; serviceName?: string };
  now?: () => number;
  /** Retry intervals for the on-chain recheck (default 1, 2, 4 s) */
  confirmDelaysMs?: number[];
}

export interface ReceivingAccount { asset: AssetSymbol; mint: string; tokenAccount: string; exists: boolean }

export interface PaymentInfo { asset: string; amount: string; payTo: string; network: string }

export interface PaymentGate {
  /** Wraps a paid handler */
  withPayment(handler: (req: Request, payment: PaymentInfo) => Promise<Response>): (req: Request) => Promise<Response>;
  /** Payment requirements that would go in a 402 now, plus missing assets and why (for checking) */
  quote(resourceUrl: string): Promise<{ accepts: PaymentRequirements[]; notOffered: { asset: AssetSymbol; reason: string }[]; facilitator: string } | null>;
  /** Whether the receiving wallet has USDC and PREQ (and A402) token accounts (assets without one are not put in the 402) */
  checkReceivingAccounts(): Promise<ReceivingAccount[]>;
}

/**
  * Whether a verify failure is a facilitator-side problem rather than the buyer's fault (e.g. the fee payer = transaction account 0 has too little balance).
  * Real case on 2026-11-19: `transaction_simulation_failed: Simulation failed: {"InsufficientFundsForRent":{"account_index":0}}`
 */
export function isFacilitatorSideFailure(reason?: string, message?: string): boolean {
  const s = `${reason ?? ''} ${message ?? ''}`;
  if (/InsufficientFundsForRent[^}]*account_index"?\s*:\s*0\b/.test(s)) return true;
  if (/fee[ _-]?payer/i.test(s) && /(insufficient|balance|funds|rent)/i.test(s)) return true;
  return false;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });

const NOT_CHARGED = 'No payment was taken.';

export function createPaymentGate(c: GateConfig): PaymentGate {
  // Check token payment settings: stop if the PREQ mint is empty; A402 (v1) only when enabled explicitly, with a warning
  if (c.preq) {
    if (c.preq.asset.symbol !== 'PREQ') throw new Error(`config.preq.asset.symbol must be PREQ (got ${c.preq.asset.symbol})`);
    if (!c.preq.asset.mint) {
      throw new Error('PREQ mint is not set: PREQ payments cannot be enabled yet. Fill PREQ_MAINNET_MINT in @agent402-dev/pay-server src/preq.ts after the PREQ launch, or pass your own asset (e.g. a devnet mint).');
    }
  }
  if (c.a402) {
    if (c.a402.asset.symbol !== 'A402') throw new Error(`config.a402.asset.symbol must be A402 (got ${c.a402.asset.symbol})`);
    (c.warn ?? console.warn)(A402_DEPRECATION_WARNING);
  }
  if (c.preq && c.a402 && c.preq.asset.mint === c.a402.asset.mint) throw new Error('config.preq and config.a402 use the same mint');
  const tokens: TokenPayment[] = [c.preq, c.a402].filter((t): t is TokenPayment => !!t);
  const now = c.now ?? (() => Date.now());
  const ledger = c.ledger ?? memoryX402Ledger();
  const named: (NamedFacilitator & { assets: AssetSymbol[] })[] = c.facilitators.map((f) => ({
    name: f.name,
    client: f.client ?? new HTTPFacilitatorClient({ url: f.url! }),
    assets: f.assets,
  }));
  const cooldown = new Map<string, number>();
  const cfgFor = (fs: NamedFacilitator[]): X402Config => ({ network: c.network, payTo: c.payTo, facilitators: fs, maxTimeoutSeconds: c.maxTimeoutSeconds ?? 60 });
  const allCfg = cfgFor(named);

  // ---- Receiving token account check (cached) ----
  let receiving: { at: number; list: ReceivingAccount[] } | null = null;
  async function checkReceivingAccounts(): Promise<ReceivingAccount[]> {
    if (receiving && now() - receiving.at < (c.receivingCheckTtlMs ?? 600_000)) return receiving.list;
    const assets = [c.usdc, ...tokens.map((t) => t.asset)];
    const atas = await Promise.all(assets.map((a) => ataOf(c.payTo, a.mint, a.tokenProgram)));
    const { accounts } = await c.chain.accounts(atas);
    const list = assets.map((a, i) => ({ asset: a.symbol as AssetSymbol, mint: a.mint, tokenAccount: atas[i], exists: !!accounts[i] && accounts[i]!.owner === a.tokenProgram }));
    receiving = { at: now(), list };
    return list;
  }

  async function quote(resourceUrl: string) {
    const healthy = named.filter((f) => (cooldown.get(f.name) ?? 0) <= now());
    const chosen = await chooseFacilitator(cfgFor(healthy), now());
    if (!chosen) return null;
    const fac = named.find((f) => f.name === chosen.facilitator.name)!;
    const notOffered: { asset: AssetSymbol; reason: string }[] = [];
    let recv: ReceivingAccount[] = [];
    try { recv = await checkReceivingAccounts(); } catch { /* check failed → continue without blocking (there is a separate on-chain recheck) */ }
    const missing = (sym: AssetSymbol) => recv.find((r) => r.asset === sym && !r.exists);

    const offers: Offer[] = [];
    // USDC
    if (missing('USDC')) notOffered.push({ asset: 'USDC', reason: `receiving token account ${missing('USDC')!.tokenAccount} does not exist` });
    else offers.push({ asset: c.usdc, amount: BigInt(Math.round(c.priceUsd * 10 ** c.usdc.decimals)) });
    // Tokens (PREQ, and A402 (v1) only when enabled explicitly)
    for (const t of tokens) {
      const sym = t.asset.symbol as AssetSymbol;
      if (!fac.assets.includes(sym)) {
        notOffered.push({ asset: sym, reason: `facilitator ${fac.name} does not accept ${sym}` });
      } else if (missing(sym)) {
        notOffered.push({ asset: sym, reason: `receiving token account ${missing(sym)!.tokenAccount} does not exist` });
      } else {
        const rate = await t.rate().catch(() => null);
        if (!rate) notOffered.push({ asset: sym, reason: `${sym} rate unavailable` });
        else if (rate.status === 'off') notOffered.push({ asset: sym, reason: rate.reason });
        else {
          let amount: bigint | null = null;
          try { amount = tokenAmountFor(c.priceUsd, t.discountPercent ?? 0, rate, t.asset.decimals); } catch { amount = null; }
          if (amount === null) notOffered.push({ asset: sym, reason: `${sym} rate out of range` });
          else offers.push({ asset: t.asset, amount, rate: { date: rate.date, tokenUsd: rate.tokenUsd, method: rate.method, discountPercent: t.discountPercent ?? 0 } });
        }
      }
    }
    if (!fac.assets.includes('USDC')) {
      const i = offers.findIndex((o) => o.asset.symbol === 'USDC');
      if (i >= 0) { offers.splice(i, 1); notOffered.push({ asset: 'USDC', reason: `facilitator ${fac.name} does not accept USDC` }); }
    }
    const accepts = offers.length ? await buildRequirements(allCfg, offers, chosen) : [];
    return { accepts, notOffered, facilitator: fac.name };
  }

  function paymentRequired(resourceUrl: string, q: NonNullable<Awaited<ReturnType<typeof quote>>>, extra: Record<string, unknown> = {}, error?: string) {
    const pr = {
      x402Version: 2,
      ...(error ? { error } : {}),
      resource: { url: resourceUrl, description: c.resource?.description ?? '', mimeType: c.resource?.mimeType ?? 'application/json', ...(c.resource?.serviceName ? { serviceName: c.resource.serviceName } : {}) },
      accepts: q.accepts,
    };
    return json(402, { ...pr, ...(q.notOffered.length ? { notOffered: q.notOffered } : {}), ...extra }, {
      'payment-required': encodePaymentRequiredHeader(pr as Parameters<typeof encodePaymentRequiredHeader>[0]),
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    });
  }

  function withPayment(handler: (req: Request, payment: PaymentInfo) => Promise<Response>) {
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const resourceUrl = `${url.origin}${url.pathname}`;
      const q = await quote(resourceUrl);
      if (!q) return json(503, { error: 'payment_unavailable', message: `No facilitator is reachable right now. ${NOT_CHARGED}` });
      if (!q.accepts.length) return json(503, { error: 'payment_unavailable', message: `No payment option can be offered right now. ${NOT_CHARGED}`, notOffered: q.notOffered });
      const header = req.headers.get('payment-signature');
      if (!header) return paymentRequired(resourceUrl, q, {}, 'Payment required');

      const d: ProcessDeps = {
        cfg: allCfg, ledger,
        loadTx: (s) => c.chain.loadTx(s),
        recentSignatures: (a, n) => c.chain.recentSignatures(a, n),
        tokenProgramOf: (mint) => tokens.find((t) => t.asset.mint === mint)?.asset.tokenProgram ?? c.usdc.tokenProgram,
        nowMs: now(),
        confirmDelaysMs: c.confirmDelaysMs,
      };

      // 1) Match requirements and verify (no money moves yet)
      const v = await verifyPaymentHeader(header, url.pathname, q.accepts, d);
      if (v.kind === 'conflict') return json(409, { error: 'payment_already_used', state: v.state, message: v.state === 'fulfilled' ? 'This payment has already been used.' : 'This payment is being processed.' });
      if (v.kind === 'unavailable') return json(503, { error: 'payment_unavailable', message: `Could not reach the facilitator. ${NOT_CHARGED}` });
      if (v.kind === 'payment_required') {
        if (isFacilitatorSideFailure(v.reason, v.message)) {
          // Not the buyer's fault → drop that facilitator for a while and ask the buyer to pay again with the next facilitator's new requirements
          const feePayer = (() => { try { return (decodePaymentSignatureHeader(header).accepted?.extra as { feePayer?: string } | undefined)?.feePayer; } catch { return undefined; } })();
          const failed = (await Promise.all(named.map(async (f) => ((await chooseFacilitator(cfgFor([f]), now()))?.feePayer === feePayer ? f.name : null)))).find(Boolean);
          if (failed) cooldown.set(failed, now() + (c.facilitatorCooldownMs ?? 300_000));
          const q2 = await quote(resourceUrl);
          if (!q2 || !q2.accepts.length) return json(503, { error: 'payment_unavailable', reason: 'facilitator_unavailable', message: `The facilitator could not process this payment and no other facilitator is available. ${NOT_CHARGED}` });
          return paymentRequired(resourceUrl, q2, { reason: 'facilitator_unavailable', message: `The facilitator could not process this payment (${v.reason}). ${NOT_CHARGED} Please pay again with these new requirements.` }, 'facilitator_unavailable');
        }
        return paymentRequired(resourceUrl, q, { reason: v.reason, message: `Payment was not accepted (${v.reason}). ${NOT_CHARGED}` }, v.reason);
      }

      // 2) Handler (time limit). No settlement on failure, timeout, or a 4xx/5xx response
      const payment = v.payment;
      const info: PaymentInfo = { asset: payment.accepted.asset, amount: payment.accepted.amount, payTo: payment.accepted.payTo, network: payment.accepted.network };
      let res: Response;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        res = await Promise.race([
          handler(req, info),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('__handler_timeout__')), c.handlerTimeoutMs ?? 40_000); }),
        ]);
      } catch (e) {
        await ledger.release(payment.key);
        const timeout = (e as Error).message === '__handler_timeout__';
        return json(timeout ? 504 : 502, { error: timeout ? 'handler_timeout' : 'handler_failed', message: `The resource could not be produced. The payment was not settled. ${NOT_CHARGED}` });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status >= 400) {
        await ledger.release(payment.key);
        const h = new Headers(res.headers);
        h.set('x-payment-status', 'not-settled');
        return new Response(res.body, { status: res.status, headers: h });
      }

      // 3) Settle (+ decide on-chain if it fails or the result is unknown)
      const s = await settleVerified(payment, { ...d, nowMs: now() });
      if (s.kind === 'payment_required') return paymentRequired(resourceUrl, q, { reason: s.reason, message: `Payment was not settled (${s.reason}). ${NOT_CHARGED}` }, s.reason);
      if (s.kind === 'unavailable') return json(503, { error: 'settlement_pending', message: 'The settlement result is not known yet. Retry with the same PAYMENT-SIGNATURE shortly; it will be judged from the chain (if it settled you get the resource; if it never lands before it expires, no payment is taken).' });
      await ledger.fulfill(payment.key, now());
      const h = new Headers(res.headers);
      h.set('payment-response', paymentResponseHeader(s.settlement));
      h.set('x-payment-confirmation', s.confirmation);
      h.set('access-control-expose-headers', 'PAYMENT-RESPONSE, X-Payment-Confirmation');
      return new Response(res.body, { status: res.status, headers: h });
    };
  }

  return { withPayment, quote, checkReceivingAccounts };
}
