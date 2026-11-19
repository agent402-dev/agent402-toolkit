# A402 Check — token check engine

Reads public Solana on-chain data for a token mint and returns **facts with evidence addresses**.
It does not judge or rate tokens and gives no investment advice. Every result carries this note:

> Factual information from public on-chain data. Not investment advice.
> 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.

This package is the open-source check engine of [A402 Check](https://a402-check.agent402-ebc.workers.dev). The hosted API at that address (it returns a JSON list of endpoints) currently offers only the free summary (items 1–4, `GET /v1/check/{mint}/summary`, 20 calls per IP per day).
The hosted API and its operating settings are not part of this repository.

## What it checks
| # | Check | Returns |
|---|---|---|
| 1 | Mint authority | revoked, or the authority address |
| 2 | Freeze authority | none, or the authority address |
| 3 | Metadata update authority | Token-2022 metadata, metadata pointer authority, Metaplex (`isMutable`) |
| 4 | Token-2022 extensions | all extensions; for transfer fee, transfer hook, permanent delegate, pausable, default account state, etc. — what the extension allows, its authority addresses and settings |
| 5 | Holder concentration | top accounts classified as pool / lock / wallet; accounts owned by programs this engine does not recognize are listed separately |
| 6 | Liquidity lock | Meteora DAMM v2 (permanent / vesting / withdrawable liquidity, position NFT holders), Raydium CPMM (LP not in circulation, Raydium LP lock) |
| 7 | Operator locks | Streamflow contracts: amount, schedule (cliff, first unlock, end), cancel / transfer / pause / rate-change permissions |
| 8 | Buys right after trading opened | wallets and supply share within N minutes of the pool opening, buys in the opening block, wallets buying in the same slot; liquidity adds/removes counted separately from sells |

Each section explains how values are calculated in its `notes`, and marks anything it cannot verify as unverifiable instead of guessing.
Item 8 reports timing facts only — it does not say whether a wallet is automated or related to another.

Supported programs: SPL Token, Token-2022, Metaplex Token Metadata, Meteora DAMM v2, Raydium CPMM (and Raydium AMM v4 / CLMM for holder classification), Streamflow.

## Usage
From the repository root:
```bash
npm install
cp .env.example .env   # set RPC_URL (Solana mainnet)
npm run check -- <mint>        # items 1-4
npm run holders -- <mint>      # item 5
npm run earlybuys -- <mint>    # item 8
npm test                       # offline, uses recorded public mainnet data
```

A public RPC works for items 1–4. Items 5–8 use `getTokenLargestAccounts` and `getProgramAccounts`, which public endpoints often throttle, so an RPC with an API key is recommended.

As a library:
```ts
import { checkFull } from 'a402-check-engine/full';
import { fetchChainReader } from 'a402-check-engine/rpc-lite';
// individual checks: checkSummary, checkHolders, checkLiquidity, checkLocks, checkEarlyBuys from 'a402-check-engine'

const reader = fetchChainReader(process.env.RPC_URL!);
const report = await checkFull('<mint>', reader); // items 1-8
```

## Limits
- Tokens with more than ~10 million token accounts (e.g. USDC): RPCs refuse largest-holder queries, so item 5 is unavailable.
- Item 8 walks the pool's history back to its creation; very long histories are reported as unverifiable, and large opening windows as partial.
- Liquidity on unsupported DEXs and locks in other programs are not included (reported as unverifiable).

## Hosted paid report — not yet available (coming soon)
The hosted full report (items 1–8) is **not yet available**: payments are switched off, and the endpoint `GET /v1/check/{mint}` currently answers `coming_soon`. No payment is taken.
Planned price: 0.02 USDC per call via x402 (planned, may change before launch).

> 호스팅 유료 리포트(항목 1~8)는 아직 제공하지 않습니다 (준비 중, 결제 꺼짐). 가격 0.02 USDC 는 예정 값입니다.

When it becomes available and you let an AI agent pay for it, use a **small, dedicated wallet** that holds only what you are willing to spend, and keep per-payment and daily limits on. Never use a wallet that holds other funds.

## License
[Apache License 2.0](../../LICENSE). See [NOTICE](../../NOTICE).

---
Factual information from public on-chain data. Not investment advice. / 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.
