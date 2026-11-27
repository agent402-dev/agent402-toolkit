import { describe, it, expect } from 'vitest';
import { parseBondClaim, verifyBondClaim, bondPreferPolicy, unbondedNeedsConfirm, SOLANA_MAINNET_CAIP2, BOND_READ_COMMITMENT } from '@agent402-dev/pay-mcp/bond-402';
import { bondExtension } from '@agent402-dev/pay-server/bond-ext';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROGRAM = 'Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev';
const SELLER = '3re9JiNpYbXqhRN4bE6R3F8wWnZiYHjZ1rmQWb8WTGYH';
const ACCT = 'GanWohB7ZyF9UES1rWRr9VS7yrHQCRNb2kWoGdq8uf8R';
const ext = () => ({ bond: bondExtension({ seller: SELLER, bondAccount: ACCT, asset: 'USDC', mint: USDC, maxCover: '5000000' }) });
const rpc = (value: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { value } }))) as unknown as typeof fetch;
const acct = (o: Partial<{ mint: string; owner: string; amount: string; prog: string; state: string }> = {}) => ({
  owner: o.prog ?? 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  data: { parsed: { info: { mint: o.mint ?? USDC, owner: o.owner ?? SELLER, state: o.state ?? 'initialized', tokenAmount: { amount: o.amount ?? '7000000' } } } },
});
const deps = (f: typeof fetch) => ({ fetch: f, rpcUrl: 'https://rpc.example', v2Program: PROGRAM, usdcMint: USDC });

describe('pay-mcp: 402 extensions.bond check (B1-b)', () => {
  it('reads what pay-server writes; absent = null; malformed = invalid', () => {
    const r = parseBondClaim(ext());
    expect(r && 'claim' in r && r.claim.maxCover).toBe(5000000n);
    expect(r && 'claim' in r && r.claim.network).toBe(SOLANA_MAINNET_CAIP2);
    expect(parseBondClaim(undefined)).toBeNull();
    expect(parseBondClaim({ bazaar: {} })).toBeNull();
    const bad = parseBondClaim({ bond: { ...ext().bond, maxCover: '-1', network: 'solana:devnet' } });
    expect(bad && 'invalid' in bad && bad.invalid.length).toBe(2);
  });

  it('verifies only when the account matches mint, seller and balance on chain', async () => {
    const c = (parseBondClaim(ext()) as { claim: any }).claim;
    const ok = await verifyBondClaim(deps(rpc(acct())), c);
    expect(ok).toEqual({ verified: true, reasons: [], balance: '7000000', coverUsd: 5, reservedForThisPayment: false });
    for (const [a, why] of [
      [acct({ amount: '4999999' }), 'below the claimed maxCover'],
      [acct({ mint: ACCT }), 'different mint'],
      [acct({ owner: ACCT }), 'claimed seller'],
      [acct({ prog: PROGRAM }), 'not a token account'],
      [acct({ state: 'frozen' }), 'frozen'],
    ] as const) {
      const r = await verifyBondClaim(deps(rpc(a)), c);
      expect(r.verified).toBe(false);
      expect(r.coverUsd).toBeNull();
      expect(r.reasons.join(' ')).toContain(why);
    }
    expect((await verifyBondClaim(deps(rpc(null)), c)).reasons).toContain('bond account does not exist');
    const wrongProgram = await verifyBondClaim({ ...deps(rpc(acct())), v2Program: SELLER }, c);
    expect(wrongProgram.verified).toBe(false);
    const broken = await verifyBondClaim(deps((async () => { throw new Error('down'); }) as unknown as typeof fetch), c);
    expect(broken.verified).toBe(false);
  });

  it('a passing check is a read, not a reservation: two concurrent quotes both pass on one balance, neither is reserved', async () => {
    const c = (parseBondClaim(ext()) as { claim: any }).claim;
    const [a, b] = await Promise.all([verifyBondClaim(deps(rpc(acct())), c), verifyBondClaim(deps(rpc(acct())), c)]);
    expect(a.verified && b.verified).toBe(true);
    expect([a.reservedForThisPayment, b.reservedForThisPayment]).toEqual([false, false]);
    expect((await verifyBondClaim(deps(rpc(null)), c)).reservedForThisPayment).toBe(false);
  });

  it('the check names the moment it describes: readAtSlot = the RPC context.slot, omitted when absent or malformed', async () => {
    const c = (parseBondClaim(ext()) as { claim: any }).claim;
    const at = (value: unknown, slot: unknown) => (async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value } }))) as unknown as typeof fetch;
    const ok = await verifyBondClaim(deps(at(acct(), 412345678)), c);
    expect(ok).toEqual({ verified: true, reasons: [], balance: '7000000', coverUsd: 5, readAtSlot: 412345678, readCommitment: 'confirmed', reservedForThisPayment: false });
    expect((await verifyBondClaim(deps(at(null, 7)), c)).readAtSlot).toBe(7);
    expect((await verifyBondClaim(deps(at(acct({ amount: '1' }), 9)), c))).toMatchObject({ verified: false, readAtSlot: 9 });
    for (const bad of [undefined, -1, 1.5, '123', null]) expect('readAtSlot' in (await verifyBondClaim(deps(at(acct(), bad)), c))).toBe(false);
    expect('readAtSlot' in (await verifyBondClaim(deps(rpc(acct())), c))).toBe(false);
  });

  it('the slot comes with the commitment it was read at, and only with it', async () => {
    const c = (parseBondClaim(ext()) as { claim: any }).claim;
    let sent: any;
    const at = (slot: unknown) => (async (_u: unknown, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot }, value: acct() } })); }) as unknown as typeof fetch;
    const r = await verifyBondClaim(deps(at(5)), c);
    expect(sent.params[1].commitment).toBe(BOND_READ_COMMITMENT);
    expect(r).toMatchObject({ readAtSlot: 5, readCommitment: 'confirmed' });
    for (const bad of [undefined, -1, 'x']) {
      const b = await verifyBondClaim(deps(at(bad)), c);
      expect('readCommitment' in b).toBe(false);
    }
    expect('readCommitment' in (await verifyBondClaim(deps(rpc(acct())), c))).toBe(false);
  });

  it('a non-USDC bond is never given a USD value', async () => {
    const PREQ = 'aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX';
    const c = (parseBondClaim({ bond: bondExtension({ seller: SELLER, bondAccount: ACCT, asset: 'PREQ', mint: PREQ, maxCover: '5000000' }) }) as { claim: any }).claim;
    const r = await verifyBondClaim(deps(rpc(acct({ mint: PREQ, prog: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' }))), c);
    expect(r.verified).toBe(true);
    expect(r.coverUsd).toBeNull();
  });

  it('policy is off by default and can only add a confirmation', () => {
    expect(bondPreferPolicy({})).toEqual({ prefer: false, unbondedConfirmAboveUsd: null });
    expect(bondPreferPolicy({ X402_BOND_PREFER: 'true' }).prefer).toBe(false);
    const p = bondPreferPolicy({ X402_BOND_PREFER: 'on', X402_UNBONDED_CONFIRM_ABOVE_USD: '0.5' });
    expect(p).toEqual({ prefer: true, unbondedConfirmAboveUsd: 0.5 });
    expect(bondPreferPolicy({ X402_BOND_PREFER: 'on' }).unbondedConfirmAboveUsd).toBe(0.05);
    const verified = { verified: true, reasons: [], coverUsd: 5, reservedForThisPayment: false as const };
    const unverified = { verified: false, reasons: ['x'], coverUsd: null, reservedForThisPayment: false as const };
    expect(unbondedNeedsConfirm(bondPreferPolicy({}), 100, null)).toBe(false);
    expect(unbondedNeedsConfirm(p, 0.49, null)).toBe(false);
    expect(unbondedNeedsConfirm(p, 0.5, null)).toBe(true);
    expect(unbondedNeedsConfirm(p, 0.5, unverified)).toBe(true);
    expect(unbondedNeedsConfirm(p, null, null)).toBe(true);
    expect(unbondedNeedsConfirm(p, 100, verified)).toBe(false);
  });
});

// ---- wired into the agent (quote path; no signing) ----
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { encodePaymentRequiredHeader } from '@x402/core/http';
import { createAgent } from '@agent402-dev/pay-mcp/agent';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { NETWORKS, policyFromEnv } from '@agent402-dev/pay-mcp/policy';

const DUSDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const PAYTO = Keypair.generate().publicKey.toBase58();
const HOST = 'api.good.test';
const prWith = (bondSeller: string | null) => ({
  x402Version: 2, resource: { url: `https://${HOST}/paid` },
  accepts: [{ scheme: 'exact', network: NETWORKS.devnet, asset: DUSDC, amount: '20000', payTo: PAYTO, maxTimeoutSeconds: 60, extra: { feePayer: 'FEE' } }],
  ...(bondSeller ? { extensions: { bond: bondExtension({ seller: bondSeller, bondAccount: ACCT, asset: 'USDC', mint: DUSDC, maxCover: '5000000' }) } } : {}),
});
function agentWith(pr: unknown, env: Record<string, string>, rpcValue: unknown) {
  const policy = policyFromEnv({ X402_NETWORK: 'devnet', X402_ALLOWED_DOMAINS: HOST, X402_TRUSTED_PAY_TO: PAYTO });
  const history = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'paymcp-bond402-')), 'h.jsonl'), () => policy.mints);
  let signed = 0;
  const wallet = { address: 'BUYER', network: NETWORKS.devnet, get signedCount() { return signed; }, async sign() { signed++; return 'X'; }, async balances() { return {}; }, async signBytes(): Promise<Uint8Array> { throw new Error('unused'); } };
  const f = (async () => new Response('{}', { status: 402, headers: { 'payment-required': encodePaymentRequiredHeader(pr as never) } })) as typeof fetch;
  const prefer = bondPreferPolicy(env);
  return createAgent({ policy, wallet, history, fetch: f, confirm: async () => 'accept', now: () => new Date('2026-11-27T12:00:00Z'),
    bond402: { prefer, check: { fetch: rpc(rpcValue), rpcUrl: 'https://rpc.example', v2Program: PROGRAM, usdcMint: DUSDC } } });
}
const ON = { X402_BOND_PREFER: 'on', X402_UNBONDED_CONFIRM_ABOVE_USD: '0.01' };

describe('pay-mcp agent: X402_BOND_PREFER', () => {
  it('off (default): same quote as without the extension, no bond field, no RPC read', async () => {
    const a = await agentWith(prWith(PAYTO), {}, acct({ mint: DUSDC, owner: PAYTO })).quote({ url: `https://${HOST}/paid` });
    const b = await agentWith(prWith(null), {}, null).quote({ url: `https://${HOST}/paid` });
    expect(a.bond).toBeUndefined();
    expect(a.reasons).toEqual(b.reasons);
    expect(a.payment).toEqual(b.payment);
  });
  it('on: a verified bond of the receiver adds nothing; unbonded, unverified or someone else\'s bond asks first', async () => {
    const ok = await agentWith(prWith(PAYTO), ON, acct({ mint: DUSDC, owner: PAYTO })).quote({ url: `https://${HOST}/paid` });
    expect(ok.bond?.verified).toBe(true);
    expect(ok.reasons).toEqual([]);
    const none = await agentWith(prWith(null), ON, null).quote({ url: `https://${HOST}/paid` });
    expect(none.reasons).toEqual(['will_ask_for_confirmation']);
    const low = await agentWith(prWith(PAYTO), ON, acct({ mint: DUSDC, owner: PAYTO, amount: '1' })).quote({ url: `https://${HOST}/paid` });
    expect(low.bond?.verified).toBe(false);
    expect(low.reasons).toEqual(['will_ask_for_confirmation']);
    const other = Keypair.generate().publicKey.toBase58();
    const borrowed = await agentWith(prWith(other), ON, acct({ mint: DUSDC, owner: other })).quote({ url: `https://${HOST}/paid` });
    expect(borrowed.bond?.verified).toBe(false);
    expect(borrowed.bond?.reasons).toContain('bond seller is not the payment receiver');
    expect(borrowed.reasons).toEqual(['will_ask_for_confirmation']);
  });
});
