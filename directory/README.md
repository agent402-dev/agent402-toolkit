# Agent402 Bond seller directory

`bond-sellers.json` is a plain list of job URLs that speak the [Bond Job Protocol v1](../docs/bond/JOB-PROTOCOL.md) or [v2](../docs/bond/JOB-PROTOCOL-v2.md). Buyer agents read it with the `bond_find_sellers` tool of [`@agent402-dev/pay-mcp`](../packages/pay-mcp), which then reads each seller's live terms from `{url}/quote` and compares them with the buyer's own rules.

- **Being listed is not an endorsement.** The list holds no ratings, rankings or reviews, and it is shown in the order sellers were added.
- Nothing here can make a buyer pay: a buyer's wallet still refuses every seller until a human adds that seller and its domain to the wallet's own settings.
- Terms, prices and descriptions come from each seller's `/quote`, not from this file.
- `operator` is optional free text. Sellers run by the toolkit developer say so.

## Getting listed

Open a pull request that adds one entry. No local clone is needed: open [`bond-sellers.json`](bond-sellers.json) on GitHub, choose **Edit this file**, add your entry at the end of `sellers`, and choose **Propose changes**.

Before you open it, check your seller the way buyers will: with `@agent402-dev/pay-mcp` and `X402_ALLOWED_DOMAINS=<your host>` (no wallet needed), `bond_v2_quote` (or `bond_job_quote` for v1) on your URL should show your terms (price, bond, deposit, deadlines). With no buyer settings it ends `refused` with reasons such as "not in X402_BOND_SELLERS": that is the buyer's wallet protecting itself, and it means your quote was read correctly. A Cloudflare Workers seller you can start from: [`packages/pay-server/examples/bond-seller-worker`](../packages/pay-server/examples/bond-seller-worker).


```json
{ "url": "https://jobs.example.com/summarize", "listedAt": "YYYY-MM-DD" }
```

Requirements:

1. `https://` URL on a public host name, with no query string. `GET {url}/quote` answers a valid Bond Job Protocol quote: v1 for the Agent402 Bond program, or v2 for the Bond v2 program (`Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`), in USDC or PREQ.
2. The seller can deliver what `/quote` describes. Entries whose `/quote` stops answering may be removed.
3. One entry per job URL. The tests check the format (`checkDirectory` in `packages/pay-mcp/src/bond-directory.ts`).

Removal: open a pull request or an issue from the seller.

Buyers can point to another list with `X402_BOND_DIRECTORY_URL`, or turn `bond_find_sellers` off with `X402_BOND_DIRECTORY_URL=off`.
