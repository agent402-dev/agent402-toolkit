# @agent402-dev/check-mcp

MCP server (stdio) that returns **facts with evidence addresses** about a Solana token mint. Free.
It does not judge or rate tokens and gives no investment advice.

> Factual information from public on-chain data. Not investment advice.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana). Uses [`@agent402-dev/check-engine`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/check-engine).
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

## Tools
| Tool | What it returns | Where it runs |
|---|---|---|
| `token_check_summary` | Items 1–4: mint, freeze and metadata update authorities; Token-2022 extensions with authority addresses | Hosted A402 Check API (no key needed, 20 calls per IP per day) |
| `token_check` | Items 1–8 (adds holders, liquidity lock, operator locks, buys right after trading opened) | **On your machine** with your own Solana RPC (`A402_CHECK_RPC_URL`) |

Input for both: `{ "mint": "<base58 mint address>" }`. No payments, no wallet.

## Try it in one minute (no RPC, no key)
```bash
claude mcp add a402-check -- npx -y @agent402-dev/check-mcp
```
Then ask your agent: **"Run token_check_summary on EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"** (the USDC mint). It answers from the hosted API with the mint, freeze and metadata authorities and their addresses, and the evidence accounts. `token_check` (the full report) asks for your own RPC first, as below.

## Connect
Claude Code:
```bash
claude mcp add a402-check -e A402_CHECK_RPC_URL=<your mainnet RPC> -- npx -y @agent402-dev/check-mcp
```
Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "a402-check": { "command": "npx", "args": ["-y", "@agent402-dev/check-mcp"], "env": { "A402_CHECK_RPC_URL": "<your mainnet RPC>" } } } }
```
Items 5–8 use `getTokenLargestAccounts` and `getProgramAccounts`, which keyless public RPC endpoints often refuse; for these, use an RPC with an API key. Without `A402_CHECK_RPC_URL`, `token_check` explains how to set it and `token_check_summary` still works. The RPC address is never printed or sent to the hosted API.

| Variable | Meaning | Default |
|---|---|---|
| `A402_CHECK_RPC_URL` | Your Solana mainnet RPC for `token_check` | none |
| `A402_CHECK_API` | Hosted API base URL for `token_check_summary` | `https://a402-check.agent402-ebc.workers.dev` |

Token amounts in results are in the token's smallest unit (raw integer) unless the field says otherwise; `uiAmount` fields are in whole tokens.

## What it does not do
- It **does not judge, score or rate tokens** and gives no investment advice. It returns facts and evidence addresses.
- It **does not operate a facilitator**, **does not hold funds**, **does not exchange** currencies, and **does not accept or send payments on anyone's behalf**. It has no payment function.

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice.
