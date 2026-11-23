// Agent402 Bond Job Protocol v1 end to end, in one process: seller (pay-server bondJobHandler) ↔ buyer agent (pay-mcp bond_job_*),
// over a fake chain that records open and mark like the program. Includes a lying seller and bad requests.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { createKeyPairSignerFromBytes, signBytes } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { checkJobQuote, deliverMessage, JOB_PROTOCOL, toBase64, verifyDeliverSignature } from '@agent402-dev/bond-client/job';
import { bondJobService, createBondSeller, JOB_FAILED, JobFailed, memoryBondStore, type BondJobStore, type BondSigner, type BondTermsConfig } from '@agent402-dev/pay-server/bond';
import { t2 } from '@agent402-dev/bond-client/rules';
import { BOND_PROGRAM } from '@agent402-dev/pay-mcp/bond';
import { bondConfirmAndPay, bondPolicyFromEnv } from '@agent402-dev/pay-mcp/bond-sign';
import { bondJobQuote, bondJobResult, bondJobStart, type BondJobDeps } from '@agent402-dev/pay-mcp/bond-job';
import { jsonlHistory } from '@agent402-dev/pay-mcp/history';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';
import { BH, chain, NOW } from './helpers/bond-fake-chain.js';

const U = 1_000_000n;
const TERMS: BondTermsConfig = { price: 20n * U, sellerBond: 2n * U, buyerDeposit: 5n * U, deliverSeconds: 600n, lateWindow: 0n, payWindow: 86_400n };

const sellerKp = Keypair.generate(), buyerKp = Keypair.generate();
const signer: BondSigner = { publicKey: sellerKp.publicKey, async signTransaction(tx) { tx.partialSign(sellerKp); return tx; } };
const BASE = 'https://seller.test/jobs/words';

type Svc = Partial<Parameters<typeof bondJobService>[0]>;
async function world(o: { sellerTerms?: BondTermsConfig; tamper?: (path: string, body: any) => any; env?: Record<string, string>; buyer?: Keypair; job?: (input: string, ctx: { signal: AbortSignal }) => Promise<unknown>; svc?: Svc; store?: BondJobStore; c?: ReturnType<typeof chain> } = {}) {
  const c = o.c ?? chain();
  const seller = createBondSeller({ rpcUrl: 'http://rpc', signer, terms: o.sellerTerms ?? TERMS, fetchImpl: c.rpcFetch, store: o.store });
  let jobs = 0;
  const service = bondJobService({ seller, basePath: '/jobs/words', description: 'Counts words', ...o.svc,
    doJob: async (input, ctx) => { jobs++; return o.job ? o.job(input, ctx) : { words: input.trim().split(/\s+/).length }; } });
  const handler = service.handle;
  // The quote always advertises TERMS (a lying seller may run other terms).
  const sellerFetch = (async (url: string, init?: RequestInit) => {
    const res = (await handler(new Request(url, init)))!;
    const path = new URL(url).pathname;
    if (path.endsWith('/quote')) { const q = await res.json(); return Response.json({ ...q, buyerDeposit: String(TERMS.buyerDeposit) }); }
    if (o.tamper && res.status === 200) return Response.json(o.tamper(path, await res.json()));
    return res;
  }) as unknown as typeof fetch;
  const policy = policyFromEnv({ X402_ALLOWED_DOMAINS: 'seller.test', X402_MAX_USD_PER_DAY: '100', ...o.env });
  const kp = o.buyer ?? buyerKp;
  const kit = await createKeyPairSignerFromBytes(kp.secretKey);
  const d: BondJobDeps = {
    policy, bond: bondPolicyFromEnv({ X402_BOND_SELLERS: sellerKp.publicKey.toBase58(), X402_BOND_MAX_USD: '50', ...o.env }),
    signer: { address: kit.address, async signBytes(m) { return new Uint8Array(await signBytes(kit.keyPair.privateKey, m)); } },
    rpc: { async latestBlockhash() { return BH; }, async sendAndConfirm(tx) { c.apply(tx); return 'SIG'; } },
    history: jsonlHistory(join(mkdtempSync(join(tmpdir(), 'job-')), 'h.jsonl'), () => policy.mints),
    confirm: async () => 'accept',
    accounts: async (as) => as.map((a) => (c.accounts.has(a) ? { owner: BOND_PROGRAM, data: c.accounts.get(a)! } : null)),
    clock: async () => NOW, wallet: kit.address, fetch: sellerFetch,
  };
  return { c, d, handler, service, seller, jobs: () => jobs };
}

describe('protocol helpers', () => {
  it('deliver message starts with 0xff (never a transaction) and signatures verify', async () => {
    const O = 'https://seller.test', now = 1_000_000, exp = now + 300;
    const m = deliverMessage('Deal111', O, exp);
    expect(m[0]).toBe(0xff);
    const kit = await createKeyPairSignerFromBytes(buyerKp.secretKey);
    const sig = toBase64(new Uint8Array(await signBytes(kit.keyPair.privateKey, m)));
    const v = (pk: Keypair, deal: string, origin: string, e: number, at = now) => verifyDeliverSignature(pk.publicKey.toBytes(), deal, origin, e, sig, at);
    expect(await v(buyerKp, 'Deal111', O, exp)).toBe(true);
    expect(await v(buyerKp, 'Deal222', O, exp)).toBe(false);
    expect(await v(sellerKp, 'Deal111', O, exp)).toBe(false);
    expect(await v(buyerKp, 'Deal111', 'https://other.test', exp)).toBe(false); // replayed to another server
    expect(await v(buyerKp, 'Deal111', O, exp, exp + 1)).toBe(false); // expired
    expect(await v(buyerKp, 'Deal111', O, exp + 10_000)).toBe(false); // expiry too far ahead
  });
  it('quote shape checks', () => {
    expect(checkJobQuote({ protocol: 'x' })).toContain(`protocol must be ${JOB_PROTOCOL}`);
  });
});

describe('job flow', () => {
  it('quote → start → result: deposit locked, work delivered, delivery marked by the seller; result is idempotent', async () => {
    const w = await world();
    const q = await bondJobQuote(w.d, BASE);
    expect(q).toMatchObject({ result: 'ok', price: '20 USDC', depositNow: '5 USDC', description: 'Counts words' });
    const s = await bondJobStart(w.d, BASE, 'agents lock a bond before work');
    expect(s.result).toBe('opened');
    const deal = (s as { deal: string }).deal;
    expect(w.c.sent).toEqual([{ by: sellerKp.publicKey.toBase58(), kind: 'open' }]);
    const r = await bondJobResult(w.d, BASE, deal);
    expect(r).toMatchObject({ result: 'delivered', work: { words: 6 } });
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
    const again = await bondJobResult(w.d, BASE, deal);
    expect(again).toMatchObject({ result: 'delivered', work: { words: 6 } });
    expect(w.jobs()).toBe(1);
  });

  it('refuses a domain that is not allowed, before any request', async () => {
    const w = await world({ env: { X402_ALLOWED_DOMAINS: 'other.test' } });
    expect(JSON.stringify(await bondJobStart(w.d, BASE, 'x'))).toContain('domain not allowed');
    expect(w.c.sent).toHaveLength(0);
  });

  it('refuses a seller that opens with a bigger deposit than quoted', async () => {
    const w = await world({ sellerTerms: { ...TERMS, buyerDeposit: 10n * U } });
    const s = await bondJobStart(w.d, BASE, 'x');
    expect(JSON.stringify(s)).toContain('buyerDeposit differs from the quote');
    expect(w.c.sent).toHaveLength(0);
  });

  it('refuses when the reported terms do not match the transaction', async () => {
    const w = await world({ tamper: (path, b) => (path.endsWith('/open') ? { ...b, terms: { ...b.terms, deliverBy: String(NOW + 100n) } } : b) });
    expect(JSON.stringify(await bondJobStart(w.d, BASE, 'x'))).toContain('transaction terms differ');
    expect(w.c.sent).toHaveLength(0);
  });

  it('refuses when the reported deal address is not the one in the transaction', async () => {
    const w = await world({ tamper: (path, b) => (path.endsWith('/open') ? { ...b, deal: Keypair.generate().publicKey.toBase58() } : b) });
    expect(JSON.stringify(await bondJobStart(w.d, BASE, 'x'))).toContain('deal address does not match');
  });
});

describe('seller handler', () => {
  it('deliver: bad signature 401, unknown deal 404, not open on chain 409; quote is well formed', async () => {
    const w = await world();
    const q = await (await w.handler(new Request(`${BASE}/quote`)))!.json();
    expect(checkJobQuote(q)).toEqual([]);
    const open = await (await w.handler(new Request(`${BASE}/open`, { method: 'POST', body: JSON.stringify({ buyer: buyerKp.publicKey.toBase58(), input: 'hi' }) })))!.json();
    const post = (b: unknown) => w.handler(new Request(`${BASE}/deliver`, { method: 'POST', body: JSON.stringify(b) }));
    const exp = Math.floor(Date.now() / 1000) + 300;
    expect((await post({ deal: open.deal, expires: exp, signature: toBase64(new Uint8Array(64)) }))!.status).toBe(401);
    expect((await post({ deal: Keypair.generate().publicKey.toBase58(), signature: '' }))!.status).toBe(404);
    const kit = await createKeyPairSignerFromBytes(buyerKp.secretKey);
    const sig = toBase64(new Uint8Array(await signBytes(kit.keyPair.privateKey, deliverMessage(open.deal, 'https://seller.test', exp))));
    expect((await post({ deal: open.deal, expires: exp, signature: sig }))!.status).toBe(409); // the buyer has not sent open yet
    expect(w.jobs()).toBe(0);
    expect(await w.handler(new Request('https://seller.test/other'))).toBeNull();
    expect((await w.handler(new Request(`${BASE}/open`, { method: 'POST', body: JSON.stringify({ buyer: 'nope', input: 'x' }) })))!.status).toBe(400);
  });

  it('a wallet that is not the buyer cannot fetch the result', async () => {
    const w = await world();
    const s = await bondJobStart(w.d, BASE, 'x y');
    const other = await world({ buyer: Keypair.generate() });
    other.c.accounts.set((s as { deal: string }).deal, w.c.accounts.get((s as { deal: string }).deal)!);
    expect(JSON.stringify(await bondJobResult(other.d, BASE, (s as { deal: string }).deal))).toContain('not the buyer');
  });
});

describe('seller does not depend on the buyer fetching the result', () => {
  it('a buyer who opens and never asks for the result cannot take the bond: the seller delivers and marks on its own', async () => {
    const w = await world();
    const s = await bondJobStart(w.d, BASE, 'one two three');
    const deal = (s as { deal: string }).deal;
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open']);
    // The buyer stays silent. The seller's timer runs:
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
    expect(w.c.sent[1].by).toBe(sellerKp.publicKey.toBase58());
    // A second run does nothing; the buyer can still fetch the same result later; the job ran once.
    expect(await w.service.processOpenJobs()).toEqual([]);
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'delivered', work: { words: 3 } });
    expect(w.jobs()).toBe(1);
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
  });

  it('prepared deals the buyer never opened are skipped (no work, nothing sent)', async () => {
    const w = await world();
    await w.handler(new Request(`${BASE}/open`, { method: 'POST', body: JSON.stringify({ buyer: buyerKp.publicKey.toBase58(), input: 'x' }) }));
    const r = await w.service.processOpenJobs();
    expect(r.map((x) => x.status)).toEqual(['not_open']);
    expect(w.jobs()).toBe(0);
    expect(w.c.sent).toHaveLength(0);
  });

  it('concurrent deliver calls run the job once', async () => {
    const w = await world();
    const s = await bondJobStart(w.d, BASE, 'a b');
    const deal = (s as { deal: string }).deal;
    const [a, b] = await Promise.all([bondJobResult(w.d, BASE, deal), w.service.processOpenJobs()]);
    expect(a).toMatchObject({ result: 'delivered' });
    expect(b).toEqual([{ deal, status: 'delivered' }]);
    expect(w.jobs()).toBe(1);
    expect(w.c.sent.filter((x) => x.kind === 'mark')).toHaveLength(1);
  });
});

describe('running a seller for real: failures, long jobs, cleanup, settling', () => {
  const start = async (w: Awaited<ReturnType<typeof world>>, input = 'a b c') => (await bondJobStart(w.d, BASE, input) as { deal: string }).deal;

  it('a failing job is recorded and retried on the next run', async () => {
    let fail = true;
    const w = await world({ job: async () => { if (fail) throw new Error('model timeout'); return { ok: 1 }; } });
    const deal = await start(w);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'working' }]);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ attempts: 1, lastError: 'model timeout' });
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open']); // nothing marked for failed work
    fail = false;
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ attempts: 2, delivered: true });
  });

  it('if marking fails after the work, the next run only retries the mark (the job is not run again)', async () => {
    const w = await world();
    const deal = await start(w);
    w.c.opts.failNextMark = true;
    expect((await w.service.processOpenJobs())[0]).toMatchObject({ deal, status: 'error' });
    expect(w.jobs()).toBe(1);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect(w.jobs()).toBe(1);
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
  });

  it('a long job: deliver answers "working" (202) while it runs, then the result', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const w = await world({ job: async () => { await gate; return { done: true }; } });
    const deal = await start(w);
    const run = w.service.processOpenJobs();
    await new Promise((r) => setTimeout(r, 20));
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'working' });
    release();
    await run;
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'delivered', work: { done: true } });
    expect(w.jobs()).toBe(1);
  });

  it('prepared deals never opened are dropped after the TTL', async () => {
    const w = await world({ svc: { prepareTtlSeconds: 300 } });
    const o = await (await w.handler(new Request(`${BASE}/open`, { method: 'POST', body: JSON.stringify({ buyer: buyerKp.publicKey.toBase58(), input: 'x' }) })))!.json();
    expect((await w.service.processOpenJobs()).map((x) => x.status)).toEqual(['not_open']);
    const j = (await w.seller.store.get(o.deal))!;
    await w.seller.store.put({ ...j, preparedAt: new Date(Date.now() - 301_000).toISOString() });
    expect((await w.service.processOpenJobs()).map((x) => x.status)).toEqual(['expired']);
    expect(await w.seller.store.list()).toHaveLength(0);
    expect(await w.service.processOpenJobs()).toEqual([]);
  });

  it('after the buyer confirms and pays, the seller settles and claims on its own, then stops tracking', async () => {
    const w = await world();
    const deal = await start(w);
    await w.service.processOpenJobs(); // delivered + marked
    expect((await bondConfirmAndPay(w.d, deal)).result).toBe('confirmed_and_paid');
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'settled' }]);
    expect(w.c.sent.map((x) => `${x.kind}`)).toEqual(['open', 'mark', 'confirm', 'pay', 'settle', 'claim_buyer', 'claim']);
    expect(w.c.sent.at(-1)!.by).toBe(sellerKp.publicKey.toBase58()); // the seller paid for settling
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'closed' }]);
    expect(await w.service.processOpenJobs()).toEqual([]);
  });

  it('a deal settled by someone else but not claimed: the seller claims', async () => {
    const w = await world();
    const deal = await start(w);
    await w.service.processOpenJobs();
    w.c.accounts.get(deal)![187] = 3; // decided (disputed) by someone's settle, claims not sent
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'settled' }]);
    expect(w.c.accounts.has(deal)).toBe(false);
  });
});

describe('security review fixes (seller side)', () => {
  const start = async (w: Awaited<ReturnType<typeof world>>, input = 'a b c') => (await bondJobStart(w.d, BASE, input) as { deal: string }).deal;
  const openReq = (w: Awaited<ReturnType<typeof world>>, buyer = buyerKp.publicKey.toBase58(), input = 'x') =>
    w.handler(new Request(`${BASE}/open`, { method: 'POST', body: JSON.stringify({ buyer, input }) }));

  it('H-1: an input that always makes the job fail does not cost the bond: after maxAttempts the failure is delivered and marked', async () => {
    const w = await world({ job: async () => { throw new Error('crash on this input'); } });
    const deal = await start(w);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'working' }]);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'working' }]);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]); // 3rd failure: give up and mark
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ failed: true, result: JOB_FAILED });
    // The buyer's tool tells it not to confirm
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'failed' });
  });

  it('H-1: a job that hangs is aborted after jobTimeoutSeconds (and the signal fires)', async () => {
    let aborted = false;
    const w = await world({ svc: { jobTimeoutSeconds: 0.05, maxAttempts: 1 }, job: (_i, ctx) => new Promise(() => { ctx.signal.addEventListener('abort', () => { aborted = true; }); }) });
    const deal = await start(w);
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect(aborted).toBe(true);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ failed: true, lastError: 'timed out' });
  });

  it('H-1: close to the mark deadline with no result, the seller gives up at once and marks', async () => {
    const w = await world();
    const deal = await start(w);
    const d = (await w.seller.readDeals([deal])).get(deal)!;
    w.c.opts.now = t2(d.terms) - 600n;
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect(w.jobs()).toBe(0);
    expect(w.c.sent.map((x) => x.kind)).toEqual(['open', 'mark']);
  });

  it('H-1: validateInput refuses before any deal is prepared', async () => {
    const w = await world({ svc: { validateInput: (i) => (i.length < 3 ? 'too short' : null) } });
    const r = (await openReq(w, undefined, 'ab'))!;
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'too short' });
    expect(await w.seller.store.list()).toHaveLength(0);
  });

  it('H-2 / M-5: pending deals are capped per buyer and in total (429)', async () => {
    const w = await world({ svc: { maxPendingPerBuyer: 2, maxPending: 3 } });
    expect((await openReq(w))!.status).toBe(200);
    expect((await openReq(w))!.status).toBe(200);
    expect((await openReq(w))!.status).toBe(429);
    expect((await openReq(w, Keypair.generate().publicKey.toBase58()))!.status).toBe(200);
    expect((await openReq(w, Keypair.generate().publicKey.toBase58()))!.status).toBe(429);
    expect(await w.seller.store.list()).toHaveLength(3);
  });

  it('H-2: one failing deal does not stop the others; deals are read in one batch', async () => {
    const w = await world();
    const a = await start(w);
    const b = await start(w, 'x y');
    let batches = 0;
    const inner = w.c.rpcFetch;
    const seller2 = createBondSeller({ rpcUrl: 'http://rpc', signer, terms: TERMS, store: w.seller.store,
      fetchImpl: (async (u: string, init: { body: string }) => { if (JSON.parse(init.body).method === 'getMultipleAccounts') batches++; return (inner as any)(u, init); }) as unknown as typeof fetch });
    let n = 0;
    const svc = bondJobService({ seller: seller2, doJob: async () => { if (n++ === 0) throw new Error('boom'); return { ok: true }; } });
    const r = await svc.processOpenJobs();
    expect(r.map((x) => x.status).sort()).toEqual(['delivered', 'working']);
    expect(new Set(r.map((x) => x.deal))).toEqual(new Set([a, b]));
    expect(batches).toBe(1);
  });

  it('M-3: two processes sharing one store (e.g. two Worker isolates) run a job once', async () => {
    const store = memoryBondStore();
    const c = chain();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let runs = 0;
    const job = async () => { runs++; await gate; return { ok: 1 }; };
    const w1 = await world({ c, store, job });
    const w2 = await world({ c, store, job });
    const deal = await start(w1);
    const p1 = w1.service.processOpenJobs();
    await new Promise((r) => setTimeout(r, 20));
    const r2 = await w2.service.processOpenJobs();
    expect(r2).toEqual([{ deal, status: 'working' }]);
    release();
    expect(await p1).toEqual([{ deal, status: 'delivered' }]);
    expect(runs).toBe(1);
    expect(c.sent.filter((x) => x.kind === 'mark')).toHaveLength(1);
  });

  it("M-4: if the buyer's token account is frozen, the seller still settles and takes its own share", async () => {
    const w = await world();
    const deal = await start(w);
    await w.service.processOpenJobs();
    await bondConfirmAndPay(w.d, deal);
    w.c.opts.failClaimBuyer = true;
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'settled' }]);
    expect(w.c.sent.map((x) => x.kind).slice(-2)).toEqual(['settle', 'claim']);
    expect(w.c.sent.some((x) => x.kind === 'claim_buyer')).toBe(false);
    // The buyer's share stays for the buyer; the seller stops tracking and sends nothing more
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'closed' }]);
    const before = w.c.sent.length;
    expect(await w.service.processOpenJobs()).toEqual([]);
    expect(w.c.sent.length).toBe(before);
  });

  it('L-4: a buyer that confirmed and paid before the work still gets it (no mark), then the seller claims', async () => {
    const w = await world();
    const deal = await start(w);
    await bondConfirmAndPay(w.d, deal);
    w.c.accounts.get(deal)![187] = 1; // settled as delivered by someone, claims not sent
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'settled' }]);
    expect(w.jobs()).toBe(1);
    expect(w.c.sent.some((x) => x.kind === 'mark')).toBe(false);
    expect(w.c.accounts.has(deal)).toBe(false);
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'delivered', work: { words: 3 } });
  });

  it('H-3: a buyer that took delivered work without confirming is refused new deals (failed jobs do not count)', async () => {
    const w = await world({ svc: { maxUnconfirmedPerBuyer: 1 } });
    const deal = await start(w);
    await w.service.processOpenJobs(); // delivered + marked; the buyer never confirms
    w.c.opts.now = NOW + 60n * 86_400n;
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'settled' }]);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ unconfirmed: true });
    const r = (await openReq(w))!;
    expect(r.status).toBe(403);
    expect((await openReq(w, Keypair.generate().publicKey.toBase58()))!.status).toBe(200);

    const f = await world({ svc: { maxUnconfirmedPerBuyer: 1, maxAttempts: 1 }, job: async () => { throw new Error('x'); } });
    const fd = await start(f);
    await f.service.processOpenJobs(); // job_failed delivered + marked
    f.c.opts.now = NOW + 60n * 86_400n;
    await f.service.processOpenJobs();
    expect((await f.seller.store.get(fd))!.meta).not.toHaveProperty('unconfirmed');
    expect((await openReq(f))!.status).toBe(200);
  });

  it('L-7: unsafe settings are refused', async () => {
    const c = chain();
    const s = createBondSeller({ rpcUrl: 'http://rpc', signer, terms: TERMS, fetchImpl: c.rpcFetch });
    expect(() => bondJobService({ seller: s, doJob: async () => 1, prepareTtlSeconds: 10 })).toThrow(/at least 300/);
    expect(() => createBondSeller({ rpcUrl: 'x', signer, terms: { ...TERMS, deliverSeconds: 5n } })).toThrow(/60 seconds/);
    expect(() => createBondSeller({ rpcUrl: 'x', signer, terms: { ...TERMS, price: 200n * U, sellerBond: 20n * U } })).toThrow(/100 USDC/);
  });
});

describe('delivered results while another process holds the lease', () => {
  it('a stored result is returned at once, even if the lease is still held elsewhere', async () => {
    const store = memoryBondStore();
    const w = await world({ store });
    const deal = (await bondJobStart(w.d, BASE, 'a b') as { deal: string }).deal;
    await w.service.processOpenJobs(); // delivered + marked
    expect(await store.lock!(deal, 60_000)).toBe(true); // another isolate still holds the lease
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'delivered', work: { words: 2 } });
  });
});

describe('JobFailed', () => {
  it('a permanent failure is delivered and marked at once, with its message, and does not count against the buyer', async () => {
    const w = await world({ job: async () => { throw new JobFailed('more than 1000 transactions in this range'); } });
    const deal = (await bondJobStart(w.d, BASE, 'x') as { deal: string }).deal;
    expect(await w.service.processOpenJobs()).toEqual([{ deal, status: 'delivered' }]);
    expect((await w.seller.store.get(deal))!.meta).toMatchObject({ failed: true, attempts: 1, result: { error: 'job_failed', message: 'more than 1000 transactions in this range' } });
    expect(await bondJobResult(w.d, BASE, deal)).toMatchObject({ result: 'failed' });
  });
});
