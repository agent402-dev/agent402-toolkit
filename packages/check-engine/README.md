# a402-check-engine

Reads public Solana on-chain data for a token mint and returns **facts with evidence addresses**.
It does not judge or rate tokens and gives no investment advice. Every result carries this note:

> Factual information from public on-chain data. Not investment advice.
> 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.

Part of the [Agent402 toolkit](https://github.com/agent402-dev/agent402-toolkit) (Solana). Free and open source.
Not related to `agent402.tools`, `@agents402` or other similarly named sites, accounts or projects, including projects named "a402" on other chains.

## Install
```bash
npm install a402-check-engine
```
Node 20+. ESM only.

## Use
```ts
import { checkFull } from 'a402-check-engine/full';
import { fetchChainReader } from 'a402-check-engine/rpc-lite';
// individual checks: checkSummary, checkHolders, checkLiquidity, checkLocks, checkEarlyBuys from 'a402-check-engine'

const reader = fetchChainReader(process.env.RPC_URL!); // your Solana mainnet RPC
const report = await checkFull('<mint>', reader);       // items 1-8
```

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
Token amounts are in the token's smallest unit (raw integer) unless the field says otherwise; `uiAmount` fields are in whole tokens (using the mint's `decimals`).

Supported programs: SPL Token, Token-2022, Metaplex Token Metadata, Meteora DAMM v2, Raydium CPMM (and Raydium AMM v4 / CLMM for holder classification), Streamflow.

A public RPC works for items 1–4. Items 5–8 use `getTokenLargestAccounts` and `getProgramAccounts`, which public endpoints often throttle; for these, use an RPC with an API key.

## Limits
- Tokens with more than ~10 million token accounts (e.g. USDC): RPCs refuse largest-holder queries, so item 5 is unavailable.
- Item 8 walks the pool's history back to its creation; very long histories are reported as unverifiable, and large opening windows as partial.
- Liquidity on unsupported DEXs and locks in other programs are not included (reported as unverifiable).

## Free: the full report runs on your machine
A402 Check is free. The hosted A402 Check API (`https://a402-check.agent402-ebc.workers.dev`) serves only the summary (items 1–4, `GET /v1/check/{mint}/summary`, 20 calls per IP per day). The full report (items 1–8) is not served by the API (`GET /v1/check/{mint}` answers `410` with these instructions); run it with your own Solana RPC, either with this library (`checkFull`) or with the [`a402-check-mcp`](https://github.com/agent402-dev/agent402-toolkit/tree/main/packages/check-mcp) tool `token_check`.

> A402 Check 는 무료입니다. 전체 리포트(항목 1~8)는 자신의 RPC 로 이 컴퓨터에서 실행합니다.

## From source
In the [repository](https://github.com/agent402-dev/agent402-toolkit), from the root:
```bash
npm install
cp .env.example .env   # set RPC_URL (Solana mainnet)
npm run check -- <mint>        # items 1-4
npm run holders -- <mint>      # item 5
npm run earlybuys -- <mint>    # item 8
npm test                       # offline, uses recorded public mainnet data
```

## What it does not do
- It **does not judge, score or rate tokens** and gives no investment advice. It returns facts and evidence addresses.
- It **does not operate a facilitator**, **does not hold funds**, **does not exchange** currencies, and **does not accept or send payments on anyone's behalf**. It only reads public chain data.

## License
Apache-2.0. See [LICENSE](https://github.com/agent402-dev/agent402-toolkit/blob/main/LICENSE) and [NOTICE](https://github.com/agent402-dev/agent402-toolkit/blob/main/NOTICE).

---
Factual information from public on-chain data. Not investment advice. / 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.
