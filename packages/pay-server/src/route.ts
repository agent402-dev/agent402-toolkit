// @agent402-dev/pay-server/route — sell one piece of work per request over x402, with checks around the payment gate.
// Order: check the input (400, no payment asked) → 402 → verify → your work → settle. If the work fails, nothing is settled.
// Use it beside a Bond seller (/quote, /open, /deliver) to sell the same work per request, or on its own. USDC only.
import { createPaymentGate, KNOWN_FACILITATORS, SOLANA_MAINNET, USDC_MAINNET, type FacilitatorSpec, type GateConfig, type PaymentGate } from './gate.js';
import { ledgerClaim, type LedgerEntry, type X402Ledger } from './x402.js';
import { rpcChain, type ChainReader } from './chain.js';
import type { DiscoveryConfig } from './discovery.js';

/** Throw from `run` when a request cannot be done (answered 422; the payment is not settled). */
export class RequestRefused extends Error {
  constructor(message: string) { super(message); this.name = 'RequestRefused'; }
}

/** What you sell at one path. */
export interface PaidRoute {
  /** Path, e.g. /x402/receipts */
  path: string;
  /** Price per request in USD (paid in USDC) */
  priceUsd: number;
  /** Shown in the 402 response */
  description: string;
  /** Input from a GET query string, or null when the query carries no input. Omit to accept POST bodies only. */
  fromQuery?(params: URLSearchParams): string | null;
  /** Refuse malformed input before a payment is asked for: a message, or null when the input is fine */
  check(input: string): string | null;
  /** The work. Throw RequestRefused when it cannot be done; any other error is answered 502. Neither is settled. */
  run(input: string): Promise<unknown>;
  /** Optional x402 Bazaar discovery metadata (see @agent402-dev/pay-server/discovery). Unset = 402 unchanged */
  discovery?: DiscoveryConfig;
  /** Optional OpenAPI document, for serving at GET /openapi.json (origin = your public origin) */
  openapi?(origin: string): unknown;
}

/** Key-value storage for the payment ledger (a Durable Object, a database row store, or a Map in tests). */
export interface LedgerStorage {
  get(key: string): Promise<LedgerEntry | undefined>;
  put(key: string, e: LedgerEntry): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * X402Ledger over a key-value storage, so a payment cannot be used twice across instances.
 * Use one storage with consistent reads (for example a single Durable Object). The default in-memory ledger only protects one process.
 */
export function storageLedger(s: LedgerStorage): X402Ledger {
  const k = (key: string) => `x402:${key}`;
  return {
    async claim(key, now) { const r = ledgerClaim(await s.get(k(key)), now); await s.put(k(key), r.next); return r.result; },
    async markSettleUnknown(key, now) { await s.put(k(key), { state: 'settle_unknown', at: now }); },
    async fulfill(key, now) { await s.put(k(key), { state: 'fulfilled', at: now }); },
    async release(key) { const e = await s.get(k(key)); if (e?.state === 'in_progress') await s.delete(k(key)); },
  };
}

export interface PaidRouteOptions {
  /** Your receiving address (public key). No key is ever needed. It must already have a USDC token account. */
  payTo: string;
  /** Solana mainnet RPC (on-chain checks after settlement). Or pass `chain`. */
  rpcUrl?: string;
  chain?: ChainReader;
  /** Use storageLedger() over shared storage in production */
  ledger?: X402Ledger;
  /** Default: PayAI, then Dexter */
  facilitators?: FacilitatorSpec[];
  serviceName?: string;
  /** Other gate settings (for example handlerTimeoutMs, or a clock in tests) */
  gate?: Partial<GateConfig>;
}

const MAX_BODY = 100_000;
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Fetch-style handler for one paid route: returns a Response for `route.path`, or null for other paths.
 * Options are read on the first request (pass a function so per-request resources are created lazily).
 */
export function paidRouteHandler(route: PaidRoute, options: () => PaidRouteOptions) {
  let gate: PaymentGate | null = null;
  const gateFor = () => {
    if (gate) return gate;
    const o = options();
    if (!o.chain && !o.rpcUrl) throw new Error('paidRouteHandler: pass rpcUrl or chain');
    gate = createPaymentGate({
      network: SOLANA_MAINNET, payTo: o.payTo, priceUsd: route.priceUsd, usdc: USDC_MAINNET,
      facilitators: o.facilitators ?? [KNOWN_FACILITATORS.payai, KNOWN_FACILITATORS.dexter],
      chain: o.chain ?? rpcChain(o.rpcUrl!), ledger: o.ledger,
      resource: { description: route.description, mimeType: 'application/json', ...(o.serviceName ? { serviceName: o.serviceName } : {}) },
      ...(route.discovery ? { discovery: route.discovery } : {}),
      ...o.gate,
    });
    return gate;
  };
  return async (req: Request): Promise<Response | null> => {
    const url = new URL(req.url);
    if (url.pathname !== route.path) return null;
    let input: string | null;
    let body: string | undefined;
    if (req.method === 'GET') input = route.fromQuery ? route.fromQuery(url.searchParams) : null;
    else if (req.method === 'POST') {
      body = await req.text();
      if (body.length > MAX_BODY) return json(413, { error: 'too_large' });
      input = body.trim() ? body : null;
    } else return json(405, { error: 'method_not_allowed', allow: route.fromQuery ? 'GET, POST' : 'POST' });
    // No input and no payment: answer with the 402, so clients and directories can read the price. The work never runs without input.
    if (input !== null) {
      const problem = route.check(input);
      if (problem) return json(400, { error: 'bad_request', message: problem, note: 'No payment was requested.' });
    } else if (req.headers.get('payment-signature')) {
      return json(400, { error: 'bad_request', message: 'No input. Nothing was charged.' });
    }
    // The body was read above: pass the same method and body on, so a signed receipt binds what the buyer actually sent.
    const forward = new Request(req.url, { method: req.method, headers: req.headers, ...(body !== undefined ? { body } : {}) });
    return gateFor().withPayment(async () => {
      try {
        return Response.json(await route.run(input!));
      } catch (e) {
        if (e instanceof RequestRefused) return json(422, { error: 'cannot_be_done', message: e.message });
        throw e; // the gate answers 502 and does not settle
      }
    })(forward);
  };
}
