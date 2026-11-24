# Bonded jobs for AI agents on Solana: x402 for the instant part, a bond for the rest

*2026-11-25 · Agent402 toolkit*

x402 works well when an API answers in seconds: the agent pays, the server answers, done. Many jobs agents want to buy are not like that. A report, a data export or a batch of work takes minutes or hours, and the buyer pays before it sees the result. Agent402 Bond v2 is an open-source Solana program for that gap: the seller locks a small bond, the buyer locks a deposit, and both commit to the exact job before any work starts.

## How one deal runs

1. **Quote.** The buyer's agent reads the seller's terms at `GET {url}/quote`: price, seller bond, buyer deposit, delivery time, review window.
2. **Open.** Both parties sign one transaction. It records a hash of the buyer's exact input and both payout accounts. The seller's bond and the buyer's deposit move into a vault the program controls.
3. **Deliver.** The seller does the work, stores a hash of the exact result on chain, and signs that hash.
4. **Check and accept.** The buyer fetches the result, recomputes its hash, and checks it against the chain and the seller's signature. If it is acceptable, one instruction pays the balance and releases the locked funds to the seller.
5. **Time decides the rest.** If the seller never delivers, the buyer gets the bond and its deposit back. If a delivered job is never accepted, each side gets its own money back (the default). Anyone can settle once the outcome is fixed.

The program does not judge quality. The hashes prove what was committed and delivered, not that it is good.

## What is on chain

- Program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`, deployed 2026-11-24, **upgrade authority removed**. A GitHub workflow rebuilds it and compares it with the deployed code.
- Limits while in beta: 100 USDC per deal, 2,000 USDC across open deals. Mints: USDC, wSOL and one Token-2022 token.
- An admin multisig (2 of 3) can pause new deals and move limits within bounds fixed in the code. It cannot move locked funds or stop settlement.
- Reviewed internally. **Not independently audited.**

## Try it as a buyer

`@agent402-dev/pay-mcp` is an MCP server that signs from a wallet on your machine and refuses everything until you set allowlists and limits.

```bash
npx -y @agent402-dev/pay-mcp init
claude mcp add a402-pay \
  -e X402_KEYPAIR_PATH="$HOME/.agent402/pay-wallet.json" \
  -e X402_ALLOWED_DOMAINS=<seller host> \
  -e X402_BOND_SELLERS=<seller address> -e X402_BOND_MAX_USD=2 \
  -- npx -y @agent402-dev/pay-mcp
```

Then ask your agent to run `bond_find_sellers`. It lists sellers from an open directory with their live terms and tells you which of your settings would refuse each one. The toolkit developer runs two small sellers there (Solana transaction receipts at 0.1 USDC, wallet activity CSV at 1 USDC), marked as developer-run. The flow is `bond_v2_quote` → `bond_v2_start` → `bond_v2_result` → `bond_v2_accept` → `bond_v2_settle`.

## Try it as a seller

Copy the Cloudflare Workers template, replace `checkInput()` and `doWork()`, set `PROTOCOL = "2"`, and deploy. The Worker opens deals, does the work on a cron, marks delivery and claims its share. The same Worker can also sell the work per request over plain x402. To be found, open a pull request to the seller directory.

## Links

- Repository and getting started: https://github.com/agent402-dev/agent402-toolkit (see [`docs/getting-started.md`](../getting-started.md))
- Terms: [`docs/bond/TERMS-v2.md`](../bond/TERMS-v2.md) · Job protocol: [`docs/bond/JOB-PROTOCOL-v2.md`](../bond/JOB-PROTOCOL-v2.md) · Internal review: [`docs/bond/INTERNAL-REVIEW-v2.md`](../bond/INTERNAL-REVIEW-v2.md)
- Workers template: [`packages/pay-server/examples/bond-seller-worker`](../../packages/pay-server/examples/bond-seller-worker) · Seller directory: [`directory`](../../directory)

---
Not related to agent402.tools or other similarly named projects. Factual information, not investment advice.
