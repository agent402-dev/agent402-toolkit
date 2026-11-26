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

### Example jobs
`jobs/` holds ready-made work you can sell as is or copy from. Each one is a pair of pure functions (no network, no keys), so the same input always gives the same result bytes.

| File | What the buyer sends | What the buyer gets |
|---|---|---|
| `jobs/csv-to-json.ts` | CSV text with a header row (up to 1 MB, 10,000 rows) | `{ columns, rowCount, rows, ragged }`: rows as objects keyed by column name, values as text, and the numbers of rows whose field count differs from the header |

To sell it, in `index.ts`:
```ts
import { checkCsvInput, csvToJson } from './jobs/csv-to-json';
function checkInput(input: string) { return checkCsvInput(input); }
async function doWork(input: string) { return csvToJson(input); }
```
Then describe it in `DESCRIPTION` (for example "CSV to JSON rows, up to 10,000 rows") and set your price. Other jobs that fit this shape: format or validate JSON against a schema you publish, extract tables from Markdown, normalize addresses or dates in a list, summarize a document with your own model or API key (keep the key in a Worker secret).

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

To see your price, asset and receiving address the way a buyer's agent reads them, call pay-mcp's `x402_quote` with `POST https://<your-worker>/x402/job` and no body. It needs no wallet and never pays; see [Check your own 402 without a wallet](../../README.md#check-your-own-402-without-a-wallet).

Optional discovery metadata: set `X402_DISCOVERY` in `index.ts` (a commented example is there) to add `extensions.bazaar` (example input with its JSON Schema, example result) and a PNG or JPG `iconUrl` to the 402. Keep `DESCRIPTION` at 500 characters or fewer and describe what the job does; text that addresses the reading agent is refused at start. Discovery catalogs list a route only after real paid calls through a facilitator that supports the extension. Unset, the 402 is unchanged.

### Also take USDC on Base (optional)
With `X402_PRICE_USD` set, set `X402_BASE_PAY_TO` (a public 0x address), `X402_BASE_FACILITATOR_URL` and the `BASE_RPC_URL` secret to take USDC on Base (`eip155:8453`) at the same `POST /x402/job`. The 402 then lists the Solana option first and the Base option second; a payment goes to the network the buyer chose. Base payments use the `exact` scheme with EIP-3009 only. There is no default facilitator for Base mainnet: pick one whose `/supported` lists `exact` on `eip155:8453`. If `X402_BASE_PAY_TO` is unset, nothing changes; if it is set but the other two are missing or not https, every request to the Worker fails with an error until it is fixed (it does not quietly fall back to Solana only). Signed receipts stay Solana-only. Details: [Accept USDC on Base](../../README.md#accept-usdc-on-base-optional).

### List your endpoint in the pay.sh catalog
The pay.sh catalog of paid APIs is open source in [`solana-foundation/pay-skills`](https://github.com/solana-foundation/pay-skills), and the `pay` CLI (`pay skills search`) searches it. To add your x402 route, open a pull request there with `providers/<operator>/<name>/PAY.md` and an OpenAPI file for `POST /x402/job` committed next to it (this template does not generate one; write it by hand), following its [CONTRIBUTING guide](https://github.com/solana-foundation/pay-skills/blob/main/CONTRIBUTING.md):
- paid endpoints must return 402 before payment and accept USDC (or USDT) on Solana mainnet;
- the PR's CI probes the 402, so the example input in your OpenAPI file must pass `checkInput` (a 400 instead of a 402 fails the probe).

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
