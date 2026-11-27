// Optional `extensions.bond` in the 402: tells a buyer that this seller works with an Agent402 Bond v2 (standby-style) bond,
// where to read it on chain, which failure is paid out automatically, and the most a buyer can recover per call.
// Off when unset: the 402 stays byte-for-byte the same. A claim only: buyers must check the chain themselves (pay-mcp does),
// never take it on trust. Prices, accepted assets, limits and payment checks are unchanged. Internal review only, not independently audited.

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DEC = /^[1-9]\d{0,19}$/;
/** The Bond v2 program as deployed on Solana mainnet. */
export const BOND_V2_PROGRAM_MAINNET = 'Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev';
/** Conditions Bond v2 pays out on chain without anyone deciding (the seller did not mark delivery in time). */
export const BOND_AUTO_PAYOUT = ['deadline_missed'] as const;
/** Conditions a buyer can check from data alone (it then does not accept; see the 8183-style job layer). */
export const BOND_MACHINE_CHECKS = ['deadline_missed', 'not_delivered', 'receipt_mismatch', 'schema_mismatch'] as const;

export interface BondExtensionConfig {
  /** Bond v2 program id (default: the mainnet program) */
  program?: string;
  /** Seller wallet that opens the bonded deals (base58) */
  seller: string;
  /** Token account holding the seller's bond funds, so a buyer can read the balance on chain (base58) */
  bondAccount: string;
  /** Asset of the bond: symbol and mint */
  asset: 'USDC' | 'SOL' | 'PREQ';
  mint: string;
  /** Most a buyer can recover per call, in the asset's smallest units (decimal string) */
  maxCover: string;
  /** Optional https page with the bond terms */
  termsUrl?: string;
}

/** The `extensions.bond` object for a valid config; throws on a bad one (so a typo never ships a wrong claim). */
export function bondExtension(c: BondExtensionConfig): Record<string, unknown> {
  const program = c.program ?? BOND_V2_PROGRAM_MAINNET;
  for (const [k, v] of [['program', program], ['seller', c.seller], ['bondAccount', c.bondAccount], ['mint', c.mint]] as const) {
    if (typeof v !== 'string' || !B58.test(v)) throw new Error(`bond extension: ${k} must be a base58 address`);
  }
  if (!['USDC', 'SOL', 'PREQ'].includes(c.asset)) throw new Error('bond extension: asset must be USDC, SOL or PREQ');
  if (typeof c.maxCover !== 'string' || !DEC.test(c.maxCover)) throw new Error('bond extension: maxCover must be a positive integer string (smallest units)');
  if (c.termsUrl !== undefined && !/^https:\/\/\S+$/.test(c.termsUrl)) throw new Error('bond extension: termsUrl must be an https URL');
  return {
    version: 1,
    scheme: 'agent402-bond-v2',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    program, seller: c.seller, bondAccount: c.bondAccount,
    asset: { symbol: c.asset, mint: c.mint }, maxCover: c.maxCover,
    autoPayout: [...BOND_AUTO_PAYOUT], machineChecks: [...BOND_MACHINE_CHECKS],
    ...(c.termsUrl ? { termsUrl: c.termsUrl } : {}),
    verify: 'Read bondAccount and the program on chain before relying on this.',
  };
}

/** `extensions` for a 402: bazaar and/or bond, or undefined when neither is set (then no `extensions` key at all). */
export function extensionsOf(bazaar: unknown | undefined, bond: BondExtensionConfig | undefined): Record<string, unknown> | undefined {
  const ext: Record<string, unknown> = {};
  if (bazaar !== undefined) ext.bazaar = bazaar;
  if (bond) ext.bond = bondExtension(bond);
  return Object.keys(ext).length ? ext : undefined;
}
