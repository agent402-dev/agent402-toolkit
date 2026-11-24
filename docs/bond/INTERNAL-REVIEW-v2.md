# Agent402 Bond v2 — Internal Review (not an independent audit)

Status: deployed on mainnet as `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev` on 2026-11-24; upgrade authority removed the same day. Scope: `programs-v2/` (program, rules crate, tests), `@agent402-dev/bond-client` v2 and job-v2, the v2 seller (`pay-server/bond-v2`) and buyer (`pay-mcp` `bond_v2_*`). **Reviewed internally by the developers. This was not an independent audit.**

## Method

- A full checklist review (root-cause questions, account constraints per instruction, Token-2022 extensions, CPI, arithmetic, rent and closing, events, admin powers, denial of service, test coverage), static, against the specification.
- The Solana Foundation static checker (`@solana/mcp check`) on the program source.
- Tests: rules property tests (8, including 20,000 random deals); LiteSVM flow tests (11) and Token-2022 tests (4) against the built program; a differential fuzz of the built program against the rules model (400 rounds per run, per-deal payout checked exactly).
- Mainnet-fork rehearsals (Surfpool) with the mainnet build: the real USDC (SPL Token) and PREQ (Token-2022) mint accounts, accept / time settlement / cancel paths, events, and the buyer and seller tools end to end over the Job Protocol v2.

## Findings and status

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| M-01 | Medium | Payout account owner was checked only when recorded, not when paid; an account closed and recreated at the same address could receive another party's share. | **Fixed.** Owner checked again at accept and at each claim. Test added. |
| M-02 | Medium | No tests for the mint screening (Token-2022 extensions, freeze authority). | **Fixed.** Tests for allowed metadata-only mints and seven refused mint types; real USDC and PREQ mint accounts replayed on a mainnet fork. |
| C-1, C-2 | Medium (checker) | Two subtractions without overflow checks (balance at accept, seller owed at claim). | **Fixed.** Checked subtraction; checker re-run: no issues. |
| L-01 | Low | `open` did not re-check the mint. | **Fixed.** |
| L-02 | Low | The buyer side was never marked done when owed nothing, so a closed or frozen buyer account could keep the deal (and the seller's rent) open. | **Fixed.** Tokens sent directly to the vault are still swept to the buyer before closing. |
| L-05 | Low | Events missing fields (sequence number, payout accounts, rent payer). | **Fixed.** All deal events carry the deal and its sequence number. |
| L-07 | Low | Fuzz assertions too weak; arbiter decisions rarely reached. | **Fixed.** Exact per-deal payouts; decisions at window edges, over-limit splits and wrong signers. |
| L-09 | Low | A deal marked at clock time 0 could not be settled by time. | **Fixed** (only reachable on test clocks). |
| L-03, L-04, L-06, L-10 | Low | Specification and code disagreed (rent payer, state/outcome numbering, account sizes, USDC bounds). | **Resolved** by updating the specification to the code. |
| Pre-deploy items | — | Final USDC bounds and admin multisig; wSOL mint; `security.txt`; separating the test build from the mainnet id. | **Done.** USDC bounds fixed in the program; admin is the Squads vault; the wSOL, USDC and PREQ limit records were created on mainnet against the real mints; `security.txt` embedded; the test build uses a different program id. |

## Mainnet deployment record (2026-11-24)

- Program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`, ProgramData `7VmjJPMQXLrGGQhiAewCHpHiJkdBvJLHKdgSt3LptvCM`, deployed in slot 473343504. On-chain code SHA-256 `a87a1830fd24d5aadeec0e91ed4678bc62c6e695a824d4ffba14d385c00aa739` (370,560 bytes), the same as the reviewed build (reproduced several times from clean checkouts with the recipe in `programs-v2/README.md`).
- Config `Gi4cmk4aJsM9LPXQg2t4qp7a4F6KYVuG7upCbehP94gY` with the Squads vault as admin; limit records for USDC, wSOL and PREQ.
- Small test deals on mainnet (accept, cancel, seller release) settled and closed as specified.
- The deploy key had been retired earlier for exposure and should not have been used. Before removing the upgrade authority, the on-chain code was checked again: same hash, last deployed in the original slot. The authority was then removed (`none`); the key controls nothing in this program and is not an Agent402 key.
- Pause and unpause were tested through the Squads vault (2 of 3 approvals).

## What this review cannot tell you

It does not prove the absence of defects. Quality of delivered work is outside the program. Limits stay low while no independent audit exists.
