# Agent402 Bond — Internal Security Review v1

2026-11-22 · Status: **internal review by the development team. This is not an independent audit.**

## Scope

- `programs/agent402-bond` (Anchor 1.2.2 Solana program) and `programs/agent402-bond-core` (pure settlement logic, caps, price record). About 1,700 lines of Rust.
- Builds: mainnet (USDC, wSOL, PREQ only), devnet, and `test-mints` (tests only; uses a different program id so it cannot run at the real address).
- Out of scope: the Meteora DAMM v2 program, the SPL Token / Token-2022 programs, off-chain clients and UI.

## Benchmark: what a top-tier audit covers

Published 2026 market references put top firms at about $25,000 per engineer-week, and Rust/Solana work is priced above Solidity. For this code size, a top-tier engagement would be roughly 2 engineers for 2–3 weeks. This review copies the parts of such an engagement that do not depend on an outside firm:

1. Manual review against a written spec and a threat model.
2. Two separate review passes that started without access to prior design discussions: one on accounts and permissions, one on economics and protocol logic.
3. Differential, stateful fuzzing of the real program binary against the pure model.
4. Fixes, re-test, a fix-verification pass, and a findings table with status.

What it cannot copy: an outside firm's independence and reputation. Treat the result accordingly.

## Method and results

| Check | Result |
| --- | --- |
| Core unit and property tests (incl. 200,000-step random invariant test) | 22 / 22 pass |
| Program flow tests in LiteSVM (all outcomes, caps, pause, mode A, mode B switch, frozen account, vault overpayment) | 15 / 15 pass |
| Differential fuzzing: random actors, times, wrong signers, wrong destinations, donations; classic SPL and Token-2022 with metadata extensions | more than 1,600 deals opened and settled across repeated runs; 0 mismatches |
| Invariants checked after every fuzz step | vault = locked amount; counter = sum of open deals; total tokens conserved; outsider never receives funds; every deal settleable 400 days later |
| Risky-mint screening test | permanent delegate, close authority and freeze authority refused |
| Mainnet-account replay (real USDC, PREQ Token-2022 mint and Meteora pool data) | pass |
| Real CLI deploy to local devnet and mainnet forks + 10-step smoke test | pass; every step under 34,000 compute units and 640 bytes |
| Fix-verification pass on changed code | no critical, high or medium issues |

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| F1 | High | A seller could mark delivery right after opening; the buyer's window then ran from the mark, so the deal could end as "disputed" before the due date. | **Fixed.** The buyer's window runs from max(mark, T1), and before a confirm it never ends before T2. Tested. |
| F2 | High | Self-deals extended again and again could keep the global cap full and block other users. | **Partly fixed.** A deal's whole term is capped at 180 days from opening. Someone with enough capital can still occupy the cap; they lose only the time value of the money. The cap counts undecided deals only. |
| F3 | Medium | Updating the price record every second rounded each move to zero, freezing the record. | **Fixed.** Exact per-second step. Tested. |
| F4 | Medium | A momentary deposit could satisfy the liquidity condition for the mode B switch. | **Partly fixed.** Liquidity must hold for 30 days of observations; one low reading resets it. A sole observer can still add liquidity inside each observing transaction. The switch is a speed bump, and its effect is bounded by the cap limits. |
| F5 | Medium | Tiny or instant self-deals could inflate the settled-deal count used by the switch. | **Partly fixed.** Only delivered deals with a seller bond of at least 5% of the base cap that stayed open at least 1 day count. Capital-backed fake deals are still possible. |
| F6 | Medium | After the switch, a stale record or an abandoned pool would have blocked all new PREQ deals for good. | **Fixed.** Stale record or thin liquidity falls back to the last operator caps. Tested. |
| F7 | Medium | The record reads the pool's spot price, which can be pushed within one transaction; repeated pushes steer it about 5% per hour. | **Accepted.** No time-weighted price is available from the pool. Effect is bounded by the hard cap limits. |
| F8 | Medium | Settlement paid both sides in one transaction. If an issuer froze one party's token account, neither side could be paid. | **Fixed.** Settlement only records the outcome; each side claims its own share (normally in the same transaction). A frozen account blocks only its own side's share. Tested. |
| F9 | Low | A mint with a freeze authority, permanent delegate, transfer fee or transfer hook could lock or drain vaults. | **Fixed.** `init_counter` accepts only metadata extensions and no freeze authority (USDC excepted). Tested. |
| F10 | Low | Admin handover took effect in one step; a typo would lose the role. | **Fixed.** Two steps: name a successor, successor accepts. Tested. |
| F11 | Low | A test build could have been deployed at the real address. | **Fixed.** Test builds use a different program id and fail at the real address. |
| F12 | Design limit | A seller can avoid the late deduction by marking before actually delivering. The buyer's remedy is not to confirm, which returns each side's own money. | **Disclosed.** Machine-only evidence cannot tell when delivery really happened. |
| F13 | Design limit | A buyer who receives the work and never confirms loses nothing. The deposit only covers confirmed-but-unpaid deals. | **Disclosed.** Owner decision: keep the neutral release with no penalty, and state it in the terms. |
| F14 | Low | An extension agreed after confirmation can reset a late deduction. Both parties must sign it. | **Disclosed.** |
| F15 | Info | The admin key in the mainnet build was a placeholder. | **Fixed.** The admin is a Squads v4 multisig vault (`36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc`, 2 of 3). Pause and unpause were executed through it on mainnet. |
| F16 | Info | The settler chooses which token account of each party receives funds; the account is always owned by that party. | **Accepted.** |

## Properties verified

- Funds go only to the recorded seller's or buyer's token accounts. Wrong destinations fail.
- Payouts always add up to the locked amount; anything sent straight to the vault beyond the locked amount goes to the buyer.
- Each deal settles once and its accounts close.
- Every deal becomes settleable by a fixed time, at most about 219 days after opening.
- The operator can only pause new deals, hand over the admin role in two steps, and (mode A) move wSOL/PREQ caps within hard limits, at most 2x per change, 48 hours later. No key can move locked funds or stop settlement. The program has no upgrade authority.
- Mode B is one-way and its caps stay inside the same hard limits.

## Launch status

1. Deployed 2026-11-22 to mainnet as `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK` (slot 472,562,556). On-chain code SHA-256 `abf47892163cda590b22ed662826973df2d0deb90f17f1f1eec6cc8da5836076` matches the reviewed build. Upgrade authority removed.
2. Limited-launch caps in force. A bug bounty may follow.
3. Open: a scheduled `observe_price` caller (only needed for the optional PREQ mode B switch).
