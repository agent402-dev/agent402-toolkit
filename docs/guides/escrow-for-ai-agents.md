# Escrow for AI agents: bonded jobs on Solana

Paying per request works when the answer comes back in the same HTTP call. Longer jobs (a report, a dataset, a batch of work) need
something else: the buyer does not want to pay before delivery, and the seller does not want to work without commitment. Agent402
Bond is an open-source Solana program for that case: both sides lock money for one job, and the program pays out by signatures and
the network clock only. It never judges whether the work is good.

Bond v2: program `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev` on Solana mainnet (beta), upgrade authority removed. Terms:
[TERMS-v2](https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/TERMS-v2.md).

## How a deal works

1. Seller and buyer both sign `open`. It fixes the amounts, deadlines, the dispute option, both payout accounts and a hash of the
   buyer's exact input. The seller locks a bond; the buyer locks a deposit.
2. The seller marks delivery and stores a hash of the exact result, and signs that hash off chain.
3. The buyer checks the result against the stored hash and signature, then accepts. Accepting pays the balance to the seller in the
   same step.
4. If nobody acts, time decides and anyone can settle. Every deal can be settled no later than about 45 days after opening.

| How the deal ends | Seller gets from the vault | Buyer gets from the vault |
| --- | --- | --- |
| Buyer accepts | bond + deposit (plus the balance paid directly) | 0 |
| Delivered, never accepted (neutral, the default) | bond | deposit |
| Not delivered in time | 0 | bond + deposit |
| Both cancel | bond | deposit |

A non-refundable share of the deposit, or an arbiter both sides name, can be chosen at opening; the buyer tools refuse both unless the
buyer turns them on.

## Buyer side: an MCP agent

`@agent402-dev/pay-mcp` has the buyer tools. With no configuration they refuse everything.

```
bond_find_sellers → bond_v2_quote → bond_v2_start → bond_v2_result → (check the work) → bond_v2_accept → bond_v2_settle
```

- `bond_v2_start` rebuilds the `open` instruction from the seller's quote and your input, and signs only if it matches byte for byte
  (human confirmation).
- `bond_v2_result` and `bond_v2_accept` refuse a result whose hash does not match the one on chain. A matching hash proves what was
  committed, not that it is good: accept only work you checked.
- Limits: `X402_BOND_SELLERS`, `X402_BOND_MAX_USD`, the daily caps and `X402_BOND_CONFIRM_ABOVE_USD`.

## Seller side

- MCP: `npx -y @agent402-dev/bond-seller-mcp init`, then run it with your price, bond and deadlines (`BOND_SELL_*` settings).
- HTTP: the [Cloudflare Workers template](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/pay-server/examples/bond-seller-worker)
  sells the same work per request over x402 and as a bonded job.

Mark delivery before `deliver_by + grace`; an unmarked deal pays the bond and the deposit to the buyer.

## What it does not do

- It does not decide quality or handle disputes beyond the option chosen at opening.
- The admin can pause new deals and adjust per-token limits within fixed bounds; it cannot move locked funds, change open deals, or
  stop settlement, claims or cancellation.
- No program fee.

## Links

- Program source and build verification: https://github.com/agent402-dev/agent402-toolkit/tree/main/programs-v2
- Job Protocol v2: https://github.com/agent402-dev/agent402-toolkit/blob/main/docs/bond/JOB-PROTOCOL-v2.md

Internal review only, not independently audited.
