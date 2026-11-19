// 결제 정책: 서명하기 "전에" 모든 조건을 확인. 허용 목록 기본값은 비어 있음 = 전부 거절.
import type { PaymentRequirements } from '@x402/core/types';

export const NETWORKS = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
} as const;
const DEFAULT_MINTS: Record<string, { USDC: string; A402: string }> = {
  [NETWORKS.mainnet]: { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', A402: 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X' },
  [NETWORKS.devnet]: { USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', A402: '5R2rKmzsNk1S5mFPR99bU1anromo73brwNApghvXeb46' },
};

export type AssetSymbol = 'USDC' | 'A402';

export interface PayPolicy {
  network: string;
  mints: Record<AssetSymbol, string>;
  /** 결제해도 되는 호출 도메인 (host 또는 host:port, 소문자). 비어 있으면 전부 거절 */
  allowedDomains: string[];
  /** 결제해도 되는 수령 주소. 비어 있으면 전부 거절 */
  trustedPayTo: string[];
  /** 결제해도 되는 자산 (기본 USDC 만, A402 는 명시해야) */
  allowedAssets: AssetSymbol[];
  /** USDC 결제당 상한 (USD) */
  maxUsdPerPayment: number;
  /** A402 결제당 상한 (원 단위). null = 설정 안 됨 → A402 결제 거절 */
  maxA402PerPayment: bigint | null;
  /** A402 하루 합계 상한 (원 단위). null = 설정 안 됨 → A402 결제 거절 */
  maxA402PerDay: bigint | null;
  maxPaymentsPerDay: number;
  /** 하루 USDC 합계 상한 (USD) */
  maxUsdPerDay: number;
  /** 이 금액(USD) 이상 USDC 결제는 사람 확인. null = 확인 안 함 */
  confirmAboveUsd: number | null;
  /** 이 금액(원 단위) 이상 A402 결제는 사람 확인. null = 확인 안 함 */
  confirmAboveA402: bigint | null;
  prefer: AssetSymbol;
}

export interface PolicyEnv {
  X402_NETWORK?: string;
  X402_ALLOWED_DOMAINS?: string;
  X402_TRUSTED_PAY_TO?: string;
  X402_ALLOWED_ASSETS?: string;
  X402_MAX_USD?: string;
  X402_MAX_A402_ATOMIC?: string;
  X402_MAX_A402_PER_DAY_ATOMIC?: string;
  X402_MAX_PAYMENTS_PER_DAY?: string;
  X402_MAX_USD_PER_DAY?: string;
  X402_CONFIRM_ABOVE_USD?: string;
  X402_CONFIRM_ABOVE_A402_ATOMIC?: string;
  X402_PAY_WITH?: string;
  /** 리허설 등에서 민트를 바꿀 때만 */
  X402_USDC_MINT?: string;
  X402_A402_MINT?: string;
}

const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined, d: number) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
/** 원 단위 정수 (양수만). 없거나 잘못되면 null */
const atomic = (s: string | undefined): bigint | null => (s && /^\d+$/.test(s.trim()) && BigInt(s.trim()) > 0n ? BigInt(s.trim()) : null);

export function policyFromEnv(env: PolicyEnv): PayPolicy {
  const network = env.X402_NETWORK === 'devnet' ? NETWORKS.devnet : NETWORKS.mainnet;
  const m = DEFAULT_MINTS[network];
  return {
    network,
    mints: { USDC: env.X402_USDC_MINT ?? m.USDC, A402: env.X402_A402_MINT ?? m.A402 },
    allowedDomains: list(env.X402_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
    trustedPayTo: list(env.X402_TRUSTED_PAY_TO),
    allowedAssets: (list(env.X402_ALLOWED_ASSETS).length ? list(env.X402_ALLOWED_ASSETS) : ['USDC']).filter((a): a is AssetSymbol => a === 'USDC' || a === 'A402'),
    maxUsdPerPayment: num(env.X402_MAX_USD, 0.05),
    // A402 는 기본값 없음 — 둘 다 설정해야 A402 결제 가능 (USD 기준 한도가 A402 에는 적용되지 않으므로)
    maxA402PerPayment: atomic(env.X402_MAX_A402_ATOMIC),
    maxA402PerDay: atomic(env.X402_MAX_A402_PER_DAY_ATOMIC),
    maxPaymentsPerDay: num(env.X402_MAX_PAYMENTS_PER_DAY, 20),
    maxUsdPerDay: num(env.X402_MAX_USD_PER_DAY, 1),
    confirmAboveUsd: env.X402_CONFIRM_ABOVE_USD ? Number(env.X402_CONFIRM_ABOVE_USD) : null,
    confirmAboveA402: env.X402_CONFIRM_ABOVE_A402_ATOMIC ? BigInt(env.X402_CONFIRM_ABOVE_A402_ATOMIC) : null,
    prefer: env.X402_PAY_WITH === 'A402' ? 'A402' : 'USDC',
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 이 URL 로 결제해도 되는지 (도메인 허용 목록 + https, 로컬만 http 허용) */
export function domainCheck(p: PayPolicy, url: string): { ok: true; host: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid_url' }; }
  const host = u.host.toLowerCase();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return { ok: false, reason: `insecure_url: only https (http only for localhost)` };
  if (!p.allowedDomains.length) return { ok: false, reason: 'domain_not_allowed: allowed domain list is empty (X402_ALLOWED_DOMAINS)' };
  if (!p.allowedDomains.includes(host)) return { ok: false, reason: `domain_not_allowed: ${host}` };
  return { ok: true, host };
}

export interface DayUsage { count: number; usd: number; /** 오늘 서명한 A402 합계 (원 단위) */ a402: bigint }

export interface Evaluated {
  requirement: PaymentRequirements;
  asset: AssetSymbol | null;
  ok: boolean;
  reasons: string[];
  /** 사람 확인이 필요한지 (ok 일 때만 의미) */
  needsConfirmation: boolean;
  /** USDC 면 USD 금액 */
  usd: number | null;
}

export function symbolOf(p: PayPolicy, mint: string): AssetSymbol | null {
  return mint === p.mints.USDC ? 'USDC' : mint === p.mints.A402 ? 'A402' : null;
}

/** 결제 조건 하나를 정책으로 평가 (서명 전) */
export function evaluate(p: PayPolicy, r: PaymentRequirements, usage: DayUsage): Evaluated {
  const reasons: string[] = [];
  const asset = symbolOf(p, r.asset);
  if (r.scheme !== 'exact') reasons.push(`unsupported_scheme: ${r.scheme}`);
  if (r.network !== p.network) reasons.push(`wrong_network: ${r.network}`);
  if (!asset) reasons.push(`asset_not_allowed: unknown mint ${r.asset}`);
  else if (!p.allowedAssets.includes(asset)) reasons.push(`asset_not_allowed: ${asset} (X402_ALLOWED_ASSETS)`);
  if (!p.trustedPayTo.length) reasons.push('pay_to_not_trusted: trusted recipient list is empty (X402_TRUSTED_PAY_TO)');
  else if (!p.trustedPayTo.includes(r.payTo)) reasons.push(`pay_to_not_trusted: ${r.payTo}`);
  let amount: bigint;
  try { amount = BigInt(r.amount); } catch { amount = -1n; }
  if (amount <= 0n) reasons.push('invalid_amount');
  let usd: number | null = null;
  if (asset === 'USDC' && amount > 0n) {
    usd = Number(amount) / 1e6;
    if (usd > p.maxUsdPerPayment) reasons.push(`over_per_payment_limit: ${usd} USD > ${p.maxUsdPerPayment} USD`);
    if (usage.usd + usd > p.maxUsdPerDay) reasons.push(`over_daily_usd_limit: ${usage.usd} + ${usd} > ${p.maxUsdPerDay} USD`);
  }
  if (asset === 'A402' && p.allowedAssets.includes('A402') && amount > 0n) {
    if (p.maxA402PerPayment === null) reasons.push('a402_limit_not_configured: set X402_MAX_A402_ATOMIC (max A402 per payment, in A402 smallest units: 1 A402 = 1,000,000)');
    else if (amount > p.maxA402PerPayment) reasons.push(`over_per_payment_limit: ${amount} > ${p.maxA402PerPayment} (A402 smallest units)`);
    if (p.maxA402PerDay === null) reasons.push('a402_limit_not_configured: set X402_MAX_A402_PER_DAY_ATOMIC (max A402 per UTC day, in A402 smallest units: 1 A402 = 1,000,000)');
    else if (usage.a402 + amount > p.maxA402PerDay) reasons.push(`over_daily_a402_limit: ${usage.a402} + ${amount} > ${p.maxA402PerDay} (A402 smallest units)`);
  }
  if (usage.count >= p.maxPaymentsPerDay) reasons.push(`over_daily_count_limit: ${p.maxPaymentsPerDay}`);
  const needsConfirmation =
    (asset === 'USDC' && p.confirmAboveUsd !== null && usd !== null && usd >= p.confirmAboveUsd) ||
    (asset === 'A402' && p.confirmAboveA402 !== null && amount >= p.confirmAboveA402);
  return { requirement: r, asset, ok: reasons.length === 0, reasons, needsConfirmation, usd };
}

/** 평가 후 고를 조건 (선호 자산 우선) */
export function choose(p: PayPolicy, evs: Evaluated[]): Evaluated | null {
  const ok = evs.filter((e) => e.ok);
  return ok.find((e) => e.asset === p.prefer) ?? ok[0] ?? null;
}
