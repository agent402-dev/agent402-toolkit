# Agent402 wallet activity CSV

| | |
|---|---|
| Service URL | `https://agent402-wallet-csv.agent402-ebc.workers.dev` |
| Seller address | `3re9JiNpwbf3y4c4ywT1mDRnVVHfHss14Pq2xaTaTGYH` |
| Protocol | Agent402 Bond Job Protocol v1 (`GET /quote`, `POST /open`, `POST /deliver`) |
| Network | Solana mainnet, USDC |

The seller is operated by the Agent402 developer.

A CSV of one Solana wallet's activity over a UTC date range, sold per job through the [Agent402 Bond Job Protocol](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md): the seller locks a bond, you lock a deposit, you get the CSV, then you confirm and pay the balance only if it is what you asked for.

> Facts read from Solana RPC (confirmed). No prices, labels, tax treatment or opinions. Not investment advice.

## What you get
One row per balance change of the wallet in each transaction:

| Column | Meaning |
|---|---|
| `time_utc` | Block time (UTC) |
| `signature` | Transaction signature |
| `slot` | Slot |
| `status` | `success` or `failed` |
| `asset` | `SOL`, or a name for a few well-known mints (USDC, USDT, wSOL, PREQ); otherwise empty |
| `mint` | Token mint (empty for SOL) |
| `amount_change` | Change of the wallet's balance in that transaction (SOL includes the fee; tokens: all of the wallet's token accounts for that mint) |
| `fee_paid_sol` | Network fee, on the first row of a transaction the wallet paid for |

The delivery also has a summary (transactions, rows, token accounts read) and notes.

## Request
```json
{ "address": "<Solana wallet>", "from": "YYYY-MM-DD", "to": "YYYY-MM-DD" }
```
- Up to 92 days, up to 300 transactions in the range, up to 50 token accounts. For a busy wallet, split the period into shorter ranges.
- Larger requests are not cut short: the job is declined (`job_failed`) and the deal ends neutral, so each side gets its own money back.
- Not covered: tokens received into a token account that has since been closed.

## Buying with an AI agent (`@agent402-dev/pay-mcp`)
Allow the service and its seller, and set your own cap:
```
X402_ALLOWED_DOMAINS=agent402-wallet-csv.agent402-ebc.workers.dev
X402_BOND_SELLERS=3re9JiNpwbf3y4c4ywT1mDRnVVHfHss14Pq2xaTaTGYH
X402_BOND_MAX_USD=<your max per deal>
```
Then: `bond_job_quote` → `bond_job_start` (with the request above as `input`) → `bond_job_result` → check the CSV → `bond_confirm_and_pay` → `bond_settle` (or let the seller settle).
If the result is `job_failed`, do not confirm.

## Terms
Price, bond, deposit and deadlines are in `GET /quote`. Program limits (beta): 100 USDC per deal, 2,000 USDC across open deals. [Agent402 Bond terms](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS.md).

Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects.
