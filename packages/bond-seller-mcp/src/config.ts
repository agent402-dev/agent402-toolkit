// Seller settings from environment variables. Amounts are given in USDC (decimal) and kept in smallest units.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checkBondTerms, type BondTermsConfig } from '@agent402-dev/pay-server/bond';

export const DEFAULT_STORE = join(homedir(), '.agent402', 'seller-jobs.json');

export interface SellerConfig {
  keypairPath: string | null;
  rpcUrl: string | null;
  storePath: string;
  terms: BondTermsConfig | null;
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

  const price = usdcToAtomic(env.BOND_SELL_PRICE_USD);
  const bond = usdcToAtomic(env.BOND_SELL_BOND_USD);
  const deposit = usdcToAtomic(env.BOND_SELL_DEPOSIT_USD ?? '0');
  let terms: BondTermsConfig | null = null;
  if (price === null || bond === null || deposit === null) {
    problems.push('BOND_SELL_PRICE_USD and BOND_SELL_BOND_USD must be set (USDC, e.g. "5" and "0.5"); BOND_SELL_DEPOSIT_USD is optional');
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

  const port = env.BOND_SELL_PORT?.trim();
  const buyers = env.BOND_SELL_BUYERS?.trim();
  return {
    keypairPath, rpcUrl, terms, problems,
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
