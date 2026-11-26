// Our own seller 402 passes our own `check` (queue 174): the seller template's unpaid answer, Solana only and with
// the optional Base option, has no "fix" finding in pay-server's check402. Fakes only: no network, nothing signed or paid.
import { describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { USDC_MAINNET } from '@agent402-dev/pay-server';
import { clearSupportedCache, SOLANA_MAINNET } from '@agent402-dev/pay-server/x402';
import { ataOf, type ChainReader } from '@agent402-dev/pay-server/chain';
import { paidRouteHandler, type PaidRoute } from '@agent402-dev/pay-server/route';
import { BASE_MAINNET, type EvmChainReader } from '@agent402-dev/pay-server/evm';
import { inspect402 } from '@agent402-dev/pay-server/check402';
import { baseOption } from '../examples/bond-seller-worker/base.js';

const PAY_TO = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
const BASE_TO = '0x1111111111111111111111111111111111111111';
const ON = { X402_BASE_PAY_TO: BASE_TO, BASE_RPC_URL: 'https://base-rpc.example', X402_BASE_FACILITATOR_URL: 'https://facilitator.example' };
const route: PaidRoute = { path: '/x402/job', priceUsd: 0.05, description: 'Counts the words in a text', check: (i) => (i.trim() ? null : 'send some text'), run: async () => ({ words: 1 }) };

function solanaFac() {
  return {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_MAINNET, extra: { feePayer: FEE } }], extensions: [], signers: {} } as SupportedResponse; },
    async verify() { throw new Error('not used'); },
    async settle() { throw new Error('not used'); },
  } as unknown as FacilitatorClient;
}
const baseFac = {
  async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: BASE_MAINNET }], extensions: [], signers: {} } as SupportedResponse; },
  async verify() { throw new Error('not used'); },
  async settle() { throw new Error('not used'); },
} as unknown as FacilitatorClient;
const evmChain: EvmChainReader = { async authorizationUsed() { return false; } };

async function first402(env: Record<string, string>) {
  clearSupportedCache();
  const usdcAta = await ataOf(PAY_TO, USDC_MAINNET.mint, USDC_MAINNET.tokenProgram);
  const chain: ChainReader = {
    async loadTx() { return null; },
    async recentSignatures() { return []; },
    async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (a === usdcAta ? { owner: USDC_MAINNET.tokenProgram, data: new Uint8Array(165) } : null)) }; },
  };
  // Same shape as index.ts paidRoute(): `...(base ? { base } : {})`; in the test the Base facilitator and chain are fakes.
  const base = baseOption(env);
  const h = paidRouteHandler(route, () => ({
    payTo: PAY_TO, chain, facilitators: [{ name: 'payai', assets: ['USDC'], client: solanaFac() }], gate: { confirmDelaysMs: [] },
    ...(base ? { base: { ...base, facilitators: [{ name: base.facilitators[0].name, client: baseFac }], chain: evmChain } } : {}),
  }));
  const r = (await h(new Request('https://seller.example/x402/job', { method: 'POST', body: '' })))!;
  const body = await r.text();
  return inspect402({ status: r.status, header: (n) => r.headers.get(n), body }, 'https://seller.example/x402/job');
}

const fixes = (list: { level: string; code: string }[]) => list.filter((x) => x.level === 'fix').map((x) => x.code);

describe('seller template 402 vs pay-server check', () => {
  it('Solana only: nothing to fix, and the Solana USDC price is read', async () => {
    const list = await first402({});
    expect(fixes(list)).toEqual([]);
    expect(list.some((x) => x.code === 'price' && x.message.includes('Solana mainnet'))).toBe(true);
  });
  it('with Base: nothing to fix, both prices read, no Permit2 note', async () => {
    const list = await first402(ON);
    expect(fixes(list)).toEqual([]);
    const prices = list.filter((x) => x.code === 'price').map((x) => x.message);
    expect(prices.some((m) => m.includes('Solana mainnet'))).toBe(true);
    expect(prices.some((m) => m.includes('Base,'))).toBe(true);
    expect(list.some((x) => x.code === 'permit2')).toBe(false);
  });
});
