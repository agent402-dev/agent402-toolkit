// @agent402-dev/pay-mcp bond_deal_status (read-only): decoding matches bond-client, status per program rules, MCP tool wiring.
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decodeDeal } from '@agent402-dev/bond-client';
import { BOND_PROGRAM, bondDealStatus, decodeDealAccount, DEAL_DISCRIMINATOR, rpcClock } from '@agent402-dev/pay-mcp/bond';
import { createPayServer } from '@agent402-dev/pay-mcp/tools';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import type { AccountData } from '@agent402-dev/pay-mcp/locks';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DAY = 86_400n;
const NOW = 1_800_000_000n;
const U = 1_000_000n;

interface Fields {
  seller: PublicKey; buyer: PublicKey; mint: PublicKey; nonce: bigint;
  price: bigint; sellerBond: bigint; buyerDeposit: bigint; deliverBy: bigint; lateWindow: bigint; payWindow: bigint;
  openedAt: bigint; mark: bigint; confirm: bigint; balancePaid: boolean; outcome: number; owedSeller: bigint;
}
/** Deal account bytes in the program's Anchor layout. */
function dealBytes(f: Fields): Uint8Array {
  const b = new Uint8Array(8 + 96 + 32 + 48 + 4 + 8);
  const v = new DataView(b.buffer);
  b.set(DEAL_DISCRIMINATOR, 0);
  let o = 8;
  for (const k of [f.seller, f.buyer, f.mint]) { b.set(k.toBytes(), o); o += 32; }
  for (const x of [f.nonce, f.price, f.sellerBond, f.buyerDeposit]) { v.setBigUint64(o, x, true); o += 8; }
  for (const x of [f.deliverBy, f.lateWindow, f.payWindow, f.openedAt, f.mark, f.confirm]) { v.setBigInt64(o, x, true); o += 8; }
  b[o++] = f.balancePaid ? 1 : 0;
  b[o++] = 254; b[o++] = 253; // bumps
  b[o++] = f.outcome;
  v.setBigUint64(o, f.owedSeller, true);
  return b;
}
const seller = Keypair.generate().publicKey, buyer = Keypair.generate().publicKey;
const base: Fields = {
  seller, buyer, mint: new PublicKey(USDC), nonce: 7n,
  price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverBy: NOW + 10n * DAY, lateWindow: 2n * DAY, payWindow: 3n * DAY,
  openedAt: NOW, mark: 0n, confirm: 0n, balancePaid: false, outcome: 0, owedSeller: 0n,
};
const DEAL = Keypair.generate().publicKey.toBase58();
const fake = (acc: AccountData | null) => async () => [acc];
const at = (t: bigint) => async () => t;

describe('decodeDealAccount', () => {
  it('matches bond-client decodeDeal on the same bytes', () => {
    const bytes = dealBytes({ ...base, mark: NOW + DAY, confirm: NOW + 2n * DAY, balancePaid: true, outcome: 1, owedSeller: 7n * U });
    const a = decodeDealAccount(bytes)!;
    const b = decodeDeal(bytes);
    expect(a.seller).toBe(b.seller.toBase58());
    expect(a.buyer).toBe(b.buyer.toBase58());
    expect(a.mint).toBe(b.mint.toBase58());
    expect(a.nonce).toBe(b.nonce);
    expect(a.terms).toEqual(b.terms);
    expect([a.openedAt, a.sellerMark, a.buyerConfirm, a.balancePaid]).toEqual([b.openedAt, b.sellerMark, b.buyerConfirm, b.balancePaid]);
    expect(a.outcome).toBe(b.outcome);
    expect(a.owedSeller).toBe(b.owedSeller);
  });
  it('refuses bytes that are not a Deal', () => {
    const bytes = dealBytes(base);
    bytes[0] ^= 1;
    expect(decodeDealAccount(bytes)).toBeNull();
    expect(decodeDealAccount(new Uint8Array(10))).toBeNull();
  });
});

describe('bondDealStatus', () => {
  it('fresh deal: deadlines, actions, not settleable yet', async () => {
    const r = await bondDealStatus({ accounts: fake({ owner: BOND_PROGRAM, data: dealBytes(base) }), clock: at(NOW + DAY), wallet: buyer.toBase58() }, DEAL);
    expect(r.result).toBe('open');
    if (r.result !== 'open') return;
    expect(r.yourRole).toBe('buyer');
    expect(r.price.display).toBe('20 USDC');
    expect(r.balanceToPay.display).toBe('15 USDC');
    expect(r.possibleActions.map((a) => a.action)).toEqual(['mark_delivered', 'confirm_receipt', 'cancel', 'extend']);
    expect(r.settlement.now).toBe(false);
    // Nothing marked: settlement opens after T2 = deliverBy + 1 day grace + late window
    const t2 = base.deliverBy + DAY + base.lateWindow;
    expect(r.settlement).toMatchObject({ earliest: new Date(Number(t2 + 1n) * 1000).toISOString() });
  });
  it('confirmed and paid: settles now as delivered, seller gets bond and deposit', async () => {
    const bytes = dealBytes({ ...base, mark: NOW + DAY, confirm: NOW + DAY, balancePaid: true });
    const r = await bondDealStatus({ accounts: fake({ owner: BOND_PROGRAM, data: bytes }), clock: at(NOW + DAY) }, DEAL);
    expect(r.result).toBe('open');
    if (r.result !== 'open') return;
    expect(r.settlement).toMatchObject({ now: true, outcome: 'delivered', toSeller: { display: '7 USDC' }, toBuyer: { atomic: '0' } });
    expect(r.possibleActions.some((a) => a.action === 'settle_and_claim')).toBe(true);
  });
  it('seller never marked: after T2 the buyer gets bond and deposit', async () => {
    const t2 = base.deliverBy + DAY + base.lateWindow;
    const r = await bondDealStatus({ accounts: fake({ owner: BOND_PROGRAM, data: dealBytes(base) }), clock: at(t2 + 1n) }, DEAL);
    if (r.result !== 'open') throw new Error(r.result);
    expect(r.settlement).toMatchObject({ now: true, outcome: 'seller_default', toBuyer: { display: '7 USDC' } });
  });
  it('decided deal shows the outcome and what the seller may claim', async () => {
    const bytes = dealBytes({ ...base, outcome: 3, owedSeller: 2n * U });
    const r = await bondDealStatus({ accounts: fake({ owner: BOND_PROGRAM, data: bytes }), clock: at(NOW) }, DEAL);
    expect(r).toMatchObject({ result: 'settled', outcome: 'disputed', owedToSeller: { display: '2 USDC' } });
  });
  it('missing account, wrong owner', async () => {
    expect((await bondDealStatus({ accounts: fake(null), clock: at(NOW) }, DEAL)).result).toBe('not_found');
    const other = await bondDealStatus({ accounts: fake({ owner: '11111111111111111111111111111111', data: dealBytes(base) }), clock: at(NOW) }, DEAL);
    expect(other.result).toBe('not_a_deal');
  });
});

describe('MCP tool', () => {
  it('bond_deal_status is listed and answers without a wallet', async () => {
    const policy = policyFromEnv({});
    const history = { append: () => {}, list: () => [], today: () => ({ usd: 0, count: 0, preq: 0n, a402: 0n, perRecipientUsd: {}, perRecipientPreq: {} }) } as never;
    const server = createPayServer({ policy, wallet: null, history, fetch, accounts: fake({ owner: BOND_PROGRAM, data: dealBytes(base) }), clock: at(NOW + DAY) });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('bond_deal_status');
    const res = await client.callTool({ name: 'bond_deal_status', arguments: { deal: DEAL } });
    expect(res.isError).toBeFalsy();
    const body = JSON.parse((res.content as { text: string }[])[0].text);
    expect(body.result).toBe('open');
    expect(body.seller).toBe(seller.toBase58());
  });
});

describe('security review fixes (status display)', () => {
  it('L-1: lateDeductionIfConfirmed is what the bond would lose if the buyer confirmed now (no mark yet, inside the late window)', async () => {
    const t1 = base.deliverBy + DAY;
    const r = await bondDealStatus({ accounts: fake({ owner: BOND_PROGRAM, data: dealBytes(base) }), clock: at(t1 + DAY), wallet: buyer.toBase58() }, DEAL);
    // Half of the 2-day late window used: half of the 2 USDC bond
    expect((r as { lateDeductionIfConfirmed: { atomic: string } }).lateDeductionIfConfirmed.atomic).toBe(String(1n * U));
  });
});

describe('chain clock (the Clock sysvar, as the program sees it)', () => {
  const TS = 1_800_000_123n;
  const clockData = () => { const b = new Uint8Array(40); new DataView(b.buffer).setBigInt64(32, TS, true); return Buffer.from(b).toString('base64'); };
  const fakeRpc = (o: { sysvar: boolean; blockTime: boolean }) => (async (_u: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body);
    const ok = (result: unknown) => Response.json({ jsonrpc: '2.0', id: 1, result });
    if (method === 'getAccountInfo' && params[0] === 'SysvarC1ock11111111111111111111111111111111') return o.sysvar ? ok({ value: { data: [clockData(), 'base64'], owner: 'Sysvar1111111111111111111111111111111111111' } }) : ok({ value: null });
    if (method === 'getSlot') return ok(123);
    if (method === 'getBlockTime') return o.blockTime ? ok(Number(TS - 5n)) : Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32004, message: 'Block not available for slot 123' } });
    return ok(null);
  }) as unknown as typeof fetch;
  it('pay-mcp rpcClock reads the sysvar; getBlockTime is only the fallback', async () => {
    expect(await rpcClock('http://rpc', fakeRpc({ sysvar: true, blockTime: false }))()).toBe(TS);
    expect(await rpcClock('http://rpc', fakeRpc({ sysvar: false, blockTime: true }))()).toBe(TS - 5n);
  });
  it('pay-server seller chainNow reads the sysvar (mainnet getBlockTime on the newest slot often fails)', async () => {
    const { createBondSeller } = await import('@agent402-dev/pay-server/bond');
    const { Keypair } = await import('@solana/web3.js');
    const kp = Keypair.generate();
    const signer = { publicKey: kp.publicKey, async signTransaction(tx: any) { return tx; } };
    const terms = { price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverSeconds: 600n, lateWindow: 0n, payWindow: DAY };
    expect(await createBondSeller({ rpcUrl: 'http://rpc', signer, terms, fetchImpl: fakeRpc({ sysvar: true, blockTime: false }) }).chainNow()).toBe(TS);
    expect(await createBondSeller({ rpcUrl: 'http://rpc', signer, terms, fetchImpl: fakeRpc({ sysvar: false, blockTime: true }) }).chainNow()).toBe(TS - 5n);
  });
});
