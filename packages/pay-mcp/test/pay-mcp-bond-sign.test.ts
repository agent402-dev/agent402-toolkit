// @agent402-dev/pay-mcp Agent402 Bond signing tools: our kit builders = bond-client (web3.js) builders, wire format round trips,
// bond_open accepts only the exact open transaction rebuilt for this wallet, refusals never sign or send, confirm/pay and settle.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { createKeyPairSignerFromBytes, signBytes } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import * as bc from '@agent402-dev/bond-client';
import { BOND_PROGRAM, DEAL_DISCRIMINATOR } from '@agent402-dev/pay-mcp/bond';
import { compileMessage, type Ix, openIx, parseTx, payIx, confirmIx, settleAndClaimIxs, TOKEN_PROGRAM } from '@agent402-dev/pay-mcp/bond-tx';
import { bondConfirmAndPay, bondOpen, bondPolicyFromEnv, bondSettle, type BondRpc, type BondSignDeps, type Confirm } from '@agent402-dev/pay-mcp/bond-sign';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';

const U = 1_000_000n;
const DAY = 86_400n;
const NOW = 1_800_000_000n;
const USDC = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BH = '11111111111111111111111111111111';

const sellerKp = Keypair.generate(), buyerKp = Keypair.generate(), otherKp = Keypair.generate();
const seller = sellerKp.publicKey.toBase58(), buyer = buyerKp.publicKey.toBase58();
const ref = (nonce = 1n): bc.DealRef => ({ seller: sellerKp.publicKey, buyer: buyerKp.publicKey, mint: USDC, tokenProgram: TOKEN_PROGRAM_ID, nonce });
const terms = (o: Partial<bc.Terms> = {}): bc.Terms => ({ price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverBy: NOW + 3_600n, lateWindow: 0n, payWindow: DAY, ...o });

const sameIx = (a: Ix, b: TransactionInstruction) => {
  expect(a.programId).toBe(b.programId.toBase58());
  expect(a.keys.map((k) => [k.pubkey, k.isSigner, k.isWritable])).toEqual(b.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]));
  expect(Buffer.from(a.data).equals(b.data)).toBe(true);
};

/** The seller's side, as in the example: build `open`, fee payer = seller, partially sign. */
function sellerOpenTx(ixs: TransactionInstruction[], feePayer = sellerKp, signers: Keypair[] = [sellerKp]): string {
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = BH;
  tx.feePayer = feePayer.publicKey;
  tx.partialSign(...signers);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function dealBytes(o: { mark?: bigint; confirm?: bigint; paid?: boolean; outcome?: number; deliverBy?: bigint } = {}): Uint8Array {
  const t = terms(o.deliverBy ? { deliverBy: o.deliverBy } : {});
  const b = new Uint8Array(196);
  const v = new DataView(b.buffer);
  b.set(DEAL_DISCRIMINATOR, 0);
  let i = 8;
  for (const k of [sellerKp.publicKey, buyerKp.publicKey, USDC]) { b.set(k.toBytes(), i); i += 32; }
  for (const x of [1n, t.price, t.sellerBond, t.buyerDeposit]) { v.setBigUint64(i, x, true); i += 8; }
  for (const x of [t.deliverBy, t.lateWindow, t.payWindow, NOW, o.mark ?? 0n, o.confirm ?? 0n]) { v.setBigInt64(i, x, true); i += 8; }
  b[i++] = o.paid ? 1 : 0; i += 2; b[i++] = o.outcome ?? 0;
  return b;
}

interface Setup { deps: BondSignDeps; sent: Uint8Array[]; signed: () => number; history: ReturnType<typeof jsonlHistory> }
async function setup(env: Record<string, string> = {}, opts: { confirm?: Awaited<ReturnType<Confirm>>; clock?: bigint; deal?: Uint8Array; wallet?: Keypair | null; sendFails?: boolean } = {}): Promise<Setup> {
  const policy = policyFromEnv({ X402_MAX_USD_PER_DAY: '100', ...env });
  const history = jsonlHistory(join(mkdtempSync(join(tmpdir(), 'bond-')), 'h.jsonl'), () => policy.mints);
  const kp = opts.wallet === undefined ? buyerKp : opts.wallet;
  const signer = kp ? await createKeyPairSignerFromBytes(kp.secretKey) : null;
  let n = 0;
  const sent: Uint8Array[] = [];
  const rpc: BondRpc = {
    async latestBlockhash() { return BH; },
    async sendAndConfirm(tx) { if (opts.sendFails) throw new Error('boom'); sent.push(tx); return 'SIG'; },
  };
  const deps: BondSignDeps = {
    policy,
    bond: bondPolicyFromEnv({ X402_BOND_SELLERS: seller, X402_BOND_MAX_USD: '50', ...env }),
    signer: signer ? { address: signer.address, async signBytes(m) { n++; return new Uint8Array(await signBytes(signer.keyPair.privateKey, m)); } } : null,
    rpc, history,
    confirm: async () => opts.confirm ?? 'accept',
    accounts: async () => [opts.deal ? { owner: BOND_PROGRAM, data: opts.deal } : null],
    clock: async () => opts.clock ?? NOW,
  };
  return { deps, sent, signed: () => n, history };
}

describe('kit builders match bond-client (web3.js)', () => {
  it('open, confirm, pay, settle + claims', async () => {
    const keys = { seller, buyer, mint: USDC.toBase58(), tokenProgram: TOKEN_PROGRAM, nonce: 9n };
    sameIx(await openIx(keys, terms()), bc.open(ref(9n), terms()));
    const deal = bc.dealOf(ref(9n)).toBase58();
    sameIx(confirmIx(buyer, deal), bc.confirmReceipt(ref(9n)));
    sameIx(await payIx(keys, deal), bc.payBalance(ref(9n)));
    const ours = await settleAndClaimIxs(keys, deal);
    bc.settleAndClaim(ref(9n)).forEach((x, i) => sameIx(ours[i], x));
  });
  it('compiled message parses back in web3.js with the same instructions and a valid signature', async () => {
    const keys = { seller, buyer, mint: USDC.toBase58(), tokenProgram: TOKEN_PROGRAM, nonce: 9n };
    const deal = bc.dealOf(ref(9n)).toBase58();
    const ixs = [confirmIx(buyer, deal), await payIx(keys, deal)];
    const { message, signers } = compileMessage(buyer, ixs, BH);
    expect(signers).toEqual([buyer]);
    const s = await createKeyPairSignerFromBytes(buyerKp.secretKey);
    const sig = new Uint8Array(await signBytes(s.keyPair.privateKey, message));
    const wire = Buffer.concat([Buffer.from([1]), Buffer.from(sig), Buffer.from(message)]);
    const tx = Transaction.from(wire);
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.toBase58()).toBe(buyer);
    [bc.confirmReceipt(ref(9n)), bc.payBalance(ref(9n))].forEach((x, i) => {
      expect(tx.instructions[i].programId.equals(x.programId)).toBe(true);
      expect(tx.instructions[i].data.equals(x.data)).toBe(true);
      expect(tx.instructions[i].keys.map((k) => k.pubkey.toBase58())).toEqual(x.keys.map((k) => k.pubkey.toBase58()));
    });
    // and our parser reads web3.js output the same way
    const p = parseTx(Uint8Array.from(wire));
    expect(p.instructions.length).toBe(2);
    expect(p.keys[0]).toBe(buyer);
  });
  it('parseTx refuses junk and trailing bytes', () => {
    expect(() => parseTx(new Uint8Array([1, 2, 3]))).toThrow();
    const ok = Buffer.from(sellerOpenTx([bc.open(ref(), terms())]), 'base64');
    expect(() => parseTx(Uint8Array.from(Buffer.concat([ok, Buffer.from([0])])))).toThrow('trailing');
  });
});

describe('bond_open', () => {
  it('signs the exact open transaction; seller and buyer signatures both valid; recorded', async () => {
    const s = await setup();
    const r = await bondOpen(s.deps, sellerOpenTx([bc.open(ref(), terms())]));
    expect(r.result).toBe('opened');
    expect(s.signed()).toBe(1);
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.feePayer?.toBase58()).toBe(seller);
    const h = s.history.list(1)[0];
    expect(h).toMatchObject({ host: 'agent402-bond', signed: true, result: 'paid', amount: (5n * U).toString(), payTo: seller });
    expect(s.history.today(new Date()).usd).toBe(5);
  });

  const refusals: [string, () => Promise<{ tx: string; env?: Record<string, string>; opts?: Parameters<typeof setup>[1] }>, string][] = [
    ['seller not allowed', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), env: { X402_BOND_SELLERS: otherKp.publicKey.toBase58() } }), 'X402_BOND_SELLERS'],
    ['no per-deal cap set', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), env: { X402_BOND_MAX_USD: '' } }), 'X402_BOND_MAX_USD is not set'],
    ['price above the cap', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), env: { X402_BOND_MAX_USD: '10' } }), 'above X402_BOND_MAX_USD'],
    ['seller bond below 5%', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms({ sellerBond: U / 2n }))]) }), 'seller bond'],
    ['delivery too far', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms({ deliverBy: NOW + 40n * DAY }))]) }), 'X402_BOND_MAX_DAYS'],
    ['deposit over the daily cap', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), env: { X402_MAX_USD_PER_DAY: '4' } }), 'daily USDC cap'],
    ['buyer token account swapped', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms(), undefined, Keypair.generate().publicKey)]) }), 'does not match'],
    ['seller token account swapped', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms(), Keypair.generate().publicKey)]) }), 'does not match'],
    ['extra instruction', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms()), bc.open(ref(2n), terms())]) }), 'exactly 1 instruction'],
    ['buyer made fee payer', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())], buyerKp, [sellerKp]) }), 'does not match'],
    ['other mint', async () => ({ tx: sellerOpenTx([bc.open({ ...ref(), mint: new PublicKey(bc.MINTS.devnet.USDC) }, terms())]) }), 'is not supported'],
    ['not an open', async () => ({ tx: sellerOpenTx([bc.markDelivered(ref())]) }), 'not an Agent402 Bond open'],
    ['user declines', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), opts: { confirm: 'decline' } }), 'declined_by_user'],
    ['client cannot ask', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), opts: { confirm: 'unsupported' } }), 'confirmation_required'],
    ['no wallet', async () => ({ tx: sellerOpenTx([bc.open(ref(), terms())]), opts: { wallet: null } }), 'no wallet'],
  ];
  for (const [name, make, expectText] of refusals) {
    it(`refuses without signing: ${name}`, async () => {
      const c = await make();
      const s = await setup(c.env, c.opts);
      const r = await bondOpen(s.deps, c.tx);
      expect(r.result).not.toBe('opened');
      expect(JSON.stringify(r)).toContain(expectText);
      expect(s.signed()).toBe(0);
      expect(s.sent.length).toBe(0);
    });
  }
  it('human confirmation is skipped only under X402_BOND_CONFIRM_ABOVE_USD', async () => {
    const s = await setup({ X402_BOND_CONFIRM_ABOVE_USD: '25' }, { confirm: 'unsupported' });
    expect((await bondOpen(s.deps, sellerOpenTx([bc.open(ref(), terms())]))).result).toBe('opened');
  });
  it('a failed send is recorded as signed (counts toward limits)', async () => {
    const s = await setup({}, { sendFails: true });
    expect((await bondOpen(s.deps, sellerOpenTx([bc.open(ref(), terms())]))).result).toBe('failed');
    expect(s.history.list(1)[0]).toMatchObject({ signed: true, result: 'failed' });
  });
});

describe('bond_confirm_and_pay', () => {
  const deal = bc.dealOf(ref()).toBase58();
  it('confirms and pays the balance (buyer only)', async () => {
    const s = await setup({}, { deal: dealBytes({ mark: NOW + 10n }), clock: NOW + 100n });
    const r = await bondConfirmAndPay(s.deps, deal);
    expect(r).toMatchObject({ result: 'confirmed_and_paid', paid: '15 USDC' });
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.verifySignatures()).toBe(true);
    expect(tx.instructions.map((i) => i.data.subarray(0, 8).toString('hex'))).toEqual([bc.confirmReceipt(ref()), bc.payBalance(ref())].map((i) => i.data.subarray(0, 8).toString('hex')));
    expect(s.history.today(new Date()).usd).toBe(15);
  });
  it('refuses for a wallet that is not the buyer, after the deadline, over the daily cap, or when declined', async () => {
    for (const [env, opts, text] of [
      [{}, { deal: dealBytes(), wallet: otherKp }, 'not the buyer'],
      [{}, { deal: dealBytes(), clock: NOW + 30n * DAY }, 'deadline has passed'],
      [{ X402_MAX_USD_PER_DAY: '10' }, { deal: dealBytes() }, 'daily USDC cap'],
      [{}, { deal: dealBytes({ confirm: NOW + 5n }) }, 'already confirmed'],
      [{}, { deal: dealBytes(), confirm: 'decline' }, 'declined_by_user'],
    ] as const) {
      const s = await setup(env as Record<string, string>, opts as Parameters<typeof setup>[1]);
      const r = await bondConfirmAndPay(s.deps, deal);
      expect(JSON.stringify(r)).toContain(text);
      expect(s.signed()).toBe(0);
      expect(s.sent.length).toBe(0);
    }
  });
});

describe('bond_settle', () => {
  const deal = bc.dealOf(ref()).toBase58();
  it('settles a paid deal and sends both claims in order', async () => {
    const s = await setup({}, { deal: dealBytes({ mark: NOW + 10n, confirm: NOW + 20n, paid: true }), clock: NOW + 30n });
    const r = await bondSettle(s.deps, deal);
    expect(r).toMatchObject({ result: 'settled', outcome: 'delivered', toSeller: '7 USDC' });
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.instructions.map((i) => i.data.toString('hex'))).toEqual(bc.settleAndClaim(ref()).map((i) => i.data.toString('hex')));
  });
  it('refuses when not settleable yet or when this wallet is not a party', async () => {
    const early = await setup({}, { deal: dealBytes(), clock: NOW + 10n });
    expect(JSON.stringify(await bondSettle(early.deps, deal))).toContain('not settleable yet');
    const stranger = await setup({}, { deal: dealBytes({ confirm: NOW, paid: true }), wallet: otherKp });
    expect(JSON.stringify(await bondSettle(stranger.deps, deal))).toContain('neither buyer nor seller');
    expect(early.signed() + stranger.signed()).toBe(0);
  });
});

describe('security review fixes (buyer side)', () => {
  const deal = bc.dealOf(ref()).toBase58();

  it('I-1: an open transaction without a valid seller signature is refused before signing', async () => {
    const s = await setup();
    const bytes = Buffer.from(sellerOpenTx([bc.open(ref(), terms())]), 'base64');
    bytes[1] ^= 0xff; // corrupt the seller's signature
    const r = await bondOpen(s.deps, bytes.toString('base64'));
    expect(JSON.stringify(r)).toContain('seller signature');
    expect(s.signed()).toBe(0);
  });

  it('I-2: non-canonical length encodings are refused', () => {
    const ok = Buffer.from(sellerOpenTx([bc.open(ref(), terms())]), 'base64');
    expect(ok[0]).toBe(2);
    const bad = Buffer.concat([Buffer.from([0x82, 0x00]), ok.subarray(1)]); // 2 written in two bytes
    expect(() => parseTx(bad)).toThrow();
  });

  it('M-2: the confirmation threshold applies to the whole price released, not only the balance', async () => {
    // price 20, balance 15: with "ask above 16 USDC" the human must still be asked
    const s = await setup({ X402_BOND_CONFIRM_ABOVE_USD: '16' }, { deal: dealBytes({ mark: NOW + 10n }), clock: NOW + 100n, confirm: 'unsupported' });
    expect(JSON.stringify(await bondConfirmAndPay(s.deps, deal))).toContain('confirmation_required');
    expect(s.signed()).toBe(0);
  });

  it('M-1: two spending calls at the same time cannot both pass the daily cap', async () => {
    const { withSpendLock } = await import('@agent402-dev/pay-mcp/spend-lock');
    // Cap 15 USDC/day, each open locks a 10 USDC deposit (one fits, two do not); the human answers slowly
    const s = await setup({ X402_MAX_USD_PER_DAY: '15' });
    s.deps.confirm = async () => { await new Promise((r) => setTimeout(r, 30)); return 'accept'; };
    const a = sellerOpenTx([bc.open(ref(1n), terms({ buyerDeposit: 10n * U }))]);
    const b = sellerOpenTx([bc.open(ref(2n), terms({ buyerDeposit: 10n * U }))]);
    const rs = await Promise.all([withSpendLock(() => bondOpen(s.deps, a)), withSpendLock(() => bondOpen(s.deps, b))]);
    expect(rs.map((r) => r.result).sort()).toEqual(['opened', 'refused']);
    expect(s.sent.length).toBe(1);
  });

  it('M-4 / L-3: settle falls back to this wallet\'s own claim; non-USDC deals are refused', async () => {
    const s = await setup({}, { deal: dealBytes({ mark: NOW + 10n, confirm: NOW + 20n, paid: true }), clock: NOW + 30n });
    let first = true;
    s.deps.rpc.sendAndConfirm = async (tx) => { if (first) { first = false; throw new Error('simulation failed: seller token account frozen'); } s.sent.push(tx); return 'SIG'; };
    const r = await bondSettle(s.deps, deal);
    expect(r).toMatchObject({ result: 'settled', note: expect.stringContaining('own share') });
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.instructions.map((i) => i.data.toString('hex'))).toEqual([bc.settle(ref()), bc.claimBuyer(ref())].map((i) => i.data.toString('hex')));

    const wsol = dealBytes();
    wsol.set(new PublicKey('So11111111111111111111111111111111111111112').toBytes(), 8 + 64);
    const w = await setup({}, { deal: wsol, clock: NOW + 30n * DAY });
    expect(JSON.stringify(await bondSettle(w.deps, deal))).toContain('is not supported (USDC or PREQ)');
  });

  it('L-6: a settle (no tokens moved) does not count as a payment for the daily count', async () => {
    const s = await setup({}, { deal: dealBytes({ mark: NOW + 10n, confirm: NOW + 20n, paid: true }), clock: NOW + 30n });
    await bondSettle(s.deps, deal);
    expect(s.history.list(5).length).toBe(1);
    expect(s.history.today(new Date()).count).toBe(0);
  });

  it('L-2 / L-8: display with 0 decimals; malformed job terms are refused with a reason', async () => {
    const { formatUnits } = await import('@agent402-dev/pay-mcp/units');
    expect(formatUnits(1234567n, 'tokens', 0)).toBe('1,234,567 tokens');
    const { checkJobTerms } = await import('@agent402-dev/bond-client/job');
    expect(checkJobTerms({ price: 'abc', sellerBond: '1', buyerDeposit: '1', deliverBy: '1', lateWindow: '0', payWindow: '1' })).toEqual(['terms.price must be a decimal string']);
    expect(checkJobTerms(null)).toHaveLength(6);
  });
});

describe('PREQ deals (Token-2022), opt-in like PREQ x402 payments', () => {
  const PREQ = new PublicKey('aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX');
  const P = 1_000_000n; // 1 PREQ in smallest units
  const pref = (nonce = 1n): bc.DealRef => ({ ...ref(nonce), mint: PREQ, tokenProgram: bc.TOKEN_2022_PROGRAM_ID });
  const pterms = () => terms({ price: 50_000n * P, sellerBond: 5_000n * P, buyerDeposit: 10_000n * P });
  const ON = { X402_ALLOWED_ASSETS: 'USDC,PREQ', X402_BOND_MAX_PREQ_ATOMIC: String(100_000n * P), X402_MAX_PREQ_ATOMIC: String(1n * P), X402_MAX_PREQ_PER_DAY_ATOMIC: String(200_000n * P) };
  const preqDeal = (o: Parameters<typeof dealBytes>[0] = {}) => {
    const b = dealBytes(o);
    b.set(PREQ.toBytes(), 8 + 64);
    const v = new DataView(b.buffer);
    let i = 8 + 96 + 8; for (const x of [50_000n * P, 5_000n * P, 10_000n * P]) { v.setBigUint64(i, x, true); i += 8; }
    return b;
  };

  it('refused unless enabled: PREQ in X402_ALLOWED_ASSETS, a PREQ per-deal cap and a PREQ daily cap', async () => {
    const s = await setup();
    const r = JSON.stringify(await bondOpen(s.deps, sellerOpenTx([bc.open(pref(), pterms())])));
    expect(r).toContain('X402_ALLOWED_ASSETS');
    expect(r).toContain('X402_BOND_MAX_PREQ_ATOMIC');
    expect(r).toContain('X402_MAX_PREQ_PER_DAY_ATOMIC');
    expect(s.signed()).toBe(0);
  });

  it('opens with the Token-2022 accounts; amounts shown in PREQ; the deposit counts toward the PREQ daily cap', async () => {
    const s = await setup(ON);
    const r = await bondOpen(s.deps, sellerOpenTx([bc.open(pref(), pterms())]));
    expect(r).toMatchObject({ result: 'opened', asset: 'PREQ', deposit: '10,000 PREQ', balanceLater: '40,000 PREQ' });
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.instructions[0].keys.some((k) => k.pubkey.equals(bc.TOKEN_2022_PROGRAM_ID))).toBe(true);
    expect(s.history.today(new Date()).preq).toBe(10_000n * P);
    expect(s.history.today(new Date()).usd).toBe(0);
  });

  it('refuses a PREQ open built with the classic token program, over the PREQ cap, or over the PREQ daily cap', async () => {
    for (const [env, tx, text] of [
      [ON, sellerOpenTx([bc.open({ ...pref(), tokenProgram: TOKEN_PROGRAM_ID }, pterms())]), 'does not match'],
      [{ ...ON, X402_BOND_MAX_PREQ_ATOMIC: String(10_000n * P) }, sellerOpenTx([bc.open(pref(), pterms())]), 'X402_BOND_MAX_PREQ_ATOMIC'],
      [{ ...ON, X402_MAX_PREQ_PER_DAY_ATOMIC: String(5_000n * P) }, sellerOpenTx([bc.open(pref(), pterms())]), 'daily PREQ cap'],
    ] as const) {
      const s = await setup(env as Record<string, string>);
      expect(JSON.stringify(await bondOpen(s.deps, tx))).toContain(text);
      expect(s.signed()).toBe(0);
    }
  });

  it('confirm and pay uses Token-2022 and asks with PREQ amounts; settle works for PREQ deals', async () => {
    let asked = '';
    const s = await setup(ON, { deal: preqDeal({ mark: NOW + 10n }), clock: NOW + 100n });
    s.deps.confirm = async (m) => { asked = m; return 'accept'; };
    const deal = bc.dealOf(pref()).toBase58();
    expect(await bondConfirmAndPay(s.deps, deal)).toMatchObject({ result: 'confirmed_and_paid', paid: '40,000 PREQ' });
    expect(asked).toContain('total 50,000 PREQ');
    const tx = Transaction.from(Buffer.from(s.sent[0]));
    expect(tx.instructions.map((i) => i.data.toString('hex'))).toEqual([bc.confirmReceipt(pref()), bc.payBalance(pref())].map((i) => i.data.toString('hex')));
    expect(tx.instructions[1].keys.map((k) => k.pubkey.toBase58())).toEqual(bc.payBalance(pref()).keys.map((k) => k.pubkey.toBase58()));

    const z = await setup({}, { deal: preqDeal({ mark: NOW + 10n, confirm: NOW + 20n, paid: true }), clock: NOW + 30n });
    const r = await bondSettle(z.deps, deal);
    // From the vault: seller bond 5,000 + deposit 10,000 (the balance went to the seller directly at confirm)
    expect(r).toMatchObject({ result: 'settled', outcome: 'delivered', toSeller: '15,000 PREQ', toBuyer: '0 PREQ' });
    const st = Transaction.from(Buffer.from(z.sent[0]));
    expect(st.instructions.map((i) => i.keys.map((k) => k.pubkey.toBase58()))).toEqual(bc.settleAndClaim(pref()).map((i) => i.keys.map((k) => k.pubkey.toBase58())));
  });
});
