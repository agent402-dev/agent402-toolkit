# Keep a checkable record of what your AI agent paid for (x402 payment proof bundle)

When an agent pays for API calls on its own, someone later asks: which rules was it running under, what did it check before
paying, what exactly did it pay, and did the seller deliver what the receipt says? A payment log answers part of that, but only
if you trust the log. This page shows how to keep one JSON file per payment that anyone can check again later, using the
open-source `@agent402-dev/pay-mcp` (Apache-2.0, pay-mcp 0.16.1 or later). Building and checking a bundle signs nothing and pays
nothing.

## What goes into a bundle

| Field | What it holds |
| --- | --- |
| `policyHash` | SHA-256 of the spending rules (hosts, recipients, limits) as sorted JSON, so the same rules always give the same hash |
| `agent` (optional) | The buyer's 8004 agent identity, if it has one |
| `preflight` (optional) | What was checked before paying: the URL, the number of things to fix (0 = clean) and their codes |
| `payment` | Resource URL, network, asset, amount in smallest units, recipient, transaction and time |
| `receipt` (optional) | The seller's signed `X-Agent402-Receipt`, if it sent one |

## 1. Pay as usual

The agent pays through `x402_fetch` under your rules (`X402_ALLOWED_DOMAINS`, `X402_TRUSTED_PAY_TO`, the per-payment and daily
limits). Its result has the payment (`network`, `mint`, `amount`, `payTo`, `settlementTx`) and, when the seller signs receipts,
`receipt.token`. The same payment is also in `payment_history`.

## 2. Build the bundle

```ts
import { buildProofBundle } from '@agent402-dev/pay-mcp/proof-bundle';
import { policyFromEnv } from '@agent402-dev/pay-mcp/policy';

const bundle = await buildProofBundle({
  policy: policyFromEnv(process.env), // the same X402_* rules the agent ran with
  payment: { resource, network, asset: mint, amount, payTo, transaction: settlementTx, at: new Date().toISOString() },
  receipt: receiptToken, // optional
});
```

`amount` must be an integer string and `at` an ISO time; anything else is refused when the bundle is built. Start-up warnings are not
part of the rules and do not change the hash.

## 3. Check it, now or later

```bash
npx -y @agent402-dev/pay-mcp verify-proof --bundle proof.json --rules-from-env
```

It prints each check and exits 0 when all pass, 1 when one fails, 2 when the file cannot be read. The checks:

- format of the bundle;
- with `--rules-from-env`: the rules hash matches the X402_* rules in this environment, and the resource host and recipient were
  allowed by them;
- `preflight` reported nothing to fix, when it is there;
- the receipt signature, and that the receipt's payment fields equal the bundle's;
- the payment on chain (Solana), through the receipt. `--rpc <url>` picks the RPC, `--no-chain` skips it.

Anything it could not check is listed under `notChecked` instead of being counted as passed: no rules given, no receipt in the
bundle, and so on. A receipt shows which key signed it; whether that key belongs to the seller is for the seller to publish.

## Limits

- The bundle records what your side did. It does not prove the response was good, only what the receipt binds (request, response
  body hash, payment).
- There is no user signature over the rules. The hash shows which rules were in place, not who approved them.
- `x402_fetch` does not build bundles for you; you build them from its result.

Internal review only, not independently audited.
