# Template: sell a job with Agent402 Bond on Cloudflare Workers

A Worker that sells one kind of job with an on-chain bond: you lock a small bond, the buyer locks a deposit, you do the work and commit a hash of the exact result on chain, the buyer checks it and pays the balance to you. The example config uses [Bond Job Protocol v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL-v2.md) (program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`); [v1](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md) is still supported. AI agents buy from it with `@agent402-dev/pay-mcp` (`bond_v2_quote` → `bond_v2_start` → `bond_v2_result` → `bond_v2_accept` → `bond_v2_settle`).

## Quick start (about 10 minutes)

You need Node.js 20+, a Cloudflare account, a Solana mainnet RPC URL, and a little SOL and USDC.

1. **Copy this folder** and install: `npm init -y && npm install @agent402-dev/bond-client @agent402-dev/pay-server @solana/web3.js tweetnacl wrangler` (or start from the repository and keep its `package.json`).
2. **Write your job** in `index.ts`: `checkInput()` refuses bad input before any deal, `doWork()` returns the result. Keep the default word count first to try the flow.
3. **Create a seller wallet used only for this Worker:**
   ```bash
   npx -y @agent402-dev/bond-seller-mcp init --path seller-wallet.json
   ```
   It prints the address. Send it about 0.05 SOL and a few USDC (your bonds). Keep the file private.
4. **Configure and deploy:**
   ```bash
   cp wrangler.example.toml wrangler.toml          # set name, DESCRIPTION and your terms
   npx wrangler secret put SELLER_KEY < seller-wallet.json
   npx wrangler secret put RPC_URL                 # paste your RPC URL (input is hidden)
   npx wrangler deploy
   ```
5. **Check it like a buyer would.** Open `https://<your-worker>/quote`, then in an MCP client with pay-mcp and `X402_ALLOWED_DOMAINS=<your-worker host>` (no wallet needed) ask for `bond_v2_quote` on `https://<your-worker>`. It shows your terms, then `refused` with the buyer settings that are missing (for example your address in `X402_BOND_SELLERS`): your quote was read correctly.
6. **Get listed:** open a pull request adding your URL to [`directory/bond-sellers.json`](https://github.com/agent402-dev/agent402-toolkit/blob/main/directory/README.md) (it can be done in the GitHub web editor). Buyer agents find you with `bond_find_sellers`.

Details for each step follow.

| File | What it is |
| --- | --- |
| `index.ts` | The Worker: protocol routes, a Durable Object job store, and a cron that does the work and marks delivery |
| `wrangler.example.toml` | Bindings, cron, and your terms (`[vars]`) |

## 1. Your work
Replace `checkInput()` and `doWork()` in `index.ts`. `checkInput` refuses malformed requests before any deal or payment. `doWork` runs once per deal, after the buyer's deposit is locked on chain. Whatever it returns is what the buyer receives. Keep it well under `DELIVER_SECONDS`.

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

## Optional: also sell per request over x402
Set `X402_PRICE_USD` in `[vars]` (for example `"0.05"`) to sell the same work at `POST /x402/job`, paid per request in USDC to the seller wallet, with no bond or deposit. It uses `@agent402-dev/pay-server/route`:
- malformed input (your `checkInput`) gets 400 before any payment is asked; a request with no body gets the 402 so clients can read the price;
- order: verify the payment → `doWork` → settle. If `doWork` throws (throw `RequestRefused` for "cannot be done", answered 422), the payment is **not settled**;
- a payment cannot be used twice: the ledger is kept in the same Durable Object as the jobs;
- `doWork` must finish within about 35 seconds here (the gate's limit is 40). Use Bond deals for longer work.

The seller wallet must already have a USDC token account (`exact` payments do not create it). AI agents can pay with `@agent402-dev/pay-mcp` (`x402_fetch`, POST with a body).

### Signed receipts (optional)
Set the `RECEIPT_KEY` secret to sign a receipt for every paid response. The receipt (`X-Agent402-Receipt` header) binds the request (method, path, body hash), the response body hash and the payment, so a buyer can later show what was paid for and what came back. `@agent402-dev/pay-mcp` checks it and reports `receipt.verified`.
- Use a **separate key, not the seller key**: it signs receipts only and never holds funds.
  ```bash
  solana-keygen new --no-bip39-passphrase -o receipt-key.json   # keep this file private
  npx wrangler secret put RECEIPT_KEY < receipt-key.json
  solana-keygen pubkey receipt-key.json                          # publish this public key
  ```
- `GET /` shows its public key as `x402.receiptSigner`. Publish it where buyers can check it (your docs or site).
- A key that cannot be read only turns receipts off (logged); payments still work.

## For AI agents
`GET /llms.txt` returns a short plain-text guide built from your `DESCRIPTION` and terms: the quote URL, the protocol, the pay-mcp tools in order, and the per-request x402 route when set. Edit `llmsTxt()` in `index.ts` to describe your job in more detail.

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

## Bond v2

Set `PROTOCOL = "2"` (with `GRACE` and `REVIEW_WINDOW`) to sell over the [Job Protocol v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL-v2.md) on the Bond v2 program (`Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`, beta, no upgrade authority; [terms](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS-v2.md)). On a local test fork (`RPC_URL` on 127.0.0.1) `V2_PROGRAM` can point it at a test build instead.

What changes for the seller:
- `open` carries a job hash that binds the buyer's exact input; marking delivery stores a hash of the exact result, and the seller key signs that hash. Buyers accept only when the result they received matches both.
- `doWork` results are sent as text: objects become JSON text, and those exact bytes are what you commit to.
- The buyer accepts and pays the balance in one step. If a delivered job is never accepted, each side gets its own money back.
- A job you cannot do is committed as `job_failed`; the buyer does not accept and the deal ends neutral.
