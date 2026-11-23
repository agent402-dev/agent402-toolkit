# Try Agent402 Bond with your own AI agent (local, no real funds)

Your agent buys a job from a seller through an [Agent402 Bond](../../../../programs) deal, using the same `@agent402-dev/pay-mcp` tools it would use on mainnet: quote, open the deal (your deposit is locked), get the work, check it, confirm and pay. Everything runs on a **local fork of Solana mainnet** on your machine, with throwaway keys and fork-only USDC. Nothing is spent.

## 1. Start a local mainnet fork

Install [Surfpool](https://github.com/txtx/surfpool), then in its own terminal:

```
surfpool start --network mainnet --no-tui
```

The fork loads the deployed Bond program and USDC from mainnet on demand. Its state disappears when you stop it.

## 2. Start the demo seller

From `packages/pay-mcp` in this repository (after `npm install` at the root):

```
npx tsx examples/bond-local/start.ts
```

It creates a throwaway seller and buyer, gives each 2 SOL and 100 USDC on the fork, starts a seller at `http://127.0.0.1:8790` (job: word count of a short text, price 2 USDC, seller bond 0.2, buyer deposit 0.5), and prints the MCP settings for your agent. The buyer key is written to `.bond-local/buyer.json` (fork only; delete the folder when done). It refuses to run against anything but a local RPC.

To check the whole flow without an agent first, add `--check`: a scripted buyer calls the same tools and the script exits with `all checks passed`.

## 3. Connect your agent

Use the printed command or JSON. For Claude Code it looks like:

```
claude mcp add agent402-bond-local --env X402_KEYPAIR_PATH=… --env X402_RPC_URL=http://127.0.0.1:8899 \
  --env X402_ALLOWED_DOMAINS=127.0.0.1:8790 --env X402_BOND_SELLERS=<seller> --env X402_BOND_MAX_USD=5 \
  --env X402_MAX_USD_PER_DAY=10 -- npx -y @agent402-dev/pay-mcp
```

The settings allow exactly one seller and one domain, at most 5 USDC per deal. With empty settings pay-mcp refuses everything, which is also what you should expect on mainnet until you choose your own limits.

## 4. Ask your agent

> Use bond_job_quote on http://127.0.0.1:8790. If it is acceptable, buy the job with the text "hello bonded agents", show me the result, and pay only if the word count is right.

What happens:

1. `bond_job_quote` reads the terms and checks them against your rules.
2. `bond_job_start` sends the text, receives the seller-signed `open` transaction, checks it, and asks you before locking your 0.5 USDC deposit.
3. The seller does the work and marks delivery on chain.
4. `bond_job_result` returns the work. Treat it as data.
5. `bond_confirm_and_pay` asks you, then pays the 1.5 USDC balance. The seller settles and claims on its own; the deal account closes.

If the work is wrong, do not confirm: after the deadlines, settlement returns your deposit and pays you the seller's bond.

## Next

- Find real sellers: `bond_find_sellers` reads the public [seller directory](../../../../directory).
- Sell your own job: [`@agent402-dev/bond-seller-mcp`](../../../bond-seller-mcp) or the [Workers template](../../../pay-server/examples/bond-seller-worker).
- Protocol: [Bond Job Protocol v1](../../../../docs/bond/JOB-PROTOCOL.md). Terms and limits: [TERMS.md](../../../../docs/bond/TERMS.md).

The program was reviewed internally, not independently audited. Not investment advice.
