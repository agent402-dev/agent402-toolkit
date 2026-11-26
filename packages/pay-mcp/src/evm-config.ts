// Base (EVM) settings (design docs/design/pay-mcp-evm.md ③).
// With none of these set, behaviour is exactly as today: Solana only.
import { evmNetworkFor, type EvmNetwork } from './evm-policy.js';

export type ChainName = 'solana' | 'base';
const CHAINS: ChainName[] = ['solana', 'base'];

export interface EvmEnv {
  X402_NETWORK?: string;
  X402_ALLOWED_NETWORKS?: string;
  X402_PREFER_NETWORK?: string;
  X402_EVM_KEY_PATH?: string;
}

export interface EvmConfig {
  /** Chains payments may use. Default ['solana'] */
  allowedChains: ChainName[];
  /** The EVM network Base payments go to (mainnet ↔ Base, devnet ↔ Base Sepolia), or null when Base is not allowed */
  evmNetwork: EvmNetwork | null;
  prefer: ChainName;
  /** Path only; the file is never read here and its content never appears in output */
  evmKeyPath: string | null;
  /** Settings errors: the server refuses to start while any exist */
  problems: string[];
  /** Shown at start; do not block */
  warnings: string[];
}

const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

export function evmConfigFromEnv(env: EvmEnv): EvmConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  const raw = list(env.X402_ALLOWED_NETWORKS);
  const unknown = raw.filter((n) => !(CHAINS as string[]).includes(n));
  if (unknown.length) problems.push(`X402_ALLOWED_NETWORKS: unknown ${unknown.join(', ')} (use solana, base)`);
  const allowedChains = raw.length ? CHAINS.filter((c) => raw.includes(c)) : (['solana'] as ChainName[]);
  if (raw.length && !allowedChains.length) problems.push('X402_ALLOWED_NETWORKS: no known network left');
  const preferRaw = (env.X402_PREFER_NETWORK ?? '').trim().toLowerCase();
  let prefer: ChainName = allowedChains[0] ?? 'solana';
  if (preferRaw) {
    if (!(CHAINS as string[]).includes(preferRaw)) problems.push(`X402_PREFER_NETWORK: unknown ${preferRaw} (use solana, base)`);
    else if (!allowedChains.includes(preferRaw as ChainName)) problems.push(`X402_PREFER_NETWORK: ${preferRaw} is not in X402_ALLOWED_NETWORKS`);
    else prefer = preferRaw as ChainName;
  } else if (allowedChains.includes('solana')) prefer = 'solana';
  const baseOn = allowedChains.includes('base');
  const evmKeyPath = env.X402_EVM_KEY_PATH?.trim() || null;
  if (baseOn && !evmKeyPath) warnings.push('Base is allowed but X402_EVM_KEY_PATH is not set: every Base payment is refused (evm_key_missing).');
  if (!baseOn && evmKeyPath) warnings.push('X402_EVM_KEY_PATH is set but base is not in X402_ALLOWED_NETWORKS: the key is not used.');
  return {
    allowedChains,
    evmNetwork: baseOn ? evmNetworkFor(env.X402_NETWORK === 'devnet' ? 'devnet' : 'mainnet') : null,
    prefer,
    evmKeyPath,
    problems,
    warnings,
  };
}

/** Pick one chain among options that already passed every rule. Never picks a chain with no passing option */
export function chooseChain(passing: ChainName[], prefer: ChainName): { chain: ChainName; reason: 'preferred network' | 'only option passing' } | null {
  if (!passing.length) return null;
  if (passing.includes(prefer)) return { chain: prefer, reason: passing.length > 1 ? 'preferred network' : 'only option passing' };
  return { chain: passing[0], reason: 'only option passing' };
}
