// @agent402-dev/pay-server 예제: Cloudflare Worker. 환율 기록은 Durable Object(RateStore) 에, 매시간 cron 으로 기록.
// wrangler.toml 예:
//   main = "index.ts"
//   compatibility_flags = ["nodejs_compat"]
//   [[durable_objects.bindings]] name = "RATES" class_name = "RateStoreDO"
//   [[migrations]] tag = "v1" new_sqlite_classes = ["RateStoreDO"]
//   [triggers] crons = ["5 * * * *"]
//   [vars] PAY_TO = "<수령 지갑 공개 주소>"   # 개인키는 넣지 않음
//   (RPC_URL 은 `wrangler secret put RPC_URL`)
// 이 예제의 Durable Object 장부는 메모리 장부(기본)를 씀 — 여러 인스턴스에서 재사용을 막으려면 X402Ledger 를 DO 로 구현해 넘기면 됨
import { DurableObject } from 'cloudflare:workers';
import {
  A402_MAINNET, createPaymentGate, createRateBook, KNOWN_FACILITATORS, rpcChain, SOLANA_MAINNET, USDC_MAINNET,
  type DailyRate, type PriceSample, type RateStore,
} from '@agent402-dev/pay-server';

interface Env { PAY_TO: string; RPC_URL: string; RATES: DurableObjectNamespace<RateStoreDO> }

/** RateStore 를 Durable Object(SQLite 저장소의 KV) 로 */
export class RateStoreDO extends DurableObject<Env> {
  async addSample(s: PriceSample) { await this.ctx.storage.put(`s:${s.at}`, s); }
  async samples(day: string) { return [...(await this.ctx.storage.list<PriceSample>({ prefix: `s:${day}` })).values()]; }
  async getRate(date: string) { return (await this.ctx.storage.get<DailyRate>(`r:${date}`)) ?? null; }
  async putRate(r: DailyRate) { await this.ctx.storage.put(`r:${r.date}`, r); }
}

function rateStore(env: Env): RateStore {
  const stub = env.RATES.get(env.RATES.idFromName('a402'));
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
  const rates = createRateBook({ store: rateStore(env), fetcher: chain.accounts });
  gate = createPaymentGate({
    network: SOLANA_MAINNET,
    payTo: env.PAY_TO,
    priceUsd: 0.02, // 설정 예시 (example setting)
    usdc: USDC_MAINNET,
    a402: { asset: A402_MAINNET, discountPercent: 30 /* 설정 예시 (example setting) */, rate: () => rates.today() },
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
