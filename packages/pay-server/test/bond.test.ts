// @agent402-dev/pay-server/bond (seller side): terms checks, prepareOpen (seller signs first, the buyer agent accepts it),
// requireOpen, markDelivered (idempotent, deadline), unmarked, settle. Fake RPC; no keys leave the test signer.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { createKeyPairSignerFromBytes, signBytes } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import * as bc from '@agent402-dev/bond-client';
import { checkBondTerms, createBondSeller, type BondSigner } from '@agent402-dev/pay-server/bond';
import { BOND_PROGRAM, DEAL_DISCRIMINATOR } from '@agent402-dev/pay-mcp/bond';
import { bondOpen, bondPolicyFromEnv } from '@agent402-dev/pay-mcp/bond-sign';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';

const U = 1_000_000n;
const DAY = 86_400n;
const NOW = 1_800_000_000n;
const BH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const USDC = bc.MINTS.mainnet.USDC;
const sellerKp = Keypair.generate(), buyerKp = Keypair.generate();
const signer: BondSigner = { publicKey: sellerKp.publicKey, async signTransaction(tx) { tx.partialSign(sellerKp); return tx; } };
const TERMS = { price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverSeconds: 600n, lateWindow: 0n, payWindow: DAY };

function dealBytes(t: bc.Terms, nonce: bigint, o: { mark?: bigint; confirm?: bigint; paid?: boolean; outcome?: number; buyer?: PublicKey } = {}) {
  const b = new Uint8Array(196);
  const v = new DataView(b.buffer);
  b.set(DEAL_DISCRIMINATOR, 0);
  let i = 8;
  for (const k of [sellerKp.publicKey, o.buyer ?? buyerKp.publicKey, USDC]) { b.set(k.toBytes(), i); i += 32; }
  for (const x of [nonce, t.price, t.sellerBond, t.buyerDeposit]) { v.setBigUint64(i, x, true); i += 8; }
  for (const x of [t.deliverBy, t.lateWindow, t.payWindow, NOW, o.mark ?? 0n, o.confirm ?? 0n]) { v.setBigInt64(i, x, true); i += 8; }
  b[i++] = o.paid ? 1 : 0; i += 2; b[i++] = o.outcome ?? 0;
  return b;
}

/** Fake JSON-RPC: clock, blockhash, accounts by address, sendTransaction (recorded), statuses (confirmed). */
function fakeRpc() {
  const s = { now: NOW, accounts: new Map<string, Uint8Array>(), sent: [] as Buffer[] };
  const f = (async (_url: string, init: { body: string }) => {
    const { method, params } = JSON.parse(init.body) as { method: string; params: unknown[] };
    const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    if (method === 'getSlot') return ok(1);
    if (method === 'getBlockTime') return ok(Number(s.now));
    if (method === 'getLatestBlockhash') return ok({ value: { blockhash: BH } });
    if (method === 'getAccountInfo') {
      const a = s.accounts.get(params[0] as string);
      return ok({ value: a ? { owner: BOND_PROGRAM, data: [Buffer.from(a).toString('base64'), 'base64'] } : null });
    }
    if (method === 'sendTransaction') { s.sent.push(Buffer.from(params[0] as string, 'base64')); return ok(`SIG${s.sent.length}`); }
    if (method === 'getSignatureStatuses') return ok({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    return new Response(JSON.stringify({ error: { message: `unexpected ${method}` } }));
  }) as unknown as typeof fetch;
  return { s, f };
}
const mk = () => { const r = fakeRpc(); return { ...r, seller: createBondSeller({ rpcUrl: 'http://rpc', signer, terms: TERMS, fetchImpl: r.f }) }; };

describe('terms', () => {
  it('rejects terms the program would refuse, before anything is signed', () => {
    expect(checkBondTerms(TERMS)).toEqual([]);
    expect(checkBondTerms({ ...TERMS, sellerBond: 5n * U })).toContain('seller bond is at most 20% of the price');
    expect(checkBondTerms({ ...TERMS, payWindow: 10n })).toContain('payWindow must be 1..30 days');
    expect(() => createBondSeller({ rpcUrl: 'x', signer, terms: { ...TERMS, buyerDeposit: 30n * U } })).toThrow('deposit');
  });
});

describe('prepareOpen', () => {
  it('builds open with the seller as fee payer, signed by the seller; deliverBy from the chain clock', async () => {
    const { seller } = mk();
    const p = await seller.prepareOpen(buyerKp.publicKey.toBase58(), { order: 7 });
    const tx = Transaction.from(Buffer.from(p.transaction, 'base64'));
    expect(tx.feePayer?.equals(sellerKp.publicKey)).toBe(true);
    expect(tx.verifySignatures(false)).toBe(true); // seller signed; buyer not yet
    expect(p.terms.deliverBy).toBe(String(NOW + 600n));
    const want = bc.open({ seller: sellerKp.publicKey, buyer: buyerKp.publicKey, mint: USDC, tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), nonce: BigInt(p.nonce) },
      { price: TERMS.price, sellerBond: TERMS.sellerBond, buyerDeposit: TERMS.buyerDeposit, deliverBy: NOW + 600n, lateWindow: 0n, payWindow: DAY });
    expect(tx.instructions[0].data.equals(want.data)).toBe(true);
    expect(tx.instructions[0].keys.map((k) => k.pubkey.toBase58())).toEqual(want.keys.map((k) => k.pubkey.toBase58()));
  });

  it('the buyer agent (pay-mcp bond_open) verifies and signs what the seller SDK built', async () => {
    const { seller, s } = mk();
    const p = await seller.prepareOpen(buyerKp.publicKey.toBase58());
    const kit = await createKeyPairSignerFromBytes(buyerKp.secretKey);
    const policy = policyFromEnv({ X402_MAX_USD_PER_DAY: '100' });
    const sentByBuyer: Uint8Array[] = [];
    const r = await bondOpen({
      policy, bond: bondPolicyFromEnv({ X402_BOND_SELLERS: sellerKp.publicKey.toBase58(), X402_BOND_MAX_USD: '50' }),
      signer: { address: kit.address, async signBytes(m) { return new Uint8Array(await signBytes(kit.keyPair.privateKey, m)); } },
      rpc: { async latestBlockhash() { return BH; }, async sendAndConfirm(tx) { sentByBuyer.push(tx); return 'OPEN'; } },
      history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'bs-')), 'h.jsonl'), () => policy.mints),
      confirm: async () => 'accept', accounts: async () => [null], clock: async () => s.now,
    }, p.transaction);
    expect(r.result).toBe('opened');
    expect(Transaction.from(Buffer.from(sentByBuyer[0])).verifySignatures()).toBe(true); // both signatures valid
  });

  it('refuses a buyer equal to the seller', async () => {
    await expect(mk().seller.prepareOpen(sellerKp.publicKey.toBase58())).rejects.toThrow('differ');
  });
});

describe('after the buyer sends open', () => {
  async function opened(o: Parameters<typeof dealBytes>[2] = {}) {
    const m = mk();
    const p = await m.seller.prepareOpen(buyerKp.publicKey.toBase58());
    m.s.accounts.set(p.deal, dealBytes({ ...TERMS, deliverBy: BigInt(p.terms.deliverBy) } as bc.Terms, BigInt(p.nonce), o));
    return { ...m, p };
  }

  it('requireOpen: not on chain yet, then matches; refuses different terms or another buyer', async () => {
    const m = mk();
    const p = await m.seller.prepareOpen(buyerKp.publicKey.toBase58());
    await expect(m.seller.requireOpen(p.deal)).rejects.toThrow('not on chain yet');
    const t = { ...TERMS, deliverBy: BigInt(p.terms.deliverBy) } as bc.Terms;
    m.s.accounts.set(p.deal, dealBytes({ ...t, buyerDeposit: 1n }, BigInt(p.nonce)));
    await expect(m.seller.requireOpen(p.deal)).rejects.toThrow('does not match');
    m.s.accounts.set(p.deal, dealBytes(t, BigInt(p.nonce), { buyer: Keypair.generate().publicKey }));
    await expect(m.seller.requireOpen(p.deal)).rejects.toThrow('does not match');
    m.s.accounts.set(p.deal, dealBytes(t, BigInt(p.nonce)));
    expect((await m.seller.requireOpen(p.deal)).outcome).toBe('open');
    await expect(m.seller.requireOpen(Keypair.generate().publicKey.toBase58())).rejects.toThrow('unknown deal');
  });

  it('markDelivered sends mark signed by the seller; idempotent once marked; refused after the deadline', async () => {
    const m = await opened();
    expect(await m.seller.unmarked()).toHaveLength(1);
    const r = await m.seller.markDelivered(m.p.deal);
    expect(r.alreadyMarked).toBe(false);
    const tx = Transaction.from(m.s.sent[0]);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions[0].data.equals(Buffer.from(bc.DISC.mark_delivered))).toBe(true);
    expect(await m.seller.unmarked()).toHaveLength(0); // recorded in the store
    m.s.accounts.set(m.p.deal, dealBytes({ ...TERMS, deliverBy: BigInt(m.p.terms.deliverBy) } as bc.Terms, BigInt(m.p.nonce), { mark: NOW + 10n }));
    expect((await m.seller.markDelivered(m.p.deal)).alreadyMarked).toBe(true);
    expect(m.s.sent).toHaveLength(1);

    const late = await opened();
    late.s.now = NOW + 600n + DAY + 1n;
    await expect(late.seller.markDelivered(late.p.deal)).rejects.toThrow('too late');
    expect(late.s.sent).toHaveLength(0);
  });

  it('status and settle', async () => {
    const early = await opened({ mark: NOW + 10n });
    const st = await early.seller.status(early.p.deal);
    expect(st.onChain && st.timeline?.settleNow).toBeNull();
    await expect(early.seller.settle(early.p.deal)).rejects.toThrow('not settleable yet');

    const done = await opened({ mark: NOW + 10n, confirm: NOW + 20n, paid: true });
    const r = await done.seller.settle(done.p.deal);
    expect(r).toMatchObject({ outcome: 'delivered', toSeller: String(7n * U), toBuyer: '0' });
    const tx = Transaction.from(done.s.sent[0]);
    expect(tx.instructions.map((i) => i.data.toString('hex'))).toEqual(bc.settleAndClaim({ seller: sellerKp.publicKey, buyer: buyerKp.publicKey, mint: USDC, tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), nonce: BigInt(done.p.nonce) }).map((i) => i.data.toString('hex')));
  });
});
