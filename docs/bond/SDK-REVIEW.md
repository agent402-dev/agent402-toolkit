# Agent402 Bond — Off-chain SDK Review v1

2026-11-23 · Status: **internal review. One reviewer worked separately, without access to the design discussions. This is not an independent audit.**

## Scope

- `@agent402-dev/bond-client` 0.2.0: `./rules`, `./job`
- `@agent402-dev/pay-server` 0.5.0: `./bond` (`createBondSeller`, `bondJobService`)
- `@agent402-dev/pay-mcp` 0.5.0: Bond tools (`bond_open`, `bond_confirm_and_pay`, `bond_settle`, `bond_job_*`) and the wire-format code they use
- `pay-server/examples/bond-seller-worker` (Cloudflare Workers template)
- Out of scope: the on-chain program (see [INTERNAL-REVIEW.md](INTERNAL-REVIEW.md)).

## Method

1. A separate reviewer read the code against the [Job Protocol](JOB-PROTOCOL.md) and the program rules. The reviewer had no access to the design history.
2. Each finding was checked with a test against the code before any fix. Findings that could not be reproduced would not have been fixed.
3. Fixes, new tests, then the full suite again.

Main conclusions from the reviewer:
- No path was found that makes the buyer's wallet sign anything other than the exact `open`, `confirm_receipt` + `pay_balance`, settle or claim transactions it rebuilds itself.
- The TypeScript settlement rules and the deal account layout match the Rust program.

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| H-1 | High | A job that always fails or hangs on some input meant the seller never marked delivery and lost its bond at the deadline. | Fixed: per-run timeout with abort signal; after `maxAttempts` failures, or 30 minutes before the mark deadline, the failure is delivered as `job_failed` and marked (neutral outcome); `validateInput` hook. |
| H-2 | High | Unlimited `/open` requests could fill the store and slow the seller's loop past deadlines. | Fixed: pending caps per buyer and in total (429); deals read in one batch; earliest deadline first; one failing deal no longer stops the others. |
| H-3 | High | A buyer can receive the work and never confirm: each side gets its own money back, so the work is free. | **Mitigated, documented.** Follows from the program's rules; cannot be prevented off-chain. Disclosed in the protocol spec; the reference seller refuses buyers with unconfirmed deliveries (`maxUnconfirmedPerBuyer`, default 2). A new wallet gets around it once. |
| M-1 | Medium | Parallel tool calls could each pass the daily cap before either was recorded. Also affects x402 payments in pay-mcp 0.4.0. | Fixed: spending tools run one at a time (check → confirm → sign → send → record). Reproduced before the fix: two parallel opens locked 20 USDC against a 15 USDC cap. |
| M-2 | Medium | The human-confirmation threshold for confirming receipt compared against the balance, not the full price released. | Fixed: threshold uses the price. |
| M-3 | Medium | With several Worker isolates, a job could run twice. | Fixed: optional store `lock`/`unlock`; implemented in the in-memory store and the Durable Object template. |
| M-4 | Medium | A closed or frozen token account on the other side made the combined settle-and-claims transaction fail. | Fixed: falls back to settle plus own claim (the other share stays claimable). |
| M-5 | Medium | Free mass opening could tie up seller capital. | Fixed by the H-2 caps. |
| L-1 | Low | `lateDeductionIfConfirmed` was computed without the confirm time. | Fixed. |
| L-2 | Low | Display with 0 decimals was wrong; devnet USDC was unknown. | Fixed. |
| L-3 | Low | `bond_settle` assumed the classic token program and USDC display. | Fixed: non-USDC deals are refused by these tools. |
| L-4 | Low | A buyer who confirmed and paid before the work got no result. | Fixed: the work is still done and served; no mark. |
| L-5 | Low | The delivery request signature was not bound to the server or to time. | Fixed: bound to origin and expiry (at most 10 minutes). Wire format changed before first publication. |
| L-6 | Low | A settle (no tokens leave the wallet) counted as a payment. | Fixed. |
| L-7 | Low | Risky settings were accepted (short TTL, no beta cap check, very short delivery time). | Fixed: refused at startup. |
| L-8 | Low | Malformed terms from a seller threw an internal error. | Fixed: structured refusal. |
| I-1 | Info | The seller's signature on `open` was not checked before the buyer signed. | Fixed. |
| I-2 | Info | Non-canonical length encodings were accepted when parsing. | Fixed. |
| I-3 | Info | Delivered work can contain text aimed at the buyer's agent. | Documented: the tool marks it as data, not instructions. |
| I-4 | Info | Program-wide caps can be filled by other users. | Program design; documented in TERMS. |
| I-5 | Info | Small clock differences between RPC and chain. | Margins already applied; no change. |
| I-6 | Info | Bond tools should stay limited to USDC. | Applied (see L-3). |

## Tests

- 19 new tests reproduce the findings above; full suite 339 / 339 pass; typecheck clean, including the Workers template.
- Local mainnet-fork rehearsals to be re-run after these changes.
