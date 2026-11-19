# Agent402 toolkit (Solana)

Open-source tools from Agent402 for Solana: factual token checks, and x402 payments in USDC and A402 (Token-2022).

> Factual information from public on-chain data. Not investment advice.
> 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.

Not related to other projects named "a402" on other chains.

## Packages
| Package | What it is | Status |
|---|---|---|
| [`a402-check-engine`](packages/check-engine) | Reads public on-chain data for a token mint and returns facts with evidence addresses | in this repository |
| `a402-check-mcp` | MCP server for the checks (free) | in development |
| `a402-pay-server` | Server helpers to accept x402 payments in USDC and A402 via standard facilitators | in development |
| `a402-pay-mcp` | MCP server that lets an agent pay x402 APIs from the user's own wallet within limits | in development |

None of the packages are published to npm yet.

## Development
```bash
npm install
npm test
npm run typecheck
```
Node 20+.

## License
[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).

---
Factual information from public on-chain data. Not investment advice. / 공개 온체인 데이터에 따른 사실 정보이며 투자 권유가 아닙니다.
