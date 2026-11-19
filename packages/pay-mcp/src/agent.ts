// 결제 판단·실행 (MCP 와 무관한 핵심 로직 — 테스트 가능하게 분리)
// 순서: 도메인 확인 → 요청(리다이렉트는 직접 따라가며 매번 도메인 확인) → 402 면 정책 평가 → (견적 고정 확인) → (사람 확인) → 서명 1회 → 재요청
// 서명은 이 요청에서 최대 1번. 결제 뒤 다시 402 가 오면 다시 서명하지 않음
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import type { History, HistoryEntry, PaymentResult } from './history.js';
import { choose, domainCheck, evaluate, type Evaluated, type PayPolicy } from './policy.js';
import { withSmallest } from './units.js';
import type { Wallet } from './wallet.js';

export type ConfirmAnswer = 'accept' | 'decline' | 'unsupported';

export interface AgentDeps {
  policy: PayPolicy;
  wallet: Wallet | null;
  history: History;
  fetch: typeof fetch;
  /** 사람 확인 (MCP elicitation). 클라이언트가 지원하지 않으면 'unsupported' → 결제 안 함 */
  confirm: (message: string) => Promise<ConfirmAnswer>;
  now?: () => Date;
  maxRedirects?: number;
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
  /** 정책 평가 결과 (거절일 때 각 조건의 이유) */
  options?: { asset: string | null; mint: string; amount: string; payTo: string; ok: boolean; reasons: string[] }[];
}

export function createAgent(d: AgentDeps) {
  const now = d.now ?? (() => new Date());
  const quotes = new Map<string, Pinned>();
  const QUOTE_TTL_MS = 5 * 60_000;

  /** 리다이렉트를 직접 따라가며 매 단계 도메인 확인 */
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

  const readBody = async (res: Response) => {
    const t = (await res.text()).slice(0, 20_000);
    try { return JSON.parse(t); } catch { return t; }
  };
  const describe = (e: Evaluated) => ({ asset: e.asset, mint: e.requirement.asset, amount: e.requirement.amount, payTo: e.requirement.payTo, ok: e.ok, reasons: e.reasons });
  const host = (u: string) => { try { return new URL(u).host; } catch { return ''; } };
  const record = (e: Omit<HistoryEntry, 'at'>) => d.history.add({ at: now().toISOString(), ...e });

  type Assessment =
    | { kind: 'refused'; refused: string }
    | { kind: 'not_required'; res: Response; finalUrl: string }
    | { kind: '402'; pr: PaymentRequired; evs: Evaluated[]; chosen: Evaluated | null; finalUrl: string };

  /** 402 를 받아 정책으로 평가 (서명 없음) */
  async function assess(spec: RequestSpec): Promise<Assessment> {
    const sent = await send(spec);
    if ('refused' in sent) return { kind: 'refused', refused: sent.refused };
    const { res, finalUrl } = sent;
    if (res.status !== 402) return { kind: 'not_required', res, finalUrl };
    const h = res.headers.get('payment-required');
    let pr: PaymentRequired;
    try { pr = decodePaymentRequiredHeader(h ?? ''); } catch { return { kind: 'refused', refused: 'invalid_payment_required_header' }; }
    // 402 가 다른 주소의 리소스를 가리키면 그 주소도 허용 목록에 있어야 함
    if (pr.resource?.url) {
      const rc = domainCheck(d.policy, pr.resource.url);
      if (!rc.ok) return { kind: 'refused', refused: `resource_on_disallowed_domain: ${rc.reason}` };
    }
    const evs = pr.accepts.map((r) => evaluate(d.policy, r, d.history.today(now())));
    return { kind: '402', pr, evs, chosen: choose(d.policy, evs), finalUrl };
  }

  async function quote(spec: RequestSpec): Promise<FetchOutcome & { quoteId?: string }> {
    const a = await assess(spec);
    if (a.kind === 'refused') return { result: 'refused', reasons: [a.refused] };
    if (a.kind === 'not_required') return { result: 'not_required', httpStatus: a.res.status };
    const options = a.evs.map(describe);
    if (!a.chosen) return { result: 'refused', reasons: ['no_option_passes_policy'], options };
    const quoteId = crypto.randomUUID();
    const r = a.chosen.requirement;
    quotes.set(quoteId, { url: spec.url, asset: r.asset, amount: r.amount, payTo: r.payTo, network: r.network, at: now().getTime() });
    return { result: 'not_required', quoteId, options, payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network }, reasons: a.chosen.needsConfirmation ? ['will_ask_for_confirmation'] : [] };
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
      return { result: 'refused', reasons, options };
    }
    const r: PaymentRequirements = a.chosen.requirement;
    const pay = { network: r.network, asset: a.chosen.asset ?? undefined, mint: r.asset, amount: r.amount, payTo: r.payTo };
    const refuse = (result: PaymentResult, reasons: string[]): FetchOutcome => {
      record({ ...base, ...pay, result, reasons, signed: false });
      return { result, reasons, options, payment: { asset: a.chosen!.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network } };
    };

    // 견적과 같은 조건인지 (재요청 사이에 금액·수령 주소가 바뀌면 거절)
    if (spec.quoteId) {
      const q = quotes.get(spec.quoteId);
      if (!q || q.url !== spec.url || now().getTime() - q.at > QUOTE_TTL_MS) return refuse('refused', ['quote_not_found_or_expired']);
      const changed = (['asset', 'amount', 'payTo', 'network'] as const).filter((k) => q[k] !== r[k]);
      if (changed.length) return refuse('refused', [`requirements_changed_since_quote: ${changed.join(',')}`]);
    }
    if (!d.wallet) return refuse('refused', ['no_wallet: set X402_KEYPAIR_PATH']);
    if (a.chosen.needsConfirmation) {
      const human = `Pay ${a.chosen.asset === 'USDC' ? `${a.chosen.usd} USDC` : withSmallest(r.amount, a.chosen.asset ?? 'A402')} to ${r.payTo} for ${spec.url}?`;
      const ans = await d.confirm(human).catch(() => 'unsupported' as const);
      if (ans === 'unsupported') return refuse('confirmation_required', ['confirmation_required: this client cannot ask for confirmation (MCP elicitation); payment not made']);
      if (ans === 'decline') return refuse('declined_by_user', ['declined_by_user']);
    }

    // 서명 (이 요청에서 한 번만)
    const header = await d.wallet.sign(a.pr.resource, r);
    const sent = await send({ ...spec, url: a.finalUrl }, { 'payment-signature': header }, false);
    if ('refused' in sent) { record({ ...base, ...pay, result: 'failed', reasons: [sent.refused], signed: true }); return { result: 'failed', reasons: [sent.refused] }; }
    const res = sent.res;
    const body = await readBody(res);
    if (res.ok) {
      const pr = res.headers.get('payment-response');
      let tx: string | undefined;
      try { tx = pr ? decodePaymentResponseHeader(pr).transaction : undefined; } catch { tx = undefined; }
      record({ ...base, ...pay, result: 'paid', httpStatus: res.status, settlementTx: tx, signed: true });
      return { result: 'paid', httpStatus: res.status, body, payment: { asset: a.chosen.asset, mint: r.asset, amount: r.amount, payTo: r.payTo, network: r.network, settlementTx: tx } };
    }
    const reason = typeof body === 'object' && body && 'reason' in body ? String((body as { reason: unknown }).reason) : `http_${res.status}`;
    const result: PaymentResult = res.status === 402 ? 'rejected_by_server' : res.headers.get('x-payment-status') === 'not-settled' || res.status === 409 ? 'failed' : 'unknown';
    record({ ...base, ...pay, result, reasons: [reason], httpStatus: res.status, signed: true });
    return { result, httpStatus: res.status, reasons: [reason], body };
  }

  return { quote, payAndFetch };
}
