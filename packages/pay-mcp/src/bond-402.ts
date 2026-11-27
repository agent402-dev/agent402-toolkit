// B1-b (part 1): read a seller's `extensions.bond` claim from a 402 and check it on chain (read only).
// A claim is never trusted: the bond token account must exist, hold the claimed mint, belong to the claimed seller
// and hold at least maxCover. Only USDC counts as a USD value; SOL and PREQ bonds are reported but get no USD value
// (thin liquidity is not treated as cash). This module can only ADD a confirmation step; it never raises limits,
// widens allowlists or skips any existing check. Off by default. Internal review only, not independently audited.

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^[1-9]\d{0,19}$/;
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
export const SOLANA_MAINNET_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

export interface BondClaim {
  program: string; seller: string; bondAccount: string;
  asset: { symbol: string; mint: string }; maxCover: bigint; network: string;
}

/** Parse `extensions.bond` (version 1, scheme agent402-bond-v2). Returns null when absent, or the reasons it is unusable. */
export function parseBondClaim(extensions: unknown): { claim: BondClaim } | { invalid: string[] } | null {
  if (!extensions || typeof extensions !== 'object') return null;
  const b = (extensions as Record<string, unknown>).bond;
  if (b === undefined) return null;
  if (!b || typeof b !== 'object') return { invalid: ['bond extension is not an object'] };
  const o = b as Record<string, unknown>;
  const bad: string[] = [];
  if (o.version !== 1) bad.push('unsupported bond extension version');
  if (o.scheme !== 'agent402-bond-v2') bad.push('unsupported bond scheme');
  if (o.network !== SOLANA_MAINNET_CAIP2) bad.push('bond is not on Solana mainnet');
  for (const k of ['program', 'seller', 'bondAccount'] as const) if (typeof o[k] !== 'string' || !B58.test(o[k] as string)) bad.push(`bond ${k} is not a base58 address`);
  const asset = o.asset as Record<string, unknown> | undefined;
  if (!asset || typeof asset.symbol !== 'string' || typeof asset.mint !== 'string' || !B58.test(asset.mint)) bad.push('bond asset is missing or malformed');
  if (typeof o.maxCover !== 'string' || !DEC.test(o.maxCover)) bad.push('bond maxCover is not a positive integer string');
  if (bad.length) return { invalid: bad };
  return { claim: { program: o.program as string, seller: o.seller as string, bondAccount: o.bondAccount as string, asset: { symbol: asset!.symbol as string, mint: asset!.mint as string }, maxCover: BigInt(o.maxCover as string), network: o.network as string } };
}

export interface BondCheck {
  /** true only when every on-chain check passed */
  verified: boolean;
  reasons: string[];
  /** balance read on chain (smallest units), when the account was readable */
  balance?: string;
  /** USD value of the claimed cover: USDC only (6 decimals); null for any other asset */
  coverUsd: number | null;
}

export interface BondCheckDeps { fetch: typeof fetch; rpcUrl: string; v2Program: string; usdcMint: string }

/** Read the bond token account on chain and compare it with the claim. Never signs anything. */
export async function verifyBondClaim(d: BondCheckDeps, c: BondClaim): Promise<BondCheck> {
  const reasons: string[] = [];
  if (c.program !== d.v2Program) reasons.push('bond program is not the Agent402 Bond v2 program');
  let info: any;
  try {
    const r = await d.fetch(d.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [c.bondAccount, { encoding: 'jsonParsed', commitment: 'confirmed' }] }), signal: AbortSignal.timeout(15_000) });
    const j = (await r.json()) as { result?: { value: any } };
    info = j?.result?.value ?? null;
  } catch (e) {
    return { verified: false, reasons: [...reasons, `bond account could not be read: ${(e as Error).message}`], coverUsd: null };
  }
  if (!info) return { verified: false, reasons: [...reasons, 'bond account does not exist'], coverUsd: null };
  if (!TOKEN_PROGRAMS.has(info.owner)) reasons.push('bond account is not a token account');
  const p = info.data?.parsed?.info;
  if (!p) return { verified: false, reasons: [...reasons, 'bond account data could not be parsed'], coverUsd: null };
  if (p.mint !== c.asset.mint) reasons.push('bond account holds a different mint than claimed');
  if (p.owner !== c.seller) reasons.push('bond account does not belong to the claimed seller');
  if (p.state && p.state !== 'initialized') reasons.push(`bond account is ${p.state}`);
  const balance = typeof p.tokenAmount?.amount === 'string' && /^\d+$/.test(p.tokenAmount.amount) ? BigInt(p.tokenAmount.amount) : null;
  if (balance === null) reasons.push('bond balance could not be read');
  else if (balance < c.maxCover) reasons.push('bond balance is below the claimed maxCover');
  const isUsdc = c.asset.mint === d.usdcMint;
  return { verified: reasons.length === 0, reasons, ...(balance !== null ? { balance: balance.toString() } : {}), coverUsd: isUsdc && reasons.length === 0 ? Number(c.maxCover) / 1e6 : null };
}

export interface BondPreferPolicy {
  /** X402_BOND_PREFER = "on": ask a human before paying an unbonded seller at or above unbondedConfirmAboveUsd */
  prefer: boolean;
  unbondedConfirmAboveUsd: number | null;
}

/** Read the opt-in policy. Anything but exactly "on" is off. */
export function bondPreferPolicy(env: Record<string, string | undefined>): BondPreferPolicy {
  const prefer = env.X402_BOND_PREFER === 'on';
  const raw = env.X402_UNBONDED_CONFIRM_ABOVE_USD;
  const n = raw !== undefined && /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw.trim()) : null;
  return { prefer, unbondedConfirmAboveUsd: prefer ? (n ?? 0.05) : null };
}

/**
 * Extra confirmation for an unbonded (or unverified) seller. Returns true only to ADD a confirmation;
 * the caller ORs it with its existing confirmation result, so a verified bond never removes one.
 */
export function unbondedNeedsConfirm(p: BondPreferPolicy, usd: number | null, check: BondCheck | null): boolean {
  if (!p.prefer || p.unbondedConfirmAboveUsd === null) return false;
  if (check?.verified) return false;
  return usd === null || usd >= p.unbondedConfirmAboveUsd;
}
