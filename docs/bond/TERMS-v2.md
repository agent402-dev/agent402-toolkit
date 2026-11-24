# Agent402 Bond v2 — Terms of Use

Status: Bond v2 program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev` on Solana mainnet (beta), deployed 2026-11-24, upgrade authority removed. These terms apply to every deal opened in this program. The published SDK does not turn v2 on yet; until it does, deals can only be opened by building the instructions yourself. Bond v1 deals stay under [`TERMS.md`](TERMS.md).

Plain-language summary: two parties lock money in a Solana program for one job. The program follows only signatures and the network clock. It never judges whether the work is good.

## 1. What this is

Open-source software: a Solana program plus client code. Nobody, including the publishers, holds your funds or can move a deal's funds outside these rules. The program's upgrade authority has been removed: it cannot be changed. Fixes come only as a new program at a new address.

## 2. How a deal works

1. Seller and buyer both sign `open`. It fixes the amounts, the deadlines, the dispute option, both payout accounts and a hash of the job (the buyer's exact input). The seller locks a bond; the buyer locks a deposit.
2. The seller marks delivery and stores a hash of the exact result. The seller also signs that hash off chain.
3. The buyer checks that the result it received matches the stored hash and the seller's signature, then accepts. Accepting pays the balance (price minus deposit) to the seller in the same step and releases the bond and the deposit to the seller.
4. If nobody acts, time decides, and anyone can settle. Each side then claims its share to its recorded payout account. The deal closes when both sides are done; the account rent goes back to the seller.

Deadlines: deliver by `deliver_by`; the seller may still mark until `deliver_by + grace` (grace 1 hour to 1 day). After a mark, the buyer has `review_window` (1 hour to 7 days, counted from `deliver_by` at the earliest) to accept. Every deal can be settled by anyone no later than about 45 days after opening.

## 3. Dispute options you choose at opening

- **Neutral (default).** If the buyer does not accept a delivered job, each side gets its own money back.
- **Non-refundable share.** A stated share of the deposit goes to the seller if the buyer does not accept a delivered job.
- **Arbiter.** A key both parties named may split the locked funds between the two recorded payout accounts within a fixed window after the review window. It can never pay itself or anyone else. If it does not act, the rule above applies.

The buyer tools refuse a non-refundable share and an arbiter unless the buyer enables them.

## 4. Outcomes

Locked amount L = seller bond + buyer deposit.

| How the deal ends | Seller gets from the vault | Buyer gets from the vault |
| --- | --- | --- |
| Buyer accepts | L (plus the balance paid directly) | 0 |
| Delivered, never accepted | bond + share of the deposit (0 by default) | the rest of the deposit |
| Not delivered by the mark deadline | 0 | L |
| Both cancel | bond | deposit |
| Both agree a split | the agreed part | the rest |
| Arbiter decides | the decided part | the rest |
| Seller releases | bond | deposit |

Rounding remainders go to the buyer.

## 5. What the bond does and does not protect

The bond protects the buyer only when the seller does not mark delivery in time. A seller who marks a result that is not useful keeps its bond unless an arbiter decides otherwise. A buyer who keeps delivered work without accepting loses at most the non-refundable share. The hashes prove what was committed, not that it is good.

## 6. What the program does not do

It does not judge quality, verify identity, hold the balance payment, charge fees, or give anyone a way to stop settlement, claims or cancellation.

## 7. Payout accounts, issuers and frozen accounts

Each party's payout account is fixed at opening; only that party can change it. At payment the program checks again that the account still belongs to that party. A frozen or closed payout account delays only that party's share until it names another account. If an issuer freezes the deal vault itself, both shares are stuck.

## 8. Funds sent directly to a vault

Do not do this. Extra tokens go to the buyer.

## 9. Limits

Per-deal and total limits apply per token (USDC, wSOL, PREQ). Other users can fill the total limit. The operator can change limits for new deals within fixed bounds written into the program, at most double or half per change, effective 48 hours after proposing. Open deals are never affected.

## 10. What the operator can and cannot do

The operator (a 2-of-3 Squads multisig) can pause new deals, hand over the role in two steps, and adjust limits as above. It cannot move funds, change an open deal, or stop settlement, claims or cancellation.

## 11. Fees and rent

No program fee. Ordinary Solana network fees apply. The seller pays the rent for the deal and vault accounts and gets it back when the deal closes.

## 12. Risks you accept

- **Software.** The program was reviewed internally. **This was not an independent audit.** Undiscovered defects may exist, and transactions cannot be reversed.
- **Keys.** Anyone with your private key can act as you.
- **Tokens.** Token values change, and issuers may freeze or change their tokens.
- **Network.** The Solana network may be slow or unavailable; an outage longer than the agreed grace period can cause a missed deadline.

## 13. Your responsibilities, no advice, no warranty

You are responsible for following the laws that apply to you and for what you buy or sell. Nothing here is legal, financial or investment advice. The software is provided "as is" under the Apache License 2.0, without warranties of any kind.

## 14. Changes and contact

A deal stays under the terms and program version in force when it was opened. Security reports and questions: agent402-security.discern669@passinbox.com (please report suspected vulnerabilities privately first). Other issues: https://github.com/agent402-dev/agent402-toolkit/issues
