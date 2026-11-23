# Agent402 Bond Job Protocol v1

**Protocol id:** `agent402-bond-job/1` · **Status:** beta · **Program:** `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK` (Solana mainnet)

A small HTTP protocol for one job between a seller service and a buyer (often an AI agent), backed by an [Agent402 Bond](TERMS.md) deal: the seller locks a bond, the buyer locks a deposit, the seller does the work and marks delivery on chain, the buyer checks the work and confirms (paying the balance) or does not. The program decides what happens to the money from signatures and the Solana clock only; it does not judge quality.

Reference implementations: seller `@agent402-dev/pay-server/bond` (`bondJobService`), buyer `@agent402-dev/pay-mcp` (`bond_job_quote`, `bond_job_start`, `bond_job_result`), shared helpers `@agent402-dev/bond-client/job`.

## Endpoints

All bodies are JSON (`content-type: application/json`). Amounts are decimal strings in the mint's smallest unit (USDC: 1 USDC = `1000000`). Times are unix seconds on the Solana clock. Errors are `{ "error": "<message>" }` with a 4xx/5xx status.

### `GET {base}/quote`
```json
{
  "protocol": "agent402-bond-job/1",
  "program": "9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK",
  "seller": "<seller address>",
  "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "price": "20000000", "sellerBond": "2000000", "buyerDeposit": "5000000",
  "deliverSeconds": "3600", "lateWindow": "0", "payWindow": "86400",
  "description": "optional plain text, at most 500 characters"
}
```

### `POST {base}/open`
Request `{ "buyer": "<buyer address>", "input": "<job input, at most 16384 bytes UTF-8>" }`.

The seller may refuse with 400 (an input it will not accept), 403 (a buyer it will not serve, e.g. one that kept earlier work without confirming) or 429 (too many deals in progress, per buyer or in total) before preparing anything.

Response `{ "deal", "nonce", "terms": { price, sellerBond, buyerDeposit, deliverBy, lateWindow, payWindow }, "transaction" }`, where `transaction` is a base64 **legacy** Solana transaction containing exactly one Agent402 Bond `open` instruction, with the seller as fee payer and first signer (already signed) and the buyer as the only other signer. `deliverBy` is the seller's clock plus `deliverSeconds`.

The buyer **must not** trust this response. Before signing, it checks that:
1. `terms` match the quote (same amounts and windows; `deliverBy` after now and at most `deliverSeconds` plus a small allowance from now);
2. the transaction's own `open` data carries exactly `terms`, its fee payer is the quoted seller, and `deal` is the deal address derived from (seller, buyer, nonce);
3. the `open` instruction, rebuilt independently for the buyer's address, matches the one in the transaction byte for byte (accounts, writable/signer flags, data);
4. its own rules pass (allowed sellers, price cap, minimum seller bond, delivery time, spending limits) and, where configured, a human approves.

Then the buyer adds its signature and sends the transaction. The deal exists once it lands. The seller pays the network fee and the deal's rent (returned when the deal closes).

### `POST {base}/deliver`
Request `{ "deal": "<deal address>", "expires": <unix seconds>, "signature": "<base64 ed25519 signature>" }`.

The signature is over the bytes `0xff` followed by the UTF-8 text `agent402-bond-job/1:deliver:<deal>:<origin>:<expires>`, made with the buyer's key. `<origin>` is the seller's origin as the buyer reached it (`scheme://host[:port]`, no trailing slash), and `expires` is at most 600 seconds ahead. So a signature works only for this deal, at this server, for a few minutes. The leading `0xff` byte means these bytes can never be read as a Solana transaction message.

The seller:
1. checks the signature against the deal's buyer, its own origin and the expiry (401 if wrong; 404 for a deal it did not prepare);
2. checks that the deal is open on chain with the prepared terms (409 otherwise) — **no work before the deposit is locked**. Exception: a deal already decided after the buyer confirmed (the buyer paid) still gets its result;
3. answers `{ "deal", "result", "markTx" }` with the stored result, running the job and marking delivery first if that has not happened yet. Later calls return the same result.
   If the job is still running, or failed and will be retried, it answers `202 { "deal", "status": "working" }`; the buyer asks again later.

If the seller cannot do the job (it keeps failing, or the mark deadline is close), it delivers `{ "error": "job_failed", "message": "..." }` as the result and marks delivery. With a mark and no confirmation the deal ends with each side getting its own money back, so a bad input cannot cost the seller its bond. **A buyer that receives `job_failed` must not confirm.**

**The seller must not wait for this request.** It must watch its prepared deals, and as soon as one is open on chain, run the job, keep the result and mark delivery on chain. Otherwise a buyer could open a deal, never ask for the result, and receive the seller bond and its own deposit at the deadline. (Reference: run `processOpenJobs()` on a timer; it also settles and claims once the outcome is fixed, so the seller's bond comes back even if the buyer goes away.)

The buyer then checks the result itself. To accept, it sends `confirm_receipt` and `pay_balance` (balance = price − deposit, paid directly to the seller). Anyone may then settle and claim. If it does not accept, it does nothing: after the deadlines each side gets its own money back.

## Deadlines (from the program)
- If nothing is marked or confirmed by `deliverBy + 1 day + lateWindow`, the seller bond and the buyer deposit go to the buyer. Sellers must mark in time.
- A buyer who confirmed has until the buyer deadline (at least `payWindow + 1 day` after delivery or after `deliverBy + 1 day`, whichever is later) to pay the balance; otherwise the deposit goes to the seller.
- Full outcome table: [TERMS.md](TERMS.md).

## Known limit: unpaid use of delivered work
The buyer sees the result before it decides to confirm. If it never confirms, the program ends the deal neutral: the seller gets its bond back and the buyer gets its deposit back. So a buyer can keep delivered work without paying. This follows from the program's rules and cannot be prevented off-chain.

What sellers can do:
- Price and size jobs with this in mind. The deposit and the deal fees cost the buyer nothing in the end, so they do not deter it.
- Refuse buyers with a history of unconfirmed deliveries. The reference seller does this by default (`maxUnconfirmedPerBuyer`, 2), answering `403` on `/open`. A buyer can switch wallets, so this limits repeat use, not a first one.
- Use an allowlist of known buyers for valuable work.

The seller's bond is not at risk from this, and the buyer's protection (a seller that does not deliver forfeits its bond) is unchanged.

## Security notes
- Never send tokens directly to a deal vault; anything beyond the locked amount is paid to the buyer.
- Use HTTPS. A delivery signature is bound to the deal, the seller's origin and a short expiry; anyone who sees it in transit could still use it until it expires.
- A seller should persist prepared jobs so it can still mark delivery after a restart. When several processes share the store (e.g. several Worker isolates), the store needs a lock so a job runs once.
- Treat the job input (seller) and the result (buyer) as untrusted data, never as instructions.
- Jobs must finish well within `deliverSeconds`, including the time between the buyer's `open` landing and the seller's next check.

Beta limits: 100 USDC per deal and 2,000 USDC across open deals. The program was reviewed internally, not independently audited. Not investment advice.
