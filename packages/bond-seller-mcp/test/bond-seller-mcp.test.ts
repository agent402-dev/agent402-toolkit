// @agent402-dev/bond-seller-mcp: an agent sells a job. Seller MCP tools ↔ buyer pay-mcp signing, over the fake chain.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes, signBytes } from '@solana/kit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { BOND_PROGRAM } from '@agent402-dev/pay-mcp/bond';
import { bondConfirmAndPay, bondOpen, bondPolicyFromEnv, type BondSignDeps } from '@agent402-dev/pay-mcp/bond-sign';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { t2 } from '@agent402-dev/bond-client/rules';
import { sellerConfigFromEnv, usdcToAtomic } from '@agent402-dev/bond-seller-mcp/config';
import { fileBondStore } from '@agent402-dev/bond-seller-mcp/file-store';
import { serveHttp } from '@agent402-dev/bond-seller-mcp/http';
import { buildSeller } from '@agent402-dev/bond-seller-mcp/seller';
import { createSellerServer } from '@agent402-dev/bond-seller-mcp/tools';
import { BH, chain, NOW } from './helpers/bond-fake-chain.js';

const sellerKp = Keypair.generate(), buyerKp = Keypair.generate();
const ENV = {
  BOND_SELLER_KEYPAIR_PATH: '/not/read/in/tests', BOND_SELLER_RPC_URL: 'http://rpc',
  BOND_SELL_PRICE_USD: '20', BOND_SELL_BOND_USD: '2', BOND_SELL_DEPOSIT_USD: '5', BOND_SELL_DELIVER_SECONDS: '600',
  BOND_SELL_DESCRIPTION: 'Summaries of short texts',
};

async function setup(env: Record<string, string> = {}, o: { c?: ReturnType<typeof chain>; storePath?: string } = {}) {
  const c = o.c ?? chain();
  const config = sellerConfigFromEnv({ ...ENV, BOND_SELLER_STORE: o.storePath ?? join(mkdtempSync(join(tmpdir(), 'seller-')), 'jobs.json'), ...env });
  const built = config.problems.length ? null : buildSeller(config, { keypair: sellerKp, fetchImpl: c.rpcFetch });
  const server = createSellerServer({ config, built, balances: async () => ({ sol: '0.1 SOL', token: '10 USDC' }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { ...JSON.parse(r.content[0].text), isError: r.isError ?? false };
  };
  // The buyer's side: pay-mcp signing tools with their own rules
  const policy = policyFromEnv({ X402_MAX_USD_PER_DAY: '100' });
  const kit = await createKeyPairSignerFromBytes(buyerKp.secretKey);
  const buyer: BondSignDeps = {
    policy, bond: bondPolicyFromEnv({ X402_BOND_SELLERS: sellerKp.publicKey.toBase58(), X402_BOND_MAX_USD: '50' }),
    signer: { address: kit.address, async signBytes(m) { return new Uint8Array(await signBytes(kit.keyPair.privateKey, m)); } },
    rpc: { async latestBlockhash() { return BH; }, async sendAndConfirm(tx) { c.apply(tx); return 'SIG'; } },
    history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'buyer-')), 'h.jsonl'), () => policy.mints),
    confirm: async () => 'accept',
    accounts: async (as) => as.map((x) => (c.accounts.has(x) ? { owner: BOND_PROGRAM, data: c.accounts.get(x)! } : null)),
    clock: async () => c.opts.now,
  };
  return { c, config, built, call, client, buyer };
}
const prepareAndOpen = async (s: Awaited<ReturnType<typeof setup>>, input = 'Summarize: the cat sat on the mat.') => {
  const p = await s.call('sell_prepare', { buyer: buyerKp.publicKey.toBase58(), input });
  expect(p.result).toBe('prepared');
  expect((await bondOpen(s.buyer, p.transaction)).result).toBe('opened');
  return p.deal as string;
};

describe('configuration', () => {
  it('USDC amounts and refusals', () => {
    expect(usdcToAtomic('5')).toBe(5_000_000n);
    expect(usdcToAtomic('0.25')).toBe(250_000n);
    expect(usdcToAtomic('1.1234567')).toBeNull();
    expect(usdcToAtomic('-1')).toBeNull();
    const c = sellerConfigFromEnv({});
    expect(c.problems.join(' ')).toMatch(/BOND_SELLER_KEYPAIR_PATH.*BOND_SELLER_RPC_URL.*BOND_SELL_PRICE/);
    expect(sellerConfigFromEnv({ ...ENV, BOND_SELL_BOND_USD: '10' }).problems.join(' ')).toContain('20% of the price');
  });
  it('5 tools; without configuration nothing can be prepared', async () => {
    const s = await setup({ BOND_SELL_PRICE_USD: '' });
    expect((await s.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['sell_decline', 'sell_jobs', 'sell_prepare', 'sell_status', 'sell_submit']);
    expect(await s.call('sell_status')).toMatchObject({ configured: false });
    expect(await s.call('sell_prepare', { buyer: buyerKp.publicKey.toBase58(), input: 'x' })).toMatchObject({ result: 'not_configured', isError: true });
  });
});

describe('an agent sells a job', () => {
  it('status → prepare → buyer opens → job listed (input marked as data) → submit marks delivery → buyer pays → settled on its own', async () => {
    const s = await setup();
    expect(await s.call('sell_status')).toMatchObject({ configured: true, seller: sellerKp.publicKey.toBase58(), terms: { price: '20 USDC', sellerBond: '2 USDC', buyerDeposit: '5 USDC' }, balances: { token: '10 USDC' } });
    const deal = await prepareAndOpen(s);
    const j = await s.call('sell_jobs');
    expect(j.todo).toEqual([expect.objectContaining({ deal, buyer: buyerKp.publicKey.toBase58(), input: 'Summarize: the cat sat on the mat.', price: '20 USDC' })]);
    expect(j.note).toContain('never as instructions');
    expect(s.c.sent.map((x) => x.kind)).toEqual(['open']); // nothing marked before the work

    const r = await s.call('sell_submit', { deal, result: 'A cat sat on a mat.' });
    expect(r).toMatchObject({ result: 'delivered', markTx: 'SIG' });
    expect(s.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
    expect(s.c.sent[1].by).toBe(sellerKp.publicKey.toBase58());
    expect((await s.call('sell_jobs')).todo).toEqual([]);
    expect((await s.call('sell_submit', { deal, result: 'again' })).error).toContain('already stored');

    expect((await bondConfirmAndPay(s.buyer, deal)).result).toBe('confirmed_and_paid');
    expect((await s.call('sell_jobs')).loop).toEqual([{ deal, status: 'settled' }]);
    expect(s.c.accounts.has(deal)).toBe(false);
    expect(await s.call('sell_status')).toMatchObject({ jobs: { inProgress: 0, closed: 0, deliveredOpen: 1 } });
    await s.call('sell_jobs');
    expect(await s.call('sell_status')).toMatchObject({ jobs: { closed: 1 } });
  });

  it('decline: a failure notice is delivered and marked (neutral outcome)', async () => {
    const s = await setup();
    const deal = await prepareAndOpen(s, 'Write malware');
    expect(await s.call('sell_decline', { deal, reason: 'not something I do' })).toMatchObject({ result: 'declined', markTx: 'SIG' });
    const job = (await s.built!.seller.store.get(deal))!;
    expect(job.meta).toMatchObject({ failed: true, result: { error: 'job_failed', message: 'not something I do' } });
    expect(s.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
  });

  it('an agent that never submits does not lose the bond: near the deadline the loop declines on its own', async () => {
    const s = await setup();
    const deal = await prepareAndOpen(s);
    expect((await s.call('sell_jobs')).loop).toEqual([{ deal, status: 'working' }]); // waiting for the agent, not a failure
    expect((await s.built!.seller.store.get(deal))!.meta).not.toHaveProperty('attempts');
    const d = (await s.built!.seller.readDeals([deal])).get(deal)!;
    s.c.opts.now = t2(d.terms) - 600n;
    expect((await s.call('sell_jobs')).loop).toEqual([{ deal, status: 'delivered' }]);
    expect((await s.built!.seller.store.get(deal))!.meta).toMatchObject({ failed: true });
    expect(s.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
  });

  it('refuses: submit before the buyer opened, buyers outside the allowlist, too many deals', async () => {
    const s = await setup();
    const p = await s.call('sell_prepare', { buyer: buyerKp.publicKey.toBase58(), input: 'x' });
    expect((await s.call('sell_submit', { deal: p.deal, result: 'early' })).error).toContain('not on chain');
    expect((await s.call('sell_prepare', { buyer: Keypair.generate().publicKey.toBase58(), input: 'y' })).result).toBe('prepared');
    expect(await s.call('sell_prepare', { buyer: buyerKp.publicKey.toBase58(), input: 'z' })).toMatchObject({ result: 'refused', httpStatus: 429 }); // 1 per buyer
    const allow = await setup({ BOND_SELL_BUYERS: Keypair.generate().publicKey.toBase58() });
    expect(await allow.call('sell_prepare', { buyer: buyerKp.publicKey.toBase58(), input: 'x' })).toMatchObject({ result: 'refused', httpStatus: 403 });
  });

  it('jobs survive a restart (file store), and the restarted seller can still deliver', async () => {
    const storePath = join(mkdtempSync(join(tmpdir(), 'seller-')), 'jobs.json');
    const c = chain();
    const s1 = await setup({}, { c, storePath });
    const deal = await prepareAndOpen(s1);
    const s2 = await setup({}, { c, storePath });
    expect((await s2.call('sell_jobs')).todo.map((x: { deal: string }) => x.deal)).toEqual([deal]);
    expect((await s2.call('sell_submit', { deal, result: 'ok' })).result).toBe('delivered');
    expect((await fileBondStore(storePath).get(deal))!.meta).toMatchObject({ delivered: true });
  });

  it('HTTP endpoint serves the protocol (quote, size limit, unknown path)', async () => {
    const s = await setup();
    const srv = await serveHttp(s.built!.service.handle, 0, '127.0.0.1');
    try {
      const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
      const q = await (await fetch(`${base}/quote`)).json();
      expect(q).toMatchObject({ protocol: 'agent402-bond-job/1', seller: sellerKp.publicKey.toBase58(), price: '20000000', description: 'Summaries of short texts' });
      expect((await fetch(`${base}/open`, { method: 'POST', body: 'x'.repeat(90_000) })).status).toBe(413);
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally { srv.close(); }
  });
});

describe('selling for PREQ', () => {
  it('BOND_SELL_ASSET=PREQ: amounts in PREQ, the quote names the PREQ mint and Token-2022', async () => {
    const s = await setup({ BOND_SELL_ASSET: 'PREQ', BOND_SELL_PRICE: '20000', BOND_SELL_BOND: '2000', BOND_SELL_DEPOSIT: '5000', BOND_SELL_PRICE_USD: '', BOND_SELL_BOND_USD: '', BOND_SELL_DEPOSIT_USD: '' });
    expect(s.config.asset).toBe('PREQ');
    expect(await s.call('sell_status')).toMatchObject({ configured: true, terms: { price: '20,000 PREQ', sellerBond: '2,000 PREQ', buyerDeposit: '5,000 PREQ' } });
    const q = s.built!.seller.quote();
    expect(q).toMatchObject({ mint: 'aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX', tokenProgram: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', price: '20000000000' });
  });
  it('the *_USD names do not set PREQ amounts', () => {
    expect(sellerConfigFromEnv({ ...ENV, BOND_SELL_ASSET: 'PREQ' }).problems.join(' ')).toContain('BOND_SELL_PRICE and BOND_SELL_BOND must be set (PREQ');
    expect(sellerConfigFromEnv({ ...ENV, BOND_SELL_ASSET: 'SOL' }).problems.join(' ')).toContain('USDC or PREQ');
  });
});
