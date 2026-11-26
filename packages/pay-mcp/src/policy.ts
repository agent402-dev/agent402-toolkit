// Payment policy: checks every condition "before" signing. Allowlists default to empty = reject everything.
// Assets: USDC (default), PREQ (must be enabled explicitly), A402 (v1, deprecated; must be enabled explicitly and prints a warning)
import type { PaymentRequirements } from '@x402/core/types';
import { formatUnits } from './units.js';
import { checkEvmRequirement, EVM_MAX_VALIDITY_SECONDS, type EvmNetwork } from './evm-policy.js';
import { chooseChain, type ChainName } from './evm-config.js';

export const NETWORKS = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
} as const;

/**
  * PREQ mainnet mint (Token-2022, 6 decimals). Same value as PREQ_MAINNET_MINT in pay-server src/preq.ts.
  * Set after the PREQ launch on 2026-11-21. X402_PREQ_MINT can override it (e.g. for devnet rehearsals)
 */
export const PREQ_MAINNET_MINT = 'aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX';

export const A402_DEPRECATION_WARNING = 'A402 (v1) is deprecated and no longer supported; use PREQ.';

const DEFAULT_MINTS: Record<string, { USDC: string; PREQ: string; A402: string }> = {
  [NETWORKS.mainnet]: { USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', PREQ: PREQ_MAINNET_MINT, A402: 'GC8VRpVFheTb8Ep53MihEDfLmTfFR5TEP4B2eGG6ny5X' },
  // No devnet PREQ mint; rehearsals pass one with X402_PREQ_MINT
  [NETWORKS.devnet]: { USDC: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', PREQ: '', A402: '5R2rKmzsNk1S5mFPR99bU1anromo73brwNApghvXeb46' },
};

export type AssetSymbol = 'USDC' | 'PREQ' | 'A402';
/** Tokens other than USDC (limits managed in base units) */
export type TokenSymbol = Exclude<AssetSymbol, 'USDC'>;
export const TOKEN_SYMBOLS: TokenSymbol[] = ['PREQ', 'A402'];
const ASSET_SYMBOLS: AssetSymbol[] = ['USDC', 'PREQ', 'A402'];

/** Limits for one token (all in base units, 1 token = 1,000,000) */
export interface TokenLimits {
  /** Per-payment cap. null = not set → payments in that token are rejected */
  perPayment: bigint | null;
  /** Daily (UTC) total cap. null = not set → payments in that token are rejected */
  perDay: bigint | null;
  /** Ask a human at or above this amount. null = never ask */
  confirmAbove: bigint | null;
}

export interface PayPolicy {
  network: string;
  /** Empty string = no mint on that network (that asset matches no payment requirement) */
  mints: Record<AssetSymbol, string>;
  /** Domains allowed for paid calls (host or host:port, lowercase). Empty means reject all */
  allowedDomains: string[];
  /** Receiving addresses allowed for payment. Empty means reject all */
  trustedPayTo: string[];
  /** Assets allowed for payment (USDC only by default; PREQ must be enabled explicitly; A402 is deprecated) */
  allowedAssets: AssetSymbol[];
  /** Per-payment USDC cap (USD) */
  maxUsdPerPayment: number;
  maxPaymentsPerDay: number;
  /** Daily USDC total cap (USD) */
  maxUsdPerDay: number;
  /** Daily USDC cap per recipient (USD). null = only the overall daily cap applies */
  maxUsdPerRecipientPerDay: number | null;
  /** Daily PREQ cap per recipient (smallest units). null = only the overall PREQ daily cap applies */
  maxPreqPerRecipientPerDay: bigint | null;
  /** Seller lock (commitment) requirement: 'always', USDC payments at or above aboveUsd, or off */
  lock: LockPolicy;
  /** USDC payments at or above this amount (USD) need human confirmation. null = never ask */
  confirmAboveUsd: number | null;
  /** Per-token limits (base units). No defaults: both per-payment and daily must be set to pay in that token */
  tokenLimits: Record<TokenSymbol, TokenLimits>;
  prefer: AssetSymbol;
  /** Warnings to show at start (e.g. when A402 (v1) is enabled) */
  warnings: string[];
}

export interface PolicyEnv {
  X402_NETWORK?: string;
  X402_ALLOWED_DOMAINS?: string;
  X402_TRUSTED_PAY_TO?: string;
  X402_ALLOWED_ASSETS?: string;
  X402_MAX_USD?: string;
  X402_MAX_PAYMENTS_PER_DAY?: string;
  X402_MAX_USD_PER_DAY?: string;
  X402_MAX_USD_PER_RECIPIENT_PER_DAY?: string;
  X402_MAX_PREQ_PER_RECIPIENT_PER_DAY_ATOMIC?: string;
  /** yes = pay only sellers whose registered lock meets the minimums */
  X402_REQUIRE_LOCK?: string;
  /** Require the lock only for USDC payments at or above this amount (USD) */
  X402_REQUIRE_LOCK_ABOVE_USD?: string;
  /** The lock must still hold the minimum this many days from now (default 90) */
  X402_MIN_LOCK_DAYS?: string;
  X402_MIN_LOCK_PREQ_ATOMIC?: string;
  X402_MIN_LOCK_USDC_ATOMIC?: string;
  X402_MIN_LOCK_SOL_ATOMIC?: string;
  X402_CONFIRM_ABOVE_USD?: string;
  X402_MAX_PREQ_ATOMIC?: string;
  X402_MAX_PREQ_PER_DAY_ATOMIC?: string;
  X402_CONFIRM_ABOVE_PREQ_ATOMIC?: string;
  /** A402 (v1, deprecated): only meaningful when A402 is allowed explicitly */
  X402_MAX_A402_ATOMIC?: string;
  X402_MAX_A402_PER_DAY_ATOMIC?: string;
  X402_CONFIRM_ABOVE_A402_ATOMIC?: string;
  X402_PAY_WITH?: string;
  /** Only to change or set mints, e.g. in rehearsals */
  X402_USDC_MINT?: string;
  X402_PREQ_MINT?: string;
  X402_A402_MINT?: string;
}

const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined, d: number) => (s && Number.isFinite(Number(s)) ? Number(s) : d);
/** Integer in base units (positive only). null if missing or invalid */
const atomic = (s: string | undefined): bigint | null => (s && /^\d+$/.test(s.trim()) && BigInt(s.trim()) > 0n ? BigInt(s.trim()) : null);
const isAsset = (a: string): a is AssetSymbol => (ASSET_SYMBOLS as string[]).includes(a);

/** Environment variable names for token limits */
export const tokenEnv = (t: TokenSymbol) => ({
  perPayment: `X402_MAX_${t}_ATOMIC`,
  perDay: `X402_MAX_${t}_PER_DAY_ATOMIC`,
  confirmAbove: `X402_CONFIRM_ABOVE_${t}_ATOMIC`,
});

export function policyFromEnv(env: PolicyEnv): PayPolicy {
  const network = env.X402_NETWORK === 'devnet' ? NETWORKS.devnet : NETWORKS.mainnet;
  const m = DEFAULT_MINTS[network];
  const e = env as Record<string, string | undefined>;
  const mints = { USDC: env.X402_USDC_MINT ?? m.USDC, PREQ: env.X402_PREQ_MINT ?? m.PREQ, A402: env.X402_A402_MINT ?? m.A402 };
  const allowedAssets = (list(env.X402_ALLOWED_ASSETS).length ? list(env.X402_ALLOWED_ASSETS) : ['USDC']).filter(isAsset);
  if (allowedAssets.includes('PREQ') && !mints.PREQ) {
    throw new Error('PREQ mint is not set: PREQ payments cannot be enabled yet. Fill PREQ_MAINNET_MINT in @agent402-dev/pay-mcp src/policy.ts after the PREQ launch, or set X402_PREQ_MINT.');
  }
  const warnings: string[] = [];
  if (allowedAssets.includes('A402') || env.X402_PAY_WITH === 'A402') warnings.push(A402_DEPRECATION_WARNING);
  // Tokens have no defaults: both per-payment and daily must be set to pay (USD limits do not apply to tokens)
  const limitsFor = (t: TokenSymbol): TokenLimits => {
    const n = tokenEnv(t);
    const c = e[n.confirmAbove];
    return { perPayment: atomic(e[n.perPayment]), perDay: atomic(e[n.perDay]), confirmAbove: c && /^\d+$/.test(c.trim()) ? BigInt(c.trim()) : null };
  };
  const prefer = env.X402_PAY_WITH && isAsset(env.X402_PAY_WITH) ? env.X402_PAY_WITH : 'USDC';
  return {
    network,
    mints,
    allowedDomains: list(env.X402_ALLOWED_DOMAINS).map((d) => d.toLowerCase()),
    trustedPayTo: list(env.X402_TRUSTED_PAY_TO),
    allowedAssets,
    maxUsdPerPayment: num(env.X402_MAX_USD, 0.05),
    maxPaymentsPerDay: num(env.X402_MAX_PAYMENTS_PER_DAY, 20),
    maxUsdPerDay: num(env.X402_MAX_USD_PER_DAY, 1),
    maxUsdPerRecipientPerDay: Number(env.X402_MAX_USD_PER_RECIPIENT_PER_DAY) > 0 ? Number(env.X402_MAX_USD_PER_RECIPIENT_PER_DAY) : null,
    maxPreqPerRecipientPerDay: atomic(env.X402_MAX_PREQ_PER_RECIPIENT_PER_DAY_ATOMIC),
    lock: lockPolicyFromEnv(env),
    confirmAboveUsd: env.X402_CONFIRM_ABOVE_USD ? Number(env.X402_CONFIRM_ABOVE_USD) : null,
    tokenLimits: { PREQ: limitsFor('PREQ'), A402: limitsFor('A402') },
    prefer,
    warnings,
  };
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** Whether paying for this URL is allowed (domain allowlist + https; http only for localhost) */
export function domainCheck(p: PayPolicy, url: string): { ok: true; host: string } | { ok: false; reason: string } {
  let u: URL;
  try { u = new URL(url); } catch { return { ok: false, reason: 'invalid_url' }; }
  const host = u.host.toLowerCase();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return { ok: false, reason: `insecure_url: only https (http only for localhost)` };
  if (!p.allowedDomains.length) return { ok: false, reason: 'domain_not_allowed: allowed domain list is empty (X402_ALLOWED_DOMAINS)' };
  if (!p.allowedDomains.includes(host)) return { ok: false, reason: `domain_not_allowed: ${host}` };
  return { ok: true, host };
}

/**
 * The 402's resource.url as an absolute URL. An absolute URL is returned unchanged (domainCheck still applies to it).
 * A relative path (for example "/v1/search") is resolved against the URL that answered 402 and must stay on that host.
 * Protocol-relative ("//host/x", "\\host\x") and anything that resolves to another host are refused. No other rule changes:
 * the result still goes through domainCheck (https only, allowed domains).
 */
export function resolveResourceUrl(raw: string, requestUrl: string): { ok: true; url: string } | { ok: false; reason: string } {
  try { return { ok: true, url: new URL(raw).href }; } catch { /* not absolute */ }
  const t = raw.trim();
  if (/^[\\/]{2}/.test(t)) return { ok: false, reason: 'resource_url_protocol_relative' };
  let base: URL, r: URL;
  try { base = new URL(requestUrl); r = new URL(t, base); } catch { return { ok: false, reason: 'invalid_url' }; }
  if (r.host.toLowerCase() !== base.host.toLowerCase() || r.protocol !== base.protocol) return { ok: false, reason: 'resource_url_other_host' };
  return { ok: true, url: r.href };
}

export interface DayUsage {
  count: number;
  usd: number;
  /** Total PREQ signed today (base units) */
  preq: bigint;
  /** Total A402 (v1) signed today (base units) */
  a402: bigint;
}

/** Lock assets are read the same way (asset-neutral): a seller passes if any configured asset meets its minimum */
export type LockAsset = 'PREQ' | 'USDC' | 'SOL';
export interface LockPolicy {
  always: boolean;
  aboveUsd: number | null;
  minDays: number;
  /** Minimum still locked at now + minDays, per asset (smallest units). Only assets listed here count */
  min: Partial<Record<LockAsset, bigint>>;
}
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function lockPolicyFromEnv(env: PolicyEnv): LockPolicy {
  const always = env.X402_REQUIRE_LOCK === 'yes';
  const aboveUsd = Number(env.X402_REQUIRE_LOCK_ABOVE_USD) > 0 ? Number(env.X402_REQUIRE_LOCK_ABOVE_USD) : null;
  const min: Partial<Record<LockAsset, bigint>> = {};
  for (const [a, v] of [['PREQ', env.X402_MIN_LOCK_PREQ_ATOMIC], ['USDC', env.X402_MIN_LOCK_USDC_ATOMIC], ['SOL', env.X402_MIN_LOCK_SOL_ATOMIC]] as const) {
    const x = atomic(v);
    if (x !== null) min[a] = x;
  }
  if ((always || aboveUsd !== null) && !Object.keys(min).length) {
    throw new Error('Lock requirement is on but no minimum is set: set at least one of X402_MIN_LOCK_PREQ_ATOMIC, X402_MIN_LOCK_USDC_ATOMIC, X402_MIN_LOCK_SOL_ATOMIC (smallest units).');
  }
  const days = Number(env.X402_MIN_LOCK_DAYS);
  return { always, aboveUsd, minDays: Number.isFinite(days) && days >= 0 && env.X402_MIN_LOCK_DAYS ? days : 90, min };
}

/** Whether this payment option needs a seller lock check */
export function needsLock(p: PayPolicy, e: { asset: AssetSymbol | null; usd: number | null }): boolean {
  if (p.lock.always) return true;
  return p.lock.aboveUsd !== null && e.asset === 'USDC' && e.usd !== null && e.usd >= p.lock.aboveUsd;
}

/** Today's signed payments to one recipient (payTo) */
export interface RecipientUsage {
  count: number;
  usd: number;
  preq: bigint;
}
const NO_RECIPIENT_USAGE: RecipientUsage = { count: 0, usd: 0, preq: 0n };

export interface Evaluated {
  requirement: PaymentRequirements;
  asset: AssetSymbol | null;
  ok: boolean;
  reasons: string[];
  /** Whether human confirmation is needed (meaningful only when ok) */
  needsConfirmation: boolean;
  /** USD amount if USDC */
  usd: number | null;
}

export function symbolOf(p: PayPolicy, mint: string): AssetSymbol | null {
  if (!mint) return null;
  return ASSET_SYMBOLS.find((s) => p.mints[s] && p.mints[s] === mint) ?? null;
}

const usedToday = (usage: DayUsage, t: TokenSymbol) => (t === 'PREQ' ? usage.preq : usage.a402);

/** Evaluates one payment requirement against the policy (before signing) */
/** CAIP-2 eip155:* = an EVM (Base) requirement */
export const isEvmRequirement = (r: { network: unknown }) => typeof r.network === 'string' && r.network.startsWith('eip155:');
export const chainOf = (r: { network: unknown }): ChainName => (isEvmRequirement(r) ? 'base' : 'solana');

/** Base (EVM) checks before signing (evm-policy.ts), written as reasons. When the network itself is not allowed, only that is reported */
function evmReasons(p: PayPolicy, r: PaymentRequirements, evmNetwork: EvmNetwork | null): { reasons: string[]; asset: AssetSymbol | null } {
  const ev = checkEvmRequirement(r, { allowedNetwork: evmNetwork, trustedPayTo: p.trustedPayTo });
  const reasons: string[] = [];
  if (ev.includes('wrong_network')) reasons.push(`wrong_network: ${r.network}${evmNetwork ? '' : ' (Base payments are off: X402_ALLOWED_NETWORKS)'}`);
  else {
    if (ev.includes('asset_not_allowed')) reasons.push(`asset_not_allowed: unknown token ${r.asset} on ${r.network} (USDC only)`);
    if (ev.includes('unsupported_transfer_method')) reasons.push(`unsupported_transfer_method: ${String((r.extra as Record<string, unknown> | undefined)?.assetTransferMethod)} (EIP-3009 only)`);
    if (ev.includes('eip712_domain_mismatch')) reasons.push('eip712_domain_mismatch: extra.name/version are not the USDC values');
    if (ev.includes('timeout_too_long')) reasons.push(`timeout_too_long: maxTimeoutSeconds ${r.maxTimeoutSeconds} (1..${EVM_MAX_VALIDITY_SECONDS})`);
  }
  if (!p.trustedPayTo.length) reasons.push('pay_to_not_trusted: trusted recipient list is empty (X402_TRUSTED_PAY_TO)');
  else if (ev.includes('pay_to_not_trusted')) reasons.push(`pay_to_not_trusted: ${r.payTo}`);
  const asset: AssetSymbol | null = ev.includes('wrong_network') || ev.includes('asset_not_allowed') ? null : 'USDC';
  if (asset && !p.allowedAssets.includes('USDC')) reasons.push('asset_not_allowed: USDC (X402_ALLOWED_ASSETS)');
  return { reasons, asset };
}

/**
 * Evaluates one payment requirement against the policy (before signing).
 * evmNetwork: the one Base network allowed (evm-config), or null = every Base (eip155) requirement is refused (the default).
 * USD limits, the payment count and confirmation are the same for both chains and use the shared daily totals.
 */
export function evaluate(p: PayPolicy, r: PaymentRequirements, usage: DayUsage, recipient: RecipientUsage = NO_RECIPIENT_USAGE, evmNetwork: EvmNetwork | null = null): Evaluated {
  const reasons: string[] = [];
  let asset: AssetSymbol | null;
  if (isEvmRequirement(r)) {
    const e = evmReasons(p, r, evmNetwork);
    reasons.push(...e.reasons);
    asset = e.asset;
  } else {
    asset = symbolOf(p, r.asset);
    if (r.scheme !== 'exact') reasons.push(`unsupported_scheme: ${r.scheme}`);
    if (r.network !== p.network) reasons.push(`wrong_network: ${r.network}`);
    if (!asset) reasons.push(`asset_not_allowed: unknown mint ${r.asset}`);
    else if (!p.allowedAssets.includes(asset)) reasons.push(`asset_not_allowed: ${asset} (X402_ALLOWED_ASSETS)${asset === 'A402' ? ' — A402 (v1) is deprecated; use PREQ' : ''}`);
    if (!p.trustedPayTo.length) reasons.push('pay_to_not_trusted: trusted recipient list is empty (X402_TRUSTED_PAY_TO)');
    else if (!p.trustedPayTo.includes(r.payTo)) reasons.push(`pay_to_not_trusted: ${r.payTo}`);
  }
  let amount: bigint;
  try { amount = BigInt(r.amount); } catch { amount = -1n; }
  // A zero price is refused as before; the text only says how to look again (some sellers price by input)
  if (amount === 0n) reasons.push('invalid_amount: price is 0 — if the seller prices by input, quote again with the same body or query you will send');
  else if (amount < 0n) reasons.push('invalid_amount');
  let usd: number | null = null;
  if (asset === 'USDC' && amount > 0n) {
    usd = Number(amount) / 1e6;
    if (usd > p.maxUsdPerPayment) reasons.push(`over_per_payment_limit: ${usd} USD > ${p.maxUsdPerPayment} USD`);
    if (usage.usd + usd > p.maxUsdPerDay) reasons.push(`over_daily_usd_limit: ${usage.usd} + ${usd} > ${p.maxUsdPerDay} USD`);
    if (p.maxUsdPerRecipientPerDay !== null && recipient.usd + usd > p.maxUsdPerRecipientPerDay) {
      reasons.push(`over_daily_recipient_usd_limit: ${recipient.usd} + ${usd} > ${p.maxUsdPerRecipientPerDay} USD to ${r.payTo} (X402_MAX_USD_PER_RECIPIENT_PER_DAY)`);
    }
  }
  let needsTokenConfirm = false;
  if (asset && asset !== 'USDC' && p.allowedAssets.includes(asset) && amount > 0n) {
    const l = p.tokenLimits[asset];
    const n = tokenEnv(asset);
    const lc = asset.toLowerCase();
    const unit = `${asset} smallest units`;
    if (l.perPayment === null) reasons.push(`${lc}_limit_not_configured: set ${n.perPayment} (max ${asset} per payment, in ${unit}: 1 ${asset} = 1,000,000)`);
    else if (amount > l.perPayment) reasons.push(`over_per_payment_limit: ${amount} > ${l.perPayment} (${unit})`);
    if (l.perDay === null) reasons.push(`${lc}_limit_not_configured: set ${n.perDay} (max ${asset} per UTC day, in ${unit}: 1 ${asset} = 1,000,000)`);
    else if (usedToday(usage, asset) + amount > l.perDay) reasons.push(`over_daily_${lc}_limit: ${usedToday(usage, asset)} + ${amount} > ${l.perDay} (${unit})`);
    if (asset === 'PREQ' && p.maxPreqPerRecipientPerDay !== null && recipient.preq + amount > p.maxPreqPerRecipientPerDay) {
      reasons.push(`over_daily_recipient_preq_limit: ${recipient.preq} + ${amount} > ${p.maxPreqPerRecipientPerDay} (${unit}) to ${r.payTo} (X402_MAX_PREQ_PER_RECIPIENT_PER_DAY_ATOMIC)`);
    }
    needsTokenConfirm = l.confirmAbove !== null && amount >= l.confirmAbove;
  }
  if (usage.count >= p.maxPaymentsPerDay) reasons.push(`over_daily_count_limit: ${p.maxPaymentsPerDay}`);
  const needsConfirmation =
    (asset === 'USDC' && p.confirmAboveUsd !== null && usd !== null && usd >= p.confirmAboveUsd) || needsTokenConfirm;
  return { requirement: r, asset, ok: reasons.length === 0, reasons, needsConfirmation, usd };
}

/** Requirement to choose after evaluation (preferred asset first) */
export function choose(p: PayPolicy, evs: Evaluated[], preferChain: ChainName = 'solana'): Evaluated | null {
  return chooseWithReason(p, evs, preferChain)?.chosen ?? null;
}

/** Picks the chain first (X402_PREFER_NETWORK among chains with a passing option), then the preferred asset on that chain */
export function chooseWithReason(p: PayPolicy, evs: Evaluated[], preferChain: ChainName = 'solana'): { chosen: Evaluated; chain: ChainName; reason: 'preferred network' | 'only option passing' } | null {
  const ok = evs.filter((e) => e.ok);
  const pick = chooseChain([...new Set(ok.map((e) => chainOf(e.requirement)))], preferChain);
  if (!pick) return null;
  const on = ok.filter((e) => chainOf(e.requirement) === pick.chain);
  const chosen = on.find((e) => e.asset === p.prefer) ?? on[0];
  return chosen ? { chosen, chain: pick.chain, reason: pick.reason } : null;
}

/** Warnings when today's usage has reached a share (default 80%) of a daily cap. Informational only; the caps themselves are enforced by evaluate() */
export function nearLimits(p: PayPolicy, usage: DayUsage, share = 0.8): string[] {
  const w: string[] = [];
  const usd = Math.round(usage.usd * 1e6) / 1e6;
  if (p.maxUsdPerDay > 0 && usd >= p.maxUsdPerDay * share - 1e-9) w.push(`near_daily_usd_limit: ${usd} of ${p.maxUsdPerDay} USD used today (UTC)`);
  if (p.maxPaymentsPerDay > 0 && usage.count >= p.maxPaymentsPerDay * share) w.push(`near_daily_count_limit: ${usage.count} of ${p.maxPaymentsPerDay} payments today (UTC)`);
  const preqCap = p.tokenLimits.PREQ.perDay;
  if (preqCap !== null && usage.preq * 100n >= preqCap * BigInt(Math.round(share * 100))) {
    w.push(`near_daily_preq_limit: ${formatUnits(usage.preq, 'PREQ')} of ${formatUnits(preqCap, 'PREQ')} used today (UTC)`);
  }
  return w;
}
