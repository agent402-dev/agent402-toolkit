# Bonded jobs on Solana: an 8183-style mapping, and bond info in the 402

[ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) describes a job with a client, a provider and an evaluator, an escrowed budget
and a terminal outcome. Agent402 Bond v2 (program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`, Solana mainnet, beta, upgrade
authority removed) already has those parts. This guide shows a compatible mapping on the client side only: the program is unchanged,
and this is not an implementation of the standard.

Two ways to read a deal:

- **L/C-style escrow**: the buyer's deposit is locked when the deal opens and goes to the seller when the buyer accepts the delivered
  result.
- **Standby-style bond**: the seller's bond goes to the buyer if delivery is not marked in time.

Neither is a bank product. Nobody holds the funds but the program, and it pays out by signatures and the Solana clock only.

## Lifecycle mapping

| 8183-style step | Bond v2 | Who |
| --- | --- | --- |
| createJob + fund | `open` (one instruction; seller bond and buyer deposit locked together) | buyer and seller both sign |
| submit | `mark_delivered` (stores the hash of the exact result) | seller |
| complete | `accept` (pays the balance to the seller in the same step) | buyer |
| reject | no instruction: the buyer does not accept; after the review window anyone settles as Unconfirmed | buyer |
| claimRefund | `settle` + claims (deadline missed: bond and deposit to the buyer) | anyone |

Status names: Funded, Submitted, Completed, Rejected, Expired. Roles: client = buyer, provider = seller, evaluator = the buyer by
default. A third-party arbiter can be named at `open`; the tools below do not offer it.

In TypeScript, `@agent402-dev/bond-client/job-8183` has `createJob` / `fund`, `submit`, `complete`, `reject`, `claimRefund`,
`jobStatus` and `machineCheck`. `reject` sends nothing; it returns a record with a reason code and when settling becomes possible.

## Conditions a buyer can check from data alone

`machineCheck` decides `complete`, `reject` or `wait` without anyone's judgment:

| Condition | Evidence | On chain |
| --- | --- | --- |
| `deadline_missed` | delivery not marked by the deadline | bond and deposit go to the buyer at settlement |
| `not_delivered` | marked, but no result received after the delivery time | not accepted: each side gets its own money back |
| `receipt_mismatch` | result hash differs from the one stored by `mark_delivered`, the seller's signature does not match, or the seller reported the job as failed | not accepted: each side gets its own money back |
| `schema_mismatch` | result does not match the small JSON schema agreed at quote time | not accepted: each side gets its own money back |

"Each side gets its own money back" is less any non-refundable share chosen at opening. Only a missed deadline moves the seller's bond without agreement. For the other three, moving the bond needs both sides to agree or a
named arbiter. Other reject reasons (`data_incorrect`, `quality_below_brief`, `scope_dispute`, `originality`,
`offchain_unfulfilled`, `other`) are recorded as client metadata only; nothing about them is stored on chain.

## MCP tools

- Buyer (`@agent402-dev/pay-mcp`): `bond_v2_job_status` reads a deal as a job (read only). `bond_v2_reject` records that you will
  not accept, with a reason code (default `other`); it signs nothing. After the review window `bond_v2_settle` returns your deposit.
- Seller (`@agent402-dev/bond-seller-mcp`): `sell_job_status` (read only), and an optional reason code on `sell_decline` for your
  records.

Spending limits, allowlists and confirmations are the same as before.

## Bond info in the 402

A seller using `@agent402-dev/pay-server` can add an optional `bond` setting to its payment gate. The 402 then carries
`extensions.bond`: the program, the seller wallet, a bond token account to read, the asset, `maxCover` (the most a buyer can recover
per call, in smallest units) and `autoPayout: ["deadline_missed"]`. Without the setting the 402 is byte for byte the same as before.

The extension is a claim. With `X402_BOND_PREFER=on`, pay-mcp reads the bond account on chain before paying: it must exist, hold the
claimed mint, belong to the wallet being paid, and hold at least `maxCover`. Only a USDC bond gets a USD value. Above
`X402_UNBONDED_CONFIRM_ABOVE_USD` it asks a human before paying a seller without a checked bond. It never raises a limit or skips a
check. The balance is funds available for per-deal bonds; a bond is locked only when a deal opens.
A passing check is a read at one moment, not a reservation: the same balance can pass for several concurrent
quotes. Bond v2 `open` moves the seller bond into that deal's vault in the same transaction (and fails if the
seller cannot fund it), so bonds of deals already open are no longer in the balance, and the only lock for you is
your own deal opening.

## Optional: sample check for data jobs

A seller's handler can tell the payment gate where its data came from (`X-Agent402-Source`: URL, fetch time, SHA-256 of the fetched
bytes, and whether the source can change). The signed receipt then includes it as `source`. A buyer can re-fetch the source and
compare with `sampleCheck`; a mismatch is recorded as `data_incorrect` with evidence `sample_mismatch`, and counts as checkable from
data only when the seller marked the source as unchanging. It moves no funds.

## Feedback for a finished job

`jobFeedback` builds feedback in the shape the Solana 8004 registry takes (the job amount as value, a score, tags, and a hashed
feedback file). It only builds data; writing feedback on chain is up to you.

## Status

The code is on the `main` branch of [agent402-toolkit](https://github.com/agent402-dev/agent402-toolkit) and in the npm
releases bond-client 0.4.0, pay-server 0.11.0, pay-mcp 0.16.0 and bond-seller-mcp 0.5.0. Terms: [TERMS-v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS-v2.md).

Internal review only, not independently audited.
