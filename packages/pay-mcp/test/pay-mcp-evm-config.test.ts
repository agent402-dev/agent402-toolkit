// Base (EVM) settings parsing (packages/pay-mcp/src/evm-config.ts). Defaults keep Solana only.
import { describe, expect, it } from 'vitest';
import { chooseChain, evmConfigFromEnv } from '@agent402-dev/pay-mcp/evm-config';

describe('evmConfigFromEnv', () => {
  it('nothing set: Solana only, Base off, no problems', () => {
    expect(evmConfigFromEnv({})).toEqual({ allowedChains: ['solana'], evmNetwork: null, prefer: 'solana', evmKeyPath: null, problems: [], warnings: [] });
  });
  it('solana,base on mainnet → Base mainnet; devnet → Base Sepolia', () => {
    const e = { X402_ALLOWED_NETWORKS: 'solana, Base', X402_EVM_KEY_PATH: '/k/evm.key' };
    expect(evmConfigFromEnv(e)).toMatchObject({ allowedChains: ['solana', 'base'], evmNetwork: 'eip155:8453', prefer: 'solana', problems: [], warnings: [] });
    expect(evmConfigFromEnv({ ...e, X402_NETWORK: 'devnet' }).evmNetwork).toBe('eip155:84532');
  });
  it('unknown names and a preferred chain that is not allowed are start-up problems', () => {
    expect(evmConfigFromEnv({ X402_ALLOWED_NETWORKS: 'solana,ethereum' }).problems.join(' ')).toContain('unknown ethereum');
    expect(evmConfigFromEnv({ X402_ALLOWED_NETWORKS: 'polygon' }).problems.length).toBe(2);
    expect(evmConfigFromEnv({ X402_PREFER_NETWORK: 'base' }).problems.join(' ')).toContain('not in X402_ALLOWED_NETWORKS');
    expect(evmConfigFromEnv({ X402_PREFER_NETWORK: 'tron' }).problems.join(' ')).toContain('unknown tron');
  });
  it('prefer base only when asked; base-only list prefers base', () => {
    expect(evmConfigFromEnv({ X402_ALLOWED_NETWORKS: 'solana,base', X402_PREFER_NETWORK: 'base', X402_EVM_KEY_PATH: 'k' }).prefer).toBe('base');
    expect(evmConfigFromEnv({ X402_ALLOWED_NETWORKS: 'base', X402_EVM_KEY_PATH: 'k' }).prefer).toBe('base');
  });
  it('warns (does not fail) about a missing or unused EVM key path, and never shows anything but the path', () => {
    expect(evmConfigFromEnv({ X402_ALLOWED_NETWORKS: 'solana,base' }).warnings.join(' ')).toContain('evm_key_missing');
    const c = evmConfigFromEnv({ X402_EVM_KEY_PATH: '/k/evm.key' });
    expect(c.evmNetwork).toBeNull();
    expect(c.warnings.join(' ')).toContain('not used');
  });
});

describe('chooseChain', () => {
  it('prefers the preferred chain when both pass, else the only passing one, else none', () => {
    expect(chooseChain(['solana', 'base'], 'solana')).toEqual({ chain: 'solana', reason: 'preferred network' });
    expect(chooseChain(['solana', 'base'], 'base')).toEqual({ chain: 'base', reason: 'preferred network' });
    expect(chooseChain(['base'], 'solana')).toEqual({ chain: 'base', reason: 'only option passing' });
    expect(chooseChain(['solana'], 'solana')).toEqual({ chain: 'solana', reason: 'only option passing' });
    expect(chooseChain([], 'solana')).toBeNull();
  });
});
