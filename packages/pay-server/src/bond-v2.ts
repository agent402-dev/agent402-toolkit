// Agent402 Bond v2, seller side, with the Job Protocol v2 (entry: @agent402-dev/pay-server/bond-v2).
// Quote, prepare `open` (job hash bound to the buyer's exact input), work, mark delivery with the output hash, sign the
// output hash for the buyer, and settle/claim. Same store, JobPending/JobFailed and timer model as the v1 seller.
// This module never takes or stores a private key: you pass a signer that can sign transactions and raw messages.
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import * as v2 from '@agent402-dev/bond-client/v2';
import {
  JOB_MAX_INPUT_V2, JOB_PROTOCOL_V2, type JobDeliveryV2, type JobOpenV2, type JobQuoteV2, type JobStatusV2, type JobTermsV2,
  jobHashV2, outputHashV2, outputMessageV2, toBase64, toHex, fromHex, verifyDeliverSignatureV2,
} from '@agent402-dev/bond-client/job-v2';
import { JobFailed, JobPending, memoryBondStore, type BondJob, type BondJobStore } from './bond.js';

export { JobFailed, JobPending };

export interface BondSignerV2 {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** ed25519 signature over raw bytes (the output message starts with 0xff, so it can never be a transaction) */
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export interface BondTermsV2Config {
  /** smallest units of the mint */
  price: bigint; sellerBond: bigint; buyerDeposit: bigint;
  /** seconds */
  deliverSeconds: bigint; grace: bigint; reviewWindow: bigint;
  /** share of the buyer deposit you keep if a delivered job is never accepted (0 = neutral, default) */
  sellerShareBps?: number;
  arbiter?: PublicKey | null;
  arbiterWindow?: bigint;
}

export function checkBondTermsV2(t: BondTermsV2Config): string[] {
  const L = v2.LIMITS_V2;
  const out: string[] = [];
  if (t.price <= 0n) out.push('price must be positive');
  if (t.sellerBond <= 0n) out.push('seller bond must be positive');
  if (t.sellerBond * 10_000n > t.price * L.maxBondBps) out.push('seller bond is at most 20% of the price');
  if (t.buyerDeposit < 0n || t.buyerDeposit > t.price) out.push('deposit must be between 0 and the price');
  if (t.deliverSeconds < 60n || t.deliverSeconds > L.maxDeliver) out.push('deliverSeconds must be between 60 seconds and 30 days');
  if (t.grace < L.graceMin || t.grace > L.graceMax) out.push('grace must be 1 hour .. 1 day');
  if (t.reviewWindow < L.reviewMin || t.reviewWindow > L.reviewMax) out.push('reviewWindow must be 1 hour .. 7 days');
  const bps = t.sellerShareBps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) out.push('sellerShareBps must be 0..10000');
  const aw = t.arbiterWindow ?? 0n;
  if (t.arbiter) { if (aw < L.arbiterMin || aw > L.arbiterMax) out.push('arbiterWindow must be 1 hour .. 7 days with an arbiter'); }
  else if (aw !== 0n) out.push('arbiterWindow must be 0 without an arbiter');
  return out;
}

export interface BondSellerV2Config {
  rpcUrl: string;
  /** The Bond v2 program: BOND_V2_DEPLOYED from @agent402-dev/bond-client/v2 (or a test build on a local fork) */
  programId: PublicKey;
  signer: BondSignerV2;
  terms: BondTermsV2Config;
  mint: PublicKey;
  tokenProgram: PublicKey;
  /** Where you are paid (default: your associated token account) */
  sellerPayout?: PublicKey;
  /** Where your bond comes from (default: your associated token account) */
  sellerToken?: PublicKey;
  /** Plain text bound into every job hash (at most 500 characters) */
  description?: string;
  store?: BondJobStore;
  fetchImpl?: typeof fetch;
}

interface V2Fields { protocol: 2; jobHash: string; outputHash?: string; status?: JobStatusV2; sellerSignature?: string; result?: string }
const v2meta = (j: BondJob) => ((j.meta ?? {}) as { v2?: V2Fields }).v2;

export function createBondSellerV2(cfg: BondSellerV2Config) {
  const bad = checkBondTermsV2(cfg.terms);
  if (bad.length) throw new Error(`bond v2 terms: ${bad.join('; ')}`);
  if (cfg.description !== undefined && [...cfg.description].length > 500) throw new Error('description is at most 500 characters');
  const f = cfg.fetchImpl ?? fetch;
  const store = cfg.store ?? memoryBondStore();
  const seller = cfg.signer.publicKey;
  const program = cfg.programId;
  const { mint, tokenProgram } = cfg;
  const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const ata = (owner: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];
  const sellerPayout = cfg.sellerPayout ?? ata(seller);
  const sellerToken = cfg.sellerToken ?? ata(seller);
  const t = { sellerShareBps: 0, arbiter: null, arbiterWindow: 0n, ...cfg.terms };

  let id = 0;
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const r = await f(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error || j.result === undefined) throw new Error(`rpc ${method}: ${j.error?.message ?? r.status}`);
    return j.result;
  }
  const chainNow = async () => {
    const v = (await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64', commitment: 'confirmed' }])).value;
    if (!v) throw new Error('clock not available');
    return Buffer.from(v.data[0], 'base64').readBigInt64LE(32);
  };
  const blockhash = async () => (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  async function readDeals(deals: string[]): Promise<Map<string, v2.DealV2 | null>> {
    const out = new Map<string, v2.DealV2 | null>();
    for (let i = 0; i < deals.length; i += 100) {
      const chunk = deals.slice(i, i + 100);
      const v = (await rpc<{ value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }])).value;
      chunk.forEach((d, k) => {
        const a = v[k];
        let st: v2.DealV2 | null = null;
        if (a && a.owner === program.toBase58()) { try { st = v2.decodeDealV2(Uint8Array.from(Buffer.from(a.data[0], 'base64'))); } catch { st = null; } }
        out.set(d, st);
      });
    }
    return out;
  }
  const readDeal = async (deal: string) => (await readDeals([deal])).get(deal) ?? null;
  async function send(ixs: TransactionInstruction[]): Promise<string> {
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = await blockhash();
    tx.feePayer = seller;
    const signed = await cfg.signer.signTransaction(tx);
    const sig = await rpc<string>('sendTransaction', [signed.serialize().toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }]);
    for (let i = 0; i < 90; i++) {
      const st = (await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>('getSignatureStatuses', [[sig]])).value[0];
      if (st?.err) throw new Error(`transaction ${sig} failed: ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
      await new Promise((res) => setTimeout(res, 1000));
    }
    throw new Error(`transaction ${sig} not confirmed in time (it may still land; check before retrying)`);
  }
  const ref = (buyer: PublicKey, nonce: bigint): v2.DealRef => ({ seller, buyer, nonce, mint, tokenProgram, programId: program });
  const refOf = (j: BondJob) => ref(new PublicKey(j.buyer), BigInt(j.nonce));
  async function job(deal: string) {
    const j = await store.get(deal);
    if (!j || !v2meta(j)) throw new Error('unknown deal (not prepared by this v2 seller)');
    return j;
  }
  /** True if the on-chain deal is the one prepared for this job (parties, mint, payout, terms and job hash). */
  async function matches(deal: string, d: v2.DealV2) {
    const j = await job(deal);
    return d.seller.equals(seller) && d.buyer.toBase58() === j.buyer && d.mint.equals(mint) && d.sellerPayout.equals(sellerPayout)
      && String(d.price) === j.terms.price && String(d.sellerBond) === j.terms.sellerBond && String(d.buyerDeposit) === j.terms.buyerDeposit
      && String(d.deliverBy) === j.terms.deliverBy && d.grace === t.grace && d.reviewWindow === t.reviewWindow && d.sellerShareBps === t.sellerShareBps
      && (d.arbiter?.toBase58() ?? null) === (t.arbiter?.toBase58() ?? null) && d.arbiterWindow === t.arbiterWindow
      && toHex(d.jobHash) === v2meta(j)!.jobHash;
  }

  return {
    seller: seller.toBase58(),
    store,
    programId: program.toBase58(),
    /** The v2 quote (without protocol/description; the job service adds them). */
    quote(): Omit<JobQuoteV2, 'protocol' | 'description'> {
      return {
        program: program.toBase58(), seller: seller.toBase58(), sellerPayout: sellerPayout.toBase58(), mint: mint.toBase58(), tokenProgram: tokenProgram.toBase58(),
        price: String(t.price), sellerBond: String(t.sellerBond), buyerDeposit: String(t.buyerDeposit),
        deliverSeconds: String(t.deliverSeconds), grace: String(t.grace), reviewWindow: String(t.reviewWindow),
        sellerShareBps: t.sellerShareBps, arbiter: t.arbiter?.toBase58() ?? null, arbiterWindow: String(t.arbiterWindow),
      };
    },
    description: cfg.description,
    /** Builds and signs `open` for this buyer and input. The job hash binds the exact input; keep it as sent. */
    async prepareOpen(buyer: string, input: string, meta?: Record<string, unknown>): Promise<JobOpenV2> {
      const b = new PublicKey(buyer);
      if (b.equals(seller)) throw new Error('buyer and seller must differ');
      const nonce = BigInt.asUintN(64, BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`));
      const deliverBy = (await chainNow()) + t.deliverSeconds;
      const jobHash = await jobHashV2({ program: program.toBase58(), seller: seller.toBase58(), buyer, nonce, deliverBy, input, description: cfg.description ?? '' });
      const r = ref(b, nonce);
      const buyerAta = ata(b);
      const tx = new Transaction().add(v2.openV2(r, { sellerToken, buyerToken: buyerAta, sellerPayout, buyerPayout: buyerAta }, {
        price: t.price, sellerBond: t.sellerBond, buyerDeposit: t.buyerDeposit, deliverBy, grace: t.grace, reviewWindow: t.reviewWindow,
        sellerShareBps: t.sellerShareBps, arbiter: t.arbiter ?? undefined, arbiterWindow: t.arbiterWindow, jobHash,
      }));
      tx.recentBlockhash = await blockhash();
      tx.feePayer = seller;
      const signed = await cfg.signer.signTransaction(tx);
      const deal = v2.dealOfV2(r).toBase58();
      const terms: JobTermsV2 = {
        price: String(t.price), sellerBond: String(t.sellerBond), buyerDeposit: String(t.buyerDeposit), deliverBy: String(deliverBy), grace: String(t.grace),
        reviewWindow: String(t.reviewWindow), sellerShareBps: t.sellerShareBps, arbiter: t.arbiter?.toBase58() ?? null, arbiterWindow: String(t.arbiterWindow),
      };
      await store.put({
        deal, buyer, nonce: String(nonce), preparedAt: new Date().toISOString(),
        terms: { price: terms.price, sellerBond: terms.sellerBond, buyerDeposit: terms.buyerDeposit, deliverBy: terms.deliverBy, lateWindow: '0', payWindow: '0' },
        meta: { ...(meta ?? {}), input, v2: { protocol: 2, jobHash: toHex(jobHash) } satisfies V2Fields },
      });
      return { deal, nonce: String(nonce), terms, jobHash: toHex(jobHash), transaction: signed.serialize({ requireAllSignatures: false }).toString('base64') };
    },
    readDeals,
    chainNow,
    matches,
    /**
     * Commits the result on chain (output hash in mark_delivered) and signs the output hash. Idempotent: once marked,
     * returns the stored delivery. The result is a string; keep exactly these bytes for the buyer.
     */
    async markDelivered(deal: string, status: JobStatusV2, result: string): Promise<{ markTx: string | null; delivery: JobDeliveryV2 }> {
      const j = await job(deal);
      const m = v2meta(j)!;
      if (m.outputHash && m.sellerSignature && m.status && m.result !== undefined) {
        return { markTx: j.markTx ?? null, delivery: { deal, status: m.status, result: m.result, outputHash: m.outputHash, sellerSignature: m.sellerSignature, markTx: j.markTx ?? null } };
      }
      const d = await readDeal(deal);
      if (!d || !(await matches(deal, d))) throw new Error('on-chain deal does not match the prepared job');
      if (d.state !== 'Open') throw new Error(`cannot mark: deal is ${d.state}`);
      if ((await chainNow()) > v2.markDeadlineV2(d)) throw new Error('too late to mark: the mark deadline has passed');
      const oh = await outputHashV2(deal, fromHex(m.jobHash), status, result);
      const sig = toBase64(await cfg.signer.signMessage(outputMessageV2(deal, oh)));
      const markTx = await send([v2.markDeliveredV2(refOf(j), oh)]);
      const next: V2Fields = { ...m, outputHash: toHex(oh), status, result, sellerSignature: sig };
      await store.put({ ...j, markedAt: new Date().toISOString(), markTx, meta: { ...(j.meta as object), v2: next } });
      return { markTx, delivery: { deal, status, result, outputHash: toHex(oh), sellerSignature: sig, markTx } };
    },
    /** Ends the deal neutrally (seller alone; not with an arbiter, not after the mark deadline of an unmarked deal). */
    async release(deal: string) {
      const j = await job(deal);
      return send([v2.sellerReleaseV2(refOf(j))]);
    },
    /** Settles by time if needed and claims what is owed (buyer share first, then yours, which closes the deal). */
    async settleAndClaim(deal: string): Promise<{ tx: string | null; outcome: string }> {
      const j = await job(deal);
      const d = await readDeal(deal);
      if (!d) return { tx: null, outcome: 'closed' };
      const r = refOf(j);
      let ixs: TransactionInstruction[];
      let outcome: string;
      if (d.state === 'Settled') { ixs = v2.claimsV2(r, d); outcome = d.outcome ?? 'Settled'; }
      else {
        const p = v2.settleAndClaimV2(r, d, await chainNow());
        if (!p) throw new Error('not settleable yet');
        ixs = p; outcome = v2.timeOutcomeV2(d, await chainNow())!.outcome;
      }
      if (!ixs.length) return { tx: null, outcome };
      const tx = await send(ixs);
      await store.put({ ...j, settleTx: tx });
      return { tx, outcome };
    },
  };
}
export type BondSellerV2 = ReturnType<typeof createBondSellerV2>;

export interface BondJobV2Options {
  seller: BondSellerV2;
  /** The work. Return a string (serialize structured results yourself). Throw JobPending to supply it later with submit. */
  doJob: (input: string, ctx: { deal: string; buyer: string; signal: AbortSignal }) => Promise<string>;
  basePath?: string;
  allowBuyer?: (buyer: string) => boolean | Promise<boolean>;
  validateInput?: (input: string) => string | null | Promise<string | null>;
  prepareTtlSeconds?: number;
  jobTimeoutSeconds?: number;
  maxAttempts?: number;
  maxUnconfirmedPerBuyer?: number;
  maxPendingPerBuyer?: number;
  maxPending?: number;
  publicOrigin?: string;
}

type Meta = { input?: string; result?: string; hasResult?: boolean; failed?: boolean; failMessage?: string; delivered?: boolean; attempts?: number; lastError?: string; closed?: boolean; expired?: boolean; unconfirmed?: boolean; v2?: V2Fields };
const FAILED_TEXT = 'The seller could not complete this job. Do not accept.';

/** Agent402 Bond Job Protocol v2, seller side (same shape as bondJobService: handle, processOpenJobs, submit, decline). */
export function bondJobServiceV2(o: BondJobV2Options) {
  const base = (o.basePath ?? '').replace(/\/+$/, '');
  const ttl = o.prepareTtlSeconds ?? 600;
  const timeoutMs = (o.jobTimeoutSeconds ?? 120) * 1000;
  const maxAttempts = Math.max(1, o.maxAttempts ?? 3);
  const perBuyer = o.maxPendingPerBuyer ?? 3, total = o.maxPending ?? 50, maxUnconfirmed = o.maxUnconfirmedPerBuyer ?? 2;
  const GIVE_UP_BEFORE = 1800n;
  const s = o.seller;
  const store = s.store;
  const q = s.quote();
  const withShare = q.sellerShareBps > 0 && q.arbiter === null;
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const metaOf = (j: BondJob) => (j.meta ?? {}) as Meta;
  const active = (j: BondJob) => !metaOf(j).closed && !metaOf(j).expired;
  async function patch(deal: string, m: Partial<Meta>) { const j = await store.get(deal); if (j) await store.put({ ...j, meta: { ...metaOf(j), ...m } }); }
  const inflight = new Map<string, Promise<JobDeliveryV2 | { status: number; error: string }>>();

  async function finish(deal: string, d: v2.DealV2, status: JobStatusV2, result: string) {
    // With a non-refundable share and no arbiter, a failed job is released (the buyer gets the whole deposit back) instead of marked.
    if (status === 'job_failed' && withShare) {
      await s.release(deal);
      await patch(deal, { delivered: true, failed: true });
      return { status: 410, error: 'job_failed: the deal was released; each side gets its own money back' };
    }
    const r = await s.markDelivered(deal, status, result);
    await patch(deal, { delivered: true });
    return r.delivery;
  }

  function deliverJob(deal: string, known?: v2.DealV2 | null) {
    const running = inflight.get(deal);
    if (running) return running;
    const p = (async () => {
      const j0 = await store.get(deal);
      if (!j0) return { status: 404, error: 'unknown deal' };
      const m0 = metaOf(j0).v2;
      if (metaOf(j0).delivered && m0?.outputHash) return { deal, status: m0.status!, result: m0.result!, outputHash: m0.outputHash, sellerSignature: m0.sellerSignature!, markTx: j0.markTx ?? null };
      if (store.lock && !(await store.lock(deal, timeoutMs + 120_000))) return { status: 202, error: 'working' };
      try {
        const j = (await store.get(deal))!;
        const meta = metaOf(j);
        const d = known !== undefined ? known : (await s.readDeals([deal])).get(deal) ?? null;
        if (!d) return { status: 409, error: 'deal is not on chain' };
        if (!(await s.matches(deal, d))) return { status: 409, error: 'on-chain deal does not match the prepared job' };
        if (d.state !== 'Open') return { status: 409, error: `deal is ${d.state}` };
        if (meta.hasResult) return await finish(deal, d, meta.failed ? 'job_failed' : 'ok', meta.result ?? FAILED_TEXT);
        const attempts = meta.attempts ?? 0;
        const late = (await s.chainNow()) >= v2.markDeadlineV2(d) - GIVE_UP_BEFORE;
        if (attempts >= maxAttempts || late) { await patch(deal, { result: FAILED_TEXT, hasResult: true, failed: true }); return await finish(deal, d, 'job_failed', FAILED_TEXT); }
        const ac = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([o.doJob(meta.input ?? '', { deal, buyer: j.buyer, signal: ac.signal }),
            new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('timed out')); }, timeoutMs); })]);
          if (typeof result !== 'string') throw new JobFailed('the job must return a string');
          await patch(deal, { result, hasResult: true, attempts: attempts + 1 });
          return await finish(deal, d, 'ok', result);
        } catch (e) {
          if ((e as Error)?.name === 'JobPending') return { status: 202, error: 'waiting for the result' };
          const n = attempts + 1;
          await patch(deal, { attempts: n, lastError: String((e as Error).message).slice(0, 300) });
          const permanent = (e as Error)?.name === 'JobFailed';
          if (!permanent && n < maxAttempts) return { status: 202, error: 'the job failed; it will be retried' };
          const text = permanent ? `${FAILED_TEXT} ${String((e as Error).message).slice(0, 300)}` : FAILED_TEXT;
          await patch(deal, { result: text, hasResult: true, failed: true });
          return await finish(deal, d, 'job_failed', text);
        } finally { clearTimeout(timer); }
      } finally { if (store.unlock) await store.unlock(deal).catch(() => undefined); }
    })().finally(() => inflight.delete(deal));
    inflight.set(deal, p);
    return p;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith(base + '/')) return null;
    const route = url.pathname.slice(base.length);
    try {
      const body = async () => {
        const t = await req.text();
        if (t.length > JOB_MAX_INPUT_V2 * 4 + 1_024) throw Object.assign(new Error('body too large'), { status: 413 });
        try { return JSON.parse(t || '{}') as Record<string, unknown>; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
      };
      if (req.method === 'GET' && route === '/quote') {
        const quote: JobQuoteV2 = { protocol: JOB_PROTOCOL_V2, ...q, ...(s.description ? { description: s.description } : {}) };
        return json(200, quote);
      }
      if (req.method === 'POST' && route === '/open') {
        const b = await body();
        const input = typeof b.input === 'string' ? b.input : '';
        if (!input) return json(400, { error: 'input required' });
        if (new TextEncoder().encode(input).length > JOB_MAX_INPUT_V2) return json(413, { error: `input is at most ${JOB_MAX_INPUT_V2} bytes` });
        let buyer: string;
        try { buyer = new PublicKey(String(b.buyer)).toBase58(); } catch { return json(400, { error: 'buyer must be a Solana address' }); }
        if (o.allowBuyer && !(await o.allowBuyer(buyer))) return json(403, { error: 'this seller does not take deals from this buyer' });
        if (o.validateInput) { const why = await o.validateInput(input); if (why) return json(400, { error: why.slice(0, 300) }); }
        const all = await store.list();
        if (all.filter((j) => j.buyer === buyer && metaOf(j).unconfirmed).length >= maxUnconfirmed) return json(403, { error: 'this buyer has received work without accepting before; no new deals' });
        const live = all.filter(active);
        if (live.length >= total) return json(429, { error: 'too many deals in progress; try again later' });
        if (live.filter((j) => j.buyer === buyer).length >= perBuyer) return json(429, { error: 'too many deals in progress for this buyer' });
        return json(200, await s.prepareOpen(buyer, input));
      }
      if (req.method === 'POST' && route === '/deliver') {
        const b = await body();
        const deal = String(b.deal ?? '');
        const j = await store.get(deal);
        if (!j) return json(404, { error: 'unknown deal' });
        const origin = (o.publicOrigin ?? url.origin).replace(/\/+$/, '');
        if (!(await verifyDeliverSignatureV2(j.buyer, deal, origin, Number(b.expires), String(b.signature ?? '')))) return json(401, { error: 'bad or expired signature' });
        if (inflight.has(deal) && !metaOf(j).delivered) return json(202, { deal, status: 'working' });
        const r = await deliverJob(deal);
        if ('error' in r) return r.status === 202 ? json(202, { deal, status: 'working' }) : json(r.status, { error: r.error });
        return json(200, r);
      }
      return null;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status !== 500) return json(status, { error: (e as Error).message });
      const m = String((e as Error)?.message ?? '');
      return json(500, { error: 'internal error', ...(m.startsWith('rpc ') ? { detail: m.replace(/https?:\/\/\S+/g, '[address]').slice(0, 160) } : {}) });
    }
  }

  type Step = { deal: string; status: 'delivered' | 'working' | 'not_open' | 'expired' | 'settled' | 'closed' | 'error'; error?: string };
  /** Run on a timer: work and mark opened deals, settle/claim decided or expired ones, drop prepared deals never opened. */
  async function processOpenJobs(): Promise<Step[]> {
    const jobs = (await store.list()).filter((j) => active(j) && metaOf(j).v2);
    if (!jobs.length) return [];
    const chain = await s.readDeals(jobs.map((j) => j.deal));
    const now = await s.chainNow();
    const out: Step[] = [];
    for (const j of jobs) {
      const meta = metaOf(j);
      const d = chain.get(j.deal) ?? null;
      try {
        if (!d) {
          if (meta.delivered || j.settleTx) { await patch(j.deal, { closed: true }); out.push({ deal: j.deal, status: 'closed' }); continue; }
          if (Date.now() - Date.parse(j.preparedAt) > ttl * 1000) { if (store.delete) await store.delete(j.deal); else await patch(j.deal, { expired: true }); out.push({ deal: j.deal, status: 'expired' }); }
          else out.push({ deal: j.deal, status: 'not_open' });
          continue;
        }
        if (d.state === 'Open' && !meta.delivered) {
          const r = await deliverJob(j.deal, d);
          out.push('error' in r ? { deal: j.deal, status: r.status === 202 ? 'working' : 'error', error: r.error } : { deal: j.deal, status: 'delivered' });
          continue;
        }
        if (d.state === 'Settled' || v2.timeOutcomeV2(d, now)) {
          if (meta.delivered && !meta.failed && (d.state !== 'Settled' || d.outcome !== 'Accepted')) await patch(j.deal, { unconfirmed: true });
          await s.settleAndClaim(j.deal);
          out.push({ deal: j.deal, status: 'settled' });
        }
      } catch (e) { out.push({ deal: j.deal, status: 'error', error: (e as Error).message }); }
    }
    return out;
  }

  async function supply(deal: string, m: Partial<Meta>) {
    const j = await store.get(deal);
    if (!j) return { status: 404, error: 'unknown deal' };
    if (metaOf(j).hasResult) return { status: 409, error: 'a result is already stored for this deal' };
    const d = (await s.readDeals([deal])).get(deal) ?? null;
    if (!d) return { status: 409, error: 'deal is not on chain (not opened yet, or already closed)' };
    if (d.state !== 'Open') return { status: 409, error: `deal is ${d.state}` };
    await patch(deal, { ...m, hasResult: true });
    return deliverJob(deal, d);
  }
  return {
    handle,
    processOpenJobs,
    /** Supply the result (a string) of a job whose doJob threw JobPending; commits and marks it. */
    submit: (deal: string, result: unknown) => supply(deal, { result: typeof result === 'string' ? result : JSON.stringify(result) }),
    /** Give up on a job: delivers a job_failed status (or releases the deal when a non-refundable share applies). */
    decline: (deal: string, message?: string) => supply(deal, { result: `${FAILED_TEXT}${message ? ` ${message.slice(0, 300)}` : ''}`, failed: true }),
  };
}
