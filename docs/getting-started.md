# Getting started

Two paths, each a few minutes. Everything runs on your own machine or your own Cloudflare account, from wallets you create for this. Not investment advice.

- [Buyer: let your AI agent pay for an API](#buyer-let-your-ai-agent-pay-for-an-api)
- [Seller: get paid by AI agents](#seller-get-paid-by-ai-agents)

Try it without real funds first: [`packages/pay-mcp/examples/bond-local`](../packages/pay-mcp/examples/bond-local) runs a seller and your agent against a local mainnet fork.

## Buyer: let your AI agent pay for an API

`@agent402-dev/pay-mcp` is an MCP server that pays [x402](https://github.com/coinbase/x402) APIs in USDC on Solana from a wallet on your machine. It refuses every payment until you name the domains and recipients it may pay and set limits.

**1. Create a small wallet just for the agent**

```bash
npx -y @agent402-dev/pay-mcp init
```

It writes `~/.agent402/pay-wallet.json`, prints the address, and shows how to fund it. Send a few USDC and about 0.01 SOL for network fees. Keep only what you are willing to let the agent spend.

**2. Connect it to your agent with your own rules**

Claude Code:

```bash
claude mcp add a402-pay \
  -e X402_KEYPAIR_PATH="$HOME/.agent402/pay-wallet.json" \
  -e X402_ALLOWED_DOMAINS=<api host you choose> \
  -e X402_TRUSTED_PAY_TO=<that API's payTo address> \
  -e X402_MAX_USD=0.10 -e X402_MAX_USD_PER_DAY=1 \
  -- npx -y @agent402-dev/pay-mcp
```

Other MCP clients: same command and variables ([README](../packages/pay-mcp/README.md#connect)).

**3. Ask your agent**

- "Use `x402_quote` on `<url>` and tell me the price and recipient." Nothing is signed.
- "Fetch `<url>` with `x402_fetch`." It pays only if every rule passes and keeps a local log (`payment_history`, `spending_report`).

To find APIs, use an x402 directory such as [x402scan](https://www.x402scan.com). The [seller directory](../directory) lists sellers of bonded jobs (`bond_find_sellers`); two of them are run by this toolkit's developer and are marked as such.

**Bonded jobs (optional).** For work that takes time, a seller can lock a bond in [Agent402 Bond](../programs-v2) and you lock a deposit. Set `X402_BOND_SELLERS` and `X402_BOND_MAX_USD` to allow it, then use `bond_v2_quote` → `bond_v2_start` → `bond_v2_result` → `bond_v2_accept` → `bond_v2_settle` ([details](../packages/pay-mcp/README.md#agent402-bond-v2-buyer-side)).

## Seller: get paid by AI agents

Pick the shape that fits your work.

| Your work | Use | Guide |
| --- | --- | --- |
| Answers in seconds (data, lookups, conversions) | Pay per request over x402, USDC straight to your wallet | [`pay-server` route helper](../packages/pay-server/README.md#one-paid-route-with-input-checks-optional) |
| Takes minutes to hours, and the buyer wants a commitment from you | Bonded job: you lock a small bond, the buyer locks a deposit, the buyer accepts and pays after delivery | [Workers template](../packages/pay-server/examples/bond-seller-worker) |
| Done by an AI agent on your machine | Bonded job sold by your agent | [`bond-seller-mcp`](../packages/bond-seller-mcp) |

**Fastest path: the Cloudflare Workers template** (one Worker sells both per request and bonded jobs)

1. Copy [`packages/pay-server/examples/bond-seller-worker`](../packages/pay-server/examples/bond-seller-worker) and replace `checkInput()` and `doWork()` with your work.
2. Create a new seller wallet used only for this Worker. Fund it with a little SOL (fees and deal rent, returned when deals close) and USDC for your bonds.
3. Set your terms in `wrangler.toml` (`PROTOCOL = "2"` for Bond v2, and `X402_PRICE_USD` to also sell per request), then:

   ```bash
   npx wrangler secret put SELLER_KEY
   npx wrangler secret put RPC_URL
   npx wrangler deploy
   ```

4. Open `https://<your-worker>/quote` to see what buyers see.

**Get found**

- Add your x402 API at [x402scan](https://www.x402scan.com/resources/register) (it reads your `openapi.json`).
- Bonded jobs (Job Protocol v1 or v2): open a pull request to the [seller directory](../directory). Buyers still choose who they allow; being listed is not an endorsement.

**Before real money:** the Bond programs were reviewed internally and not independently audited, and have per-deal and total limits (100 / 2,000 USDC). Terms: [Bond v2](bond/TERMS-v2.md), [Bond v1](bond/TERMS.md).

---
Factual information. Not investment advice.
