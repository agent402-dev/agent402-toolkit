# Template: sell a job with Agent402 Bond on Cloudflare Workers

A Worker that sells one kind of job over the [Bond Job Protocol v1](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md): you lock a small bond, the buyer locks a deposit, you do the work and mark delivery on chain, the buyer checks it and pays the balance directly to you. AI agents can buy from it with `@agent402-dev/pay-mcp` (`bond_job_quote` → `bond_job_start` → `bond_job_result` → `bond_confirm_and_pay`).

| File | What it is |
| --- | --- |
| `index.ts` | The Worker: protocol routes, a Durable Object job store, and a cron that does the work and marks delivery |
| `wrangler.example.toml` | Bindings, cron, and your terms (`[vars]`) |

## 1. Your work
Replace `doJob()` in `index.ts`. It runs once per deal, after the buyer's deposit is locked on chain. Whatever it returns is what the buyer receives. Keep it well under `DELIVER_SECONDS`.

## 2. A dedicated seller wallet
The Worker signs as the seller (opening deals, marking delivery, settling), so it needs a key. Use **a new wallet used only for this Worker**, and keep in it only what deals need:
- SOL for network fees and the rent of each open deal's two accounts (about 0.005 SOL per deal, returned to you when the deal closes);
- USDC for your bonds (`SELLER_BOND` × the number of deals open at the same time).

Payments come in to this wallet's USDC account. Move earnings out regularly. Anyone who obtains the Worker's secrets controls this wallet.

## 3. Configure and deploy
```bash
cp wrangler.example.toml wrangler.toml       # set name and [vars]
npx wrangler secret put SELLER_KEY           # paste the wallet's Solana CLI key array (input is hidden)
npx wrangler secret put RPC_URL              # your Solana mainnet RPC URL
npx wrangler deploy
```
Then open `https://<your-worker>/quote`. Buyers allow your host in `X402_ALLOWED_DOMAINS` and your seller address in `X402_BOND_SELLERS`.

Buyers sign delivery requests for the address they use. If that differs from what the Worker sees (another proxy in front of it), set `PUBLIC_ORIGIN` in `[vars]` to that address.

## How it behaves
- `POST /open` builds the `open` transaction with you as fee payer and signs it; the deal exists only once the buyer signs and sends it.
- The cron (every 2 minutes) runs `processOpenJobs()`: for each deal the buyer has opened, it does the work, stores the result and marks delivery. It does **not** wait for the buyer to ask, because a deal nobody marked by `deliverBy + 1 day + LATE_WINDOW` pays your bond and the deposit to the buyer.
- `POST /deliver` returns the stored result to the deal's buyer only (signed request), running the job first if the cron has not yet.
- The program does not judge quality. If the buyer never confirms, each side gets its own money back after the deadlines.
- The same cron settles and claims deals whose outcome is fixed (your bond and the deposit come back to you after the buyer pays), retries jobs that failed (attempts and the last error are kept in the job store), never re-runs a job whose result is already stored, and drops prepared deals the buyer never opened. While a long job runs, `/deliver` answers `202 working`.

## Before you run it with real money
- Try it first against a local mainnet fork (see `packages/bond-client/examples/job`).
- Beta limits: 100 USDC locked per deal, 2,000 USDC across all open deals (all sellers). The program was reviewed internally, not independently audited. [Terms](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS.md).
- Not investment advice.
