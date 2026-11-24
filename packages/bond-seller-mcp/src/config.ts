// Seller settings from environment variables. Amounts are decimals in the deal asset (USDC by default, or PREQ), kept in smallest units.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkBondTerms, type BondTermsConfig } from '@agent402-dev/pay-server/bond';
import { checkBondTermsV2, type BondTermsV2Config } from '@agent402-dev/pay-server/bond-v2';
import { BOND_V2_DEPLOYED } from '@agent402-dev/bond-client/v2';

export const DEFAULT_STORE = join(homedir(), '.agent402', 'seller-jobs.json');

export interface SellerConfig {
  keypairPath: string | null;
  rpcUrl: string | null;
  storePath: string;
  terms: BondTermsConfig | null;
  /** Job Protocol version: 1 (Bond v1, default) or 2 (Bond v2) */
  protocol: 1 | 2;
  /** Bond v2 terms and program (protocol 2 only) */
  termsV2: BondTermsV2Config | null;
  v2Program: string | null;
  /** Deal asset: USDC (default) or PREQ (Token-2022). Both have 6 decimals */
  asset: 'USDC' | 'PREQ';
  /** Problems that keep the seller tools off (shown by sell_status) */
  problems: string[];
  description?: string;
  buyers: string[] | null;
  maxPending: number;
  maxPendingPerBuyer: number;
  maxUnconfirmedPerBuyer: number;
  http: { port: number; host: string; publicOrigin?: string } | null;
  intervalSeconds: number;
}

/** "12.5" USDC -> 12500000n; null if not a plain decimal with at most 6 places */
export function usdcToAtomic(v: string | undefined): bigint | null {
  if (v === undefined || !/^\d+(\.\d{1,6})?$/.test(v.trim())) return null;
  const [i, f = ''] = v.trim().split('.');
  return BigInt(i) * 1_000_000n + BigInt(f.padEnd(6, '0'));
}
const int = (v: string | undefined, d: number) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v) : d);

export function sellerConfigFromEnv(env: Record<string, string | undefined>): SellerConfig {
  const problems: string[] = [];
  const keypairPath = env.BOND_SELLER_KEYPAIR_PATH?.trim() || null;
  if (!keypairPath) problems.push('BOND_SELLER_KEYPAIR_PATH is not set (a dedicated seller wallet key file)');
  const rpcUrl = env.BOND_SELLER_RPC_URL?.trim() || null;
  if (!rpcUrl) problems.push('BOND_SELLER_RPC_URL is not set');

  const assetRaw = (env.BOND_SELL_ASSET ?? 'USDC').trim().toUpperCase();
  const asset: 'USDC' | 'PREQ' = assetRaw === 'PREQ' ? 'PREQ' : 'USDC';
  if (assetRaw !== 'USDC' && assetRaw !== 'PREQ') problems.push('BOND_SELL_ASSET must be USDC or PREQ');
  // BOND_SELL_PRICE / _BOND / _DEPOSIT are in the deal asset; the *_USD names stay as USDC aliases
  const usdOnly = (v: string | undefined) => (asset === 'USDC' ? v : undefined);
  const price = usdcToAtomic(env.BOND_SELL_PRICE ?? usdOnly(env.BOND_SELL_PRICE_USD));
  const bond = usdcToAtomic(env.BOND_SELL_BOND ?? usdOnly(env.BOND_SELL_BOND_USD));
  const deposit = usdcToAtomic(env.BOND_SELL_DEPOSIT ?? usdOnly(env.BOND_SELL_DEPOSIT_USD) ?? '0');
  let terms: BondTermsConfig | null = null;
  if (price === null || bond === null || deposit === null) {
    problems.push(`BOND_SELL_PRICE and BOND_SELL_BOND must be set (${asset}, e.g. "5" and "0.5"); BOND_SELL_DEPOSIT is optional${asset === 'USDC' ? ' (the *_USD names also work)' : ''}`);
  } else {
    terms = {
      price, sellerBond: bond, buyerDeposit: deposit,
      deliverSeconds: BigInt(int(env.BOND_SELL_DELIVER_SECONDS, 3600)),
      lateWindow: BigInt(int(env.BOND_SELL_LATE_WINDOW_SECONDS, 0)),
      payWindow: BigInt(int(env.BOND_SELL_PAY_WINDOW_SECONDS, 86_400)),
    };
    const bad = checkBondTerms(terms);
    if (bad.length) { problems.push(...bad.map((x) => `terms: ${x}`)); terms = null; }
  }

  const protocol: 1 | 2 = env.BOND_SELL_PROTOCOL?.trim() === '2' ? 2 : 1;
  if (env.BOND_SELL_PROTOCOL && !['1', '2'].includes(env.BOND_SELL_PROTOCOL.trim())) problems.push('BOND_SELL_PROTOCOL must be 1 or 2');
  let termsV2: BondTermsV2Config | null = null;
  let v2Program: string | null = null;
  if (protocol === 2) {
    const local = !!rpcUrl && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(rpcUrl);
    v2Program = BOND_V2_DEPLOYED?.toBase58() ?? (local ? env.BOND_SELL_V2_PROGRAM?.trim() || null : null);
    if (!v2Program) problems.push('Bond v2 is not deployed yet (protocol 2 runs only against a local test fork with BOND_SELL_V2_PROGRAM)');
    if (terms) {
      termsV2 = {
        price: terms.price, sellerBond: terms.sellerBond, buyerDeposit: terms.buyerDeposit, deliverSeconds: terms.deliverSeconds,
        grace: BigInt(int(env.BOND_SELL_GRACE_SECONDS, 86_400)), reviewWindow: BigInt(int(env.BOND_SELL_REVIEW_SECONDS, 86_400)),
      };
      const bad2 = checkBondTermsV2(termsV2);
      if (bad2.length) { problems.push(...bad2.map((x) => `terms: ${x}`)); termsV2 = null; }
    }
  }

  const port = env.BOND_SELL_PORT?.trim();
  const buyers = env.BOND_SELL_BUYERS?.trim();
  return {
    keypairPath, rpcUrl, terms, problems, asset, protocol, termsV2, v2Program,
    storePath: env.BOND_SELLER_STORE?.trim() || DEFAULT_STORE,
    description: env.BOND_SELL_DESCRIPTION?.trim() || undefined,
    buyers: buyers ? buyers.split(',').map((x) => x.trim()).filter(Boolean) : null,
    maxPending: int(env.BOND_SELL_MAX_PENDING, 3),
    maxPendingPerBuyer: int(env.BOND_SELL_MAX_PER_BUYER, 1),
    maxUnconfirmedPerBuyer: int(env.BOND_SELL_MAX_UNCONFIRMED_PER_BUYER, 2),
    http: port && /^\d+$/.test(port)
      ? { port: Number(port), host: env.BOND_SELL_HOST?.trim() || '127.0.0.1', publicOrigin: env.BOND_SELL_PUBLIC_ORIGIN?.trim() || undefined }
      : null,
    intervalSeconds: Math.max(30, int(env.BOND_SELL_INTERVAL_SECONDS, 60)),
  };
}
