# Installing @agent402-dev/pay-mcp (for AI agents such as Cline)

pay-mcp is a local MCP server (stdio) that lets an agent pay x402 APIs in USDC on Solana and buy Agent402 Bond jobs, from a wallet on the user's own machine, within limits the user sets. With no configuration it refuses every payment, so it is safe to install first and configure after.

## Requirements

- Node.js 20 or newer (`node --version`).
- No API key is needed. A wallet key file is only needed for paying.

## 1. Add the server (read-only until configured)

Add this to the MCP settings (for Cline: `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "a402-pay": {
      "command": "npx",
      "args": ["-y", "@agent402-dev/pay-mcp"]
    }
  }
}
```

Check it works: call `wallet_status`. It shows the limits and allowlists, and no wallet until one is configured. `x402_quote` already works (it never pays).

## 2. Create a payment wallet (only if the user wants to pay)

Ask the user before doing this. Run:

```bash
npx -y @agent402-dev/pay-mcp init
```

It creates `~/.agent402/pay-wallet.json` (never overwriting an existing file) and prints the address and how to fund it with a small amount of USDC. The key stays on the machine. Do not print or copy the key file contents. Payments need no SOL.

## 3. Set the limits the user chooses

Add an `env` block. Every value below must come from the user; do not invent recipients or raise limits on your own.

```json
"env": {
  "X402_KEYPAIR_PATH": "<path printed by init>",
  "X402_ALLOWED_DOMAINS": "<api host the user trusts>",
  "X402_TRUSTED_PAY_TO": "<recipient address the user trusts>",
  "X402_MAX_USD": "0.05",
  "X402_MAX_USD_PER_DAY": "1"
}
```

- Empty `X402_ALLOWED_DOMAINS` or `X402_TRUSTED_PAY_TO` means every payment is refused.
- For Agent402 Bond jobs also set `X402_BOND_SELLERS` (seller addresses) and `X402_BOND_MAX_USD`. Deals ask a human before signing by default.
- Optional, experimental: `X402_MCP_TASKS=on` adds the read-only `bond_v2_wait_result`, which waits for a Bond v2 delivery as an MCP task (default 30 minutes). Off by default. Clients without MCP Tasks get a normal call that answers within 50 seconds by default; call it again if the result is not final.

## 4. Verify

- `wallet_status` shows the address, balances and the limits.
- `x402_quote` on a paid URL shows the price and whether the rules pass, without paying.
- `bond_find_sellers` lists sellers from the open directory and says which settings would refuse each one.

## Troubleshooting

- `refused` with reasons: a rule did not pass (domain, recipient, asset or limit). Nothing was signed.
- `no_wallet`: `X402_KEYPAIR_PATH` is not set or the file cannot be read.
- Public Solana RPCs can rate-limit; the user can set `X402_RPC_URL`.

More: https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/getting-started.md
