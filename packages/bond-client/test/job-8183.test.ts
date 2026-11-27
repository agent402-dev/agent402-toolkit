import { Keypair, PublicKey } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { describe, expect, it } from 'vitest';
import * as j from '../src/job-8183.js';
import * as jv from '../src/job-v2.js';
import * as v2 from '../src/v2.js';

const key = () => Keypair.generate().publicKey;
const T0 = 1_800_000_000n;
const seller = Keypair.generate();

function deal(over: Partial<v2.DealV2> = {}): v2.DealV2 {
  return {
    version: 1, seller: seller.publicKey, buyer: key(), mint: key(), arbiter: null, rentPayer: seller.publicKey, sellerPayout: key(), buyerPayout: key(),
    seq: 1n, nonce: 7n, price: 1_000_000n, sellerBond: 100_000n, buyerDeposit: 300_000n,
    deliverBy: T0 + 3_600n, grace: 3_600n, reviewWindow: 3_600n, arbiterWindow: 0n, sellerShareBps: 0,
    openedAt: T0, markedAt: null, settledAt: null, state: 'Open', outcome: null, owedSeller: 0n, owedBuyer: 0n,
    sellerClaimed: false, buyerClaimed: false, vaultShort: false, jobHash: new Uint8Array(32).fill(3), outputHash: new Uint8Array(32), ...over,
  };
}
const ref = (d: v2.DealV2): v2.DealRef => ({ seller: d.seller, buyer: d.buyer, nonce: d.nonce, mint: d.mint, tokenProgram: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });

async function delivered(d: v2.DealV2, result: string, status: jv.JobStatusV2 = 'ok') {
  const addr = v2.dealOfV2(ref(d)).toBase58();
  const h = await jv.outputHashV2(addr, d.jobHash, status, result);
  const sig = jv.toBase64(nacl.sign.detached(jv.outputMessageV2(addr, h), seller.secretKey));
  const marked = { ...d, state: 'Marked' as const, markedAt: T0 + 60n, outputHash: h };
  const delivery: jv.JobDeliveryV2 = { deal: addr, status, result, outputHash: jv.toHex(h), sellerSignature: sig, markTx: null };
  return { marked, delivery, addr };
}

describe('8183-style job layer on Bond v2', () => {
  it('reason codes: ten codes, four machine-checkable, blank becomes other', () => {
    expect(j.REASON_CODES).toHaveLength(10);
    expect(j.MACHINE_REASONS).toEqual(['deadline_missed', 'not_delivered', 'receipt_mismatch', 'schema_mismatch']);
    expect(j.normalizeReason(undefined)).toBe('other');
    expect(j.normalizeReason('nonsense')).toBe('other');
    expect(j.normalizeReason('quality_below_brief')).toBe('quality_below_brief');
    expect(j.countReasons(['deadline_missed', 'data_incorrect', undefined, 'schema_mismatch'])).toMatchObject({ machine: 2, notMachine: 2, total: 4, by: { other: 1 } });
  });

  it('maps every Bond v2 outcome to a job status', () => {
    expect(j.statusOfOutcome('Accepted', 1n, 1n)).toBe('Completed');
    expect(j.statusOfOutcome('SellerDefault', 0n, 1n)).toBe('Expired');
    for (const o of ['Unconfirmed', 'Cancelled', 'Released'] as const) expect(j.statusOfOutcome(o, 5n, 1n)).toBe('Rejected');
    expect(j.statusOfOutcome('Agreed', 2n, 1n)).toBe('Completed');
    expect(j.statusOfOutcome('Arbitrated', 1n, 1n)).toBe('Rejected');
  });

  it('jobStatus follows the clock: funded, submitted, then settleable', () => {
    const d = deal();
    expect(j.jobStatus(d, T0 + 10n)).toMatchObject({ status: 'Funded', canSubmit: true, canComplete: true, settleable: false });
    expect(j.jobStatus(d, T0 + 7_201n)).toMatchObject({ status: 'Expired', outcome: 'SellerDefault', settleable: true, canSubmit: false });
    const m = { ...d, state: 'Marked' as const, markedAt: T0 + 60n };
    expect(j.jobStatus(m, T0 + 100n)).toMatchObject({ status: 'Submitted', canComplete: true, completeBy: T0 + 7_200n });
    expect(j.jobStatus(m, T0 + 7_201n)).toMatchObject({ status: 'Rejected', outcome: 'Unconfirmed', settleable: true });
    const s = { ...d, state: 'Settled' as const, outcome: 'Accepted' as const, owedSeller: 400_000n };
    expect(j.jobStatus(s, T0)).toMatchObject({ status: 'Completed', settleable: false, canComplete: false });
  });

  it('job API returns the existing Bond v2 instructions, byte for byte', () => {
    const d = deal();
    const r = ref(d);
    const terms: v2.OpenTermsV2 = { price: d.price, sellerBond: d.sellerBond, buyerDeposit: d.buyerDeposit, deliverBy: d.deliverBy, grace: d.grace,
      reviewWindow: d.reviewWindow, sellerShareBps: 0, arbiterWindow: 0n, jobHash: d.jobHash };
    const acc = { sellerToken: key(), buyerToken: key(), sellerPayout: d.sellerPayout, buyerPayout: d.buyerPayout };
    expect(j.createJob(r, acc, terms).data).toEqual(v2.openV2(r, acc, terms).data);
    expect(j.fund).toBe(j.createJob);
    expect(j.submit(r, new Uint8Array(32).fill(1)).data).toEqual(v2.markDeliveredV2(r, new Uint8Array(32).fill(1)).data);
    const bt = key();
    expect(j.complete(r, bt, d.sellerPayout).keys).toEqual(v2.acceptV2(r, bt, d.sellerPayout).keys);
    expect(j.claimRefund(r, d, T0 + 10n)).toBeNull();
    expect(j.claimRefund(r, d, T0 + 7_201n)?.map((i) => i.data)).toEqual(v2.settleAndClaimV2(r, d, T0 + 7_201n)!.map((i) => i.data));
  });

  it('reject sends nothing and keeps a reason record (default other)', () => {
    const d = { ...deal(), state: 'Marked' as const, markedAt: T0 + 60n };
    const rec = j.reject(d, 'Deal111', T0 + 100n);
    expect(rec).toMatchObject({ reason: 'other', machineCheckable: false, expectedOutcome: 'Unconfirmed', settleAfter: String(T0 + 7_200n) });
    expect(j.reject(deal(), 'Deal111', T0, 'deadline_missed', '  late  ')).toMatchObject({ reason: 'deadline_missed', machineCheckable: true, note: 'late', expectedOutcome: 'SellerDefault' });
    expect(() => j.reject({ ...d, state: 'Settled', outcome: 'Accepted' }, 'x', T0)).toThrow(/settled/);
  });

  it('schema subset', () => {
    const s: j.JobSchema = { type: 'object', required: ['rows'], properties: { rows: { type: 'array', items: { type: 'object', required: ['tx'] } }, n: { type: 'integer' } } };
    expect(j.matchesJobSchema('{"rows":[{"tx":"a"}],"n":1}', s)).toEqual([]);
    expect(j.matchesJobSchema('{"rows":[{}],"n":1.5}', s)).toEqual(['$.rows[0].tx is missing', '$.n must be integer']);
    expect(j.matchesJobSchema('not json', s)).toEqual(['result is not JSON']);
    expect(j.schemaProblems('b', { enum: ['a'] })).toEqual(['$ is not an allowed value']);
  });

  it('machine check: complete on a matching signed delivery, reject with machine reasons otherwise', async () => {
    const schema: j.JobSchema = { type: 'object', required: ['ok'] };
    const good = await delivered(deal(), '{"ok":true}');
    expect(await j.machineCheck({ deal: good.marked, dealAddress: good.addr, now: T0 + 100n, delivery: good.delivery, schema })).toEqual({ action: 'complete', reasons: [], problems: [] });
    // schema mismatch
    const bad = await delivered(deal(), '{"nope":1}');
    expect(await j.machineCheck({ deal: bad.marked, dealAddress: bad.addr, now: T0 + 100n, delivery: bad.delivery, schema })).toMatchObject({ action: 'reject', reasons: ['schema_mismatch'] });
    // tampered result -> receipt mismatch
    const tampered = { ...good.delivery, result: '{"ok":false}' };
    expect(await j.machineCheck({ deal: good.marked, dealAddress: good.addr, now: T0 + 100n, delivery: tampered })).toMatchObject({ action: 'reject', reasons: ['receipt_mismatch'] });
    // seller reports failure -> receipt mismatch
    const failed = await delivered(deal(), 'x', 'job_failed');
    expect((await j.machineCheck({ deal: failed.marked, dealAddress: failed.addr, now: T0 + 100n, delivery: failed.delivery })).reasons).toEqual(['receipt_mismatch']);
    // no delivery: wait before deliver_by, not_delivered after
    expect((await j.machineCheck({ deal: good.marked, dealAddress: good.addr, now: T0 + 100n, delivery: null })).action).toBe('wait');
    expect(await j.machineCheck({ deal: good.marked, dealAddress: good.addr, now: T0 + 3_700n, delivery: null })).toMatchObject({ action: 'reject', reasons: ['not_delivered'] });
    // never submitted: time decides
    expect(await j.machineCheck({ deal: deal(), dealAddress: 'x', now: T0 + 7_201n, delivery: null })).toMatchObject({ action: 'settle', reasons: ['deadline_missed'] });
    expect((await j.machineCheck({ deal: deal(), dealAddress: 'x', now: T0 + 10n, delivery: null })).action).toBe('wait');
  });

  it('machine check does not complete after the review window (arbiter window still open)', async () => {
    const g = await delivered(deal({ arbiter: key(), arbiterWindow: 3_600n }), '{"ok":true}');
    const v = await j.machineCheck({ deal: g.marked, dealAddress: g.addr, now: T0 + 7_300n, delivery: g.delivery });
    expect(v.action).toBe('wait');
  });
});
