# a402-pay-mcp

MCP server (stdio) that lets an AI agent call [x402](https://github.com/coinbase/x402) paid APIs on Solana and pay in **USDC** (or, if you allow it, **A402**) from **your own wallet on your machine**, only within the rules you set.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana).
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

> It pays only what you allow and gives no opinion on any API or token. Not investment advice.
> 허용한 만큼만 결제하며 API나 토큰에 대한 의견을 주지 않습니다. 투자 권유가 아닙니다.

## Rules checked before signing
Nothing is signed unless every rule passes. **With no configuration, every payment is refused.**

| Rule | Variable | Default |
|---|---|---|
| Allowed domains (host or host:port; https only, http only for localhost) | `X402_ALLOWED_DOMAINS` | empty → refuse all |
| Trusted recipients (payTo addresses) | `X402_TRUSTED_PAY_TO` | empty → refuse all |
| Allowed assets | `X402_ALLOWED_ASSETS` | `USDC` (A402 only if listed) |
| Max USDC per payment (USD) | `X402_MAX_USD` | `0.05` |
| Max USDC per UTC day (USD) | `X402_MAX_USD_PER_DAY` | `1` |
| Max payments per UTC day | `X402_MAX_PAYMENTS_PER_DAY` | `20` |
| **Max A402 per payment** (A402 smallest units; 1 A402 = 1,000,000) | `X402_MAX_A402_ATOMIC` | **not set → A402 payments refused** |
| **Max A402 per UTC day** (A402 smallest units; 1 A402 = 1,000,000) | `X402_MAX_A402_PER_DAY_ATOMIC` | **not set → A402 payments refused** |
| Ask a human at or above this USDC amount (USD) | `X402_CONFIRM_ABOVE_USD` | off |
| Ask a human at or above this A402 amount (A402 smallest units) | `X402_CONFIRM_ABOVE_A402_ATOMIC` | off |

- **A402 units.** The A402 variables take the smallest unit (A402 has 6 decimals). Example: `X402_MAX_A402_ATOMIC=200000000000` is 200,000 A402 per payment. `wallet_status` and `payment_history` also show A402 amounts in smallest units (`…Atomic` fields).
- USD limits apply to USDC only. A402 has its own two limits, and **both must be set** before any A402 payment is made.
- Human confirmation uses MCP elicitation. If your MCP client cannot ask, the payment is not made (`confirmation_required`).
- At most one signature per `x402_fetch` call. If the server answers 402 again after payment, it does not sign again.
- Redirects are followed manually and each hop must be an allowed domain; a disallowed hop is not contacted.
- Pass `quoteId` from `x402_quote` to `x402_fetch` to refuse if the amount, asset or recipient changed.
- Daily totals count every payment this server signed, whatever the result.
- Daily limits are counted from the local payment log file (`X402_HISTORY_PATH`). Deleting or moving that file resets the daily totals.

Other settings: `X402_KEYPAIR_PATH` (wallet key file, Solana CLI JSON; without it nothing is paid), `X402_NETWORK` (`mainnet` | `devnet`), `X402_RPC_URL`, `X402_PAY_WITH` (`USDC` | `A402`), `X402_HISTORY_PATH` (default `~/.agent402/payments.jsonl`).

## Tools
| Tool | What it does |
|---|---|
| `x402_fetch` | Fetch a URL; pay only if the rules pass |
| `x402_quote` | Show payment requirements and which rules pass; never signs; returns `quoteId` |
| `wallet_status` | Address, balances, today's usage (count, USDC, A402), limits including both A402 limits, allowlists |
| `payment_history` | Local log: time, URL, asset, amount, recipient, result, settlement transaction id |

The log never stores keys or signed payment payloads.

## Use a small, dedicated wallet
Put only what you are willing to spend in the payment wallet. Never point this at a wallet that holds other funds. The key file stays on your machine; only a partially signed payment transaction is sent.

## What it does not do
- It **does not judge, score or rate** tokens or APIs and gives no investment advice.
- It **does not operate a facilitator**, **does not hold funds**, **does not exchange** currencies, and **does not accept or send payments on anyone's behalf**. It signs payments from your own wallet, on your machine, under your rules.

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice. / 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.
