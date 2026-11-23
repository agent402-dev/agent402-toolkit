import { createHash } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import * as bond from '../src/index.js';

describe('bond-client', () => {
  it('discriminators match sha256("global:<name>")', () => {
    for (const [name, d] of Object.entries(bond.DISC)) {
      const want = [...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)];
      expect([...d], name).toEqual(want);
    }
  });

  it('settleAndClaim orders settle, buyer claim, seller claim', () => {
    const d = { seller: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, mint: bond.MINTS.devnet.USDC, tokenProgram: TOKEN_PROGRAM_ID, nonce: 1n };
    const ixs = bond.settleAndClaim(d);
    expect(ixs.map((i) => [...i.data.subarray(0, 8)])).toEqual([[...bond.DISC.settle], [...bond.DISC.claim_buyer], [...bond.DISC.claim_seller]]);
    expect(ixs[0].keys[0].pubkey.equals(bond.dealOf(d))).toBe(true);
  });

  it('open encodes nonce and terms little-endian', () => {
    const d = { seller: Keypair.generate().publicKey, buyer: Keypair.generate().publicKey, mint: bond.MINTS.devnet.USDC, tokenProgram: TOKEN_PROGRAM_ID, nonce: 7n };
    const i = bond.open(d, { price: 300n, sellerBond: 30n, buyerDeposit: 60n, deliverBy: 1_800_000_000n, lateWindow: 0n, payWindow: 86_400n });
    expect(i.data.length).toBe(8 + 8 * 7);
    expect(i.data.readBigUInt64LE(8)).toBe(7n);
    expect(i.data.readBigInt64LE(8 + 8 * 4)).toBe(1_800_000_000n);
    expect(i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([d.seller.toBase58(), d.buyer.toBase58()]);
  });

  it('decodes a Deal account', () => {
    const raw = new Uint8Array(8 + 96 + 8 * 10 + 4 + 8);
    const v = new DataView(raw.buffer);
    const s = Keypair.generate().publicKey;
    raw.set(s.toBytes(), 8);
    v.setBigUint64(104, 5n, true); // nonce
    v.setBigUint64(112, 300n, true); // price
    raw[8 + 96 + 80] = 1; // balance_paid
    raw[8 + 96 + 80 + 3] = 1; // outcome = delivered
    v.setBigUint64(8 + 96 + 80 + 4, 330n, true);
    const d = bond.decodeDeal(raw);
    expect(d.seller.equals(s)).toBe(true);
    expect(d.nonce).toBe(5n);
    expect(d.terms.price).toBe(300n);
    expect(d.balancePaid).toBe(true);
    expect(d.outcome).toBe('delivered');
    expect(d.owedSeller).toBe(330n);
    expect(PublicKey.isOnCurve(bond.BOND_PROGRAM_ID.toBytes())).toBe(true);
  });
});

// associatedTokenAddress must equal @solana/spl-token's derivation (bond-client no longer depends on spl-token).
describe('associatedTokenAddress', () => {
  it('matches spl-token for SPL Token and Token-2022', () => {
    expect(bond.TOKEN_PROGRAM_ID.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(bond.TOKEN_2022_PROGRAM_ID.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    for (let i = 0; i < 20; i++) {
      const owner = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
      for (const tp of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
        expect(bond.associatedTokenAddress(owner, mint, tp).equals(getAssociatedTokenAddressSync(mint, owner, false, tp))).toBe(true);
      }
    }
  });
});
