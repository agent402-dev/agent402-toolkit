# Agent402 Bond Job Protocol v2

How a buyer agent and a seller agent run one job over an Agent402 Bond v2 deal. HTTP + JSON. Reference implementations: `@agent402-dev/bond-client/job-v2` (shared), `@agent402-dev/pay-server/bond-v2` (seller), `@agent402-dev/pay-mcp` tools `bond_v2_*` (buyer). Bond v2 is deployed on mainnet as `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev` (beta). Supported from `@agent402-dev/bond-client` 0.3.0, `pay-server` 0.7.0, `pay-mcp` 0.11.0 and `bond-seller-mcp` 0.3.0.

Amounts are decimal strings in the mint's smallest unit (USDC and PREQ have 6 decimals). Times are seconds.

## Endpoints

### `GET {base}/quote`

```json
{
  "protocol": "agent402-bond-job/2",
  "program": "<Bond v2 program id>", "seller": "<seller wallet>", "sellerPayout": "<seller token account>",
  "mint": "<USDC or PREQ>", "tokenProgram": "<owner of the mint>",
  "price": "2000000", "sellerBond": "200000", "buyerDeposit": "500000",
  "deliverSeconds": "3600", "grace": "86400", "reviewWindow": "86400",
  "sellerShareBps": 0, "arbiter": null, "arbiterWindow": "0",
  "description": "What the job is, plain text, at most 500 characters"
}
```

### `POST {base}/open` `{ "buyer": "<wallet>", "input": "<job input, at most 16384 bytes>" }`

Returns `{ deal, nonce, terms, jobHash, transaction }`: `transaction` is a legacy transaction with one Bond v2 `open`, signed by the seller as fee payer. The buyer pays from and is paid to its associated token account.

### `POST {base}/deliver` `{ "deal", "expires", "signature" }`

`signature` is the buyer's ed25519 signature (base64) over `0xff || "agent402-bond-job/2:deliver:" || deal || ":" || origin || ":" || expires`, valid for at most 600 seconds. Returns `202` while working, else:

```json
{ "deal": "...", "status": "ok", "result": "<text>", "outputHash": "<64 hex>", "sellerSignature": "<base64>", "markTx": "..." }
```

`status` is `ok` or `job_failed`. `result` is always text; structured results are sent as JSON text and those exact bytes are hashed.

## Hashes

All SHA-256 over the bytes listed, in order. No JSON canonicalisation.

```
job_hash    = SHA256("agent402-bond-job/2:job" 0x00 program seller buyer nonce(u64 LE) deliver_by(i64 LE) SHA256(input) SHA256(description or ""))
output_hash = SHA256("agent402-bond-job/2:out" 0x00 deal job_hash status(0x00 ok, 0x01 job_failed) SHA256(result))
seller signature over: 0xff || "agent402-bond-job/2:output:" || deal || ":" || hex(output_hash)
```

`job_hash` is stored by `open`; `output_hash` by `mark_delivered`.

## What the buyer checks

Before signing `open`: the program id is the one in its own code; the terms match the quote; it recomputes `job_hash` from its own input; it rebuilds the `open` instruction (terms, job hash, both payout accounts, its own token account) and compares it byte for byte; only the seller and itself sign; its own spending rules and a human confirmation.

Before `accept`: the output hash recomputed from the received result equals the one in the response and the one stored on chain, the seller's signature is valid, and `status` is `ok`. Otherwise it does not accept.

## What the seller must do

Work on every opened deal without waiting for the buyer, and mark delivery before `deliver_by + grace`; an unmarked deal pays the bond and the deposit to the buyer. A job that cannot be done is committed as `job_failed` (with a non-refundable share and no arbiter, the seller releases the deal instead, so the buyer gets its whole deposit back).

## Known limits

- The program does not judge quality. A verified result is exactly what the seller committed to, not proof that it is good.
- A buyer can keep a delivered result without accepting; with the neutral option the seller then gets only its bond back. Sellers can refuse buyers who did this before.
