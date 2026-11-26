// Base (EVM) is off by default: a seller offering Base next to Solana is quoted with each option's network,
// the Base option is refused before anything is signed, and a Base-only 402 is refused with nothing signed.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequirements } from '@x402/core/types';
import { createAgent } from '@agent402-dev/pay-mcp/agent';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { NETWORKS, policyFromEnv, type PolicyEnv } from '@agent402-dev/pay-mcp/policy';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { evmConfigFromEnv } from '@agent402-dev/pay-mcp/evm-config';

const TRUSTED = Keypair.generate().publicKey.toBase58();
const EVM_PAY_TO = '0x1111111111111111111111111111111111111111';
const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const HOST = 'api.good.test';
// Even with the 0x address trusted, Base stays refused: this version pays on the configured Solana network only
const ENV: PolicyEnv = { X402_NETWORK: 'devnet', X402_ALLOWED_DOMAINS: HOST, X402_TRUSTED_PAY_TO: `${TRUSTED},${EVM_PAY_TO}` };
const sol = (): PaymentRequirements => ({ scheme: 'exact', network: NETWORKS.devnet as never, asset: USDC, amount: '20000', payTo: TRUSTED, maxTimeoutSeconds: 60, extra: { feePayer: 'FEE' } });
const baseSepolia = (): PaymentRequirements => ({ scheme: 'exact', network: 'eip155:84532' as never, asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', amount: '20000', payTo: EVM_PAY_TO, maxTimeoutSeconds: 60, extra: { name: 'USDC', version: '2' } });

function agentFor(accepts: PaymentRequirements[]) {
  const policy = policyFromEnv(ENV);
  const history = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'paymcp-evm-off-')), 'h.jsonl'), () => policy.mints);
  let signed = 0;
  const wallet = { address: 'BUYER', network: NETWORKS.devnet, get signedCount() { return signed; }, async sign() { signed++; return 'X'; }, async balances() { return {}; }, async signBytes(): Promise<Uint8Array> { throw new Error('unused'); } };
  const pr = { x402Version: 2, resource: { url: `https://${HOST}/paid`, description: 'x' }, accepts };
  const f = (async (_u: unknown, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.get('payment-signature')) return new Response('{"ok":true}', { status: 200 });
    return new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr as never) } });
  }) as typeof fetch;
  return { agent: createAgent({ policy, wallet, history, fetch: f, confirm: async () => 'accept' }), signed: () => signed, history };
}

describe('Base (EVM) is off by default', () => {
  it('quote lists each option with its network; picks Solana; the Base option is refused for its network', async () => {
    const t = agentFor([baseSepolia(), sol()]);
    const q = await t.agent.quote({ url: `https://${HOST}/paid` });
    expect(q.options?.map((o) => [o.network, o.ok])).toEqual([['eip155:84532', false], [NETWORKS.devnet, true]]);
    expect(q.options?.[0].reasons.join(' ')).toMatch(/wrong_network: eip155:84532/);
    expect(q.payment?.network).toBe(NETWORKS.devnet);
    expect(t.signed()).toBe(0);
  });

  it('paying a Solana + Base 402 signs once, on Solana', async () => {
    const t = agentFor([baseSepolia(), sol()]);
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('paid');
    expect(r.payment?.network).toBe(NETWORKS.devnet);
    expect(t.signed()).toBe(1);
  });

  it('a Base-only 402 is refused and nothing is signed', async () => {
    const t = agentFor([baseSepolia()]);
    const r = await t.agent.payAndFetch({ url: `https://${HOST}/paid` });
    expect(r.result).toBe('refused');
    expect(r.reasons).toContain('no_option_passes_policy');
    expect(r.options?.[0].network).toBe('eip155:84532');
    expect(t.signed()).toBe(0);
    expect(t.history.list(5)[0]).toMatchObject({ result: 'refused', signed: false });
  });
});

describe('wallet_status networks', () => {
  async function status(evm?: ReturnType<typeof evmConfigFromEnv>) {
    const policy = policyFromEnv(ENV);
    const history = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'paymcp-evm-ws-')), 'h.jsonl'), () => policy.mints);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createPayServer({ policy, wallet: null, history, fetch: (async () => new Response('', { status: 404 })) as typeof fetch, ...(evm ? { evm } : {}) }).connect(a);
    const c = new Client({ name: 't', version: '0' });
    await c.connect(b);
    return JSON.parse(((await c.callTool({ name: 'wallet_status', arguments: {} })).content as { text: string }[])[0].text);
  }

  it('default: Solana only, Base off', async () => {
    for (const w of [await status(), await status(evmConfigFromEnv({}))]) {
      expect(w.networks).toMatchObject({ allowed: ['solana'], prefer: 'solana', base: 'off (X402_ALLOWED_NETWORKS)' });
      expect(w.networks.note).toMatch(/shared across networks/);
    }
  });

  it('Base allowed: shows the Base network and whether a key file is set, never the path', async () => {
    const path = '/home/someone/secret-folder/evm-key.json';
    const w = await status(evmConfigFromEnv({ X402_NETWORK: 'devnet', X402_ALLOWED_NETWORKS: 'solana,base', X402_EVM_KEY_PATH: path }));
    expect(w.networks.allowed).toEqual(['solana', 'base']);
    expect(w.networks.base).toMatchObject({ network: 'eip155:84532', keyFile: 'set' });
    expect(w.networks.base.note).toMatch(/refused/);
    expect(JSON.stringify(w)).not.toContain('secret-folder');
  });
});
