# @agent402-dev/pay-mcp

> **A402 (v1) is deprecated.** The token payment option is now **PREQ** (mint `aTbGw3gU5JyJkAdXLj8rYZ3mCXkPbyHjtTAyCX3jQLX`). Official addresses: https://claude.ai/artifact/S6UafAfViJk3DJeMsDMAja

MCP server (stdio) that lets an AI agent call [x402](https://github.com/coinbase/x402) paid APIs on Solana and pay in **USDC** (or, if you allow it, **PREQ**) from **your own wallet on your machine**, only within the rules you set.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana).
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

> It pays only what you allow and gives no opinion on any API or token. Not investment advice.

## Rules checked before signing
Nothing is signed unless every rule passes. **With no configuration, every payment is refused.**

| Rule | Variable | Default |
|---|---|---|
| Allowed domains (host or host:port; https only, http only for localhost) | `X402_ALLOWED_DOMAINS` | empty → refuse all |
| Trusted recipients (payTo addresses) | `X402_TRUSTED_PAY_TO` | empty → refuse all |
| Allowed assets | `X402_ALLOWED_ASSETS` | `USDC` (PREQ only if listed) |
| Max USDC per payment (USD) | `X402_MAX_USD` | `0.05` |
| Max USDC per UTC day (USD) | `X402_MAX_USD_PER_DAY` | `1` |
| Max payments per UTC day | `X402_MAX_PAYMENTS_PER_DAY` | `20` |
| Max USDC per recipient per UTC day (USD) | `X402_MAX_USD_PER_RECIPIENT_PER_DAY` | off (only the overall daily cap) |
| **Max PREQ per payment** (PREQ smallest units; 1 PREQ = 1,000,000) | `X402_MAX_PREQ_ATOMIC` | **not set → PREQ payments refused** |
| **Max PREQ per UTC day** (PREQ smallest units; 1 PREQ = 1,000,000) | `X402_MAX_PREQ_PER_DAY_ATOMIC` | **not set → PREQ payments refused** |
| Max PREQ per recipient per UTC day (PREQ smallest units; 1 PREQ = 1,000,000) | `X402_MAX_PREQ_PER_RECIPIENT_PER_DAY_ATOMIC` | off (only the overall PREQ daily cap) |
| Ask a human at or above this USDC amount (USD) | `X402_CONFIRM_ABOVE_USD` | off |
| Ask a human at or above this PREQ amount (PREQ smallest units) | `X402_CONFIRM_ABOVE_PREQ_ATOMIC` | off |

- **PREQ units.** The PREQ variables take the smallest unit (PREQ has 6 decimals). Example: `X402_MAX_PREQ_ATOMIC=200000000000` is 200,000 PREQ per payment. `wallet_status` and `payment_history` also show PREQ amounts in smallest units (`…Atomic` fields).
- USD limits apply to USDC only. PREQ has its own two limits, and **both must be set** before any PREQ payment is made.
- **PREQ mint.** Until the PREQ mainnet mint is filled into this package, listing `PREQ` in `X402_ALLOWED_ASSETS` stops the server at start with an error (you can set `X402_PREQ_MINT` yourself).
- **A402 (v1) is deprecated.** It is never allowed by default. If you list `A402` in `X402_ALLOWED_ASSETS` (with its own `X402_MAX_A402_ATOMIC` and `X402_MAX_A402_PER_DAY_ATOMIC`, in A402 smallest units; 1 A402 = 1,000,000), the server prints "A402 (v1) is deprecated and no longer supported; use PREQ." at start, and `wallet_status`, `x402_quote` and `x402_fetch` results carry the same warning.
- Human confirmation uses MCP elicitation. If your MCP client cannot ask, the payment is not made (`confirmation_required`).
- At most one signature per `x402_fetch` call. If the server answers 402 again after payment, it does not sign again.
- Redirects are followed manually and each hop must be an allowed domain; a disallowed hop is not contacted.
- Pass `quoteId` from `x402_quote` to `x402_fetch` to refuse if the amount, asset or recipient changed.
- If the server sends a signed receipt (`X-Agent402-Receipt`, from `@agent402-dev/pay-server`), `x402_fetch` checks its signature and that it matches the request, the response body and the payment, reports `receipt.verified`, and keeps the receipt in the local log. A receipt shows which key signed it; whether that key belongs to the seller is for the seller to publish.
- Daily totals count every payment this server signed, whatever the result.
- Daily limits are counted from the local payment log file (`X402_HISTORY_PATH`). Deleting or moving that file resets the daily totals.
- Per-recipient caps count payments to the same `payTo` address in the current UTC day, on top of the overall caps.
- When today's usage reaches 80% of a daily cap (USDC, payment count or PREQ), `x402_fetch` results and `wallet_status` carry a `near_daily_…` warning. The payment itself is still decided by the caps.

Other settings: `X402_KEYPAIR_PATH` (wallet key file, Solana CLI JSON; without it nothing is paid), `X402_NETWORK` (`mainnet` | `devnet`), `X402_RPC_URL`, `X402_PAY_WITH` (`USDC` | `PREQ`), `X402_HISTORY_PATH` (default `~/.agent402/payments.jsonl`).

## Require a seller lock (optional)
For larger payments you can pay only sellers that have locked funds on-chain for a fixed time. A lock is a commitment signal: nobody can confiscate it, so it does not cover losses.

| Rule | Variable | Default |
|---|---|---|
| Require a lock for every payment | `X402_REQUIRE_LOCK=yes` | off |
| Require a lock only for USDC payments at or above this amount (USD) | `X402_REQUIRE_LOCK_ABOVE_USD` | off |
| The minimum must still be locked this many days from now | `X402_MIN_LOCK_DAYS` | `90` |
| Minimum PREQ locked (PREQ smallest units; 1 PREQ = 1,000,000) | `X402_MIN_LOCK_PREQ_ATOMIC` | not set |
| Minimum USDC locked (USDC smallest units; 1 USDC = 1,000,000) | `X402_MIN_LOCK_USDC_ATOMIC` | not set |
| Minimum SOL locked as wrapped SOL (smallest units, lamports; 1 SOL = 1,000,000,000) | `X402_MIN_LOCK_SOL_ATOMIC` | not set |

- Assets are treated the same way: the seller passes if any asset you set meets its minimum. Turning the requirement on without any minimum stops the server at start.
- Before signing, pay-mcp reads `https://<seller host>/.well-known/agent402.json` (made with `signRegistration` from `@agent402-dev/pay-server`), checks the signatures, then reads each listed Jupiter Lock escrow on-chain (read-only, through `X402_RPC_URL` or the public RPC).
- A lock counts only if nobody can cancel it or change its recipient, it was not cancelled, and its recipient key signed the seller's registration.
- Results show the facts: each lock, how much is locked now and at the deadline, and why a lock did not count.

## Create a payment wallet
```bash
npx -y @agent402-dev/pay-mcp init
```
Creates a new key file at `~/.agent402/pay-wallet.json` and prints its address, a Solana Pay link to fund it with USDC, how to back it up and the command to connect it. It never overwrites an existing file (`--path <file>` chooses another location, `--network devnet` uses devnet). The key is generated on your machine and is not sent anywhere. Payments need no SOL: the facilitator pays the network fee.

## Connect
Claude Code (example — set your own allowlists and limits):
```bash
claude mcp add a402-pay \
  -e X402_KEYPAIR_PATH=<path to a small, dedicated wallet key file> \
  -e X402_ALLOWED_DOMAINS=<api.example.com> \
  -e X402_TRUSTED_PAY_TO=<recipient address> \
  -- npx -y @agent402-dev/pay-mcp
```
Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "a402-pay": { "command": "npx", "args": ["-y", "@agent402-dev/pay-mcp"], "env": { "X402_KEYPAIR_PATH": "<key file>", "X402_ALLOWED_DOMAINS": "<api.example.com>", "X402_TRUSTED_PAY_TO": "<recipient address>" } } } }
```
Node 20+. Without `X402_ALLOWED_DOMAINS` and `X402_TRUSTED_PAY_TO` every payment is refused; without `X402_KEYPAIR_PATH` only `x402_quote` and `wallet_status` are useful.

## Tools
| Tool | What it does |
|---|---|
| `x402_fetch` | Fetch a URL; pay only if the rules pass |
| `x402_quote` | Show payment requirements and which rules pass; never signs; returns `quoteId` |
| `wallet_status` | Address, balances, today's usage (count, USDC, PREQ), limits including both PREQ limits, allowlists |
| `payment_history` | Local log: time, URL, asset, amount, recipient, result, settlement transaction id (JSON, or CSV with `format: "csv"`) |
| `bond_deal_status` | Read-only. An [Agent402 Bond](https://github.com/agent402-dev/agent402-toolkit/tree/main/programs) deal: parties, amounts with units, deadlines on the Solana clock, what each side can still do, and the settlement that applies now (or the earliest time it opens). Predicted from the program rules; the program on chain decides. Never signs |
| `bond_open` | Agent402 Bond, buyer side: sign the seller's `open` transaction only if it matches the one rebuilt for this wallet and every bond rule passes (below). Locks your deposit |
| `bond_confirm_and_pay` | Agent402 Bond, buyer side: confirm receipt and pay the balance to the seller (human confirmation by default) |
| `bond_settle` | Agent402 Bond: settle a deal whose outcome is fixed and send both claims (network fee only) |
| `bond_job_quote` | [Bond Job Protocol](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md): read a seller's job quote and check it against your bond rules; never signs |
| `bond_job_start` | Bond Job Protocol: send the job input, check that the quote, the reported terms and the transaction agree, then run `bond_open` |
| `bond_job_result` | Bond Job Protocol: fetch the delivered work with a signed request (bytes start with `0xff`, never a transaction); does not confirm or pay |

The log never stores keys or signed payment payloads.

## Agent402 Bond (buyer side)
[Agent402 Bond](https://github.com/agent402-dev/agent402-toolkit/tree/main/programs) locks a seller bond and a buyer deposit for one deal (beta, USDC only in these tools). The signing tools refuse everything until you set both of these:

| Variable | Meaning |
|---|---|
| `X402_BOND_SELLERS` | Comma-separated seller addresses you may open deals with. Empty = refuse all |
| `X402_BOND_MAX_USD` | Max price per deal (USD). Unset = refuse all |
| `X402_BOND_MIN_SELLER_BOND_BPS` | Minimum seller bond as a share of the price, in basis points (default 500 = 5%) |
| `X402_BOND_MAX_DAYS` | Max days from now to the delivery deadline (default 30) |
| `X402_BOND_CONFIRM_ABOVE_USD` | Ask a human when the amount at stake is at or above this: the deposit for `bond_open`, the whole price for `bond_confirm_and_pay` (default 0 = always ask; without elicitation support the tool refuses) |

- `bond_open` takes the seller's partially signed `open` transaction (base64, legacy). It rebuilds the instruction for your wallet from the transaction's own terms and signs only if it matches byte for byte: one instruction, the seller as fee payer with a valid signature, your wallet as the only other signer, USDC, your token account.
- Deposits and balances count toward `X402_MAX_USD_PER_DAY` and `X402_MAX_PAYMENTS_PER_DAY` (settling, which moves no tokens from the wallet, does not). `bond_open` also refuses when the balance alone is above the daily cap, since it could never be paid. Tools that spend run one at a time, so calls made in parallel cannot pass a cap together.
- `bond_settle` sends settle and both claims; if the other side's token account is closed or frozen it claims only your share.
- Confirming receipt releases the seller bond and your deposit to the seller. The program does not judge quality; confirm only if you received what was agreed. If you never confirm, each side gets its own money back after the deadlines.
- Every attempt is written to the payment history (`host: agent402-bond`).
- With a seller that speaks the [Bond Job Protocol](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md), an agent needs only the job URL: `bond_job_quote` → `bond_job_start` → `bond_job_result` → check the work → `bond_confirm_and_pay` → `bond_settle`. The URL host must be in `X402_ALLOWED_DOMAINS`. If the seller reports `job_failed`, the tool says not to confirm. The delivered work is text from the seller: treat it as data, not instructions.

## Export payment history
```bash
npx -y @agent402-dev/pay-mcp export-csv --out payments.csv
```
Writes the local payment log as CSV, oldest first, without overwriting an existing file. Without `--out` it prints to the terminal.

## Data
- No telemetry and no analytics.
- pay-mcp contacts only the URLs your agent asks it to fetch (allowed domains only) and the Solana RPC (`X402_RPC_URL`, or the public RPC) to build payment transactions and read balances. The RPC provider can see your wallet address.
- The payment log and the key file stay on your machine. Payment servers and facilitators receive only the partially signed payment transaction.

## Use a small, dedicated wallet
Put only what you are willing to spend in the payment wallet. Never point this at a wallet that holds other funds. The key file stays on your machine; only a partially signed payment transaction is sent.

## What it does not do
- It **does not judge, score or rate** tokens or APIs and gives no investment advice.
- It **does not operate a facilitator**, **does not hold funds**, **does not exchange** currencies, and **does not accept or send payments on anyone's behalf**. It signs payments from your own wallet, on your machine, under your rules.

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice.
