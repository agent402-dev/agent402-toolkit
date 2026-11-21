# @agent402-dev/pay-server

> **A402 (v1) is deprecated.** The token payment option is now **PREQ** (mint `aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX`). Official addresses: https://claude.ai/artifact/S6UafAfViJk3DJeMsDMAja

Server helpers for [x402](https://github.com/coinbase/x402) payments on Solana that accept **USDC** and, optionally, **PREQ** (a Token-2022 token) through standard x402 facilitators.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana).
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

> This package moves no funds itself and gives no opinion on any token. Rates and amounts are facts computed from public on-chain data, not investment advice.

## What it does
- Builds x402 v2 `exact` payment requirements per request with the official `@x402/core` `x402ResourceServer` (USDC, plus PREQ when it can be offered).
- Order of work: **verify → your handler → settle**. If your handler fails, times out (default 40 s), or returns a status ≥ 400, the payment is **not settled**.
- If a settlement fails or its result is unknown, it checks the chain for the buyer's transaction before answering. It treats the payment as not taken only after the transaction can no longer land (about 150 s).
- Keeps a ledger so a payment cannot be used twice.
- Rechecks the settlement transaction on chain (amount received by your address).
- Uses the next facilitator in your list when one is unreachable or fails for reasons on its own side (for example its fee payer lacks SOL).

## What it does not do
- It **does not judge, score or rate tokens** and gives no investment advice.
- It **does not operate a facilitator.** Verification and settlement are done by the external facilitators you configure.
- It **does not hold funds.** Payments go from the buyer's wallet directly to your receiving address.
- It **does not exchange** currencies. The PREQ rate is used only to compute the PREQ amount; there is no PREQ ↔ USDC conversion.
- It **does not accept or send payments on anyone's behalf.** Your server receives only your receiving address (public key); there is no API that takes a private key.

## PREQ option
PREQ is offered only when all of these hold for the request:
1. The selected facilitator is configured to accept PREQ.
2. Your receiving address has a PREQ (Token-2022) token account. `exact` payments do not create the receiving account; create it in advance. The same applies to USDC.
3. The day's PREQ rate is available. The rate is the median of the previous UTC day's hourly samples (Meteora DAMM v2 PREQ/SOL pool price × Pyth SOL/USD). It is switched off for the day when there are fewer than 12 samples, the pool's SOL-side depth fell below 100 USD, the max/min ratio exceeded 1.5, or any sample has a zero or non-finite price. These thresholds are configurable. Right after trading starts, a single-sided pool holds almost no SOL, so the depth rule keeps PREQ off until the pool has SOL-side depth.

When PREQ is not offered, the 402 response lists it under `notOffered` with the reason.

**PREQ addresses.** `PREQ_MAINNET` (mint) and the pricing pool address are kept in one place, `src/preq.ts`. Until they are filled in, enabling PREQ (`config.preq` with `PREQ_MAINNET`, or `rates.record()`) stops with an error that names the missing value.

**Units.** As in every x402 requirement, `amount` is in the token's smallest unit. USDC and PREQ both have 6 decimals: 1 USDC = 1,000,000 smallest units, 1 PREQ = 1,000,000 smallest units. For example, a PREQ `amount` of `140000000000` is 140,000 PREQ. The PREQ amount is `priceUsd ÷ (PREQ rate in USD)`, rounded up to the smallest unit: the same USD price as USDC. (`discountPercent` exists as an optional setting and defaults to 0.)

**A402 (v1).** A402 is deprecated and is not part of any default. `A402_MAINNET` and `config.a402` remain only for existing setups; passing `config.a402` prints the warning "A402 (v1) is deprecated and no longer supported; use PREQ.". Nothing is paid in A402 unless you configure it explicitly.

## Facilitators (facts as checked on Solana mainnet, 2026-11-19)
| Facilitator | USDC `exact` | A402 (v1, deprecated; Token-2022) `exact` |
|---|---|---|
| PayAI `https://facilitator.payai.network` | verify and settle succeeded | verify and settle succeeded (fee paid by the facilitator's fee payer) |
| Dexter `https://x402.dexter.cash` | listed in `/supported`; at the time of the check, verify returned `transaction_simulation_failed` because its fee payer account held 0.000656 SOL | verify returned `policy:asset_not_allowed` (A402 is not in its asset allowlist) |

PREQ has not been checked with any facilitator yet; it will be checked on mainnet after the PREQ launch. `KNOWN_FACILITATORS.payai` lists PREQ because it accepted a Token-2022 token in the check above. These are observations from one day. Facilitator policies and balances change; `KNOWN_FACILITATORS` only provides defaults that you can override.

## Install
```bash
npm install @agent402-dev/pay-server
```
Node 20+ or Cloudflare Workers (`nodejs_compat`). ESM only.

## Usage
```ts
import { createPaymentGate, rpcChain, KNOWN_FACILITATORS, SOLANA_MAINNET, USDC_MAINNET, PREQ_MAINNET,
  createRateBook, memoryRateStore } from '@agent402-dev/pay-server';

const rates = createRateBook({ store: memoryRateStore(), fetcher: rpcChain(RPC_URL).accounts }); // PREQ pool from src/preq.ts
const gate = createPaymentGate({
  network: SOLANA_MAINNET,
  payTo: 'YOUR_RECEIVING_ADDRESS',
  priceUsd: 0.02, // example setting
  usdc: USDC_MAINNET,
  preq: { asset: PREQ_MAINNET, rate: () => rates.today() },
  facilitators: [KNOWN_FACILITATORS.payai, KNOWN_FACILITATORS.dexter],
  chain: rpcChain(RPC_URL),
});

export default {
  fetch: gate.withPayment(async (req) => new Response(JSON.stringify({ hello: 'paid world' }))),
};
// call rates.record() hourly (cron) to collect samples
```
Rate stores: `memoryRateStore()` (default, tests), `fileRateStore(path)` from `@agent402-dev/pay-server/rates-file` (Node), or your own `RateStore` (for example a Cloudflare Durable Object; see the [Workers example](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-server/examples/cloudflare-worker)). A Node example is in [`examples/node-server`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-server/examples/node-server).

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice.
