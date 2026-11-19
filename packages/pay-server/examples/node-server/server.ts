// @agent402-dev/pay-server 예제: Node HTTP 서버 하나에 유료 경로 하나 (USDC, 조건이 맞으면 A402).
// 실행: PAY_TO=<수령 공개 주소> RPC_URL=<메인넷 RPC> npx tsx examples/node-server/server.ts
// 서버에는 수령 지갑의 공개 주소만 들어감 (개인키 없음). 수령 지갑에 USDC·A402 토큰 계정이 미리 있어야 함.
import { createServer } from 'node:http';
import {
  A402_MAINNET, createPaymentGate, createRateBook, KNOWN_FACILITATORS, rpcChain, SOLANA_MAINNET, USDC_MAINNET,
} from '@agent402-dev/pay-server';
import { fileRateStore } from '@agent402-dev/pay-server/rates-file';
import { nodeHandler } from './node-adapter.js';

const PORT = Number(process.env.PORT ?? 8080);
const payTo = process.env.PAY_TO;
const rpcUrl = process.env.RPC_URL;
if (!payTo || !rpcUrl) { console.error('PAY_TO 와 RPC_URL 을 설정하세요'); process.exit(1); }

const chain = rpcChain(rpcUrl);
const rates = createRateBook({ store: fileRateStore('./data/a402-rates.json'), fetcher: chain.accounts });
// 매시간 환율 기록 (실패한 기록은 남기지 않음 — 그날 기록이 부족하면 다음 날 A402 결제는 꺼짐)
setInterval(() => { rates.record().catch((e) => console.warn('rate sample skipped:', (e as Error).message)); }, 3_600_000);

const gate = createPaymentGate({
  network: SOLANA_MAINNET,
  payTo,
  priceUsd: 0.02, // 설정 예시 (example setting)
  usdc: USDC_MAINNET,
  a402: { asset: A402_MAINNET, discountPercent: 30 /* 설정 예시 (example setting) */, rate: () => rates.today() },
  facilitators: [KNOWN_FACILITATORS.payai, KNOWN_FACILITATORS.dexter],
  chain,
  resource: { description: 'Example paid resource', serviceName: 'example' },
});

// 시작할 때 수령 토큰 계정 확인 (없으면 그 자산은 402 에 나오지 않음)
for (const a of await gate.checkReceivingAccounts().catch(() => [])) {
  console.log(`${a.asset} receiving token account ${a.tokenAccount}: ${a.exists ? 'exists' : 'MISSING — this asset will not be offered'}`);
}

const paid = gate.withPayment(async (_req, payment) => Response.json({ message: 'paid content', paidWith: payment.asset }));

createServer(nodeHandler(async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/paid') return paid(req);
  return Response.json({ paid: '/paid' });
}, `http://localhost:${PORT}`)).listen(PORT, () => console.log(`listening on :${PORT}`));
