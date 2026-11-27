// Payment decision and execution (core logic independent of MCP, separated for testing)
// Order: domain check → request (follows redirects itself, checking the domain each time) → on 402, evaluate the policy → (confirm the quote is unchanged) → (human confirmation) → sign once → re-request
// At most one signature per request. If another 402 comes after paying, it does not sign again
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { History, HistoryEntry, PaymentResult } from './history.js';
import { checkCommitment, type CommitmentResult } from './commitment.js';
import type { AccountsFetcher } from './locks.js';
import { A402_DEPRECATION_WARNING, chooseWithReason, domainCheck, evaluate, resolveResourceUrl, isEvmRequirement, nearLimits, needsLock, type Evaluated, type PayPolicy } from './policy.js';
import type { EvmConfig } from './evm-config.js';
import { EvmAuthorizationMismatch } from './evm-wallet.js';
import { checkReceipt, RECEIPT_HEADER } from './receipt.js';
import { discoverySummary, type DiscoverySummary } from './discovery.js';
import { withSmallest } from './units.js';
import type { Wallet } from './wallet.js';

export type ConfirmAnswer = 'accept' | 'decline' | 'unsupported';

export interface AgentDeps {
  policy: PayPolicy;
  wallet: Wallet | null;
  history: History;
  fetch: typeof fetch;
  /** Human confirmation (MCP elicitation). If the client does not support it, 'unsupported' → no payment */
  confirm: (message: string) => Promise<ConfirmAnswer>;
  now?: () => Date;
  maxRedirects?: number;
  /** Read-only account reader for seller lock checks (getMultipleAccounts) */
  accounts?: AccountsFetcher;
  /** Networks settings (evmConfigFromEnv). Missing = Solana only: every Base (eip155) option is refused */
  evm?: EvmConfig;
  /** Base wallet (X402_EVM_KEY_PATH), used only for an option on the allowed Base network that passed every rule */
  evmWallet?: Wallet | null;
}

export interface RequestSpec { url: string; method?: string; headers?: Record<string, string>; body?: string }

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

interface Pinned { url: string; asset: string; amount: string; payTo: string; network: string; at: number }

export interface FetchOutcome {
  result: PaymentResult | 'not_required';
  httpStatus?: number;
  reasons?: string[];
  payment?: { asset: string | null; mint: string; amount: string; payTo: string; network: string; settlementTx?: string };
  body?: unknown;
  /** Policy evaluation result (the reason for each condition when rejected) */
  options?: { asset: string | null; mint: string; amount: string; payTo: string; network: string; ok: boolean; reasons: string[] }[];
  /** Warnings (e.g. the deprecation notice when trying to pay with A402 (v1)) */
  warnings?: string[];
  /** Seller lock check, when the policy required one */
  lock?: CommitmentResult['facts'] & { ok: boolean };
  /** Seller's signed receipt, if the server sent one (X-Agent402-Receipt) */
  receipt?: { signer: string | null; verified: boolean; reasons: string[]; token: string };
  /** x402_quote only: shape of the seller's discovery metadata (lengths, presence, formats; never its text). Does not affect the rules */
  discovery?: DiscoverySummary;
  /** Which chain the chosen option is on and why (X402_PREFER_NETWORK, or the only chain with a passing option) */
  choice?: { chain: 'solana' | 'base'; reason: 'preferred network' | 'only option passing' };
}

/** Adds the deprecation warning if the chosen asset is A402 (v1) (there is no path that silently pays with A402) */
const withDeprecation = <T extends FetchOutcome>(o: T): T =>
  o.payment?.asset === 'A402' ? { ...o, warnings: [...(o.warnings ?? []), A402_DEPRECATION_WARNING] } : o;

export function createAgent(d: AgentDeps) {
  const now = d.now ?? (() => new Date());
  const quotes = new Map<string, Pinned>();
  const QUOTE_TTL_MS = 5 * 60_000;
  const lockCache = new Map<string, { at: number; r: CommitmentResult }>();
  const LOCK_TTL_MS = 10 * 60_000;
  async function commitmentFor(origin: string, payTo: string): Promise<CommitmentResult> {
    const key = `${origin}|${payTo}`;
    const hit = lockCache.get(key);
    if (hit && now().getTime() - hit.at < LOCK_TTL_MS) return hit.r;
    const r = await checkCommitment({ origin, payTo, policy: d.policy, fetch: d.fetch, accounts: d.accounts, now: now() });
    lockCache.set(key, { at: now().getTime(), r });
    return r;
  }

  /** Follows redirects itself and checks the domain at each step */
  async function send(spec: RequestSpec, extraHeaders: Record<string, string> = {}, follow = true): Promise<{ res: Response; finalUrl: string } | { refused: string }> {
    let url = spec.url;
    for (let hop = 0; hop <= (d.maxRedirects ?? 3); hop++) {
      const dc = domainCheck(d.policy, url);
      if (!dc.ok) return { refused: hop === 0 ? dc.reason : `redirect_to_disallowed_domain: ${dc.reason}` };
      const res = await d.fetch(url, { method: spec.method ?? 'GET', headers: { ...(spec.headers ?? {}), ...extraHeaders }, body: spec.body, redirect: 'manual' });
      if (!follow || !REDIRECTS.has(res.status)) return { res, finalUrl: url };
      const loc = res.headers.get('location');
      if (!loc) return { res, finalUrl: url };
      url = new URL(loc, url).toString();
    }
    return { refused: 'too_many_redirects' };
  }

  const parseBody = (buf: ArrayBuffer) => {
    const t = new TextDecoder().decode(buf).slice(0, 20_000);
    try { return JSON.parse(t); } catch { return t; }
  };
  const readBody = async (res: Response) => parseBody(await res.arrayBuffer());
  // network (CAIP-2) shows which chain each option is on, e.g. when a seller offers Solana and Base side by side
  const describe = (e: Evaluated) => ({ asset: e.asset, mint: e.requirement.asset, amount: e.requirement.amount, payTo: e.requirement.payTo, network: e.requirement.network as string, ok: e.ok, reasons: e.reasons });
  const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
  const record = (e: Omit<HistoryEntry, 'at'>) => d.history.add({ at: now().toISOString(), ...e });

  type Assessment =
    | { kind: 'refused'; refused: string }
    | { kind: 'not_required'; res: Response; finalUrl: string }
    | { kind: '402'; pr: PaymentRequired; evs: Evaluated[]; chosen: Evaluated | null; choice?: FetchOutcome['choice']; finalUrl: string; lock?: FetchOutcome['lock'] };

  /** Receives a 402 and evaluates it with the policy (no signing) */
  async function assess(spec: RequestSpec): Promise<Assessment> {
    const sent = await send(spec);
    if ('refused' in sent) return { kind: 'refused', refused: sent.refused };
    const { res, finalUrl } = sent;
    if (res.status !== 402) return { kind: 'not_required', res, finalUrl };
    const h = res.headers.get('payment-required');
    let pr: PaymentRequired;
    try { pr = decodePaymentRequiredHeader(h ?? ''); } catch { return { kind: 'refused', refused: 'invalid_payment_required_header' }; }
    // If the 402 points to a resource at another address, that address must also be on the allowlist
    // A relative resource.url is read against the URL that answered 402 (same host only); the result is checked the same way
    if (pr.resource?.url) {
      const abs = resolveResourceUrl(pr.resource.url, finalUrl);
      if (!abs.ok) return { kind: 'refused', refused: `resource_on_disallowed_domain: ${abs.reason}` };
      const rc = domainCheck(d.policy, abs.url);
      if (!rc.ok) return { kind: 'refused', refused: `resource_on_disallowed_domain: ${rc.reason}` };
    }
    const usage = d.history.today(now());
    const evmNetwork = d.evm?.evmNetwork ?? null;
    const evs = pr.accepts.map((r) => evaluate(d.policy, r, usage, d.history.recipientToday(r.payTo, now()), evmNetwork));
    // Seller lock check, only for options that need it and passed every other rule (before signing)
    let lock: FetchOutcome['lock'];
    for (const e of evs) {
      if (!e.ok || !needsLock(d.policy, e)) continue;
      const c = await commitmentFor(new URL(finalUrl).origin, e.requirement.payTo);
      lock = { ok: c.ok, ...c.facts };
      if (!c.ok) { e.ok = false; e.reasons.push(...c.reasons); }
    }
    const pick = chooseWithReason(d.policy, evs, d.evm?.prefer ?? 'solana');
    return { kind: '402', pr, evs, chosen: pick?.chosen ?? null, ...(pick ? { choice: { chain: pick.chain, reason: pick.reason } } : {}), finalUrl, ...(lock ? { lock } : {}) };
  }

  async function quote(spec: RequestSpec): Promise<FetchOutcome & { quoteId?: string }> {
    const a = await assess(spec);
    if (a.kind === 'refused') return { result: 'refused', reasons: [a.refused] };
    if (a.kind === 'not_required') return { result: 'not_required', httpStatus: a.res.status };
    const options = a.evs.map(describe);
    const discovery = discoverySummary(a.pr as { resource?: unknown; extensions?: unknown });
    if (!a.chosen) return { result: 'refused', reasons: ['no_option_passes_policy'], options, ...(a.lock ? { lock: a.lock } : {}), discovery };
    const quoteId = crypto.randomUUID();
    const r = a.chosen.requirement;
    quotes.set(quoteId, { url: spec.url, asset: r.asset, amount: r.amount, payTo: r.payTo, network: r.network, at: now().getTime() });
    return { result: 'not_required', quoteId, options, ...(a.lock ? { lock: a.lock } : {}), payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network }, ...(a.choice ? { choice: a.choice } : {}), reasons: a.chosen.needsConfirmation ? ['will_ask_for_confirmation'] : [], discovery };
  }

  async function payAndFetch(spec: RequestSpec & { quoteId?: string }): Promise<FetchOutcome> {
    const base = { url: spec.url, host: host(spec.url) };
    const a = await assess(spec);
    if (a.kind === 'refused') { record({ ...base, result: 'refused', reasons: [a.refused], signed: false }); return { result: 'refused', reasons: [a.refused] }; }
    if (a.kind === 'not_required') return { result: 'not_required', httpStatus: a.res.status, body: await readBody(a.res) };
    const options = a.evs.map(describe);
    if (!a.chosen) {
      const reasons = ['no_option_passes_policy', ...a.evs.flatMap((e) => e.reasons)];
      record({ ...base, result: 'refused', reasons, signed: false });
      return { result: 'refused', reasons, options, ...(a.lock ? { lock: a.lock } : {}) };
    }
    const r: PaymentRequirements = a.chosen.requirement;
    const pay = { network: r.network, asset: a.chosen.asset ?? undefined, mint: r.asset, amount: r.amount, payTo: r.payTo };
    const refuse = (result: PaymentResult, reasons: string[]): FetchOutcome => {
      record({ ...base, ...pay, result, reasons, signed: false });
      return { result, reasons, options, payment: { asset: a.chosen!.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network } };
    };

    // Same requirement as the quote? (reject if the amount or receiver changed between requests)
    if (spec.quoteId) {
      const q = quotes.get(spec.quoteId);
      if (!q || q.url !== spec.url || now().getTime() - q.at > QUOTE_TTL_MS) return refuse('refused', ['quote_not_found_or_expired']);
      const changed = (['asset', 'amount', 'payTo', 'network'] as const).filter((k) => q[k] !== r[k]);
      if (changed.length) return refuse('refused', [`requirements_changed_since_quote: ${changed.join(',')}`]);
    }
    const onBase = isEvmRequirement(r);
    const wallet = onBase ? d.evmWallet ?? null : d.wallet;
    if (!wallet) return refuse('refused', [onBase ? 'evm_key_missing: set X402_EVM_KEY_PATH' : 'no_wallet: set X402_KEYPAIR_PATH']);
    if (a.chosen.needsConfirmation) {
      const human = `Pay ${a.chosen.asset === 'USDC' ? `${a.chosen.usd} USDC${onBase ? ' on Base' : ''}` : withSmallest(r.amount, a.chosen.asset ?? 'tokens')} to ${r.payTo} for ${spec.url}?${a.chosen.asset === 'A402' ? ` (${A402_DEPRECATION_WARNING})` : ''}`;
      const ans = await d.confirm(human).catch(() => 'unsupported' as const);
      if (ans === 'unsupported') return refuse('confirmation_required', ['confirmation_required: this client cannot ask for confirmation (MCP elicitation); payment not made']);
      if (ans === 'decline') return refuse('declined_by_user', ['declined_by_user']);
    }

    // Sign (only once per request)
    let header: string;
    try { header = await wallet.sign(a.pr.resource, r); } catch (e) {
      if (!(e instanceof EvmAuthorizationMismatch)) throw e;
      // Signed but the signed values differ from what was checked: nothing is sent
      record({ ...base, ...pay, result: 'refused', reasons: [e.message], signed: true });
      return { result: 'refused', reasons: [e.message], options, payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network } };
    }
    // After signing, a dropped connection or a broken response body must still be recorded as a signed payment,
    // so it counts toward the daily and per-recipient caps and the agent is told not to pay for this request again blindly
    let res: Response;
    let buf: ArrayBuffer;
    try {
      const sent = await send({ ...spec, url: a.finalUrl }, { 'payment-signature': header }, false);
      if ('refused' in sent) { record({ ...base, ...pay, result: 'failed', reasons: [sent.refused], signed: true }); return { result: 'failed', reasons: [sent.refused] }; }
      res = sent.res;
      buf = await res.arrayBuffer();
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      const reasons = [`network_error_after_signing: ${msg}; the payment may have settled, check the seller or the chain before paying for this request again`];
      record({ ...base, ...pay, result: 'unknown', reasons, signed: true });
      return { result: 'unknown', reasons, payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network } };
    }
    const body = parseBody(buf);
    if (res.ok) {
      const pr = res.headers.get('payment-response');
      let tx: string | undefined;
      try { tx = pr ? decodePaymentResponseHeader(pr).transaction : undefined; } catch { tx = undefined; }
      const rt = res.headers.get(RECEIPT_HEADER);
      const rc = rt
        ? await checkReceipt(rt, { method: spec.method ?? 'GET', url: a.finalUrl, requestBody: spec.body, responseBody: buf, payment: { network: r.network, asset: r.asset, amount: r.amount, payTo: r.payTo, transaction: tx } })
        : null;
      // token: the receipt as received, to keep as evidence or check later with verify_receipt
      const receipt = rc ? { signer: rc.signer, verified: rc.verified, reasons: rc.reasons, token: rc.token } : undefined;
      record({ ...base, ...pay, result: 'paid', httpStatus: res.status, settlementTx: tx, signed: true, ...(receipt ? { receipt } : {}) });
      const near = nearLimits(d.policy, d.history.today(now()));
      return { result: 'paid', httpStatus: res.status, body, payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network, settlementTx: tx }, ...(a.choice ? { choice: a.choice } : {}), ...(a.lock ? { lock: a.lock } : {}), ...(receipt ? { receipt } : {}), ...(near.length ? { warnings: near } : {}) };
    }
    const reason = typeof body === 'object' && body && 'reason' in body ? String((body as { reason: unknown }).reason) : `http_${res.status}`;
    const result: PaymentResult = res.status === 402 ? 'rejected_by_server' : res.headers.get('x-payment-status') === 'not-settled' || res.status === 409 ? 'failed' : 'unknown';
    record({ ...base, ...pay, result, reasons: [reason], httpStatus: res.status, signed: true });
    return { result, httpStatus: res.status, reasons: [reason], body };
  }

  return {
    quote: async (spec: RequestSpec) => withDeprecation(await quote(spec)),
    payAndFetch: async (spec: RequestSpec & { quoteId?: string }) => withDeprecation(await payAndFetch(spec)),
  };
}
