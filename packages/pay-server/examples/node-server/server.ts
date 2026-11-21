// @agent402-dev/pay-server example: one Node HTTP server with one paid route (USDC, and PREQ when conditions are met). A402 (v1) is deprecated; switched to PREQ.
// Run: PAY_TO=<receiving public address> RPC_URL=<mainnet RPC> npx tsx examples/node-server/server.ts
// The server only gets the receiving wallet's public address (no private key). The receiving wallet must already have USDC and PREQ token accounts.
import { createServer } from 'node:http';
import {
  createPaymentGate, createRateBook, KNOWN_FACILITATORS, PREQ_MAINNET, rpcChain, SOLANA_MAINNET, USDC_MAINNET,
} from '@agent402-dev/pay-server';
import { fileRateStore } from '@agent402-dev/pay-server/rates-file';
import { nodeHandler } from './node-adapter.js';

const PORT = Number(process.env.PORT ?? 8080);
const payTo = process.env.PAY_TO;
const rpcUrl = process.env.RPC_URL;
if (!payTo || !rpcUrl) { console.error('Set PAY_TO and RPC_URL'); process.exit(1); }

const chain = rpcChain(rpcUrl);
const rates = createRateBook({ store: fileRateStore('./data/preq-rates.json'), fetcher: chain.accounts });
// Hourly rate sample (failed samples are not stored; if a day has too few samples, PREQ payments are off the next day)
setInterval(() => { rates.record().catch((e) => console.warn('rate sample skipped:', (e as Error).message)); }, 3_600_000);

const gate = createPaymentGate({
  network: SOLANA_MAINNET,
  payTo,
  priceUsd: 0.02, // example setting
  usdc: USDC_MAINNET,
  // Stops here with an error if the PREQ mint is empty
  preq: { asset: PREQ_MAINNET, rate: () => rates.today() },
  facilitators: [KNOWN_FACILITATORS.payai, KNOWN_FACILITATORS.dexter],
  chain,
  resource: { description: 'Example paid resource', serviceName: 'example' },
});

// Check receiving token accounts at start (assets without one do not appear in the 402)
for (const a of await gate.checkReceivingAccounts().catch(() => [])) {
  console.log(`${a.asset} receiving token account ${a.tokenAccount}: ${a.exists ? 'exists' : 'MISSING — this asset will not be offered'}`);
}

const paid = gate.withPayment(async (_req, payment) => Response.json({ message: 'paid content', paidWith: payment.asset }));

createServer(nodeHandler(async (req) => {
  const { pathname } = new URL(req.url);
  if (pathname === '/paid') return paid(req);
  return Response.json({ paid: '/paid' });
}, `http://localhost:${PORT}`)).listen(PORT, () => console.log(`listening on :${PORT}`));
