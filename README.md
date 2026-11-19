# Agent402 toolkit (Solana)

Open-source tools from Agent402 for Solana: factual token checks, and [x402](https://github.com/coinbase/x402) payments in USDC and A402 (a Token-2022 token).

> Factual information from public on-chain data. Not investment advice.
> 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.

Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

## Packages
| Package | What it is |
|---|---|
| [`@agent402-dev/check-engine`](packages/check-engine) | Reads public on-chain data for a token mint and returns facts with evidence addresses (authorities, Token-2022 extensions, holders, liquidity locks, operator locks, early buys) |
| [`@agent402-dev/check-mcp`](packages/check-mcp) | MCP server for the checks. Free: summary from the hosted API, full report on your machine with your own RPC |
| [`@agent402-dev/pay-server`](packages/pay-server) | Server helpers to accept x402 payments in USDC and, optionally, A402 through external facilitators (verify → your handler → settle) |
| [`@agent402-dev/pay-mcp`](packages/pay-mcp) | MCP server that lets an AI agent pay x402 APIs from your own wallet, on your machine, within limits and allowlists you set (with no configuration, every payment is refused) |

## What this toolkit does not do
- It **does not operate a facilitator.** Payment verification and settlement are done by external x402 facilitators (for example PayAI).
- It **does not hold funds.** Payments go from the buyer's wallet directly to the seller's receiving address.
- It **does not exchange** currencies. The A402 rate is used only to compute an A402 price; there is no A402 ↔ USDC conversion.
- It **does not accept or send payments on anyone's behalf.** The payment MCP signs with your own wallet on your machine; the server SDK takes only your public receiving address.
- It **does not judge, score or rate tokens** and gives no investment advice.

## Amounts and units
USDC and A402 both have 6 decimals. In x402 requirements, limits and logs, amounts are in the **smallest unit** unless marked otherwise: 1 USDC = 1,000,000 and **1 A402 = 1,000,000 smallest units**. Tool outputs add the unit next to each amount (for example `"amountDisplay": "140,000 A402"`).

## Development
```bash
npm install
npm test
npm run typecheck
```
Node 20+. Tests run offline (recorded public mainnet data and local fakes).

## License
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

---
Factual information from public on-chain data. Not investment advice. / 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.
