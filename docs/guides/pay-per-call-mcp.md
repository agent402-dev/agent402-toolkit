# Pay-per-call MCP: let an AI agent pay for API calls, within limits you set

Many paid APIs now answer `402 Payment Required` with an [x402](https://github.com/coinbase/x402) price instead of asking for an API
key. An MCP client (Claude Code, Claude Desktop, Codex, Cursor, Cline and others) can pay those calls if it has a payment tool. An
agent with a wallet can spend, so this page shows how to give it a small wallet and rules it cannot get around,
using the open-source `@agent402-dev/pay-mcp` server (Apache-2.0). It pays in USDC on Solana, and on Base when you turn Base on.

## 1. Try it with no wallet

With only an allowed host and no key file, nothing can be paid, but the agent can still read prices:

```bash
claude mcp add a402-pay -e X402_ALLOWED_DOMAINS=api.example.com -- npx -y @agent402-dev/pay-mcp
```

Ask the agent to run `x402_quote` on a URL. It shows the price, asset, network, recipient and which of your rules pass, and never
signs.

## 2. Give it a small, dedicated wallet

```bash
npx -y @agent402-dev/pay-mcp init
```

This creates a new key file at `~/.agent402/pay-wallet.json` (it never overwrites one) and prints the address and a link to fund it
with USDC. The key stays on your machine. Payments need no SOL: the facilitator pays the network fee. Fund it with only what you are
willing to let the agent spend.

## 3. Set the rules

Nothing is signed unless every rule passes. With no configuration every payment is refused.

| Rule | Variable | Default |
| --- | --- | --- |
| Hosts it may pay (https only) | `X402_ALLOWED_DOMAINS` | empty → refuse all |
| Recipient addresses it may pay | `X402_TRUSTED_PAY_TO` | empty → refuse all |
| Most USDC per payment | `X402_MAX_USD` | `0.05` |
| Most USDC per UTC day | `X402_MAX_USD_PER_DAY` | `1` |
| Most payments per UTC day | `X402_MAX_PAYMENTS_PER_DAY` | `20` |
| Most per recipient per UTC day | `X402_MAX_USD_PER_RECIPIENT_PER_DAY` | off |
| Ask a human at or above | `X402_CONFIRM_ABOVE_USD` | off |

```bash
claude mcp add a402-pay \
  -e X402_KEYPAIR_PATH=$HOME/.agent402/pay-wallet.json \
  -e X402_ALLOWED_DOMAINS=api.example.com \
  -e X402_TRUSTED_PAY_TO=<the seller's address> \
  -e X402_MAX_USD_PER_DAY=0.5 \
  -- npx -y @agent402-dev/pay-mcp
```

Human confirmation uses MCP elicitation; if the client cannot ask, the payment is not made.

## 4. Pay

1. `x402_quote` → returns a `quoteId`.
2. `x402_fetch` with that `quoteId` → pays only if the amount, asset and recipient still match the quote and every rule passes. At most
   one signature per call; if the seller answers 402 again after payment, it does not sign again.
3. If the connection drops after signing, the payment is recorded as `unknown` and still counts against your daily caps, so the agent
   cannot pay twice by retrying.

## 5. See what it spent

- `wallet_status`: balances, today's usage and what is left of each cap.
- `payment_history`: every payment with URL, amount, recipient, result and settlement transaction (JSON or CSV).
- `spending_report`: totals by recipient, host and day for any date range.

When a seller signs its responses (`X-Agent402-Receipt` from pay-server), `x402_fetch` checks the receipt and keeps it in the log.

## Base

Set `X402_ALLOWED_NETWORKS=solana,base` and `X402_EVM_KEY_PATH` to also pay USDC on Base (EIP-3009, no gas needed from the buyer).
The same domains, recipients and caps apply across both networks.

## Links

- pay-mcp: https://www.npmjs.com/package/@agent402-dev/pay-mcp
- Full rules and tools: https://github.com/agent402-dev/agent402-toolkit/blob/main/packages/pay-mcp/README.md
- Sellers it reads today: https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/works-with.md

Internal review only, not independently audited.
