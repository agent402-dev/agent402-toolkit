// @agent402-dev/pay-server example: Cloudflare Worker. A402 (v1) is deprecated; switched to PREQ.
// Payments: USDC + PREQ. Rate samples are stored in a Durable Object (RateStore), recorded by an hourly cron.
// Example wrangler.toml:
//   main = "index.ts"
//   compatibility_flags = ["nodejs_compat"]
//   [[durable_objects.bindings]] name = "RATES" class_name = "RateStoreDO"
//   [[migrations]] tag = "v1" new_sqlite_classes = ["RateStoreDO"]
//   [triggers] crons = ["5 * * * *"]
//   [vars] PAY_TO = "<receiving wallet public address>"   # never put a private key here
//   (RPC_URL via `wrangler secret put RPC_URL`)
// This example uses the in-memory ledger (default). To prevent reuse across instances, implement X402Ledger as a DO and pass it in
import { DurableObject } from 'cloudflare:workers';
import {
  createPaymentGate, createRateBook, KNOWN_FACILITATORS, PREQ_MAINNET, rpcChain, SOLANA_MAINNET, USDC_MAINNET,
  type DailyRate, type PriceSample, type RateStore,
} from '@agent402-dev/pay-server';

interface Env { PAY_TO: string; RPC_URL: string; RATES: DurableObjectNamespace<RateStoreDO> }

/** RateStore backed by a Durable Object (SQLite-backed KV) */
export class RateStoreDO extends DurableObject<Env> {
  async addSample(s: PriceSample) { await this.ctx.storage.put(`s:${s.at}`, s); }
  async samples(day: string) { return [...(await this.ctx.storage.list<PriceSample>({ prefix: `s:${day}` })).values()]; }
  async getRate(date: string) { return (await this.ctx.storage.get<DailyRate>(`r:${date}`)) ?? null; }
  async putRate(r: DailyRate) { await this.ctx.storage.put(`r:${r.date}`, r); }
}

function rateStore(env: Env): RateStore {
  const stub = env.RATES.get(env.RATES.idFromName('preq'));
  return {
    addSample: (s) => stub.addSample(s),
    samples: (d) => stub.samples(d) as Promise<PriceSample[]>,
    getRate: (d) => stub.getRate(d) as Promise<DailyRate | null>,
    putRate: (r) => stub.putRate(r),
  };
}

let gate: ReturnType<typeof createPaymentGate> | null = null;
function gateFor(env: Env) {
  if (gate) return gate;
  const chain = rpcChain(env.RPC_URL);
  const rates = createRateBook({ store: rateStore(env), fetcher: chain.accounts }); // PREQ pool (pay-server src/preq.ts)
  gate = createPaymentGate({
    network: SOLANA_MAINNET,
    payTo: env.PAY_TO,
    priceUsd: 0.02, // example setting
    usdc: USDC_MAINNET,
    // Stops here with an error if the PREQ mint is empty
    preq: { asset: PREQ_MAINNET, rate: () => rates.today() },
    facilitators: [KNOWN_FACILITATORS.payai, KNOWN_FACILITATORS.dexter],
    chain,
    resource: { description: 'Example paid resource', serviceName: 'example' },
  });
  return gate;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname !== '/paid') return Response.json({ paid: '/paid' });
    return gateFor(env).withPayment(async (_r, p) => Response.json({ message: 'paid content', paidWith: p.asset }))(req);
  },
  async scheduled(_c: ScheduledController, env: Env): Promise<void> {
    const chain = rpcChain(env.RPC_URL);
    await createRateBook({ store: rateStore(env), fetcher: chain.accounts }).record().catch(() => undefined);
  },
} satisfies ExportedHandler<Env>;
