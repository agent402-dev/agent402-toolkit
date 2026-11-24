import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import * as client from '@agent402-dev/bond-client/v2';
import * as tx from '@agent402-dev/pay-mcp/bond-v2-tx';
import { evaluateV2, resolveV2Program, BOND_V2_PROGRAM, type BondV2Deps } from '@agent402-dev/pay-mcp/bond-v2';
import { bondPolicyFromEnv } from '@agent402-dev/pay-mcp/bond-sign';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { JOB_PROTOCOL_V2, type JobQuoteV2 } from '@agent402-dev/bond-client/job-v2';

const PROGRAM = client.BOND_V2_PROGRAM_ID.toBase58();
const key = () => Keypair.generate().publicKey;
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('pay-mcp bond v2 instructions match bond-client v2', () => {
  it('open, accept, settle and claims are identical', async () => {
    const [seller, buyer, mint, arb] = [key(), key(), key(), key()];
    const ref = { seller, buyer, nonce: 42n, mint, tokenProgram: new PublicKey(TOKEN) };
    const acc = { sellerToken: key(), buyerToken: key(), sellerPayout: key(), buyerPayout: key() };
    const jobHash = new Uint8Array(32).fill(4);
    const t = { price: 30n, sellerBond: 3n, buyerDeposit: 5n, deliverBy: 1_800_000_000n, grace: 3_600n, reviewWindow: 7_200n, sellerShareBps: 250, arbiter: arb, arbiterWindow: 3_600n, jobHash };
    const a = client.openV2(ref, acc, t);
    const b = await tx.openIxV2(
      { program: PROGRAM, seller: seller.toBase58(), buyer: buyer.toBase58(), nonce: 42n, mint: mint.toBase58(), tokenProgram: TOKEN },
      { sellerToken: acc.sellerToken.toBase58(), buyerToken: acc.buyerToken.toBase58(), sellerPayout: acc.sellerPayout.toBase58(), buyerPayout: acc.buyerPayout.toBase58() },
      { ...t, arbiter: arb.toBase58() },
    );
    const same = (x: typeof a, y: typeof b) => {
      expect(Buffer.from(y.data).equals(x.data)).toBe(true);
      expect(y.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable])).toEqual(x.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
    };
    same(a, b);
    const dec = tx.decodeOpenDataV2(b.data)!;
    expect(dec.nonce).toBe(42n);
    expect(dec.terms.arbiter).toBe(arb.toBase58());
    expect(dec.terms.arbiterWindow).toBe(3_600n);
    expect(Buffer.from(dec.terms.jobHash).equals(Buffer.from(jobHash))).toBe(true);
    const noArb = tx.decodeOpenDataV2(client.openV2(ref, acc, { ...t, arbiter: undefined, arbiterWindow: 0n }).data)!;
    expect(noArb.terms.arbiter).toBeNull();

    const p = { program: PROGRAM, seller: seller.toBase58(), buyer: buyer.toBase58(), nonce: 42n, mint: mint.toBase58(), tokenProgram: TOKEN };
    same(client.acceptV2(ref, acc.buyerToken, acc.sellerPayout), await tx.acceptIxV2(p, acc.buyerToken.toBase58(), acc.sellerPayout.toBase58()));
    const deal = client.dealOfV2(ref);
    expect(await tx.dealPdaV2(PROGRAM, p.seller, p.buyer, 42n)).toBe(deal.toBase58());
    same(client.settleV2(ref), await tx.settleIxV2(PROGRAM, deal.toBase58(), p.mint));
    same(client.claimBuyerV2(ref, seller, acc.buyerPayout), await tx.claimIxV2(PROGRAM, deal.toBase58(), p.mint, TOKEN, seller.toBase58(), acc.buyerPayout.toBase58(), true));
    same(client.claimSellerV2(ref, seller, acc.sellerPayout), await tx.claimIxV2(PROGRAM, deal.toBase58(), p.mint, TOKEN, seller.toBase58(), acc.sellerPayout.toBase58(), false));
  });

  it('Deal decoding agrees with bond-client', () => {
    const raw = Buffer.alloc(450);
    Buffer.from(client.ACCOUNT_DISC_V2.Deal).copy(raw);
    const s = key(), b = key(), arb = key();
    s.toBuffer().copy(raw, 9); b.toBuffer().copy(raw, 41); arb.toBuffer().copy(raw, 105);
    raw.writeBigUInt64LE(9n, 241); raw.writeBigUInt64LE(100n, 249); raw.writeBigInt64LE(1_000n, 273); raw.writeBigInt64LE(50n, 281); raw.writeBigInt64LE(20n, 289);
    raw.writeUInt16LE(500, 305); raw[331] = 2; raw.writeBigInt64LE(0n, 315); raw.fill(7, 384, 416);
    const x = client.decodeDealV2(raw), y = tx.decodeDealV2(raw)!;
    expect([y.seller, y.buyer, y.arbiter, y.nonce, y.price, y.sellerShareBps, y.state, y.markedAt]).toEqual([x.seller.toBase58(), x.buyer.toBase58(), x.arbiter!.toBase58(), x.nonce, x.price, x.sellerShareBps, x.state, x.markedAt]);
    expect(Buffer.from(y.outputHash).equals(Buffer.from(x.outputHash))).toBe(true);
    expect(tx.acceptOpenUntil(y)).toBe(1_020n);
    expect(tx.timeOutcomeV2(y, 1_020n)).toBeNull();
    expect(tx.timeOutcomeV2({ ...y, arbiterWindow: 0n }, 1_021n)?.outcome).toBe('Unconfirmed');
  });
});

describe('pay-mcp bond v2 rules', () => {
  it('is off unless the code constant is set; a local fork may override', () => {
    expect(BOND_V2_PROGRAM).toBeNull();
    expect(resolveV2Program({ X402_BOND_V2_PROGRAM: PROGRAM }, 'https://api.mainnet-beta.solana.com')).toBeNull();
    expect(resolveV2Program({ X402_BOND_V2_PROGRAM: PROGRAM }, 'http://127.0.0.1:8899')).toBe(PROGRAM);
    expect(resolveV2Program({}, 'http://127.0.0.1:8899')).toBeNull();
  });

  it('refuses dispute options unless allowed, and other programs', () => {
    const seller = key().toBase58();
    const policy = policyFromEnv({ X402_ALLOWED_DOMAINS: 'seller.example' });
    const d = { policy, bond: bondPolicyFromEnv({ X402_BOND_SELLERS: seller, X402_BOND_MAX_USD: '10' }), v2Program: PROGRAM, v2: { arbiters: [], allowShare: false } } as unknown as BondV2Deps;
    const q: JobQuoteV2 = { protocol: JOB_PROTOCOL_V2, program: PROGRAM, seller, sellerPayout: key().toBase58(), mint: policy.mints.USDC, tokenProgram: TOKEN,
      price: '1000000', sellerBond: '100000', buyerDeposit: '300000', deliverSeconds: '3600', grace: '86400', reviewWindow: '86400', sellerShareBps: 0, arbiter: null, arbiterWindow: '0' };
    expect(evaluateV2(d, q)).toEqual([]);
    expect(evaluateV2(d, { ...q, sellerShareBps: 1000 }).join()).toContain('X402_BOND_V2_ALLOW_SHARE');
    const arb = key().toBase58();
    expect(evaluateV2(d, { ...q, arbiter: arb, arbiterWindow: '3600' }).join()).toContain('X402_BOND_V2_ARBITERS');
    expect(evaluateV2({ ...d, v2: { arbiters: [arb], allowShare: true } } as BondV2Deps, { ...q, arbiter: arb, sellerShareBps: 1000 })).toEqual([]);
    expect(evaluateV2(d, { ...q, program: key().toBase58() })).toContain('not the Agent402 Bond v2 program');
  });
});
