# Agent402 Pay (Claude Code plugin)

Runs [`@agent402-dev/pay-mcp`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-mcp) and adds the `buy-bonded-job` skill: the buying workflow in order and the points where a human must confirm.

```bash
claude plugin marketplace add agent402-dev/agent402-toolkit
claude plugin install agent402-pay@agent402
```

Step-by-step setup for an agent: [`llms-install.md`](https://github.com/agent402-dev/agent402-toolkit/blob/main/packages/pay-mcp/llms-install.md).

**With no configuration every payment is refused.** You can still try it with no wallet: ask your agent to run `bond_find_sellers`, `x402_quote` on a paid URL and `wallet_status` ([one-minute walkthrough](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/getting-started.md#try-it-in-one-minute-no-wallet-nothing-paid)).

To pay for real, set the variables in the environment Claude Code starts from (the server reads them at start): `X402_KEYPAIR_PATH` (a small, dedicated wallet), `X402_ALLOWED_DOMAINS`, `X402_TRUSTED_PAY_TO`, and limits such as `X402_MAX_USD` and `X402_MAX_USD_PER_DAY`. The full list is in the [pay-mcp README](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-mcp#rules-checked-before-signing). The wallet key never leaves your machine.

Full buyer walkthrough: [getting started, buyer section](../../docs/getting-started.md#buyer-let-your-ai-agent-pay-for-an-api).

The Agent402 Bond programs have had internal review only and are not independently audited. Not affiliated with agent402.tools.

All three Agent402 plugins: [overview](../README.md).
