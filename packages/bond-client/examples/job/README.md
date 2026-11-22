# Example: a bonded job between two agents

A seller agent offers a job over HTTP. Before any work starts, the seller locks a performance bond and the buyer locks a deposit in an Agent402 Bond deal. The seller does the work, marks delivery on-chain and returns the result. The buyer checks the result, confirms, and pays the balance directly to the seller.

Use plain x402 (`@agent402-dev/pay-server`) for instant pay-per-request calls. Use a bond when the work takes time, costs more than a single request, or the buyer wants the seller to have something at stake.

## Files

| File | What it does |
| --- | --- |
| `seller.ts` | HTTP service: `GET /quote`, `POST /open`, `POST /deliver` |
| `buyer.ts` | Agent that checks the quote, verifies the `open` transaction, signs, checks the result, pays |
| `common.ts` | Wire format, sending by polling, buyer message signature |
| `demo.ts` | Runs both sides end to end on a local mainnet fork |
| `checks.ts` | Offline checks: the buyer refuses tampered `open` transactions and quotes outside its limits |

## Flow

```
buyer                         seller                         chain
  | GET /quote  -------------->  |                               |
  | POST /open {buyer, input} -> | builds `open`, signs as seller |
  | <---------- tx (base64) ---- |                               |
  | rebuild + compare, sign, send ------------------------------> | bond + deposit locked
  | POST /deliver {deal, sig} -> | checks deal on-chain, works,  |
  |                              | mark_delivered -------------> |
  | <--------------- result ---- |                               |
  | own acceptance check         |                               |
  | confirm_receipt + pay_balance --------------------------------> | balance to seller
  | settle + claim_buyer + claim_seller --------------------------> | bond + deposit to seller, deal closed
```

## Run it locally (no real funds)

Install [Surfpool](https://github.com/txtx/surfpool), then from `packages/bond-client`:

```
surfpool start --network mainnet --no-tui
npx tsx examples/job/demo.ts
```

The fork loads the deployed program and its accounts on demand. The demo creates two throwaway keys and funds them with Surfpool cheatcodes on your machine. It refuses to run against any non-local RPC. Expected end: seller `+20 USDC`, buyer `-20 USDC`, deal closed.

## Things to get right in your own code

- **Verify before you sign.** The buyer rebuilds the `open` instruction from terms it accepts and compares it byte for byte (`checkOpenTx`). Never sign a transaction from a counterparty without doing this.
- **Seller: mark before the deadline.** If nothing is marked or confirmed by `deliverBy`, the bond and the deposit go to the buyer.
- **Seller: start work only after the deal is on-chain.** `deliver` reads the deal account first.
- **Buyer: the program does not judge quality.** If the result fails your check, do not confirm. Once the deadlines pass, anyone can settle and each side gets its own money back. Quality disputes are resolved between the parties.
- **Never send tokens directly to a deal vault.** Anything beyond the locked amount is paid to the buyer.
- **Use the network clock.** Deadlines are checked against Solana time; `chainNow` reads it.
- **Persist jobs.** The example keeps jobs in memory. A real seller stores them so it can still mark delivery after a restart.
- **Use HTTPS.** The result is protected only by the buyer's signature over the deal address.

Outcomes, limits and operator powers: [`docs/bond/TERMS.md`](../../../../docs/bond/TERMS.md). Beta limits: 100 USDC per deal, 2,000 USDC across open deals.

The program was reviewed internally, not independently audited. Not investment advice.
