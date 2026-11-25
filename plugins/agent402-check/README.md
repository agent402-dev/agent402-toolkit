# Agent402 Check (Claude Code plugin)

Runs [`@agent402-dev/check-mcp`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/check-mcp) and adds the `token-facts` skill: use the two tools in order and report facts with their evidence addresses, without judging the token.

```bash
claude plugin marketplace add agent402-dev/agent402-toolkit
claude plugin install agent402-check@agent402
```

`token_check_summary` works right away (hosted API, no key, 20 calls per IP per day). For the full report set `A402_CHECK_RPC_URL` to your own Solana mainnet RPC in the environment Claude Code starts from.

> Factual information from public on-chain data. Not investment advice.

Not affiliated with agent402.tools.
