// @agent402-dev/pay-server/evm — accept USDC on Base (EVM) over standard x402 v2 (exact, EIP-3009), beside or instead of Solana.
// Off unless you create it: nothing in the Solana gate changes.
//
// Order (same as the Solana gate): 402 → (payment header) official requirement matching + local checks → claim in the ledger →
// facilitator /verify → your handler (time limit) → settle only on success (<400) → on-chain recheck of the authorization.
//
// Only EIP-3009 `transferWithAuthorization` payloads are accepted (the buyer signs; the facilitator pays gas). USDC only.
// The server holds only the receiving 0x address. It never takes a private key.
// On-chain recheck: USDC's authorizationState(from, nonce) through your RPC. An EIP-3009 authorization can be used once and
// only before validBefore, so an unknown settlement is decided exactly: used → paid; unused after validBefore → never paid.
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http';
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from '@x402/core/server';
import type { Network, PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { memoryX402Ledger, sha256Hex, type X402Ledger } from './x402.js';
import { discoveryProblems, type DiscoveryConfig } from './discovery.js';
import { extensionsOf, type BondExtensionConfig } from './bond-ext.js';
import type { PaymentInfo } from './gate.js';
import { definiteVerifyRejection, settleFailureReason } from './core.js';

export const BASE_MAINNET = 'eip155:8453';
export const BASE_SEPOLIA = 'eip155:84532';
export type BaseNetwork = typeof BASE_MAINNET | typeof BASE_SEPOLIA;

/** USDC on Base. name/version are the token's EIP-712 domain (read on-chain 2026-11-26: Base "USD Coin", Base Sepolia "USDC", version "2") */
export const BASE_USDC: Record<BaseNetwork, { address: string; decimals: number; name: string; version: string }> = {
  [BASE_MAINNET]: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6, name: 'USD Coin', version: '2' },
  [BASE_SEPOLIA]: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, name: 'USDC', version: '2' },
};

/** Public x402.org facilitator: Base Sepolia only (testnet). For Base mainnet, pass a facilitator you have checked */
export const X402_ORG_TESTNET_FACILITATOR = { name: 'x402.org', url: 'https://x402.org/facilitator' } as const;

export interface EvmFacilitatorSpec { name: string; url?: string; client?: FacilitatorClient }

/** Reads whether an EIP-3009 authorization was used (true), is unused (false), or could not be read (null) */
export interface EvmChainReader {
  authorizationUsed(asset: string, from: string, nonce: string): Promise<boolean | null>;
}

const AUTHORIZATION_STATE = '0xe94a0102'; // authorizationState(address,bytes32)
const HEX20 = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
export const isEvmAddress = (s: unknown): s is string => typeof s === 'string' && HEX20.test(s) && !/^0x0{40}$/.test(s);

/** EvmChainReader over a JSON-RPC endpoint (eth_call, read only) */
export function rpcEvmChain(rpcUrl: string, f: typeof fetch = fetch): EvmChainReader {
  return {
    async authorizationUsed(asset, from, nonce) {
      if (!HEX20.test(asset) || !HEX20.test(from) || !HEX32.test(nonce)) return null;
      const data = AUTHORIZATION_STATE + from.slice(2).toLowerCase().padStart(64, '0') + nonce.slice(2).toLowerCase();
      try {
        const r = await f(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: asset, data }, 'latest'] }) });
        const j = (await r.json()) as { result?: string };
        if (typeof j.result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(j.result)) return null;
        return BigInt(j.result) !== 0n;
      } catch { return null; }
    },
  };
}

export interface EvmGateConfig {
  network: BaseNetwork;
  /** Your receiving 0x address. No key is ever needed */
  payTo: string;
  /** USDC price (USD) */
  priceUsd: number;
  /** First is primary, the rest are fallbacks. Required for Base mainnet; Base Sepolia defaults to the x402.org testnet facilitator */
  facilitators?: EvmFacilitatorSpec[];
  /** On-chain recheck (USDC authorizationState). Or pass rpcUrl */
  chain?: EvmChainReader;
  rpcUrl?: string;
  ledger?: X402Ledger;
  /** Handler time limit: if exceeded, no settlement (default 40 s) */
  handlerTimeoutMs?: number;
  /** Default 60 */
  maxTimeoutSeconds?: number;
  resource?: { description?: string; mimeType?: string; serviceName?: string };
  discovery?: DiscoveryConfig;
  /** Optional `extensions.bond` (see @agent402-dev/pay-server/bond-ext). Unset = 402 unchanged; a claim only, payment checks unchanged */
  bond?: BondExtensionConfig;
  now?: () => number;
  /** Retry intervals for the on-chain recheck (default 1, 2, 4 s) */
  confirmDelaysMs?: number[];
}

export interface EvmPaymentGate {
  withPayment(handler: (req: Request, payment: PaymentInfo) => Promise<Response>): (req: Request) => Promise<Response>;
  /** Payment requirements that would go in a 402 now (null when no facilitator supports the network) */
  quote(): Promise<{ accepts: PaymentRequirements[]; facilitator: string } | null>;
}

interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }

/** The EIP-3009 authorization in an exact EVM payload, or null (permit2 and unknown shapes are refused) */
export function eip3009Authorization(payload: PaymentPayload): Authorization | null {
  const a = (payload.payload as { authorization?: Record<string, unknown>; signature?: unknown })?.authorization;
  const sig = (payload.payload as { signature?: unknown })?.signature;
  if (!a || typeof sig !== 'string') return null;
  const s = (k: string) => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
  const out = { from: s('from'), to: s('to'), value: s('value'), validAfter: s('validAfter'), validBefore: s('validBefore'), nonce: s('nonce') };
  if (!HEX20.test(out.from) || !HEX20.test(out.to) || !HEX32.test(out.nonce) || !/^\d+$/.test(out.value) || !/^\d+$/.test(out.validAfter) || !/^\d+$/.test(out.validBefore)) return null;
  return out;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const NOT_CHARGED = 'No payment was taken.';

export function createEvmPaymentGate(c: EvmGateConfig): EvmPaymentGate {
  const usdc = BASE_USDC[c.network];
  if (!usdc) throw new Error(`evm gate: network must be ${BASE_MAINNET} or ${BASE_SEPOLIA}`);
  if (!isEvmAddress(c.payTo)) throw new Error('evm gate: payTo must be a 0x address (40 hex digits, not the zero address)');
  if (!(c.priceUsd > 0)) throw new Error('evm gate: priceUsd must be above 0');
  const specs: EvmFacilitatorSpec[] = c.facilitators ?? (c.network === BASE_SEPOLIA ? [X402_ORG_TESTNET_FACILITATOR] : []);
  if (!specs.length) throw new Error('evm gate: pass facilitators for Base mainnet (the x402.org facilitator is testnet only)');
  if (!c.chain && !c.rpcUrl) throw new Error('evm gate: pass rpcUrl or chain (on-chain recheck)');
  if (c.discovery) {
    const problems = discoveryProblems(c.resource?.description, c.discovery);
    if (problems.length) throw new Error(`config.discovery: ${problems.join('; ')}`);
  }
  const chain = c.chain ?? rpcEvmChain(c.rpcUrl!);
  const now = c.now ?? (() => Date.now());
  const ledger = c.ledger ?? memoryX402Ledger();
  const amount = BigInt(Math.round(c.priceUsd * 10 ** usdc.decimals));
  const named = specs.map((f) => ({ name: f.name, client: f.client ?? new HTTPFacilitatorClient({ url: f.url! }) }));
  const servers = new Map<string, { at: number; server: x402ResourceServer | null }>();
  const matcher = new x402ResourceServer([]).register(c.network as Network, new ExactEvmScheme());

  async function serverFor(f: (typeof named)[number]): Promise<x402ResourceServer | null> {
    const hit = servers.get(f.name);
    if (hit && now() - hit.at < 600_000) return hit.server;
    let server: x402ResourceServer | null = null;
    try {
      const s = new x402ResourceServer(f.client).register(c.network as Network, new ExactEvmScheme());
      await s.initialize();
      if (s.getSupportedKind(2, c.network as Network, 'exact')) server = s;
    } catch { /* outage → try the next facilitator */ }
    servers.set(f.name, { at: server ? now() : now() - 600_000 + 30_000, server });
    return server;
  }

  async function choose() {
    for (const f of named) { const s = await serverFor(f); if (s) return { f, s }; }
    return null;
  }

  async function quote() {
    const ch = await choose();
    if (!ch) return null;
    const accepts = await ch.s.buildPaymentRequirementsFromOptions([{
      scheme: 'exact', network: c.network as Network, payTo: c.payTo, maxTimeoutSeconds: c.maxTimeoutSeconds ?? 60,
      price: { asset: usdc.address, amount: amount.toString(), extra: { name: usdc.name, version: usdc.version } },
    }], {});
    return { accepts, facilitator: ch.f.name, server: ch.s };
  }

  const ext = extensionsOf(c.discovery?.bazaar, c.bond);
  function paymentRequired(resourceUrl: string, accepts: PaymentRequirements[], extra: Record<string, unknown> = {}, error?: string) {
    const pr = {
      x402Version: 2,
      ...(error ? { error } : {}),
      resource: { url: resourceUrl, description: c.resource?.description ?? '', mimeType: c.resource?.mimeType ?? 'application/json', ...(c.resource?.serviceName ? { serviceName: c.resource.serviceName } : {}), ...(c.discovery?.iconUrl ? { iconUrl: c.discovery.iconUrl } : {}) },
      accepts,
      ...(ext ? { extensions: ext } : {}),
    };
    return json(402, { ...pr, ...extra }, {
      'payment-required': encodePaymentRequiredHeader(pr as Parameters<typeof encodePaymentRequiredHeader>[0]),
      'access-control-expose-headers': 'PAYMENT-REQUIRED, PAYMENT-RESPONSE',
    });
  }

  /** Polls authorizationState after a reported settlement */
  async function usedOnChain(auth: Authorization, delays: number[]): Promise<boolean | null> {
    let last: boolean | null = null;
    for (const wait of delays) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = await chain.authorizationUsed(usdc.address, auth.from, auth.nonce).catch(() => null);
      if (last) return true;
    }
    return last;
  }

  function withPayment(handler: (req: Request, payment: PaymentInfo) => Promise<Response>) {
    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const resourceUrl = `${url.origin}${url.pathname}`;
      const q = await quote().catch(() => null);
      if (!q || !q.accepts.length) return json(503, { error: 'payment_unavailable', message: `No facilitator for ${c.network} is reachable right now. ${NOT_CHARGED}` });
      const header = req.headers.get('payment-signature');
      if (!header) return paymentRequired(resourceUrl, q.accepts, {}, 'Payment required');
      const refuse = (reason: string, message: string) => paymentRequired(resourceUrl, q.accepts, { reason, message: `${message} ${NOT_CHARGED}` }, reason);

      // 1) Decode, match, local checks (no money moves yet)
      let payload: PaymentPayload;
      try { payload = decodePaymentSignatureHeader(header); } catch { return refuse('invalid_payload', 'Could not decode the PAYMENT-SIGNATURE header.'); }
      if (payload.x402Version !== 2) return refuse('invalid_x402_version', 'Only x402Version 2 is accepted.');
      try {
        if (payload.resource?.url && new URL(payload.resource.url).pathname !== url.pathname) return refuse('resource_mismatch', 'This payment is for a different resource.');
      } catch { return refuse('resource_mismatch', 'Could not parse resource.url.'); }
      let accepted: PaymentRequirements | undefined;
      try { accepted = matcher.findMatchingRequirements(q.accepts, payload); } catch { accepted = undefined; }
      if (!accepted) return refuse('requirements_mismatch', 'The chosen payment requirements do not match the current ones; pay again with the new requirements.');
      const auth = eip3009Authorization(payload);
      if (!auth) return refuse('invalid_payload', 'Only an EIP-3009 transferWithAuthorization payload is accepted.');
      if (auth.to.toLowerCase() !== c.payTo.toLowerCase()) return refuse('recipient_mismatch', 'The authorization pays a different address.');
      if (BigInt(auth.value) !== BigInt(accepted.amount)) return refuse('amount_mismatch', 'The authorization amount differs from the price.');
      if (BigInt(auth.validBefore) * 1000n <= BigInt(now())) return refuse('payment_expired', 'The authorization has expired.');

      const key = await sha256Hex(`${c.network}|${auth.from.toLowerCase()}|${auth.nonce.toLowerCase()}`);
      const claim = await ledger.claim(key, now());
      if (!claim.ok) return json(409, { error: 'payment_already_used', state: claim.state, message: claim.state === 'fulfilled' ? 'This payment has already been used.' : 'This payment is being processed.' });
      const info: PaymentInfo = { asset: accepted.asset, amount: accepted.amount, payTo: accepted.payTo, network: accepted.network };

      // A previous settlement result is unknown: decide on-chain only (never settle twice)
      if (claim.state === 'settle_unknown') {
        const used = await chain.authorizationUsed(usdc.address, auth.from, auth.nonce).catch(() => null);
        if (used === false && BigInt(auth.validBefore) * 1000n <= BigInt(now())) {
          await ledger.release(key);
          return refuse('payment_expired', 'This payment did not land on chain and has expired; please pay again.');
        }
        if (used !== true) {
          await ledger.markSettleUnknown(key, claim.since);
          return json(503, { error: 'settlement_pending', message: 'The settlement result is not known yet. Retry with the same PAYMENT-SIGNATURE shortly.' });
        }
        // used on chain → fall through to the handler with a confirmed settlement
      } else {
        try {
          const v = await q.server.verifyPayment(payload, accepted);
          if (!v.isValid) { await ledger.release(key); return refuse(v.invalidReason ?? 'invalid_payment', `Payment verification failed${v.invalidMessage ? ` (${v.invalidMessage})` : ''}.`); }
        } catch (e) {
          await ledger.release(key);
          const rejected = definiteVerifyRejection(e);
          if (rejected) return refuse(rejected.reason, rejected.message ?? 'Payment verification failed.');
          return json(503, { error: 'payment_unavailable', message: `The facilitator did not respond. ${NOT_CHARGED}` });
        }
      }

      // 2) Handler (time limit). No settlement on failure, timeout, or a 4xx/5xx response
      let res: Response;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        res = await Promise.race([
          handler(req, info),
          new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('__handler_timeout__')), c.handlerTimeoutMs ?? 40_000); }),
        ]);
      } catch (e) {
        if (claim.state !== 'settle_unknown') await ledger.release(key);
        else await ledger.markSettleUnknown(key, claim.since);
        const timeout = (e as Error).message === '__handler_timeout__';
        return json(timeout ? 504 : 502, { error: timeout ? 'handler_timeout' : 'handler_failed', message: `The resource could not be produced.${claim.state === 'settle_unknown' ? ' The payment is on chain; retry with the same PAYMENT-SIGNATURE.' : ` The payment was not settled. ${NOT_CHARGED}`}` });
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (res.status >= 400) {
        if (claim.state !== 'settle_unknown') await ledger.release(key);
        else await ledger.markSettleUnknown(key, claim.since);
        const h = new Headers(res.headers);
        h.set('x-payment-status', 'not-settled');
        return new Response(res.body, { status: res.status, headers: h });
      }

      // 3) Settle (+ on-chain decision when it fails or its result is unknown)
      let settlement: SettleResponse;
      let confirmation: 'confirmed' | 'pending';
      if (claim.state === 'settle_unknown') {
        settlement = { success: true, transaction: '', network: c.network as Network, payer: auth.from } as SettleResponse;
        confirmation = 'confirmed';
      } else {
        let s: SettleResponse | null = null;
        let said: string | undefined;
        try { s = await q.server.settlePayment(payload, accepted); } catch (e) { said = settleFailureReason(e) ?? undefined; }
        if (s && s.success) {
          const used = await usedOnChain(auth, [0, ...(c.confirmDelaysMs ?? [1000, 2000, 4000])]);
          settlement = s;
          confirmation = used ? 'confirmed' : 'pending';
        } else {
          if (s && !s.success) said = s.errorReason ?? 'settle_failed';
          const used = await chain.authorizationUsed(usdc.address, auth.from, auth.nonce).catch(() => null);
          if (used === true) {
            settlement = { success: true, transaction: s?.transaction ?? '', network: c.network as Network, payer: auth.from } as SettleResponse;
            confirmation = 'confirmed';
          } else {
            // Not on chain (or unreadable): keep it as "result unknown" until validBefore, then it can never settle
            await ledger.markSettleUnknown(key, now());
            return json(503, { error: 'settlement_pending', message: `${said ? `The facilitator reported a settlement failure (${said}). ` : ''}The settlement result is not final until the chain is checked. Retry with the same PAYMENT-SIGNATURE; after the authorization expires it is treated as not paid.` });
          }
        }
      }
      await ledger.fulfill(key, now());
      const h = new Headers(res.headers);
      h.set('payment-response', encodePaymentResponseHeader(settlement));
      h.set('x-payment-confirmation', confirmation);
      h.set('access-control-expose-headers', 'PAYMENT-RESPONSE, X-Payment-Confirmation');
      return new Response(res.body, { status: res.status, headers: h });
    };
  }

  return {
    withPayment,
    async quote() { const q = await quote().catch(() => null); return q ? { accepts: q.accepts, facilitator: q.facilitator } : null; },
  };
}
