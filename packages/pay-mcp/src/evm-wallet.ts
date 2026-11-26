// Base (EVM) payment wallet: signs one x402 `exact` EIP-3009 authorization (USDC transferWithAuthorization) with a key file
// on the user's computer (design docs/design/pay-mcp-evm.md ②④). Off unless base is in X402_ALLOWED_NETWORKS and X402_EVM_KEY_PATH is set.
// The key never leaves this machine and never appears in output, errors or history: only the address is shown.
// This module signs only a requirement that already passed every rule (policy.evaluate). After signing, the signed values are
// checked again against the requirement and the fixed USDC domain; if anything differs the header is not returned (nothing is sent).
import { readFileSync } from 'node:fs';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { getAddress, verifyTypedData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { authorizationMatches, EVM_USDC, type EvmNetwork } from './evm-policy.js';
import type { PayPolicy } from './policy.js';
import type { Wallet } from './wallet.js';

/** Thrown when a signed authorization does not match what was checked; the caller records it as refused (signed, not sent) */
export class EvmAuthorizationMismatch extends Error {
  constructor(public readonly detail: string) { super(`evm_authorization_mismatch: ${detail}`); }
}

const TRANSFER_WITH_AUTHORIZATION = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }

const KEY_LINE = /^0x[0-9a-fA-F]{64}$/;

/** Reads a key file: one line, a 0x-prefixed 32-byte hex private key. Errors never include the file content */
export function readEvmKeyFile(path: string): Hex {
  let text: string;
  try { text = readFileSync(path, 'utf8').trim(); } catch (e) {
    throw new Error(`X402_EVM_KEY_PATH: cannot read the key file (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (!KEY_LINE.test(text)) throw new Error('X402_EVM_KEY_PATH: expected one line with a 0x-prefixed 32-byte hex private key');
  return text as Hex;
}

export interface EvmWalletOptions {
  /** Unix seconds; for tests */
  nowSeconds?: () => number;
}

/** Builds the Base wallet from a key held in memory only */
export function evmWalletFromKey(key: Hex, network: EvmNetwork, policy: PayPolicy, o: EvmWalletOptions = {}): Wallet {
  const account = privateKeyToAccount(key);
  const usdc = EVM_USDC[network];
  const nowSeconds = o.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let signed = 0;
  // The official client's USD cap is set to the same value (a second safety net); only this one network is registered
  const client = x402Client.fromConfig({
    schemes: [{ network, client: new ExactEvmScheme(account) }],
    spendControls: { maxAmountPerPayment: `$${policy.maxUsdPerPayment}` },
  });
  return {
    address: account.address,
    network,
    get signedCount() { return signed; },
    async signBytes(): Promise<Uint8Array> { throw new Error('Bond signing is Solana only; the Base wallet signs x402 payments only'); },
    async sign(resource: PaymentRequired['resource'], requirement: PaymentRequirements) {
      if (requirement.network !== network) throw new EvmAuthorizationMismatch('network');
      const payload = await client.createPaymentPayload({ x402Version: 2, resource, accepts: [requirement] } as PaymentRequired);
      signed++;
      const p = payload.payload as { authorization?: Authorization; signature?: Hex; permit2Authorization?: unknown };
      const auth = p.authorization;
      if (!auth || typeof p.signature !== 'string' || p.permit2Authorization !== undefined) throw new EvmAuthorizationMismatch('not an EIP-3009 authorization');
      if ((payload as { extensions?: unknown }).extensions !== undefined) throw new EvmAuthorizationMismatch('unexpected extensions');
      if (getAddress(auth.from) !== account.address) throw new EvmAuthorizationMismatch('from');
      const domain = { name: usdc.name, version: usdc.version, chainId: usdc.chainId, verifyingContract: getAddress(usdc.address) };
      if (!authorizationMatches(requirement, { domain, to: auth.to, value: auth.value, validBefore: auth.validBefore }, nowSeconds())) {
        throw new EvmAuthorizationMismatch('to, value, validity or domain');
      }
      if (auth.validAfter !== '0' && !(/^\d+$/.test(auth.validAfter) && Number(auth.validAfter) <= nowSeconds())) throw new EvmAuthorizationMismatch('validAfter');
      // The signature must verify against the fixed USDC domain (not the one the seller sent)
      const ok = await verifyTypedData({
        address: account.address,
        domain,
        types: TRANSFER_WITH_AUTHORIZATION,
        primaryType: 'TransferWithAuthorization',
        message: { from: getAddress(auth.from), to: getAddress(auth.to), value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore), nonce: auth.nonce as Hex },
        signature: p.signature,
      });
      if (!ok) throw new EvmAuthorizationMismatch('signature does not verify against the USDC domain');
      return encodePaymentSignatureHeader(payload);
    },
    async balances() { return { USDC: 'not checked (Base balance reading is not part of this version)' }; },
  };
}

export async function loadEvmWallet(keyPath: string, network: EvmNetwork, policy: PayPolicy): Promise<Wallet> {
  return evmWalletFromKey(readEvmKeyFile(keyPath), network, policy);
}
