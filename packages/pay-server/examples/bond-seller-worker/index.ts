// Agent402 Bond seller on Cloudflare Workers — a template for selling one kind of job over the Bond Job Protocol
// (v1 today; set PROTOCOL=2 for Bond v2 once its program is deployed).
// Replace checkInput() and doWork() with your work, set the terms in wrangler.toml [vars], deploy. See README.md in this folder.
//
// Routes: GET /quote, POST /open, POST /deliver (protocol) and GET / (info).
// Optional: set X402_PRICE_USD to also sell the same work per request over x402 at POST /x402/job (USDC, no bond),
// and the RECEIPT_KEY secret to sign a receipt for each paid response (X-Agent402-Receipt).
// Cron:   every 2 minutes, does the work and marks delivery for deals buyers have opened (never wait for the buyer),
//         settles and claims deals whose outcome is fixed, retries failed jobs, drops deals never opened.
//
// The seller key is a Worker secret (SELLER_KEY). Use a dedicated wallet that holds only what deals need
// (network fees, deal rent, your bonds). The SDK itself never takes a key: this file builds the signer.
import { DurableObject } from 'cloudflare:workers';
import { Keypair, PublicKey } from '@solana/web3.js';
import { type BondJob, type BondJobStore, bondJobService, createBondSeller } from '@agent402-dev/pay-server/bond';
import { bondJobServiceV2, createBondSellerV2 } from '@agent402-dev/pay-server/bond-v2';
import { BOND_V2_DEPLOYED } from '@agent402-dev/bond-client/v2';
import nacl from 'tweetnacl';
import { receiptSignerFromBytes, type LedgerEntry, type ReceiptSigner } from '@agent402-dev/pay-server';
import { paidRouteHandler, storageLedger } from '@agent402-dev/pay-server/route';

interface Env {
  /** Secret: the seller key, as the Solana CLI JSON array ([12,34,...]). `wrangler secret put SELLER_KEY` */
  SELLER_KEY: string;
  /** Secret: Solana mainnet RPC URL (with your provider key). `wrangler secret put RPC_URL` */
  RPC_URL: string;
  /** Optional: deal asset, USDC (default) or PREQ (Token-2022). Buyers must enable PREQ deals in their own rules */
  ASSET?: string;
  /** Terms, in the asset's smallest units (both have 6 decimals: 1 USDC or 1 PREQ = 1000000) and seconds */
  PRICE: string;
  SELLER_BOND: string;
  BUYER_DEPOSIT: string;
  DELIVER_SECONDS: string;
  LATE_WINDOW: string;
  PAY_WINDOW: string;
  DESCRIPTION: string;
  /** Optional: "2" = Bond v2 and Job Protocol v2 (job and output hashes, accept pays the balance in one step). Default "1" */
  PROTOCOL?: string;
  /** Bond v2 only: seconds after DELIVER_SECONDS you may still mark (1 hour .. 1 day) and seconds the buyer has to review (1 hour .. 7 days) */
  GRACE?: string;
  REVIEW_WINDOW?: string;
  /** Bond v2 only, local testing: program id when RPC_URL is a local fork. Ignored otherwise (the deployed id is in the SDK) */
  V2_PROGRAM?: string;
  /** Optional: the origin buyers use (e.g. https://jobs.example.com). Delivery requests are signed for it. Default: the request URL's origin */
  PUBLIC_ORIGIN?: string;
  /** Optional: price in USD to also sell the work per request over x402 at POST /x402/job (USDC to the seller wallet). Unset = off */
  X402_PRICE_USD?: string;
  /** Optional secret: a separate key (Solana CLI JSON array, NOT the seller key) that signs x402 receipts. `wrangler secret put RECEIPT_KEY` */
  RECEIPT_KEY?: string;
  JOBS: DurableObjectNamespace<JobStoreDO>;
}

// ---------------------------------------------------------------------------------------------
// YOUR WORK. For a Bond deal it runs once, after the buyer's deposit is locked on chain; over x402 it runs after the
// payment is verified and before it is settled. Keep it well under DELIVER_SECONDS (x402: under 40 seconds).
// Whatever you return is what the buyer receives. `input` is untrusted. Stop when `signal` aborts.
function checkInput(input: string): string | null {
  return input.trim() ? null : 'send some text';
}
// Bond v2 commits to the exact result bytes: objects are sent as JSON text (JSON.stringify of what doWork returns).
async function doWork(input: string, _signal: AbortSignal, _env: Env): Promise<unknown> {
  return { words: input.trim().split(/\s+/).filter(Boolean).length, characters: input.length };
}
// ---------------------------------------------------------------------------------------------

/** Job store in a Durable Object: consistent reads, survives restarts (you must still be able to mark delivery). */
export class JobStoreDO extends DurableObject<Env> {
  async getJob(deal: string) { return (await this.ctx.storage.get<BondJob>(`job:${deal}`)) ?? null; }
  async deleteJob(deal: string) { await this.ctx.storage.delete(`job:${deal}`); }
  async putJob(job: BondJob) { await this.ctx.storage.put(`job:${job.deal}`, job); }
  async listJobs() { return [...(await this.ctx.storage.list<BondJob>({ prefix: 'job:' })).values()]; }
  /** Lease on one deal, so a request and the cron (or two isolates) never run the same job at once. Atomic inside the object. */
  async lockJob(deal: string, ms: number) {
    const now = Date.now();
    const until = (await this.ctx.storage.get<number>(`lock:${deal}`)) ?? 0;
    if (until > now) return false;
    await this.ctx.storage.put(`lock:${deal}`, now + ms);
    return true;
  }
  async unlockJob(deal: string) { await this.ctx.storage.delete(`lock:${deal}`); }
  /** x402 payment ledger, so a payment cannot be used twice */
  async ledgerGet(key: string) { return (await this.ctx.storage.get<LedgerEntry>(key)) ?? undefined; }
  async ledgerPut(key: string, e: LedgerEntry) { await this.ctx.storage.put(key, e); }
  async ledgerDelete(key: string) { await this.ctx.storage.delete(key); }
}
const doStub = (env: Env) => env.JOBS.get(env.JOBS.idFromName('jobs'));
function jobStore(env: Env): BondJobStore {
  const stub = env.JOBS.get(env.JOBS.idFromName('jobs'));
  return {
    async get(deal) { return (await stub.getJob(deal)) ?? undefined; },
    async put(job) { await stub.putJob(job); },
    async list() { return stub.listJobs(); },
    async delete(deal) { await stub.deleteJob(deal); },
    async lock(deal, ms) { return stub.lockJob(deal, ms); },
    async unlock(deal) { await stub.unlockJob(deal); },
  };
}

function keypairFrom(secret: string): Keypair {
  const bytes = Uint8Array.from(JSON.parse(secret) as number[]);
  if (bytes.length !== 64) throw new Error('SELLER_KEY must be the 64-number Solana CLI key array');
  return Keypair.fromSecretKey(bytes);
}

// USDC needs nothing extra. PREQ is a Token-2022 mint, so the deal uses that token program.
function assetOptions(asset = 'USDC'): { mint?: PublicKey; tokenProgram?: PublicKey } {
  const a = asset.trim().toUpperCase();
  if (a === 'USDC') return {};
  if (a === 'PREQ') return { mint: new PublicKey('aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX'), tokenProgram: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') };
  throw new Error('ASSET must be USDC or PREQ');
}

function v2Program(env: Env): PublicKey {
  if (BOND_V2_DEPLOYED) return BOND_V2_DEPLOYED;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(env.RPC_URL);
  if (local && env.V2_PROGRAM) return new PublicKey(env.V2_PROGRAM);
  throw new Error('PROTOCOL=2: Bond v2 is not deployed yet (only a local fork with V2_PROGRAM can run it)');
}

function serviceV2(env: Env) {
  const kp = keypairFrom(env.SELLER_KEY);
  const big = (k: keyof Env) => BigInt(String(env[k]));
  const a = assetOptions(env.ASSET);
  const seller = createBondSellerV2({
    rpcUrl: env.RPC_URL, programId: v2Program(env), description: env.DESCRIPTION,
    mint: a.mint ?? new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
    tokenProgram: a.tokenProgram ?? new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    // The signer is the only place the key is used: transactions, and the output hash the buyer checks before accepting.
    signer: { publicKey: kp.publicKey, async signTransaction(tx) { tx.partialSign(kp); return tx; }, async signMessage(m) { return nacl.sign.detached(m, kp.secretKey); } },
    terms: {
      price: big('PRICE'), sellerBond: big('SELLER_BOND'), buyerDeposit: big('BUYER_DEPOSIT'), deliverSeconds: big('DELIVER_SECONDS'),
      grace: BigInt(env.GRACE ?? '86400'), reviewWindow: BigInt(env.REVIEW_WINDOW ?? '86400'),
    },
    store: jobStore(env),
  });
  return { seller, jobs: bondJobServiceV2({
    seller, publicOrigin: env.PUBLIC_ORIGIN || undefined, validateInput: checkInput,
    doJob: async (input, ctx) => { const r = await doWork(input, ctx.signal, env); return typeof r === 'string' ? r : JSON.stringify(r); },
  }) };
}

function service(env: Env) {
  const kp = keypairFrom(env.SELLER_KEY);
  const big = (k: keyof Env) => BigInt(String(env[k]));
  const seller = createBondSeller({
    rpcUrl: env.RPC_URL,
    // The signer is the only place the key is used.
    signer: { publicKey: kp.publicKey, async signTransaction(tx) { tx.partialSign(kp); return tx; } },
    terms: {
      price: big('PRICE'), sellerBond: big('SELLER_BOND'), buyerDeposit: big('BUYER_DEPOSIT'),
      deliverSeconds: big('DELIVER_SECONDS'), lateWindow: big('LATE_WINDOW'), payWindow: big('PAY_WINDOW'),
    },
    store: jobStore(env),
    ...assetOptions(env.ASSET),
  });
  return { seller, jobs: bondJobService({
    seller, description: env.DESCRIPTION, publicOrigin: env.PUBLIC_ORIGIN || undefined,
    validateInput: checkInput,
    doJob: (input, ctx) => doWork(input, ctx.signal, env),
  }) };
}

// Optional x402 route (X402_PRICE_USD). verify → doWork → settle; if doWork throws, the payment is not settled.
// With RECEIPT_KEY set, each paid response carries a receipt signed by that key; a bad key only turns receipts off.
let paid: Promise<{ handle: ReturnType<typeof paidRouteHandler>; receiptSigner: ReceiptSigner | null }> | null = null;
function paidRoute(env: Env) {
  if (!env.X402_PRICE_USD) return null;
  paid ??= (async () => {
    let receiptSigner: ReceiptSigner | null = null;
    if (env.RECEIPT_KEY) {
      try { receiptSigner = await receiptSignerFromBytes(Uint8Array.from(JSON.parse(env.RECEIPT_KEY) as number[])); }
      catch (e) { console.error(`RECEIPT_KEY unusable, receipts off: ${(e as Error).message}`); }
    }
    const handle = paidRouteHandler({
      path: '/x402/job',
      priceUsd: Number(env.X402_PRICE_USD),
      description: env.DESCRIPTION,
      check: checkInput,
      run: (input) => doWork(input, AbortSignal.timeout(35_000), env),
    }, () => ({
      payTo: keypairFrom(env.SELLER_KEY).publicKey.toBase58(),
      rpcUrl: env.RPC_URL,
      // A Durable Object stub belongs to one request: get a new one on every call.
      ledger: storageLedger({
        get: (k) => doStub(env).ledgerGet(k) as Promise<LedgerEntry | undefined>,
        put: (k, e) => doStub(env).ledgerPut(k, e),
        delete: (k) => doStub(env).ledgerDelete(k),
      }),
      ...(receiptSigner ? { gate: { receipts: { signer: receiptSigner } } } : {}),
    }));
    return { handle, receiptSigner };
  })();
  return paid;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const route = await paidRoute(env);
    const p = await route?.handle(req);
    if (p) return p;
    const v2 = env.PROTOCOL === '2';
    const { seller, jobs } = v2 ? serviceV2(env) : service(env);
    const r = await jobs.handle(req);
    if (r) return r;
    if (req.method === 'GET' && new URL(req.url).pathname === '/') {
      return Response.json({
        protocol: v2 ? 'agent402-bond-job/2' : 'agent402-bond-job/1', seller: seller.seller, quote: '/quote',
        spec: `https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/${v2 ? 'JOB-PROTOCOL-v2.md' : 'JOB-PROTOCOL.md'}`,
        ...(route ? { x402: { path: '/x402/job', method: 'POST', priceUsd: Number(env.X402_PRICE_USD), asset: 'USDC (Solana)',
          ...(route.receiptSigner ? { receiptSigner: route.receiptSigner.publicKey, receipts: 'Paid responses carry an X-Agent402-Receipt signed by receiptSigner (not the seller wallet key).' } : {}) } } : {}),
      });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.PROTOCOL === '2') {
      const { jobs } = serviceV2(env);
      ctx.waitUntil((async () => {
        for (const r of await jobs.processOpenJobs()) if (r.status !== 'not_open') console.log(`deal ${r.deal}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      })());
      return;
    }
    const { seller, jobs } = service(env);
    ctx.waitUntil((async () => {
      for (const r of await jobs.processOpenJobs()) if (r.status !== 'not_open') console.log(`deal ${r.deal}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      // Anything still unmarked close to its deadline needs your attention.
      const soon = Date.now() + 30 * 60_000;
      for (const u of await seller.unmarked()) if (Date.parse(u.markBy) < soon) console.warn(`deal ${u.deal} must be marked by ${u.markBy}`);
    })());
  },
} satisfies ExportedHandler<Env>;

