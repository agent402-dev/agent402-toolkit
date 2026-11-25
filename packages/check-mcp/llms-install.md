# Installing @agent402-dev/check-mcp (for AI agents such as Cline)

check-mcp is a local MCP server (stdio) that returns facts with evidence addresses about a Solana token mint: authorities, Token-2022 extensions, holders, liquidity locks and buys right after trading opened. It does not judge or rate tokens and gives no investment advice. It never pays and needs no wallet.

> Factual information from public on-chain data. Not investment advice.

## Requirements

- Node.js 20 or newer (`node --version`).
- No API key and no wallet. A Solana mainnet RPC is only needed for the full report (`token_check`).

## 1. Add the server

Add this to the MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "a402-check": {
      "command": "npx",
      "args": ["-y", "@agent402-dev/check-mcp"]
    }
  }
}
```

## 2. Verify (no RPC needed)

Call `token_check_summary` with `{ "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }` (the USDC mint). It answers from the hosted A402 Check API (20 calls per IP per day) with the mint, freeze and metadata authorities and the evidence accounts.

## 3. Full report (optional, needs the user's RPC)

Ask the user for their Solana mainnet RPC address; do not pick one yourself. Then add an `env` block:

```json
"env": {
  "A402_CHECK_RPC_URL": "<mainnet RPC address from the user>"
}
```

`token_check` then computes items 1-8 on this machine. Items 5-8 use `getTokenLargestAccounts` and `getProgramAccounts`, which keyless public RPC endpoints often refuse. The RPC address is never printed or sent to the hosted API.

## Reporting results

Report the facts and their evidence addresses as returned. Do not turn them into a rating, a recommendation or a prediction. Token amounts are in the token's smallest unit unless the field says otherwise.

## Troubleshooting

- `rpc_not_configured`: `A402_CHECK_RPC_URL` is not set; `token_check_summary` still works.
- HTTP 429 from `token_check_summary`: the daily limit for this IP is reached (`remainingToday`).
- `upstream_unavailable`: the RPC failed or refused the calls; check the address and plan limits.

More: https://github.com/agent402-dev/agent402-toolkit/blob/main/packages/check-mcp/README.md
