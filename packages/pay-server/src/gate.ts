// a402-pay-server 의 바깥 API: createPaymentGate(config).withPayment(handler)
// 표준 Request → Response. Cloudflare Workers·Node 20+(fetch API)·Hono 등에서 그대로 씀.
//
// 순서: 402 → (결제 헤더) 공식 서버로 조건 맞추기·verify → 핸들러 (제한 시간) → 성공(<400)일 때만 settle → 체인 재확인
// 정산이 실패·결과 모름이면 체인에서 먼저 판정 (x402.ts settleVerified)
//
// 하지 않는 것: facilitator 운영, 자금 보관, 환전, 결제 대행. 서버는 수령 지갑 공개 주소만 받음 (개인키 받는 API 없음)
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, type FacilitatorClient } from '@x402/core/server';
import type { PaymentRequirements } from '@x402/core/types';
import { ataOf, type ChainReader } from './chain.js';
import type { DailyRate } from './pricing.js';
import { a402AmountFor } from './rates.js';
import {
  buildRequirements, chooseFacilitator, memoryX402Ledger, paymentResponseHeader, settleVerified, verifyPaymentHeader,
  type Asset, type NamedFacilitator, type Offer, type ProcessDeps, type X402Config, type X402Ledger,
} from './x402.js';

export type AssetSymbol = 'USDC' | 'A402';

export interface FacilitatorSpec {
  name: string;
  /** url 또는 client 중 하나 */
  url?: string;
  client?: FacilitatorClient;
  /** 이 facilitator 가 받는 결제 자산. 받지 않는 자산은 402 에 넣지 않음 */
  assets: AssetSymbol[];
}

/**
 * 확인된 facilitator (2026-11-19 메인넷에서 verify·settle 로 확인한 사실 — docs: README "Facilitators").
 * 정책·상태는 바뀔 수 있으므로 기본값일 뿐, 설정으로 덮어쓸 수 있음
 */
export const KNOWN_FACILITATORS = {
  payai: { name: 'payai', url: 'https://facilitator.payai.network', assets: ['USDC', 'A402'] as AssetSymbol[] },
  dexter: { name: 'dexter', url: 'https://x402.dexter.cash', assets: ['USDC'] as AssetSymbol[] },
} as const;

export const SOLANA_MAINNET = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
export const SOLANA_DEVNET = 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1';
export const USDC_MAINNET: Asset = { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' };
export const A402_MAINNET: Asset = { symbol: 'A402', mint: 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X', decimals: 6, tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' };

export interface GateConfig {
  network: string;
  /** 수령 지갑 공개 주소 */
  payTo: string;
  /** USDC 가격 (USD) */
  priceUsd: number;
  usdc: Asset;
  /** A402 를 받을 때만. rate() 가 off 거나 실패하면 그 요청은 USDC 만 */
  a402?: { asset: Asset; discountPercent: number; rate: () => Promise<DailyRate | null> };
  /** 앞이 기본, 뒤가 예비 */
  facilitators: FacilitatorSpec[];
  /** 체인 읽기 (정산 재확인·결과 모를 때 판정·수령 토큰 계정 확인) */
  chain: ChainReader;
  ledger?: X402Ledger;
  /** 핸들러 제한 시간 — 넘으면 정산하지 않음 (기본 40초, 결제 트랜잭션 유효시간보다 짧게) */
  handlerTimeoutMs?: number;
  maxTimeoutSeconds?: number;
  /** facilitator 쪽 문제(수수료 대납 주소 잔액 부족 등)로 verify 가 실패하면 이 시간 동안 그 facilitator 를 건너뜀 (기본 5분) */
  facilitatorCooldownMs?: number;
  /** 수령 토큰 계정 확인 캐시 (기본 10분) */
  receivingCheckTtlMs?: number;
  resource?: { description?: string; mimeType?: string; serviceName?: string };
  now?: () => number;
  /** 체인 재확인 재시도 간격 (기본 1·2·4초) */
  confirmDelaysMs?: number[];
}

export interface ReceivingAccount { asset: AssetSymbol; mint: string; tokenAccount: string; exists: boolean }

export interface PaymentInfo { asset: string; amount: string; payTo: string; network: string }

export interface PaymentGate {
  /** 유료 핸들러 감싸기 */
  withPayment(handler: (req: Request, payment: PaymentInfo) => Promise<Response>): (req: Request) => Promise<Response>;
  /** 지금 402 에 넣을 결제 조건과 빠진 자산·이유 (확인용) */
  quote(resourceUrl: string): Promise<{ accepts: PaymentRequirements[]; notOffered: { asset: AssetSymbol; reason: string }[]; facilitator: string } | null>;
  /** 수령 지갑의 USDC·A402 토큰 계정이 있는지 (없으면 그 자산은 402 에 넣지 않음) */
  checkReceivingAccounts(): Promise<ReceivingAccount[]>;
}

/**
 * verify 실패가 구매자 탓이 아니라 facilitator 쪽 문제인지 (수수료 대납 주소 = 트랜잭션 계정 0 의 잔액 부족 등).
 * 2026-11-19 실제 사례: `transaction_simulation_failed: Simulation failed: {"InsufficientFundsForRent":{"account_index":0}}`
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

  // ---- 수령 토큰 계정 확인 (캐시) ----
  let receiving: { at: number; list: ReceivingAccount[] } | null = null;
  async function checkReceivingAccounts(): Promise<ReceivingAccount[]> {
    if (receiving && now() - receiving.at < (c.receivingCheckTtlMs ?? 600_000)) return receiving.list;
    const assets = [c.usdc, ...(c.a402 ? [c.a402.asset] : [])];
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
    try { recv = await checkReceivingAccounts(); } catch { /* 확인 실패 → 막지 않고 진행 (체인 재확인이 따로 있음) */ }
    const missing = (sym: AssetSymbol) => recv.find((r) => r.asset === sym && !r.exists);

    const offers: Offer[] = [];
    // USDC
    if (missing('USDC')) notOffered.push({ asset: 'USDC', reason: `receiving token account ${missing('USDC')!.tokenAccount} does not exist` });
    else offers.push({ asset: c.usdc, amount: BigInt(Math.round(c.priceUsd * 10 ** c.usdc.decimals)) });
    // A402
    if (c.a402) {
      if (!fac.assets.includes('A402')) {
        notOffered.push({ asset: 'A402', reason: `facilitator ${fac.name} does not accept A402` });
      } else if (missing('A402')) {
        notOffered.push({ asset: 'A402', reason: `receiving token account ${missing('A402')!.tokenAccount} does not exist` });
      } else {
        const rate = await c.a402.rate().catch(() => null);
        if (!rate) notOffered.push({ asset: 'A402', reason: 'A402 rate unavailable' });
        else if (rate.status === 'off') notOffered.push({ asset: 'A402', reason: rate.reason });
        else {
          offers.push({
            asset: c.a402.asset,
            amount: a402AmountFor(c.priceUsd, c.a402.discountPercent, rate, c.a402.asset.decimals),
            rate: { date: rate.date, a402Usd: rate.a402Usd, method: rate.method, discountPercent: c.a402.discountPercent },
          });
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
        tokenProgramOf: (mint) => (mint === c.a402?.asset.mint ? c.a402.asset.tokenProgram : c.usdc.tokenProgram),
        nowMs: now(),
        confirmDelaysMs: c.confirmDelaysMs,
      };

      // 1) 조건 맞추기·verify (돈은 아직 안 나감)
      const v = await verifyPaymentHeader(header, url.pathname, q.accepts, d);
      if (v.kind === 'conflict') return json(409, { error: 'payment_already_used', state: v.state, message: v.state === 'fulfilled' ? 'This payment has already been used.' : 'This payment is being processed.' });
      if (v.kind === 'unavailable') return json(503, { error: 'payment_unavailable', message: `Could not reach the facilitator. ${NOT_CHARGED}` });
      if (v.kind === 'payment_required') {
        if (isFacilitatorSideFailure(v.reason, v.message)) {
          // 구매자 탓이 아님 → 그 facilitator 를 잠시 빼고, 다음 facilitator 의 새 조건으로 다시 결제하도록 안내
          const feePayer = (() => { try { return (decodePaymentSignatureHeader(header).accepted?.extra as { feePayer?: string } | undefined)?.feePayer; } catch { return undefined; } })();
          const failed = (await Promise.all(named.map(async (f) => ((await chooseFacilitator(cfgFor([f]), now()))?.feePayer === feePayer ? f.name : null)))).find(Boolean);
          if (failed) cooldown.set(failed, now() + (c.facilitatorCooldownMs ?? 300_000));
          const q2 = await quote(resourceUrl);
          if (!q2 || !q2.accepts.length) return json(503, { error: 'payment_unavailable', reason: 'facilitator_unavailable', message: `The facilitator could not process this payment and no other facilitator is available. ${NOT_CHARGED}` });
          return paymentRequired(resourceUrl, q2, { reason: 'facilitator_unavailable', message: `The facilitator could not process this payment (${v.reason}). ${NOT_CHARGED} Please pay again with these new requirements.` }, 'facilitator_unavailable');
        }
        return paymentRequired(resourceUrl, q, { reason: v.reason, message: `Payment was not accepted (${v.reason}). ${NOT_CHARGED}` }, v.reason);
      }

      // 2) 핸들러 (제한 시간). 실패·시간 초과·4xx/5xx 응답이면 정산하지 않음
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

      // 3) 정산 (+ 실패·결과 모름이면 체인 판정)
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
