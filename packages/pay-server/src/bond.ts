// Agent402 Bond, seller side (optional entry: @agent402-dev/pay-server/bond).
// Quote a job, prepare the `open` transaction (seller pays fees and rent, signs first), check the deal on chain before working,
// mark delivery before the deadline, read the status, and settle.
// This module never takes or stores a private key: you pass a signer (a wallet, a KMS, or your own wrapper).
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import * as bond from '@agent402-dev/bond-client';
import { t2, timeline } from '@agent402-dev/bond-client/rules';
import { JOB_MAX_INPUT, JOB_PROTOCOL, type JobDelivery, type JobOpen, type JobQuote, verifyDeliverSignature } from '@agent402-dev/bond-client/job';

/** Beta cap of the deployed program for USDC deals (per deal, smallest units). */
const USDC_BETA_CAP = 100_000_000n;

const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Signs a transaction (partial signatures allowed). The private key stays with you. */
export interface BondSigner {
  publicKey: PublicKey;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

export interface BondTermsConfig {
  /** All amounts in the mint's smallest unit (USDC: 1 USDC = 1,000,000) */
  price: bigint;
  sellerBond: bigint;
  buyerDeposit: bigint;
  /** How long after opening you promise to deliver (seconds) */
  deliverSeconds: bigint;
  /** 0..=7 days */
  lateWindow: bigint;
  /** 1..=30 days */
  payWindow: bigint;
}

/** One prepared or opened deal, as the seller keeps it. Persist these: you must still mark delivery after a restart. */
export interface BondJob {
  deal: string;
  buyer: string;
  nonce: string;
  terms: Record<keyof bond.Terms, string>;
  preparedAt: string;
  markedAt?: string;
  markTx?: string;
  settleTx?: string;
  /** Anything you want to keep with the job (the request, an order id) */
  meta?: unknown;
}
export interface BondJobStore {
  get(deal: string): Promise<BondJob | undefined>;
  put(job: BondJob): Promise<void>;
  list(): Promise<BondJob[]>;
  /** Optional: remove a job (used to drop prepared deals that can no longer be opened) */
  delete?(deal: string): Promise<void>;
  /**
   * Optional but needed when several processes or isolates share one store (Workers, several servers): take a lease on a
   * deal for `ms` milliseconds; false if another holder has an unexpired lease. Without it, a job can run twice.
   */
  lock?(deal: string, ms: number): Promise<boolean>;
  unlock?(deal: string): Promise<void>;
}
/** In-memory store (lost on restart). Use a database in production. */
export function memoryBondStore(): BondJobStore {
  const m = new Map<string, BondJob>();
  const leases = new Map<string, number>();
  return {
    async get(d) { return m.get(d); }, async put(j) { m.set(j.deal, j); }, async list() { return [...m.values()]; }, async delete(d) { m.delete(d); },
    async lock(d, ms) { const now = Date.now(); if ((leases.get(d) ?? 0) > now) return false; leases.set(d, now + ms); return true; },
    async unlock(d) { leases.delete(d); },
  };
}

export interface BondSellerConfig {
  rpcUrl: string;
  signer: BondSigner;
  terms: BondTermsConfig;
  /** Default: mainnet USDC */
  mint?: PublicKey;
  tokenProgram?: PublicKey;
  store?: BondJobStore;
  fetchImpl?: typeof fetch;
}

const termsJson = (t: bond.Terms) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, String(v)])) as Record<keyof bond.Terms, string>;
const termsFrom = (j: Record<keyof bond.Terms, string>): bond.Terms => ({
  price: BigInt(j.price), sellerBond: BigInt(j.sellerBond), buyerDeposit: BigInt(j.buyerDeposit),
  deliverBy: BigInt(j.deliverBy), lateWindow: BigInt(j.lateWindow), payWindow: BigInt(j.payWindow),
});

/** Checks terms against the program's limits before anything is signed. */
export function checkBondTerms(t: BondTermsConfig): string[] {
  const out: string[] = [];
  if (t.price <= 0n) out.push('price must be positive');
  if (t.sellerBond <= 0n) out.push('seller bond must be positive');
  if (t.sellerBond * 10_000n > t.price * 2_000n) out.push('seller bond is at most 20% of the price');
  if (t.buyerDeposit < 0n || t.buyerDeposit > t.price) out.push('deposit must be between 0 and the price');
  if (t.deliverSeconds < 60n || t.deliverSeconds > 180n * 86_400n) out.push('deliverSeconds must be between 60 seconds and 180 days');
  if (t.lateWindow < 0n || t.lateWindow > 7n * 86_400n) out.push('lateWindow must be 0..7 days');
  if (t.payWindow < 86_400n || t.payWindow > 30n * 86_400n) out.push('payWindow must be 1..30 days');
  return out;
}

export function createBondSeller(cfg: BondSellerConfig) {
  const bad = checkBondTerms(cfg.terms);
  if (bad.length) throw new Error(`bond terms: ${bad.join('; ')}`);
  const f = cfg.fetchImpl ?? fetch;
  const mint = cfg.mint ?? bond.MINTS.mainnet.USDC;
  const tokenProgram = cfg.tokenProgram ?? TOKEN_PROGRAM;
  const store = cfg.store ?? memoryBondStore();
  const seller = cfg.signer.publicKey;
  if (mint.equals(bond.MINTS.mainnet.USDC) && cfg.terms.price > USDC_BETA_CAP) throw new Error('bond terms: price is above the program cap for USDC (100 USDC per deal)');

  let id = 0;
  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    const r = await f(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    const j = (await r.json()) as { result?: T; error?: { message: string } };
    if (j.error || j.result === undefined) throw new Error(`rpc ${method}: ${j.error?.message ?? r.status}`);
    return j.result;
  }
  /**
   * Chain time as the program sees it: the Clock sysvar's unix_timestamp (offset 32). getBlockTime on the newest slot often
   * fails on mainnet ("block not available"), so it is only the fallback.
   */
  const chainNow = async () => {
    try {
      const v = (await rpc<{ value: { data: [string, string] } | null }>('getAccountInfo', ['SysvarC1ock11111111111111111111111111111111', { encoding: 'base64', commitment: 'confirmed' }])).value;
      if (v) {
        const b = Buffer.from(v.data[0], 'base64');
        if (b.length >= 40) return b.readBigInt64LE(32);
      }
    } catch { /* fall back */ }
    return BigInt(await rpc<number>('getBlockTime', [await rpc<number>('getSlot', [{ commitment: 'confirmed' }])]));
  };
  const blockhash = async () => (await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])).value.blockhash;
  async function readDeal(deal: string): Promise<bond.DealState | null> {
    const v = (await rpc<{ value: { owner: string; data: [string, string] } | null }>('getAccountInfo', [deal, { encoding: 'base64', commitment: 'confirmed' }])).value;
    if (!v || v.owner !== bond.BOND_PROGRAM_ID.toBase58()) return null;
    return bond.decodeDeal(Uint8Array.from(Buffer.from(v.data[0], 'base64')));
  }
  /** Reads many deals with getMultipleAccounts (100 per request). null = not on chain (or not a deal). */
  async function readDeals(deals: string[]): Promise<Map<string, bond.DealState | null>> {
    const out = new Map<string, bond.DealState | null>();
    for (let i = 0; i < deals.length; i += 100) {
      const chunk = deals.slice(i, i + 100);
      const v = (await rpc<{ value: ({ owner: string; data: [string, string] } | null)[] }>('getMultipleAccounts', [chunk, { encoding: 'base64', commitment: 'confirmed' }])).value;
      chunk.forEach((d, k) => {
        const a = v[k];
        let st: bond.DealState | null = null;
        if (a && a.owner === bond.BOND_PROGRAM_ID.toBase58()) { try { st = bond.decodeDeal(Uint8Array.from(Buffer.from(a.data[0], 'base64'))); } catch { st = null; } }
        out.set(d, st);
      });
    }
    return out;
  }
  /** Signs as the seller (fee payer), sends, waits by polling (no websocket). */
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
  async function sendWithFallback(full: TransactionInstruction[], own: TransactionInstruction[]) {
    try { return { tx: await send(full), partial: false }; }
    catch (e) {
      // Only a refusal in preflight simulation (nothing sent, no fee) falls back; a sent or unconfirmed transaction does not.
      if (!(e as Error).message.startsWith('rpc sendTransaction:')) throw e;
      return { tx: await send(own), partial: true };
    }
  }
  const ref = (buyer: PublicKey, nonce: bigint): bond.DealRef => ({ seller, buyer, mint, tokenProgram, nonce });
  const refOf = (j: BondJob) => ref(new PublicKey(j.buyer), BigInt(j.nonce));
  async function job(deal: string) {
    const j = await store.get(deal);
    if (!j) throw new Error('unknown deal (not prepared by this seller)');
    return j;
  }

  async function requireOpen(deal: string): Promise<bond.DealState> {
    const j = await job(deal);
    const d = await readDeal(deal);
    if (!d) throw new Error('deal is not on chain yet');
    const want = termsFrom(j.terms);
    const same = d.seller.equals(seller) && d.buyer.toBase58() === j.buyer && d.mint.equals(mint)
      && (Object.keys(want) as (keyof bond.Terms)[]).every((k) => d.terms[k] === want[k]);
    if (!same) throw new Error('on-chain deal does not match the prepared terms');
    if (d.outcome !== 'open') throw new Error(`deal is already decided (${d.outcome})`);
    return d;
  }

  return {
    seller: seller.toBase58(),
    /** The job store (the one passed in, or the in-memory default) */
    store,
    /** What you offer, before any money moves. Amounts as strings (smallest units). */
    quote() {
      const t = cfg.terms;
      return {
        program: bond.BOND_PROGRAM_ID.toBase58(), seller: seller.toBase58(), mint: mint.toBase58(), tokenProgram: tokenProgram.toBase58(),
        price: String(t.price), sellerBond: String(t.sellerBond), buyerDeposit: String(t.buyerDeposit),
        deliverSeconds: String(t.deliverSeconds), lateWindow: String(t.lateWindow), payWindow: String(t.payWindow),
      };
    },

    /**
     * Builds `open` for this buyer, with you as fee payer, signed by you. Send `transaction` to the buyer, who verifies it,
     * adds its signature and sends it. The deal exists only once that transaction lands (check with `requireOpen`).
     */
    async prepareOpen(buyer: string, meta?: unknown) {
      const b = new PublicKey(buyer);
      if (b.equals(seller)) throw new Error('buyer and seller must differ');
      const nonce = BigInt.asUintN(64, BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString('hex')}`));
      const t = cfg.terms;
      const terms: bond.Terms = { price: t.price, sellerBond: t.sellerBond, buyerDeposit: t.buyerDeposit, deliverBy: (await chainNow()) + t.deliverSeconds, lateWindow: t.lateWindow, payWindow: t.payWindow };
      const r = ref(b, nonce);
      const tx = new Transaction().add(bond.open(r, terms));
      tx.recentBlockhash = await blockhash();
      tx.feePayer = seller;
      const signed = await cfg.signer.signTransaction(tx);
      const deal = bond.dealOf(r).toBase58();
      await store.put({ deal, buyer, nonce: String(nonce), terms: termsJson(terms), preparedAt: new Date().toISOString(), ...(meta !== undefined ? { meta } : {}) });
      return { deal, nonce: String(nonce), terms: termsJson(terms), transaction: signed.serialize({ requireAllSignatures: false }).toString('base64') };
    },

    /** Start work only after this returns: the deal is on chain, open, yours, and matches the prepared terms. */
    requireOpen,
    /** Many deals at once (getMultipleAccounts); null when not on chain. */
    readDeals,
    /** Chain time (seconds), from the latest confirmed block */
    chainNow,
    /** True if this on-chain deal is the one prepared for this job (seller, buyer, mint and terms). */
    async matches(deal: string, d: bond.DealState) {
      const j = await job(deal);
      const want = termsFrom(j.terms);
      return d.seller.equals(seller) && d.buyer.toBase58() === j.buyer && d.mint.equals(mint)
        && (Object.keys(want) as (keyof bond.Terms)[]).every((k) => d.terms[k] === want[k]);
    },

    /**
     * Marks delivery. Call it when you hand over the work, before the deadline: if nothing is marked or confirmed
     * by deliverBy + 1 day (+ late window), the bond and the deposit go to the buyer. Idempotent.
     */
    async markDelivered(deal: string): Promise<{ markTx: string | null; alreadyMarked: boolean }> {
      const j = await job(deal);
      const d = await requireOpen(deal);
      if (d.sellerMark !== null || d.buyerConfirm !== null) return { markTx: j.markTx ?? null, alreadyMarked: true };
      if ((await chainNow()) > t2(d.terms)) throw new Error('too late to mark: the mark deadline has passed');
      const markTx = await send([bond.markDelivered(refOf(j))]);
      await store.put({ ...j, markedAt: new Date().toISOString(), markTx });
      return { markTx, alreadyMarked: false };
    },

    /** Deadlines, possible actions and the settlement that applies now (predicted from the program rules). */
    async status(deal: string) {
      const d = await readDeal(deal);
      if (!d) return { onChain: false as const };
      return { onChain: true as const, outcome: d.outcome, deal: d, timeline: d.outcome === 'open' ? timeline(d, await chainNow()) : null };
    },

    /** Prepared jobs that are open on chain and not yet marked, earliest mark deadline first. Run it on a timer. */
    async unmarked() {
      const out: { deal: string; markBy: string; meta?: unknown }[] = [];
      for (const j of await store.list()) {
        if (j.markedAt || j.settleTx) continue;
        const d = await readDeal(j.deal);
        if (!d || d.outcome !== 'open' || d.sellerMark !== null || d.buyerConfirm !== null) continue;
        out.push({ deal: j.deal, markBy: new Date(Number(t2(d.terms)) * 1000).toISOString(), ...(j.meta !== undefined ? { meta: j.meta } : {}) });
      }
      return out.sort((a, b) => a.markBy.localeCompare(b.markBy));
    },

    /** Settles and sends both claims once the outcome is fixed (you pay the network fee). */
    async settle(deal: string) {
      const j = await job(deal);
      const d = await readDeal(deal);
      if (!d) throw new Error('deal not found (already settled and closed?)');
      if (d.outcome !== 'open') throw new Error(`already decided (${d.outcome}); send claims with bond-client claimBuyer/claimSeller`);
      const tl = timeline(d, await chainNow());
      if (!tl.settleNow) throw new Error(`not settleable yet${tl.settleableFrom ? ` (from ${new Date(Number(tl.settleableFrom) * 1000).toISOString()})` : ''}`);
      const r = refOf(j);
      // If the buyer's token account is closed or frozen, its claim fails and would block the whole transaction:
      // then settle and claim only your share (the buyer's share stays in the vault for the buyer to claim later).
      const { tx: settleTx, partial } = await sendWithFallback([bond.settle(r), bond.claimBuyer(r), bond.claimSeller(r)], [bond.settle(r), bond.claimSeller(r)]);
      await store.put({ ...j, settleTx });
      return { settleTx, outcome: tl.settleNow.outcome, toSeller: String(tl.settleNow.toSeller), toBuyer: String(tl.settleNow.toBuyer), ...(partial ? { buyerShareLeftInVault: true } : {}) };
    },

    /** For a deal already decided but not yet claimed: send both claims (buyer share, then yours, which closes the deal). */
    async claim(deal: string) {
      const j = await job(deal);
      const d = await readDeal(deal);
      if (!d) throw new Error('deal not found (already closed?)');
      if (d.outcome === 'open') throw new Error('not decided yet; use settle');
      const r = refOf(j);
      const { tx: settleTx, partial } = await sendWithFallback([bond.claimBuyer(r), bond.claimSeller(r)], [bond.claimSeller(r)]);
      await store.put({ ...j, settleTx });
      return { settleTx, outcome: d.outcome, ...(partial ? { buyerShareLeftInVault: true } : {}) };
    },
  };
}
export type BondSeller = ReturnType<typeof createBondSeller>;

export interface BondJobHandlerOptions {
  seller: BondSeller;
  /**
   * The work. Runs after the deposit is locked. Stop when `ctx.signal` aborts (after `jobTimeoutSeconds`).
   * Treat `input` as untrusted: it comes from whoever opened the deal.
   */
  doJob: (input: string, ctx: { deal: string; buyer: string; signal: AbortSignal }) => Promise<unknown>;
  /** Path prefix, e.g. "/jobs/summarize" (default: none) */
  basePath?: string;
  /** Plain text shown in the quote (at most 500 characters) */
  description?: string;
  /** Refuse a buyer before any deal is prepared (403), e.g. an allowlist. Default: everyone. */
  allowBuyer?: (buyer: string) => boolean | Promise<boolean>;
  /** Refuse an input before any deal is prepared: return an error message, or null to accept. */
  validateInput?: (input: string) => string | null | Promise<string | null>;
  /** Drop prepared deals not opened on chain after this many seconds (default 600, at least 300) */
  prepareTtlSeconds?: number;
  /** Abort one run of the work after this many seconds (default 120) */
  jobTimeoutSeconds?: number;
  /**
   * Runs of the work before giving up (default 3). Giving up, or reaching the mark deadline minus 30 minutes with no result,
   * delivers `{ error: "job_failed" }` and marks it. With a mark and no confirmation the deal ends neutral (each side gets its
   * own money back) instead of you losing the bond; the buyer sees the failure and should not confirm.
   */
  maxAttempts?: number;
  /**
   * Refuse new deals from a buyer once this many of its deals ended with the work delivered but never confirmed
   * (default 2; Infinity turns it off). The program ends such deals neutral, so the buyer kept the work without paying.
   * A buyer can switch wallets, so this limits repeat use, not a first one.
   */
  maxUnconfirmedPerBuyer?: number;
  /** Deals not yet closed, per buyer (default 3) and in total (default 50). Each open deal locks your bond. */
  maxPendingPerBuyer?: number;
  maxPending?: number;
  /** Jobs worked on at the same time by processOpenJobs (default 4) */
  concurrency?: number;
  /**
   * The origin buyers use to reach you (e.g. "https://api.example.com"). Delivery requests are signed for it.
   * Default: the origin of the request URL (set this when you run behind a proxy that changes scheme or host).
   */
  publicOrigin?: string;
}

/**
 * Throw this from `doJob` when the result is not ready yet and will be supplied later with `submit` (for example by a
 * person or an AI agent doing the work). It does not count as a failure; the deadline give-up still applies.
 */
export class JobPending extends Error {
  constructor() { super('waiting for the result'); this.name = 'JobPending'; }
}

/**
 * Throw this from `doJob` when the job cannot be done for this input and retrying will not help (too large, not found).
 * The failure, with this message, is delivered and marked at once (neutral outcome; your bond comes back).
 */
export class JobFailed extends Error {
  constructor(message: string) { super(message); this.name = 'JobFailed'; }
}

/** What is delivered when the work could not be done (see maxAttempts). */
export const JOB_FAILED = { error: 'job_failed', message: 'The seller could not complete this job. Do not confirm; after the deadlines each side gets its own money back.' } as const;

/**
 * Agent402 Bond Job Protocol v1, seller side.
 * - `handle(req)`: GET {base}/quote, POST {base}/open, POST {base}/deliver. Returns null for other paths so you can chain
 *   your own routes. Works with any Fetch-style runtime (Node, Workers).
 * - `processOpenJobs()`: run this on a timer (every few minutes). It does the work for every prepared deal that is open on
 *   chain and marks delivery, without waiting for the buyer to ask. Otherwise a buyer could open a deal, never fetch the
 *   result, and take your bond at the deadline.
 */
export function bondJobService(o: BondJobHandlerOptions) {
  const base = (o.basePath ?? '').replace(/\/+$/, '');
  if (o.description !== undefined && o.description.length > 500) throw new Error('description is at most 500 characters');
  const ttlSeconds = o.prepareTtlSeconds ?? 600;
  if (ttlSeconds < 300) throw new Error('prepareTtlSeconds is at least 300 (an open transaction can land for a while after it is prepared)');
  const timeoutMs = (o.jobTimeoutSeconds ?? 120) * 1000;
  const maxAttempts = Math.max(1, o.maxAttempts ?? 3);
  const perBuyer = o.maxPendingPerBuyer ?? 3;
  const maxUnconfirmed = o.maxUnconfirmedPerBuyer ?? 2;
  const total = o.maxPending ?? 50;
  const concurrency = Math.max(1, o.concurrency ?? 4);
  const GIVE_UP_BEFORE = 1800n; // seconds before the mark deadline

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const body = async (req: Request) => {
    const t = await req.text();
    if (t.length > JOB_MAX_INPUT * 4 + 1_024) throw Object.assign(new Error('body too large'), { status: 413 });
    try { return JSON.parse(t || '{}') as Record<string, unknown>; } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
  };
  const store = o.seller.store;

  type JobMeta = {
    input?: string; result?: unknown; hasResult?: boolean; delivered?: boolean; failed?: boolean;
    attempts?: number; lastError?: string; closed?: boolean; expired?: boolean;
    /** Delivered (not a failure) and decided without the buyer confirming */
    unconfirmed?: boolean;
  };
  type Outcome = JobDelivery | { status: number; error: string };
  const inflight = new Map<string, Promise<Outcome>>();
  const metaOf = (j: BondJob) => (j.meta ?? {}) as JobMeta;
  const active = (j: BondJob) => { const m = metaOf(j); return !m.closed && !m.expired; };
  async function patch(deal: string, m: Partial<JobMeta>) {
    const j = await store.get(deal);
    if (j) await store.put({ ...j, meta: { ...metaOf(j), ...m } });
  }
  async function runWithTimeout(input: string, ctx: { deal: string; buyer: string }) {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error('timed out')); }, timeoutMs); });
    try { return await Promise.race([o.doJob(input, { ...ctx, signal: ac.signal }), timeout]); }
    finally { clearTimeout(timer); }
  }

  /**
   * Does the work for a deal that is open on chain (or already paid for), keeps the result, marks delivery.
   * Same answer on repeat calls; a stored result is never recomputed. 202 = being worked on or will be retried.
   */
  function deliverJob(deal: string, known?: bond.DealState | null): Promise<Outcome> {
    const running = inflight.get(deal);
    if (running) return running;
    const p = (async (): Promise<Outcome> => {
      // Already delivered: answer from the store without waiting for a lease another process may still hold.
      const done = await store.get(deal);
      if (done && metaOf(done).delivered) return { deal, result: metaOf(done).result, markTx: done.markTx ?? null };
      const leaseMs = timeoutMs + 120_000;
      if (store.lock && !(await store.lock(deal, leaseMs))) return { status: 202, error: 'working' };
      try {
        const j = await store.get(deal);
        if (!j) return { status: 404, error: 'unknown deal' };
        const meta = metaOf(j);
        if (meta.delivered) return { deal, result: meta.result, markTx: j.markTx ?? null };
        const d = known !== undefined ? known : (await o.seller.readDeals([deal])).get(deal) ?? null;
        if (!d) return { status: 409, error: 'deal is not on chain' };
        if (!(await o.seller.matches(deal, d))) return { status: 409, error: 'on-chain deal does not match the prepared terms' };
        // Open: work and mark. Already decided: work only if the buyer confirmed (it paid), never mark.
        const paid = d.outcome !== 'open' && d.buyerConfirm !== null;
        if (d.outcome !== 'open' && !paid) return { status: 409, error: `deal is already decided (${d.outcome})` };

        let result = meta.result;
        if (!meta.hasResult) {
          const attempts = meta.attempts ?? 0;
          const late = d.outcome === 'open' && (await o.seller.chainNow()) >= t2(d.terms) - GIVE_UP_BEFORE;
          let failed = attempts >= maxAttempts || late;
          let failMessage: string | undefined;
          if (!failed) {
            try {
              result = await runWithTimeout(meta.input ?? '', { deal, buyer: j.buyer });
              await patch(deal, { result, hasResult: true, attempts: attempts + 1, lastError: undefined });
            } catch (e) {
              if (e instanceof JobPending || (e as Error)?.name === 'JobPending') return { status: 202, error: 'waiting for the result' };
              const n = attempts + 1;
              await patch(deal, { attempts: n, lastError: (e as Error).message.slice(0, 300) });
              const permanent = e instanceof JobFailed || (e as Error)?.name === 'JobFailed';
              if (!permanent && n < maxAttempts) return { status: 202, error: 'the job failed; it will be retried' };
              failed = true;
              if (permanent) failMessage = (e as Error).message.slice(0, 300);
            }
          }
          if (failed) {
            result = failMessage ? { ...JOB_FAILED, message: failMessage } : JOB_FAILED;
            await patch(deal, { result, hasResult: true, failed: true });
          }
        }
        if (paid) {
          await patch(deal, { delivered: true });
          return { deal, result, markTx: j.markTx ?? null };
        }
        // Mark before the deadline. With no mark and no confirmation, the bond goes to the buyer.
        const { markTx } = await o.seller.markDelivered(deal);
        await patch(deal, { delivered: true });
        return { deal, result, markTx };
      } finally {
        if (store.unlock) await store.unlock(deal).catch(() => undefined);
      }
    })().finally(() => inflight.delete(deal));
    inflight.set(deal, p);
    return p;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname;
    if (!path.startsWith(base + '/')) return null;
    const route = path.slice(base.length);
    try {
      if (req.method === 'GET' && route === '/quote') {
        const q: JobQuote = { protocol: JOB_PROTOCOL, ...o.seller.quote(), ...(o.description ? { description: o.description } : {}) };
        return json(200, q);
      }
      if (req.method === 'POST' && route === '/open') {
        const b = await body(req);
        const input = typeof b.input === 'string' ? b.input : '';
        if (!input) return json(400, { error: 'input required' });
        if (new TextEncoder().encode(input).length > JOB_MAX_INPUT) return json(413, { error: `input is at most ${JOB_MAX_INPUT} bytes` });
        let buyer: string;
        try { buyer = new PublicKey(String(b.buyer)).toBase58(); } catch { return json(400, { error: 'buyer must be a Solana address' }); }
        if (o.allowBuyer && !(await o.allowBuyer(buyer))) return json(403, { error: 'this seller does not take deals from this buyer' });
        if (o.validateInput) {
          const why = await o.validateInput(input);
          if (why) return json(400, { error: why.slice(0, 300) });
        }
        const all = await store.list();
        if (all.filter((j) => j.buyer === buyer && metaOf(j).unconfirmed).length >= maxUnconfirmed) {
          return json(403, { error: 'this buyer has received work without confirming before; no new deals' });
        }
        const jobs = all.filter(active);
        if (jobs.length >= total) return json(429, { error: 'too many deals in progress; try again later' });
        if (jobs.filter((j) => j.buyer === buyer).length >= perBuyer) return json(429, { error: 'too many deals in progress for this buyer' });
        const p = await o.seller.prepareOpen(buyer, { input });
        const out: JobOpen = { deal: p.deal, nonce: p.nonce, terms: p.terms, transaction: p.transaction };
        return json(200, out);
      }
      if (req.method === 'POST' && route === '/deliver') {
        const b = await body(req);
        const deal = String(b.deal ?? '');
        const j = await store.get(deal);
        if (!j) return json(404, { error: 'unknown deal' });
        // Only the deal's buyer may fetch the result; the request is signed for this server and expires.
        const origin = (o.publicOrigin ?? url.origin).replace(/\/+$/, '');
        if (!(await verifyDeliverSignature(new PublicKey(j.buyer).toBytes(), deal, origin, Number(b.expires), String(b.signature ?? '')))) {
          return json(401, { error: 'bad or expired signature' });
        }
        // A long job already running (from the timer or another request): answer at once, the buyer asks again later.
        if (inflight.has(deal) && !metaOf(j).delivered) return json(202, { deal, status: 'working' });
        const r = await deliverJob(deal);
        if ('error' in r) return r.status === 202 ? json(202, { deal, status: 'working' }) : json(r.status, { error: r.error });
        return json(200, r);
      }
      return null;
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status !== 500) return json(status, { error: (e as Error).message });
      // Which RPC step failed (method and the node's message only; the RPC address is never part of these messages)
      const m = String((e as Error)?.message ?? '');
      const detail = m.startsWith('rpc ') ? m.replace(/https?:\/\/\S+/g, '[address]').slice(0, 160) : undefined;
      return json(500, { error: 'internal error', ...(detail ? { detail } : {}) });
    }
  }

  type Step = { deal: string; status: 'delivered' | 'working' | 'not_open' | 'expired' | 'settled' | 'closed' | 'error'; error?: string };
  /**
   * Run on a timer. Reads all tracked deals in one batch, then, earliest mark deadline first:
   * - opened on chain, not delivered → do the work (or give up, see maxAttempts), keep the result, mark delivery;
   * - delivered and settleable → settle and claim, so your bond comes back even if the buyer goes away;
   * - decided on chain → claim (after doing the work if the buyer paid for it);
   * - closed on chain → stop tracking;
   * - prepared but not opened after `prepareTtlSeconds` → drop.
   * One failing deal does not stop the others.
   */
  async function processOpenJobs(): Promise<Step[]> {
    const jobs = (await store.list()).filter(active);
    if (!jobs.length) return [];
    const chain = await o.seller.readDeals(jobs.map((j) => j.deal));
    const now = await o.seller.chainNow();
    const key = (j: BondJob) => { const d = chain.get(j.deal); return d && d.outcome === 'open' ? t2(d.terms) : BigInt(Number.MAX_SAFE_INTEGER); };
    jobs.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

    async function noteUnconfirmed(j: BondJob, d: bond.DealState) {
      const m = (await store.get(j.deal))?.meta as JobMeta | undefined;
      if (m?.delivered && !m.failed && d.buyerConfirm === null) await patch(j.deal, { unconfirmed: true });
    }
    async function one(j: BondJob): Promise<Step | null> {
      const meta = metaOf(j);
      const d = chain.get(j.deal) ?? null;
      try {
        if (!d) {
          if (meta.delivered || j.settleTx) { await patch(j.deal, { closed: true }); return { deal: j.deal, status: 'closed' }; }
          if (Date.now() - Date.parse(j.preparedAt) > ttlSeconds * 1000) {
            if (store.delete) await store.delete(j.deal); else await patch(j.deal, { expired: true });
            return { deal: j.deal, status: 'expired' };
          }
          return { deal: j.deal, status: 'not_open' };
        }
        const paid = d.outcome !== 'open' && d.buyerConfirm !== null;
        if (!meta.delivered && (d.outcome === 'open' || paid)) {
          const r = await deliverJob(j.deal, d);
          if ('error' in r) return r.status === 202 ? { deal: j.deal, status: 'working' } : { deal: j.deal, status: 'error', error: r.error };
          if (d.outcome === 'open') return { deal: j.deal, status: 'delivered' };
        }
        if (d.outcome === 'open') {
          if (timeline(d, now).settleNow) {
            await noteUnconfirmed(j, d);
            await o.seller.settle(j.deal);
            return { deal: j.deal, status: 'settled' };
          }
          return null; // delivered, waiting for the buyer or the deadlines
        }
        // Our share already claimed, the buyer's left in the vault for the buyer: nothing more to do here.
        if (j.settleTx) { await patch(j.deal, { closed: true }); return { deal: j.deal, status: 'closed' }; }
        // Decided (by us or anyone) but not claimed: claim. Closing the deal ends tracking on the next run.
        await noteUnconfirmed(j, d);
        await o.seller.claim(j.deal);
        return { deal: j.deal, status: 'settled' };
      } catch (e) {
        return { deal: j.deal, status: 'error', error: (e as Error).message };
      }
    }

    const out: (Step | null)[] = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) { const k = next++; out[k] = await one(jobs[k]); }
    }));
    return out.filter((x): x is Step => x !== null);
  }

  /** Stores a result for a deal that is open on chain (or paid) and has none yet, then marks delivery. */
  async function supply(deal: string, m: Partial<JobMeta>): Promise<Outcome> {
    const j = await store.get(deal);
    if (!j) return { status: 404, error: 'unknown deal' };
    if (metaOf(j).hasResult) return { status: 409, error: 'a result is already stored for this deal' };
    const d = (await o.seller.readDeals([deal])).get(deal) ?? null;
    if (!d) return { status: 409, error: 'deal is not on chain (not opened yet, or already closed)' };
    if (!(await o.seller.matches(deal, d))) return { status: 409, error: 'on-chain deal does not match the prepared terms' };
    if (d.outcome !== 'open' && d.buyerConfirm === null) return { status: 409, error: `deal is already decided (${d.outcome})` };
    await patch(deal, { ...m, hasResult: true, lastError: undefined });
    return deliverJob(deal, d);
  }

  return {
    handle,
    processOpenJobs,
    /** Supply the result of a job whose `doJob` threw JobPending; marks delivery. */
    submit: (deal: string, result: unknown) => supply(deal, { result }),
    /** Give up on a job: delivers `{ error: "job_failed", message }` and marks (neutral outcome, your bond comes back). */
    decline: (deal: string, message?: string) =>
      supply(deal, { result: { ...JOB_FAILED, ...(message ? { message: message.slice(0, 300) } : {}) }, failed: true }),
  };
}

/** Same as `bondJobService(o).handle`. Prefer bondJobService so you can also run processOpenJobs on a timer. */
export const bondJobHandler = (o: BondJobHandlerOptions) => bondJobService(o).handle;
