// Agent402 Bond seller on Cloudflare Workers — a template for selling one kind of job over the Bond Job Protocol v1.
// Replace doJob() with your work, set the terms in wrangler.toml [vars], deploy. See README.md in this folder.
//
// Routes: GET /quote, POST /open, POST /deliver (protocol) and GET / (info).
// Cron:   every 2 minutes, does the work and marks delivery for deals buyers have opened (never wait for the buyer),
//         settles and claims deals whose outcome is fixed, retries failed jobs, drops deals never opened.
//
// The seller key is a Worker secret (SELLER_KEY). Use a dedicated wallet that holds only what deals need
// (network fees, deal rent, your bonds). The SDK itself never takes a key: this file builds the signer.
import { DurableObject } from 'cloudflare:workers';
import { Keypair, PublicKey } from '@solana/web3.js';
import { type BondJob, type BondJobStore, bondJobService, createBondSeller } from '@agent402-dev/pay-server/bond';

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
  /** Optional: the origin buyers use (e.g. https://jobs.example.com). Delivery requests are signed for it. Default: the request URL's origin */
  PUBLIC_ORIGIN?: string;
  JOBS: DurableObjectNamespace<JobStoreDO>;
}

// ---------------------------------------------------------------------------------------------
// YOUR WORK. Runs once per deal, after the buyer's deposit is locked on chain.
// Keep it well under DELIVER_SECONDS. Whatever you return is what the buyer receives.
// `input` comes from whoever opened the deal: treat it as untrusted. Stop when ctx.signal aborts.
async function doJob(input: string, _ctx: { deal: string; buyer: string; signal: AbortSignal }, _env: Env): Promise<unknown> {
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
}
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
function assetOptions(asset = 'USDC') {
  const a = asset.trim().toUpperCase();
  if (a === 'USDC') return {};
  if (a === 'PREQ') return { mint: new PublicKey('aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX'), tokenProgram: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') };
  throw new Error('ASSET must be USDC or PREQ');
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
  return { seller, jobs: bondJobService({ seller, description: env.DESCRIPTION, publicOrigin: env.PUBLIC_ORIGIN || undefined, doJob: (input, ctx) => doJob(input, ctx, env) }) };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const { seller, jobs } = service(env);
    const r = await jobs.handle(req);
    if (r) return r;
    if (req.method === 'GET' && new URL(req.url).pathname === '/') {
      return Response.json({
        protocol: 'agent402-bond-job/1', seller: seller.seller, quote: '/quote',
        spec: 'https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md',
      });
    }
    return Response.json({ error: 'not found' }, { status: 404 });
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const { seller, jobs } = service(env);
    ctx.waitUntil((async () => {
      for (const r of await jobs.processOpenJobs()) if (r.status !== 'not_open') console.log(`deal ${r.deal}: ${r.status}${r.error ? ` (${r.error})` : ''}`);
      // Anything still unmarked close to its deadline needs your attention.
      const soon = Date.now() + 30 * 60_000;
      for (const u of await seller.unmarked()) if (Date.parse(u.markBy) < soon) console.warn(`deal ${u.deal} must be marked by ${u.markBy}`);
    })());
  },
} satisfies ExportedHandler<Env>;

