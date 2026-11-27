// pay-server optional extensions.bond (B1): off = 402 byte-for-byte unchanged, on = a checked claim next to bazaar, payment terms unchanged
import { describe, expect, it } from 'vitest';
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { FacilitatorClient } from '@x402/core/server';
import type { SupportedResponse } from '@x402/core/types';
import { Keypair } from '@solana/web3.js';
import { createPaymentGate, SOLANA_DEVNET, type GateConfig } from '@agent402-dev/pay-server';
import { clearSupportedCache } from '@agent402-dev/pay-server/x402';
import { ataOf, SPL_TOKEN, type ChainReader } from '@agent402-dev/pay-server/chain';
import { bazaarDeclaration, type DiscoveryConfig } from '@agent402-dev/pay-server/discovery';
import { bondExtension, BOND_V2_PROGRAM_MAINNET, type BondExtensionConfig } from '@agent402-dev/pay-server/bond-ext';

const PAY_TO = Keypair.generate().publicKey.toBase58();
const FEE = Keypair.generate().publicKey.toBase58();
const USDC = { symbol: 'USDC' as const, mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', decimals: 6, tokenProgram: SPL_TOKEN };
const URL_ = 'https://api.example/x402/job';
const DESC = 'Counts the words and characters in a text. Input: plain text in the POST body. Output: JSON with words and characters.';

const wordCount = (): DiscoveryConfig => ({
  bazaar: bazaarDeclaration({
    method: 'POST', bodyType: 'text', example: 'hello world', inputSchema: { type: 'string', minLength: 1 },
    outputExample: { words: 2, characters: 11 },
    outputSchema: { type: 'object', properties: { words: { type: 'integer' }, characters: { type: 'integer' } }, required: ['words', 'characters'] },
  }),
  iconUrl: 'https://api.example/icon.png',
});

async function first402(extra: Partial<GateConfig> = {}) {
  clearSupportedCache();
  const usdcAta = await ataOf(PAY_TO, USDC.mint, SPL_TOKEN);
  const client = {
    async getSupported() { return { kinds: [{ x402Version: 2, scheme: 'exact', network: SOLANA_DEVNET, extra: { feePayer: FEE } }], extensions: [], signers: {} } as SupportedResponse; },
    async verify() { throw new Error('not used'); },
    async settle() { throw new Error('not used'); },
  } as unknown as FacilitatorClient;
  const chain: ChainReader = {
    async loadTx() { return null; },
    async recentSignatures() { return []; },
    async accounts(addrs) { return { slot: 1, accounts: addrs.map((a) => (a === usdcAta ? { owner: SPL_TOKEN, data: new Uint8Array(165) } : null)) }; },
  };
  const gate = createPaymentGate({
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.05, usdc: USDC,
    facilitators: [{ name: 'payai', assets: ['USDC'], client }], chain, confirmDelaysMs: [],
    resource: { description: DESC }, ...extra,
  });
  const r = await gate.withPayment(async () => new Response('{}'))(new Request(URL_));
  expect(r.status).toBe(402);
  return { text: await r.clone().text(), body: await r.json(), header: decodePaymentRequiredHeader(r.headers.get('payment-required')!) as unknown as Record<string, any> };
}

const BOND: BondExtensionConfig = {
  seller: Keypair.generate().publicKey.toBase58(), bondAccount: Keypair.generate().publicKey.toBase58(),
  asset: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', maxCover: '10000',
};

describe('extensions.bond in the 402 (optional, B1)', () => {
  it('unset: same bytes as before (with and without discovery)', async () => {
    const a = await first402(), b = await first402({ bond: undefined });
    expect(b.text).toBe(a.text);
    expect(a.header.extensions).toBeUndefined();
    const d = wordCount();
    const c = await first402({ discovery: d }), e = await first402({ discovery: d, bond: undefined });
    expect(e.text).toBe(c.text);
    expect(c.header.extensions).toEqual({ bazaar: d.bazaar });
  });

  it('set: extensions.bond in body and PAYMENT-REQUIRED, next to bazaar; accepts unchanged', async () => {
    const off = await first402();
    const on = await first402({ bond: BOND });
    expect(on.header.extensions).toEqual({ bond: bondExtension(BOND) });
    expect(on.body.extensions).toEqual(on.header.extensions);
    expect(on.body.accepts).toEqual(off.body.accepts);
    const d = wordCount();
    const both = await first402({ discovery: d, bond: BOND });
    expect(Object.keys(both.header.extensions)).toEqual(['bazaar', 'bond']);
    const x = bondExtension(BOND);
    expect(x).toMatchObject({ version: 1, scheme: 'agent402-bond-v2', program: BOND_V2_PROGRAM_MAINNET, autoPayout: ['deadline_missed'], maxCover: '10000', asset: { symbol: 'USDC' } });
    expect(x.machineChecks).toEqual(['deadline_missed', 'not_delivered', 'receipt_mismatch', 'schema_mismatch']);
    expect(JSON.stringify(x)).not.toMatch(/\b(safe|risky|rug|scam|guarantee)/i);
  });

  it('a bad config refuses to start (no wrong claim ships)', () => {
    for (const bad of [{ seller: 'x' }, { bondAccount: '' }, { mint: '0OIl' }, { maxCover: '0' }, { maxCover: '1.5' }, { maxCover: '-1' }, { asset: 'USDT' }, { termsUrl: 'http://a' }, { program: 'nope' }]) {
      expect(() => bondExtension({ ...BOND, ...bad } as BondExtensionConfig), JSON.stringify(bad)).toThrow(/bond extension/);
    }
    expect(() => createPaymentGateWith({ ...BOND, maxCover: '0' })).toThrow(/bond extension/);
  });
});

function createPaymentGateWith(bond: BondExtensionConfig) {
  return createPaymentGate({
    network: SOLANA_DEVNET, payTo: PAY_TO, priceUsd: 0.05, usdc: USDC,
    facilitators: [{ name: 'payai', assets: ['USDC'], client: {} as FacilitatorClient }], chain: {} as ChainReader, confirmDelaysMs: [],
    resource: { description: DESC }, bond,
  });
}
