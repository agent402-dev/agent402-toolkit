# x402 on Solana: charge per API request in USDC, and let an AI agent pay

[x402](https://github.com/coinbase/x402) is an HTTP payment standard: your API answers `402 Payment Required` with a price, the client
signs a payment, retries the same request with a `PAYMENT-SIGNATURE` header, and gets the response. A facilitator verifies and settles
the payment on chain. On Solana the `exact` scheme moves USDC (an SPL token) straight to your wallet; you never hold the buyer's key and
the buyer never holds yours.

This page shows both sides with the open-source Agent402 toolkit (Apache-2.0).

## Sell: one paid route

```bash
npm install @agent402-dev/pay-server
```

```ts
import { paidRouteHandler, storageLedger } from '@agent402-dev/pay-server/route';

const handle = paidRouteHandler({
  path: '/x402/job',
  priceUsd: 0.05,
  description: 'Counts the words in a text',
  check: (input) => (input.trim() ? null : 'send some text'), // malformed input → 400, no payment asked
  run: async (input) => ({ words: input.trim().split(/\s+/).length }),
}, () => ({ payTo: 'YOUR_SOLANA_ADDRESS', rpcUrl: RPC_URL, ledger: storageLedger(yourStorage) }));
```

- A request without input gets the 402, so clients and directories can read the price.
- Order: verify → your work → settle. If your work throws, the payment is not settled.
- Your receiving address needs a USDC token account before the first payment (`exact` payments do not create it).
- Default facilitators: PayAI, then Dexter. As of 2026-11-22, PayAI's documentation describes a free tier of up to 10,000 settlements per month without an API key; check current terms before production use.

Prefer a deployable starting point? The [Cloudflare Workers template](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-server/examples/bond-seller-worker)
sells the same work per request (`X402_PRICE_USD`) and, optionally, as a bonded job.

## Check your own 402 without a wallet

```bash
npx -y @agent402-dev/pay-server check https://your-api.example.com/x402/job --post '{"text":"hello"}'
```

One request, no payment header. Each line is `fix`, `note` or `ok` (x402 v2 header, network id, USDC mint, amount format, `payTo`,
`feePayer`, `resource.url`). Exit code 1 means something to fix. `--json` prints the same for CI.

## Buy: let an AI agent pay, within your rules

```bash
npx -y @agent402-dev/pay-mcp init   # a small wallet just for the agent
```

Add the MCP server to your client with your own rules. Without them every payment is refused:

| Rule | Variable |
| --- | --- |
| Hosts it may pay | `X402_ALLOWED_DOMAINS` |
| Addresses it may pay | `X402_TRUSTED_PAY_TO` |
| Most per payment / per UTC day (USD) | `X402_MAX_USD`, `X402_MAX_USD_PER_DAY` |

Then ask the agent to run `x402_quote` on a URL (never pays: shows price, asset, recipient and whether your rules allow it) and
`x402_fetch` with the `quoteId` to pay. Payments are logged locally (`payment_history`, `spending_report`).

USDC on Base works the same way when you turn it on (`X402_ALLOWED_NETWORKS=solana,base`); the same rules apply across both networks.

## Links

- pay-server: https://www.npmjs.com/package/@agent402-dev/pay-server
- pay-mcp: https://www.npmjs.com/package/@agent402-dev/pay-mcp
- Getting started: https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/getting-started.md
- Which sellers pay-mcp reads today: https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/works-with.md

Internal review only, not independently audited.
