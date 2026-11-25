# Agent402 plugins

Three plugins in the `agent402` marketplace. Each one runs one MCP server from this repository and adds one skill.

| Plugin | MCP server | Skill | Description |
|---|---|---|---|
| [`agent402-pay`](agent402-pay/README.md) | `a402-pay` ([`@agent402-dev/pay-mcp`](../packages/pay-mcp/README.md)) | `buy-bonded-job` | Let your agent pay x402 APIs in USDC on Solana and buy Agent402 Bond jobs from your own wallet, within allowlists and limits you set. With no configuration every payment is refused. Includes the buy-bonded-job skill. |
| [`agent402-sell`](agent402-sell/README.md) | `bond-seller` ([`@agent402-dev/bond-seller-mcp`](../packages/bond-seller-mcp/README.md)) | `sell-bonded-job` | Let your agent sell one kind of job as an Agent402 Bond seller on Solana (seller bond, buyer deposit, result hash on chain) from your own seller wallet. Includes the sell-bonded-job skill. |
| [`agent402-check`](agent402-check/README.md) | `a402-check` ([`@agent402-dev/check-mcp`](../packages/check-mcp/README.md)) | `token-facts` | Free facts with evidence addresses about a Solana token mint: authorities, Token-2022 extensions, holders, liquidity locks. No ratings, not investment advice. Includes the token-facts skill. |

## Install

- Claude Code: `claude plugin marketplace add agent402-dev/agent402-toolkit`, then `claude plugin install agent402-pay@agent402` (or `agent402-sell@agent402`, `agent402-check@agent402`).
- Codex: `codex plugin marketplace add agent402-dev/agent402-toolkit`, then `codex plugin add agent402-pay@agent402` (or `agent402-sell@agent402`, `agent402-check@agent402`). Needs git on PATH.
- Cursor: the repository root has `.cursor-plugin/marketplace.json` and each plugin has `.cursor-plugin/plugin.json` and `mcp.json`. To try one locally, copy its folder to `~/.cursor/plugins/local/<name>` (for example `~/.cursor/plugins/local/agent402-pay`) and run Reload Window. Teams can add the repository from the Cursor dashboard with Import from Repo.

Other MCP clients can run the same servers directly; see each package README or the [getting started guide](../docs/getting-started.md).

Requirements: each plugin starts its server with `npx -y <package>` (the `.mcp.json` in its folder), so Node.js and npm must be on PATH. License: Apache-2.0 ([LICENSE](../LICENSE), [NOTICE](../NOTICE)).

The Agent402 Bond programs have had internal review only and are not independently audited. Not affiliated with agent402.tools.
