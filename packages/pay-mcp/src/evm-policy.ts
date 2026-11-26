// Base (EVM) per-request payments: checks that run before anything is signed (design docs/design/pay-mcp-evm.md ④).
// Pure functions, no signing and no EVM libraries. Used by policy.evaluate (before signing) and evm-wallet.ts (after signing); off by default.
// Nothing here loosens the existing rules: allowlisted domains, trusted payTo, limits and confirmation still apply on top.
import type { PaymentRequirements } from '@x402/core/types';

/** USDC on Base, checked on-chain 2026-11-26 (name()/version()): Base = "USD Coin"/"2", Base Sepolia = "USDC"/"2" */
export const EVM_USDC = {
  'eip155:8453': { chainId: 8453, address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', name: 'USD Coin', version: '2' },
  'eip155:84532': { chainId: 84532, address: '0x036cbd53842c5426634e7929541ec2318f3dcf7e', name: 'USDC', version: '2' },
} as const;
export type EvmNetwork = keyof typeof EVM_USDC;

/** Base mainnet goes with X402_NETWORK=mainnet, Base Sepolia with devnet (testnet only with testnet) */
export const evmNetworkFor = (solanaNetwork: 'mainnet' | 'devnet'): EvmNetwork => (solanaNetwork === 'devnet' ? 'eip155:84532' : 'eip155:8453');

const EVM_ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isEvmAddress = (s: string) => EVM_ADDR.test(s);
/** 0x addresses compare case-insensitively; anything else (base58) compares exactly as today */
export const normalizePayTo = (s: string) => (isEvmAddress(s) ? s.toLowerCase() : s);

/** Max validity accepted for an EIP-3009 authorization (seconds) */
export const EVM_MAX_VALIDITY_SECONDS = 3600;

export type EvmRefusal =
  | 'wrong_network'
  | 'asset_not_allowed'
  | 'unsupported_transfer_method'
  | 'eip712_domain_mismatch'
  | 'pay_to_not_trusted'
  | 'bad_amount'
  | 'timeout_too_long';

export interface EvmCheckInput {
  /** The one EVM network allowed for this run (from evmNetworkFor), or null when Base payments are off (the default) */
  allowedNetwork: EvmNetwork | null;
  /** X402_TRUSTED_PAY_TO entries (mixed Solana and 0x). Empty means refuse all */
  trustedPayTo: string[];
}

/** Checks one EVM payment requirement. Returns every reason it is refused (empty = passes these checks only) */
export function checkEvmRequirement(req: PaymentRequirements, input: EvmCheckInput): EvmRefusal[] {
  const reasons: EvmRefusal[] = [];
  const net = req.network as string;
  const usdc = input.allowedNetwork && net === input.allowedNetwork ? EVM_USDC[input.allowedNetwork] : null;
  if (req.scheme !== 'exact' || !usdc) reasons.push('wrong_network');
  if (!usdc || typeof req.asset !== 'string' || req.asset.toLowerCase() !== usdc.address) reasons.push('asset_not_allowed');
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== 'eip3009') reasons.push('unsupported_transfer_method');
  if (!usdc || extra.name !== usdc.name || extra.version !== usdc.version) reasons.push('eip712_domain_mismatch');
  const trusted = input.trustedPayTo.filter(isEvmAddress).map(normalizePayTo);
  if (typeof req.payTo !== 'string' || !isEvmAddress(req.payTo) || !trusted.includes(normalizePayTo(req.payTo))) reasons.push('pay_to_not_trusted');
  if (typeof req.amount !== 'string' || !/^\d+$/.test(req.amount) || BigInt(req.amount) <= 0n) reasons.push('bad_amount');
  if (!(req.maxTimeoutSeconds > 0 && req.maxTimeoutSeconds <= EVM_MAX_VALIDITY_SECONDS)) reasons.push('timeout_too_long');
  return reasons;
}

/** What a signed EIP-3009 authorization claims; compared against the requirement before it is sent */
export interface SignedEvmAuthorization {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  to: string;
  value: string;
  validBefore: string;
}

/** After signing, before sending: the signed values must equal the checked requirement, or nothing is sent */
export function authorizationMatches(req: PaymentRequirements, auth: SignedEvmAuthorization, nowSeconds: number): boolean {
  const usdc = EVM_USDC[req.network as EvmNetwork];
  if (!usdc) return false;
  const d = auth.domain;
  if (d.name !== usdc.name || d.version !== usdc.version || d.chainId !== usdc.chainId || d.verifyingContract.toLowerCase() !== usdc.address) return false;
  if (normalizePayTo(auth.to) !== normalizePayTo(req.payTo) || auth.value !== req.amount) return false;
  if (!/^\d+$/.test(auth.validBefore)) return false;
  const left = Number(auth.validBefore) - nowSeconds;
  return left > 0 && left <= Math.min(req.maxTimeoutSeconds, EVM_MAX_VALIDITY_SECONDS);
}
