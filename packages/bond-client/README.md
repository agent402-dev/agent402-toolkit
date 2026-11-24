# @agent402-dev/bond-client

Instruction builders for the **Agent402 Bond** Solana program (beta): a performance bond for one deal between a seller and a buyer.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana).
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

> This package only builds instructions and decodes accounts. It holds no keys and sends nothing on its own. The program was reviewed internally, **not independently audited**. Not investment advice.

## The program
- Program id `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK` on Solana mainnet, **no upgrade authority**.
- The seller locks a bond (at most 20% of the price), the buyer may lock a deposit. The outcome follows only the parties' signatures and the Solana clock. The program does not judge quality; quality disputes are resolved between the parties.
- Beta limits: 100 USDC locked per deal, 2,000 USDC across open deals.
- Source, tests and how to check the deployed code: [programs/](https://github.com/agent402-dev/agent402-toolkit/tree/main/programs). Terms and outcome table: [TERMS.md](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS.md). Internal review: [INTERNAL-REVIEW.md](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/INTERNAL-REVIEW.md).

## Bond v2
`@agent402-dev/bond-client/v2` builds instructions, decodes accounts and events, and applies the rules for [Bond v2](https://github.com/agent402-dev/agent402-toolkit/tree/main/programs-v2): program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev` on mainnet (beta, **no upgrade authority**, deployed 2026-11-24). Both parties sign `open`, which records a hash of the job and both payout accounts; payouts are claimed to those accounts. `@agent402-dev/bond-client/job-v2` has the [Job Protocol v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL-v2.md) helpers (job and output hashes, seller and buyer signatures, quote and delivery checks) and no dependencies.

```ts
import * as v2 from '@agent402-dev/bond-client/v2';
v2.BOND_V2_DEPLOYED;            // PublicKey of the deployed program
v2.decodeDealV2(data);          // deal account → state, amounts, deadlines, owed shares
v2.claimsV2(ref, deal);         // claim instructions still needed for a settled deal, in order
```
Terms: [TERMS-v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS-v2.md). Internal review (not an independent audit): [INTERNAL-REVIEW-v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/INTERNAL-REVIEW-v2.md).

## Install
```bash
npm install @agent402-dev/bond-client @solana/web3.js
```
`@solana/web3.js` (v1) is a peer dependency. `@agent402-dev/bond-client/rules` (deadlines, possible actions, settlement preview) has no dependencies at all. Node 20+.

## Usage
```ts
import { Transaction } from '@solana/web3.js';
import * as bond from '@agent402-dev/bond-client';

const U = 1_000_000n; // USDC has 6 decimals; all amounts are in the smallest unit
const now = BigInt((await connection.getBlockTime(await connection.getSlot()))!); // Solana clock
const deal: bond.DealRef = {
  seller, buyer,                    // PublicKey
  mint: bond.MINTS.mainnet.USDC,
  tokenProgram: bond.TOKEN_PROGRAM_ID,
  nonce: 1n,                        // unique per seller + buyer pair
};
const terms: bond.Terms = {
  price: 20n * U,
  sellerBond: 2n * U,
  buyerDeposit: 5n * U,
  deliverBy: now + 3_600n,          // unix seconds
  lateWindow: 0n,                   // 0..=7 days
  payWindow: 86_400n,               // 1..=30 days
};

// 1. Both sign: locks the bond and the deposit.
new Transaction().add(bond.open(deal, terms));
// 2. Seller marks delivery.
new Transaction().add(bond.markDelivered(deal));
// 3. Buyer confirms and pays the balance (price - deposit) straight to the seller.
new Transaction().add(bond.confirmReceipt(deal), bond.payBalance(deal));
// 4. Anyone: settle, then each side's claim (order matters).
new Transaction().add(...bond.settleAndClaim(deal));
```
Both sides can end a deal early with `cancelAndClaim` (both sign; each side gets its own money back). `decodeDeal(accountData)` reads a deal's state and outcome.

| Export | What it builds |
|---|---|
| `open`, `markDelivered`, `confirmReceipt`, `payBalance`, `extend` | Deal steps |
| `settle`, `claimBuyer`, `claimSeller`, `settleAndClaim` | Closing a deal whose outcome is fixed |
| `cancel`, `cancelAndClaim` | Closing a deal by mutual agreement |
| `dealPda`, `vaultPda`, `counterPda`, `configPda`, `dealOf` | Addresses |
| `decodeDeal`, `OUTCOMES` | Reading a deal |
| `timeline`, `settlePreview`, `buyerDeadline`, `possibleActions`, `settleBy` | The program's settlement rules in TypeScript (also at `@agent402-dev/bond-client/rules`, no dependencies): deadlines, what each side can do, what settlement pays |
| `associatedTokenAddress`, `TOKEN_PROGRAM_ID`, `TOKEN_2022_PROGRAM_ID` | Token account helpers |
| `JOB_PROTOCOL`, `checkJobQuote`, `termsMatchQuote`, `deliverMessage`, `verifyDeliverSignature` | [Bond Job Protocol](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL.md) helpers shared by sellers and buyers (also at `@agent402-dev/bond-client/job`, no dependencies) |
| `setPaused`, `setAdmin`, `acceptAdmin`, `proposeCaps`, `observePrice`, `activatePriceMode` | Operator and price-record instructions (the operator is a Squads multisig) |

## Things to get right
- **Verify before you sign.** If the other side builds a transaction for you to sign, rebuild the instruction yourself from terms you accept and compare it byte for byte. The [bonded-job example](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/bond-client/examples/job) shows how.
- **Seller: mark before `deliverBy`.** If nothing is marked or confirmed by the deadline, the bond and the deposit go to the buyer.
- **Never send tokens directly to a deal vault.** Anything beyond the locked amount is paid to the buyer.
- If one side's token account is frozen, send `settle` and the other side's claim on their own; the frozen side can claim later into another account it owns.

## Example
Two agents running a bonded job end to end (seller HTTP service, buyer agent, local mainnet-fork demo with no real funds): [examples/job](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/bond-client/examples/job).

## License
Apache-2.0
