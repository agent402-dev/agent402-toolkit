import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { describe, expect, it } from 'vitest';
import * as v2 from '../src/v2.js';

const programSrc = readFileSync(fileURLToPath(new URL('../../../programs-v2/agent402-bond-v2/src/lib.rs', import.meta.url)), 'utf8');
const key = () => Keypair.generate().publicKey;
const ref = (nonce = 1n): v2.DealRef => ({ seller: key(), buyer: key(), nonce, mint: key(), tokenProgram: TOKEN_PROGRAM_ID });

/** A Deal account laid out like the program (450 bytes). */
function rawDeal(f: { seller: PublicKey; buyer: PublicKey; state: number; outcome?: number; markedAt?: bigint; arbiter?: PublicKey }) {
  const b = Buffer.alloc(v2.DEAL_V2_SIZE);
  Buffer.from(v2.ACCOUNT_DISC_V2.Deal).copy(b, 0);
  b[8] = 2;
  f.seller.toBuffer().copy(b, 9);
  f.buyer.toBuffer().copy(b, 41);
  (f.arbiter ?? PublicKey.default).toBuffer().copy(b, 105);
  b.writeBigUInt64LE(7n, 233); // seq
  b.writeBigUInt64LE(42n, 241); // nonce
  b.writeBigUInt64LE(30_000_000n, 249);
  b.writeBigUInt64LE(3_000_000n, 257);
  b.writeBigUInt64LE(5_000_000n, 265);
  b.writeBigInt64LE(1_800_086_400n, 273);
  b.writeBigInt64LE(86_400n, 281);
  b.writeBigInt64LE(86_400n, 289);
  b.writeUInt16LE(2_500, 305);
  b.writeBigInt64LE(1_800_000_000n, 307);
  b.writeBigInt64LE(f.markedAt ?? 0n, 315);
  b[331] = f.state;
  b[332] = f.outcome ?? 0;
  b.writeBigUInt64LE(4_000_000n, 333);
  b[350] = 1;
  return new Uint8Array(b);
}

describe('bond-client v2', () => {
  it('instruction and account discriminators match sha256', () => {
    for (const [name, d] of Object.entries(v2.DISC_V2)) {
      expect([...d], name).toEqual([...createHash('sha256').update(`global:${name}`).digest().subarray(0, 8)]);
      expect(programSrc, `program has ${name}`).toContain(`pub fn ${name}(`);
    }
    for (const [name, d] of Object.entries(v2.ACCOUNT_DISC_V2)) {
      expect([...d], name).toEqual([...createHash('sha256').update(`account:${name}`).digest().subarray(0, 8)]);
    }
  });

  it('error names follow the program enum order', () => {
    const body = programSrc.slice(programSrc.indexOf('pub enum BondError'));
    const names = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s+([A-Z][A-Za-z]+),/gm)].map((m) => m[1]);
    expect(names).toEqual([...v2.ERRORS_V2]);
    expect(v2.errorNameV2(6027)).toBe('BadPayout');
  });

  it('open encodes the args in program order with both signers', () => {
    const d = ref(9n);
    const arb = key();
    const i = v2.openV2(d, { sellerToken: key(), buyerToken: key(), sellerPayout: key(), buyerPayout: key() }, {
      price: 30n, sellerBond: 3n, buyerDeposit: 5n, deliverBy: 1_800_000_000n, grace: 3_600n, reviewWindow: 7_200n,
      sellerShareBps: 1_000, arbiter: arb, arbiterWindow: 3_600n, jobHash: new Uint8Array(32).fill(9),
    });
    expect(i.data.length).toBe(8 + 8 + 8 * 6 + 2 + 32 + 8 + 32);
    expect(i.data.readBigUInt64LE(8)).toBe(9n);
    expect(i.data.readBigInt64LE(8 + 8 * 4)).toBe(1_800_000_000n);
    expect(i.data.readUInt16LE(8 + 8 * 7)).toBe(1_000);
    expect(new PublicKey(i.data.subarray(66, 98)).equals(arb)).toBe(true);
    expect(i.keys.length).toBe(13);
    expect(i.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())).toEqual([d.seller.toBase58(), d.buyer.toBase58()]);
    expect(i.keys[7].pubkey.equals(v2.dealOfV2(d))).toBe(true);
    expect(i.keys[8].pubkey.equals(v2.vaultPdaV2(v2.dealOfV2(d)))).toBe(true);
  });

  it('decide-style instructions list signers first, then deal, vault, counter', () => {
    const d = { ...ref(), tokenProgram: TOKEN_2022_PROGRAM_ID };
    expect(v2.settleV2(d).keys.map((k) => k.isSigner)).toEqual([false, false, false]);
    const c = v2.cancelV2(d);
    expect(c.keys.slice(0, 2).every((k) => k.isSigner && !k.isWritable)).toBe(true);
    expect(c.keys[2].pubkey.equals(v2.dealOfV2(d)) && c.keys[2].isWritable).toBe(true);
    expect(v2.settleAgreedV2(d, 11n).data.readBigUInt64LE(8)).toBe(11n);
  });

  it('decodes a Deal and hides fields that do not apply', () => {
    const [s, b] = [key(), key()];
    const open = v2.decodeDealV2(rawDeal({ seller: s, buyer: b, state: 1 }));
    expect(open.state).toBe('Open');
    expect(open.outcome).toBeNull();
    expect(open.markedAt).toBeNull();
    expect(open.arbiter).toBeNull();
    expect(open.seller.equals(s) && open.buyer.equals(b)).toBe(true);
    expect([open.seq, open.nonce, open.sellerShareBps]).toEqual([7n, 42n, 2_500]);
    const settled = v2.decodeDealV2(rawDeal({ seller: s, buyer: b, state: 3, outcome: 2, markedAt: 0n }));
    expect(settled.outcome).toBe('SellerDefault');
    const marked0 = v2.decodeDealV2(rawDeal({ seller: s, buyer: b, state: 2, markedAt: 0n }));
    expect(marked0.markedAt).toBe(0n);
    expect(() => v2.decodeDealV2(new Uint8Array(450))).toThrow();
  });

  it('time outcomes match the core rules', () => {
    const t = { price: 30n, sellerBond: 3n, buyerDeposit: 8n, deliverBy: 1_000n, grace: 100n, reviewWindow: 50n, arbiterWindow: 20n, sellerShareBps: 2_500 };
    expect(v2.timeOutcomeV2({ ...t, state: 'Open', markedAt: null }, 1_100n)).toBeNull();
    expect(v2.timeOutcomeV2({ ...t, state: 'Open', markedAt: null }, 1_101n)).toEqual({ outcome: 'SellerDefault', toSeller: 0n, toBuyer: 11n });
    // early mark counts from deliverBy: A = 1000 + 50, R = 1070
    expect(v2.acceptDeadlineV2(t, 900n)).toBe(1_050n);
    expect(v2.timeOutcomeV2({ ...t, state: 'Marked', markedAt: 900n }, 1_070n)).toBeNull();
    expect(v2.timeOutcomeV2({ ...t, state: 'Marked', markedAt: 900n }, 1_071n)).toEqual({ outcome: 'Unconfirmed', toSeller: 5n, toBuyer: 6n });
    expect(v2.settleByV2(t)).toBe(1_171n);
  });

  it('claims go buyer first and skip sides already done', () => {
    const d = ref();
    const base = { rentPayer: d.seller, sellerPayout: key(), buyerPayout: key(), state: 'Settled' as const };
    const names = (ixs: { data: Buffer }[]) => ixs.map((i) => (i.data.subarray(0, 8).equals(Buffer.from(v2.DISC_V2.claim_buyer)) ? 'buyer' : 'seller'));
    expect(names(v2.claimsV2(d, { ...base, sellerClaimed: false, buyerClaimed: false }))).toEqual(['buyer', 'seller']);
    expect(names(v2.claimsV2(d, { ...base, sellerClaimed: false, buyerClaimed: true }))).toEqual(['seller']);
    expect(names(v2.claimsV2(d, { ...base, sellerClaimed: true, buyerClaimed: true }, 5n))).toEqual(['buyer']);
    expect(v2.claimsV2(d, { ...base, sellerClaimed: true, buyerClaimed: true })).toEqual([]);
  });

  it('checkTerms mirrors the open checks', () => {
    const [s, b] = [key(), key()];
    const t: v2.OpenTermsV2 = { price: 100n, sellerBond: 20n, buyerDeposit: 10n, deliverBy: 2_000n, grace: 3_600n, reviewWindow: 3_600n, sellerShareBps: 0, arbiterWindow: 0n, jobHash: new Uint8Array(32) };
    expect(v2.checkTermsV2(t, 1_000n, s, b)).toBeNull();
    expect(v2.checkTermsV2({ ...t, sellerBond: 21n }, 1_000n, s, b)).toBe('BondTooLarge');
    expect(v2.checkTermsV2({ ...t, arbiter: s, arbiterWindow: 3_600n }, 1_000n, s, b)).toBe('BadArbiter');
    expect(v2.checkTermsV2({ ...t, grace: 3_599n }, 1_000n, s, b)).toBe('GraceOutOfRange');
  });
});

describe('bond-client v2 events', () => {
  it('event discriminators match sha256 and names exist in the program', () => {
    for (const [name, ev] of Object.entries(v2.EVENTS_V2)) {
      expect([...ev.disc], name).toEqual([...createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)]);
      expect(programSrc, name).toContain(`pub struct ${name} {`);
    }
  });

  it('event field lists follow the program structs', () => {
    const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    for (const [name, ev] of Object.entries(v2.EVENTS_V2)) {
      const body = programSrc.slice(programSrc.indexOf(`pub struct ${name} {`));
      const fields = [...body.slice(0, body.indexOf('\n}')).matchAll(/^\s+pub (\w+):/gm)].map((m) => m[1]);
      expect(ev.fields.map(([k]) => snake(k)), name).toEqual(fields);
    }
  });

  it('decodes Claimed and Settled from program logs, ignoring other programs', () => {
    const deal = key(), to = key();
    const claimed = Buffer.concat([Buffer.from(v2.EVENTS_V2.Claimed.disc), deal.toBuffer(), Buffer.alloc(8, 0), Buffer.from([1]), Buffer.alloc(8), to.toBuffer()]);
    claimed.writeBigUInt64LE(3n, 40);
    claimed.writeBigUInt64LE(500n, 49);
    const settled = Buffer.alloc(8 + 32 + 8 + 96 + 1 + 24 + 1 + 8);
    Buffer.from(v2.EVENTS_V2.Settled.disc).copy(settled);
    settled[8 + 32 + 8 + 96] = 2; // SellerDefault
    const id = v2.BOND_V2_PROGRAM_ID.toBase58();
    const logs = [
      `Program ${id} invoke [1]`, `Program data: ${settled.toString('base64')}`,
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]', `Program data: ${claimed.toString('base64')}`,
      'Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success', `Program data: ${claimed.toString('base64')}`, `Program ${id} success`,
    ];
    const ev = v2.eventsFromLogsV2(logs);
    expect(ev.map((e) => e.name)).toEqual(['Settled', 'Claimed']);
    expect(ev[0].data.outcomeName).toBe('SellerDefault');
    expect(ev[1].data.amount).toBe(500n);
    expect((ev[1].data.to as PublicKey).equals(to)).toBe(true);
    expect(v2.decodeEventV2(claimed.subarray(0, claimed.length - 1))).toBeNull();
  });
});
