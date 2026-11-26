// Base (EVM) pre-sign checks (packages/pay-mcp/src/evm-policy.ts). Pure functions; nothing is signed here.
import { describe, expect, it } from 'vitest';
import type { PaymentRequirements } from '@x402/core/types';
import { authorizationMatches, checkEvmRequirement, EVM_USDC, evmNetworkFor, normalizePayTo } from '@agent402-dev/pay-mcp/evm-policy';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const base = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  amount: '10000',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2' },
  ...over,
} as PaymentRequirements);
const on = { allowedNetwork: 'eip155:8453' as const, trustedPayTo: ['So1anaAddr1111111111111111111111111111111111', PAY_TO.toUpperCase().replace('0X', '0x')] };

describe('checkEvmRequirement', () => {
  it('passes a Base USDC exact requirement to a trusted 0x payTo (case-insensitive)', () => {
    expect(checkEvmRequirement(base(), on)).toEqual([]);
  });
  it('default (Base off) refuses everything', () => {
    expect(checkEvmRequirement(base(), { allowedNetwork: null, trustedPayTo: [PAY_TO] })).toEqual(expect.arrayContaining(['wrong_network', 'asset_not_allowed', 'eip712_domain_mismatch']));
  });
  it('mainnet run refuses Base Sepolia and vice versa', () => {
    expect(checkEvmRequirement(base({ network: 'eip155:84532' as PaymentRequirements['network'] }), on)).toContain('wrong_network');
    const sep = base({ network: 'eip155:84532' as PaymentRequirements['network'], asset: EVM_USDC['eip155:84532'].address, extra: { name: 'USDC', version: '2' } });
    expect(checkEvmRequirement(sep, { ...on, allowedNetwork: evmNetworkFor('devnet') })).toEqual([]);
    expect(checkEvmRequirement(base(), { ...on, allowedNetwork: evmNetworkFor('devnet') })).toContain('wrong_network');
  });
  it('refuses another token, permit2, a wrong EIP-712 domain, untrusted payTo, bad amount, long timeout, other scheme', () => {
    expect(checkEvmRequirement(base({ asset: '0x2222222222222222222222222222222222222222' }), on)).toEqual(['asset_not_allowed']);
    expect(checkEvmRequirement(base({ extra: { name: 'USD Coin', version: '2', assetTransferMethod: 'permit2' } }), on)).toEqual(['unsupported_transfer_method']);
    expect(checkEvmRequirement(base({ extra: { name: 'USDC', version: '2' } }), on)).toEqual(['eip712_domain_mismatch']);
    expect(checkEvmRequirement(base({ extra: { name: 'USD Coin', version: '1' } }), on)).toEqual(['eip712_domain_mismatch']);
    expect(checkEvmRequirement(base({ payTo: '0x3333333333333333333333333333333333333333' }), on)).toEqual(['pay_to_not_trusted']);
    expect(checkEvmRequirement(base(), { ...on, trustedPayTo: [] })).toEqual(['pay_to_not_trusted']);
    expect(checkEvmRequirement(base({ amount: '0' }), on)).toEqual(['bad_amount']);
    expect(checkEvmRequirement(base({ amount: '1.5' }), on)).toEqual(['bad_amount']);
    expect(checkEvmRequirement(base({ maxTimeoutSeconds: 3601 }), on)).toEqual(['timeout_too_long']);
    expect(checkEvmRequirement(base({ scheme: 'upto' }), on)).toEqual(['wrong_network']);
  });
  it('a Solana requirement never passes the EVM check', () => {
    const sol = base({ network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' as PaymentRequirements['network'], asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', payTo: 'So1anaAddr1111111111111111111111111111111111' });
    expect(checkEvmRequirement(sol, on)).toEqual(expect.arrayContaining(['wrong_network', 'pay_to_not_trusted']));
  });
  it('normalizePayTo lowercases 0x only', () => {
    expect(normalizePayTo('0xABCDEFabcdef0000000000000000000000000000')).toBe('0xabcdefabcdef0000000000000000000000000000');
    expect(normalizePayTo('So1anaAddrABC')).toBe('So1anaAddrABC');
  });
});

describe('authorizationMatches (after signing, before sending)', () => {
  const now = 1_800_000_000;
  const auth = { domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }, to: PAY_TO, value: '10000', validBefore: String(now + 200) };
  it('accepts the exact checked values', () => {
    expect(authorizationMatches(base(), auth, now)).toBe(true);
  });
  it('rejects any changed field', () => {
    expect(authorizationMatches(base(), { ...auth, to: '0x3333333333333333333333333333333333333333' }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, value: '10001' }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, domain: { ...auth.domain, chainId: 84532 } }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, domain: { ...auth.domain, name: 'USDC' } }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, domain: { ...auth.domain, verifyingContract: '0x2222222222222222222222222222222222222222' } }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, validBefore: String(now + 301) }, now)).toBe(false);
    expect(authorizationMatches(base(), { ...auth, validBefore: String(now) }, now)).toBe(false);
  });
});
