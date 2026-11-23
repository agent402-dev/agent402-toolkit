// Payment wallet: signs x402 exact payment transactions with a key file on the user's computer (official @x402 client).
// The key is never sent to the server; only the partially signed transaction goes in the PAYMENT-SIGNATURE header. This module signs only one requirement that passed the policy check
import { readFileSync } from 'node:fs';
import { createKeyPairSignerFromBytes, signBytes } from '@solana/kit';
import { encodePaymentSignatureHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types';
import { x402Client } from '@x402/fetch';
import { toClientSvmSigner } from '@x402/svm';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { TOKEN_SYMBOLS, type PayPolicy } from './policy.js';

export interface Wallet {
  address: string;
  network: string;
  /** Signs one requirement that passed the policy check → PAYMENT-SIGNATURE header value */
  sign(resource: PaymentRequired['resource'], requirement: PaymentRequirements): Promise<string>;
  /** Number of signatures made in this process */
  readonly signedCount: number;
  balances(): Promise<Record<string, string>>;
  /** Raw ed25519 signature over transaction message bytes (Agent402 Bond tools only; every rule is checked by the caller first) */
  signBytes(message: Uint8Array): Promise<Uint8Array>;
}

export async function loadWallet(keyPath: string, policy: PayPolicy, rpcUrl?: string): Promise<Wallet> {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(keyPath, 'utf8')) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  bytes.fill(0);
  let signed = 0;
  const tokenAllow = TOKEN_SYMBOLS.flatMap((t) => {
    const max = policy.tokenLimits[t].perPayment;
    return policy.allowedAssets.includes(t) && policy.mints[t] && max !== null
      ? [{ network: policy.network as `${string}:${string}`, asset: policy.mints[t], maxAmountPerPayment: max.toString() }]
      : [];
  });
  // The official client's spending limit is set to the same value (a second safety net)
  const client = x402Client.fromConfig({
    schemes: [{ network: policy.network as `${string}:${string}`, client: new ExactSvmScheme(toClientSvmSigner(signer), rpcUrl ? { rpcUrl } : undefined) }],
    spendControls: {
      maxAmountPerPayment: `$${policy.maxUsdPerPayment}`,
      // Tokens (PREQ, A402 (v1)) are allowed in the official client only when allowed and a per-payment cap is set (without a cap the official client rejects too)
      ...(tokenAllow.length ? { allowedAssets: tokenAllow } : {}),
    },
  });
  const rpc = rpcUrl ?? (policy.network.includes('EtWTRAB') ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  return {
    address: signer.address,
    network: policy.network,
    get signedCount() { return signed; },
    async signBytes(message) {
      const sig = new Uint8Array(await signBytes(signer.keyPair.privateKey, message));
      signed++;
      return sig;
    },
    async sign(resource, requirement) {
      const payload = await client.createPaymentPayload({ x402Version: 2, resource, accepts: [requirement] } as PaymentRequired);
      signed++;
      return encodePaymentSignatureHeader(payload);
    },
    async balances() {
      const out: Record<string, string> = {};
      for (const [sym, mint] of Object.entries(policy.mints)) {
        // Skip assets without a mint and A402 (v1) when not allowed
        if (!mint || (sym === 'A402' && !policy.allowedAssets.includes('A402'))) continue;
        try {
          const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountsByOwner', params: [signer.address, { mint }, { encoding: 'jsonParsed' }] }) });
          const j = (await r.json()) as { result?: { value: { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }[] } };
          out[sym] = j.result?.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? '0';
        } catch { out[sym] = 'unavailable'; }
      }
      return out;
    },
  };
}
