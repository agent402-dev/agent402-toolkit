# Agent402 Bond — Terms of Use (Beta)

**Effective 2026-11-22 for program `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK` (version 1).**

## 1. What this is

Agent402 Bond is open-source software: a Solana program (program id `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK`) plus client code. It lets a seller and a buyer lock a performance bond and an optional deposit for one deal. The program decides what happens to that money using only two kinds of evidence: the parties' signatures and the Solana network clock.

Nobody, including the people who publish this software, holds your funds or can move a deal's funds outside the rules below.

## 2. How a deal works

1. Seller and buyer agree on the terms and both sign `open`. The seller's bond (at most 20% of the price) and the buyer's deposit (if any) are locked in a vault that belongs to that deal.
2. The seller may mark the work as delivered. The buyer confirms receipt. **Only the buyer's confirmation counts as proof of delivery.**
3. The buyer pays the balance (price minus deposit) directly to the seller.
4. When the outcome is fixed by time and signatures, anyone may settle the deal. Each side then claims its own share. Normally all of this happens in one transaction.

## 3. Outcomes

| Situation at the deadline | Seller receives | Buyer receives |
| --- | --- | --- |
| Buyer confirmed and paid the balance | Bond back and the deposit | Nothing more (the work was delivered) |
| Buyer confirmed but did not pay the balance in time | Bond back and the deposit | Nothing |
| Seller marked delivery, buyer never confirmed | Bond back | Deposit back |
| Nothing was marked or confirmed | Nothing | Bond and deposit |
| Delivered late, inside the agreed late window | Bond minus a pro-rata late deduction, and the deposit | The late deduction |
| Both sign to cancel | Bond back | Deposit back |

All deadlines are measured by the Solana network clock. A deal always becomes settleable within a fixed time; the longest possible lock is about 219 days from opening.

## 4. What the program does not do

- It does not judge quality, completeness or whether the work matches a description. If a quality dispute arises, the parties to the deal resolve it between themselves.
- It does not verify identities, licenses or the legality of what is traded.
- It does not arbitrate disputes or issue refunds by judgement.
- It does not hold the balance payment; that goes directly from buyer to seller.

If the seller marks delivery and the buyer does not confirm, each side simply gets its own money back. This is deliberate: it means neither side can profit from making a false claim, but it also means the program does not settle quality disputes. If a quality dispute arises, the seller and the buyer resolve it between themselves.

A seller can avoid the late deduction by marking delivery before actually delivering. In that case the buyer's choice is not to confirm, which returns each side's own money.

## 5. Token issuers and frozen accounts

Some tokens, including USDC, are issued by a company that can freeze token accounts. If a token account of one party is frozen, that party's share waits in the deal vault until it can be received, and that party may claim into another token account it owns. The other party's share is not affected.

## 6. Funds sent directly to a vault

Do not send tokens directly to a deal vault. The program cannot tell who sent them. Any amount in a vault beyond what the deal locked is paid to the buyer.

## 7. Limits during the beta

- USDC: at most 100 USDC locked per deal and 2,000 USDC locked across all open deals, rising 2% per full year.
- wSOL and PREQ: limits are set within fixed bounds written into the program. The operator may move them for new deals only, at most double or half per change, effective 48 hours after the change is proposed.
- PREQ limits may later follow an on-chain price record automatically once usage and data thresholds in the program are met. This switch is one-way.

Limits apply to new deals only. They never change an open deal.

## 8. What the operator can and cannot do

The operator key can pause new deals, hand over the operator role in two steps, and adjust wSOL/PREQ limits as described above. It cannot move locked funds, change an open deal, or stop settlement, claims or cancellation. The deployed program cannot be upgraded. Fixes and new features ship as new programs; each deal is governed by the program version it was opened under.

## 9. Fees

The program charges no fee. Users pay ordinary Solana network fees and the rent for accounts they create; the seller's deal rent is returned when the deal closes.

## 10. Risks you accept

- **Software risk.** The program was reviewed internally by its developers. **This was not an independent audit.** Undiscovered defects may exist and transactions cannot be reversed.
- **Key risk.** Anyone with your private key can act as you. Nobody can recover a lost key.
- **Token risk.** Token values change, and issuers may freeze or change their tokens.
- **Network risk.** The Solana network may be slow or unavailable at times.

## 11. Your responsibilities

You are responsible for following the laws that apply to you, including tax, consumer, sanctions and licensing rules, and for what you buy or sell. Do not use the software for anything illegal or for deals with sanctioned persons.

## 12. No advice, no warranty

Nothing here is legal, financial or investment advice. The software is provided "as is" under the Apache License 2.0, without warranties of any kind. To the extent the law allows, the publishers are not liable for losses arising from its use.

## 13. Changes

These terms may be updated for future program versions. A deal stays under the terms and program version in force when it was opened.

## 14. Contact

Security reports and questions about these terms: agent402-security.discern669@passinbox.com. Announcements: @A402_official on X. Please report suspected vulnerabilities privately by email before any public disclosure. Other bug reports: https://github.com/agent402-dev/agent402-toolkit/issues
