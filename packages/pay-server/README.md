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
- It **does not accept or send payments on anyone's behalf.** The x402 gate receives only your receiving address (public key). No API takes a private key: the optional Bond seller helper (below) asks for a signer function that you provide (a wallet, a KMS, or your own wrapper) and never reads or stores keys.

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

PREQ has not been checked on a hosted facilitator yet. On 2026-11-22 a PREQ payment was verified and settled end to end in a local mainnet-fork rehearsal (Surfpool, with the official x402 facilitator code `@x402/svm` exact scheme and the real PREQ mint). `KNOWN_FACILITATORS.payai` lists PREQ because PayAI's `/supported` shows no asset restriction for the Solana `exact` scheme and it accepted a Token-2022 token in the check above. These are observations from one day. Facilitator policies and balances change; `KNOWN_FACILITATORS` only provides defaults that you can override.

**Facilitator fees.** As of 2026-11-22, PayAI's documentation describes a free tier of up to 10,000 settlements per month without an API key, and paid credits with an API key beyond that. Check the facilitator's current terms before production use.

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

## Signed receipts (optional)
After a settled payment the gate can add an `X-Agent402-Receipt` header: a small JSON record, signed with Ed25519, that binds the request (method, path, body hash), the hash of the response body you delivered, and the payment (network, asset, amount, recipient, transaction). Buyers can keep it as evidence for disputes and settlement reports; `@agent402-dev/pay-mcp` checks it automatically.

```ts
import { receiptSignerFromBytes } from '@agent402-dev/pay-server';

const signer = await receiptSignerFromBytes(receiptKeyBytes); // 64-byte Solana CLI key file, or a 32-byte seed
const gate = createPaymentGate({ /* ... */ receipts: { signer } });
```
- Use a key made only for receipts (for example `solana-keygen new -o receipt-key.json`), never the key of your receiving wallet. The gate never needs the receiving wallet's key.
- Publish the receipt key's public key (`signer.publicKey`) so buyers can tell that receipts come from you.
- If signing fails, the paid resource is still delivered, without a receipt.

## Seller registration and locks (optional)
Buyers using `@agent402-dev/pay-mcp` can require sellers to have an on-chain lock. To be eligible, lock tokens (PREQ, USDC or wrapped SOL) with [Jupiter Lock](https://lock.jup.ag/) to your own address with **no cancel and no recipient-change permission**, then serve a signed registration at `https://<your host>/.well-known/agent402.json`:

```ts
import { receiptSignerFromBytes, signRegistration } from '@agent402-dev/pay-server';

const lockKey = await receiptSignerFromBytes(lockRecipientKeyBytes); // offline; the key that receives the lock
const doc = await signRegistration({ host: 'api.example.com', payTo: ['YOUR_RECEIVING_ADDRESS'], locks: [{ protocol: 'jupiter-lock', account: 'LOCK_ESCROW_ADDRESS' }] }, [lockKey]);
// Serve JSON.stringify(doc) at /.well-known/agent402.json
```
Or from the command line (keys are read on your computer and never sent):
```bash
npx -y @agent402-dev/pay-server register --host api.example.com --pay-to <receiving address> \
  --lock jupiter-lock:<lock escrow address> --key <lock recipient key file> --out agent402.json
```
- Sign offline and serve only the resulting document. The gate never needs the lock key or the receiving wallet's key.
- Use a lock received by a regular key. A lock received by a multisig vault cannot sign the registration yet.
- The format is the same for every asset. A lock is a commitment signal only; nothing can be confiscated.

## Agent402 Bond, seller side (optional)
`@agent402-dev/pay-server/bond` helps a seller run [Agent402 Bond](https://github.com/agent402-dev/agent402-toolkit/tree/main/programs) deals (beta): the seller locks a bond, the buyer locks a deposit, and the outcome follows only signatures and the Solana clock. Use it for work that takes time; use the x402 gate for instant pay-per-request.

```ts
import { createBondSeller } from '@agent402-dev/pay-server/bond';

const seller = createBondSeller({
  rpcUrl,
  signer,                       // { publicKey, signTransaction(tx) } — your wallet or KMS; the SDK never sees the key
  terms: { price: 20_000_000n, sellerBond: 2_000_000n, buyerDeposit: 5_000_000n, deliverSeconds: 3_600n, lateWindow: 0n, payWindow: 86_400n },
  store,                        // persist jobs (default: in memory)
});

seller.quote();                                   // terms to show the buyer
const p = await seller.prepareOpen(buyerAddress); // `open` with you as fee payer, signed by you → send p.transaction to the buyer
await seller.requireOpen(p.deal);                 // start work only after this passes (deposit locked, terms as prepared)
await seller.markDelivered(p.deal);               // when you hand over the work, before the deadline
await seller.settle(p.deal);                      // once the outcome is fixed (you pay the network fee)
await seller.unmarked();                          // open deals you have not marked yet, earliest deadline first
```

- Terms are checked against the program limits before anything is signed (bond at most 20% of the price, late window up to 7 days, pay window 1 to 30 days).
- If nothing is marked or confirmed by the deadline (delivery time + 1 day + late window), the bond and the deposit go to the buyer. Run `unmarked()` on a timer.
- The program does not judge quality. If the buyer never confirms, each side gets its own money back; quality disputes are resolved between the parties.
- `bondJobService({ seller, doJob })` serves the whole [Bond Job Protocol](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md) (`GET /quote`, `POST /open`, `POST /deliver`) as a Fetch-style `handle(req)` (Node, Cloudflare Workers): it checks the buyer's signature, starts work only once the deal is open on chain, marks delivery, and returns the same result on repeat calls. **Run its `processOpenJobs()` on a timer**: it does the work and marks delivery for every deal the buyer has opened, without waiting for the buyer to ask (otherwise a buyer who never fetches the result would get your bond at the deadline); it also settles and claims once the outcome is fixed, retries failed jobs without re-running finished ones, and drops prepared deals that were never opened. Long jobs answer `202 working` on `/deliver`.
- Protections in `bondJobService` (all configurable):
  - each run of `doJob` is aborted after `jobTimeoutSeconds` (default 120; `ctx.signal` fires). After `maxAttempts` failures (default 3), or 30 minutes before the mark deadline with no result, it delivers `{ "error": "job_failed" }` and marks, so a bad input ends neutral (each side gets its own money back) instead of costing your bond;
  - `validateInput(input)` refuses inputs before any deal is prepared;
  - a buyer sees the work before deciding to confirm, and a deal never confirmed ends neutral, so the buyer could keep the work without paying. `maxUnconfirmedPerBuyer` (default 2) refuses buyers with that history (403); a buyer can switch wallets, so price jobs with this in mind or allowlist buyers for valuable work;
  - `maxPendingPerBuyer` (default 3) and `maxPending` (default 50) cap deals in progress (each one locks your bond); over the cap `/open` answers 429;
  - `processOpenJobs()` reads all deals in one batch, works on the earliest deadlines first (`concurrency`, default 4), and one failing deal does not stop the others;
  - when several processes share one store (several Worker isolates, several servers), give the store `lock`/`unlock` so a job runs once (the in-memory store and the Workers example have it);
  - if the buyer's token account is frozen or closed, settling falls back to claiming only your share;
  - delivery requests are signed for your origin and expire within 10 minutes; set `publicOrigin` if you run behind a proxy that changes the scheme or host;
  - USDC prices above the program's 100 USDC beta cap, `deliverSeconds` under 60 and `prepareTtlSeconds` under 300 are refused at startup.
- Buyers can use `@agent402-dev/pay-mcp` (`bond_job_start`, or `bond_open` for a transaction you deliver another way), which rebuilds your `open` transaction for its own wallet and signs only if it matches.
- Ready-to-deploy Cloudflare Workers seller (Durable Object job store, cron that delivers and marks): [`examples/bond-seller-worker`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-server/examples/bond-seller-worker).
- Full example with a seller service and a buyer agent: [`packages/bond-client/examples/job`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/bond-client/examples/job).

## Data
- No telemetry and no analytics.
- It contacts only the facilitators you configure (`/supported`, `/verify`, `/settle`) and the RPC you pass to `rpcChain` (settlement checks, receiving token accounts, pool prices for the PREQ rate).
- Replay protection keeps payment identifiers in the ledger you configure (in memory by default). It stores no other buyer data.
- It writes nothing to the console except the A402 (v1) deprecation warning when you enable A402.

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice.
