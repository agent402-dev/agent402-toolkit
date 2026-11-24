import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import * as j from '../src/job-v2.js';

const key = () => Keypair.generate().publicKey;
const sha = (...parts: (Buffer | Uint8Array)[]) => createHash('sha256').update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();
const le = (v: bigint, signed = false) => { const b = Buffer.alloc(8); signed ? b.writeBigInt64LE(v) : b.writeBigUInt64LE(v); return b; };

const quote = (): j.JobQuoteV2 => ({
  protocol: j.JOB_PROTOCOL_V2, program: key().toBase58(), seller: key().toBase58(), sellerPayout: key().toBase58(), mint: key().toBase58(),
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', price: '1000000', sellerBond: '100000', buyerDeposit: '300000',
  deliverSeconds: '3600', grace: '86400', reviewWindow: '86400', sellerShareBps: 0, arbiter: null, arbiterWindow: '0', description: 'wallet CSV',
});

describe('job protocol v2', () => {
  it('checks quote shape', () => {
    expect(j.checkJobQuoteV2(quote())).toEqual([]);
    const bad = { ...quote(), sellerShareBps: 10_001, arbiter: 'x', price: '1.5' };
    expect(j.checkJobQuoteV2(bad)).toEqual(expect.arrayContaining(['price must be a decimal string', 'sellerShareBps must be an integer 0..10000', 'arbiter must be a base58 address or null']));
  });

  it('terms must equal the quote, deadline bounded', () => {
    const q = quote();
    const t: j.JobTermsV2 = { price: q.price, sellerBond: q.sellerBond, buyerDeposit: q.buyerDeposit, deliverBy: '5000', grace: q.grace, reviewWindow: q.reviewWindow, sellerShareBps: 0, arbiter: null, arbiterWindow: '0' };
    expect(j.termsMatchQuoteV2(t, q, 2_000n)).toEqual([]);
    expect(j.termsMatchQuoteV2({ ...t, sellerShareBps: 100 }, q, 2_000n)).toContain('sellerShareBps differs from the quote');
    expect(j.termsMatchQuoteV2({ ...t, arbiter: key().toBase58() }, q, 2_000n)).toContain('arbiter differs from the quote');
    expect(j.termsMatchQuoteV2(t, q, 1_000n)).toContain('deliverBy is later than the quote allows');
  });

  it('job and output hashes follow the spec byte layout', async () => {
    const [program, seller, buyer, deal] = [key(), key(), key(), key()];
    const h = await j.jobHashV2({ program: program.toBase58(), seller: seller.toBytes(), buyer: buyer.toBase58(), nonce: 7n, deliverBy: 1_800_000_000n, input: '{"wallet":"x"}', description: 'd' });
    const want = sha(Buffer.from('agent402-bond-job/2:job'), Buffer.from([0]), program.toBytes(), seller.toBytes(), buyer.toBytes(), le(7n), le(1_800_000_000n, true), sha(Buffer.from('{"wallet":"x"}')), sha(Buffer.from('d')));
    expect(Buffer.from(h).equals(want)).toBe(true);
    const o = await j.outputHashV2(deal.toBase58(), h, 'job_failed', 'r');
    expect(Buffer.from(o).equals(sha(Buffer.from('agent402-bond-job/2:out'), Buffer.from([0]), deal.toBytes(), h, Buffer.from([1]), sha(Buffer.from('r'))))).toBe(true);
    // no canonicalisation: whitespace changes the hash
    expect(j.toHex(await j.jobHashV2({ program: program.toBase58(), seller: seller.toBytes(), buyer: buyer.toBase58(), nonce: 7n, deliverBy: 1_800_000_000n, input: '{ "wallet":"x"}', description: 'd' }))).not.toBe(j.toHex(h));
  });

  it('accept checks: hash, chain and seller signature must all agree', async () => {
    const sellerKp = Keypair.generate();
    const deal = key();
    const jobHash = new Uint8Array(32).fill(3);
    const result = 'date,amount\n2026-11-01,1';
    const oh = await j.outputHashV2(deal.toBase58(), jobHash, 'ok', result);
    const sig = j.toBase64(nacl.sign.detached(j.outputMessageV2(deal.toBase58(), oh), sellerKp.secretKey));
    const delivery: j.JobDeliveryV2 = { deal: deal.toBase58(), status: 'ok', result, outputHash: j.toHex(oh), sellerSignature: sig, markTx: null };
    const base = { delivery, deal: deal.toBase58(), seller: sellerKp.publicKey.toBase58(), jobHash, onChainOutputHash: oh };
    expect(await j.checkDeliveryV2(base)).toEqual([]);
    expect(await j.checkDeliveryV2({ ...base, delivery: { ...delivery, result: result + ' ' } })).toContain('output hash does not match the received result');
    expect(await j.checkDeliveryV2({ ...base, onChainOutputHash: new Uint8Array(32) })).toContain('output hash on chain does not match the received result');
    expect(await j.checkDeliveryV2({ ...base, seller: key().toBase58() })).toContain('seller signature over the output hash is not valid');
    expect(await j.checkDeliveryV2({ ...base, delivery: { ...delivery, status: 'job_failed' } })).toContain('the seller reports the job failed');
  });

  it('deliver request signature is bound to origin and expiry', async () => {
    const buyer = Keypair.generate();
    const deal = key().toBase58();
    const now = 1_800_000_000;
    const s = j.toBase64(nacl.sign.detached(j.deliverMessageV2(deal, 'https://a.example', now + 60), buyer.secretKey));
    expect(await j.verifyDeliverSignatureV2(buyer.publicKey.toBase58(), deal, 'https://a.example', now + 60, s, now)).toBe(true);
    expect(await j.verifyDeliverSignatureV2(buyer.publicKey.toBase58(), deal, 'https://b.example', now + 60, s, now)).toBe(false);
    expect(await j.verifyDeliverSignatureV2(buyer.publicKey.toBase58(), deal, 'https://a.example', now + 60, s, now + 61)).toBe(false);
    expect(j.deliverMessageV2(deal, 'o', 1)[0]).toBe(0xff);
    const k = key();
    expect(Buffer.from(j.b58decode(k.toBase58())).equals(k.toBuffer())).toBe(true);
    expect(Buffer.from(j.b58decode('11111111111111111111111111111111')).equals(Buffer.alloc(32))).toBe(true);
  });
});
