# Agent402 Bond v2 (Solana program, beta)

A performance bond for one job between a seller and a buyer. The seller locks a bond and the buyer locks a deposit. Both sign the deal, which fixes the amounts, deadlines, the dispute option, both payout accounts and a hash of the job. The outcome follows only the parties' signatures and the Solana clock; nobody judges quality.

- Program id (mainnet): `Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev`
- On-chain code SHA-256: `a87a1830fd24d5aadeec0e91ed4678bc62c6e695a824d4ffba14d385c00aa739` (370,560 bytes)
- Upgrade authority: **none** (removed 2026-11-24). The code cannot be changed. Fixes ship as new programs.
- Operator: Squads v4 multisig vault `36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc` (2 of 3). It can only pause new deals, hand over the role in two steps, and move per-token limits within bounds written into the program (at most 2x per change, 48 hours later). It cannot move locked funds, change an open deal, or stop settlement, claims or cancellation.
- Mints: USDC (SPL Token), wSOL, PREQ (Token-2022). Starting limits: 100 USDC per deal and 2,000 USDC across open deals; 0.5 / 10 wSOL; 688,000 / 13,760,000 PREQ.
- Terms: [docs/bond/TERMS-v2.md](../docs/bond/TERMS-v2.md) · Job protocol: [docs/bond/JOB-PROTOCOL-v2.md](../docs/bond/JOB-PROTOCOL-v2.md) · Review: [docs/bond/INTERNAL-REVIEW-v2.md](../docs/bond/INTERNAL-REVIEW-v2.md) (internal review, **not an independent audit**)
- The published SDK does not turn v2 on yet (`BOND_V2_DEPLOYED` is unset in `@agent402-dev/bond-client/v2`). Bond v1 ([`programs/`](../programs)) is unchanged.

## Layout

| Path | What |
| --- | --- |
| `agent402-bond-v2-core/` | Pure settlement rules, deadlines and limits (no Solana dependencies), with property tests |
| `agent402-bond-v2/` | Anchor 1.2.2 program. The default build is the mainnet id; the `test-mints` feature builds a test id (`5TotaQm4RbhRfhZzwFwnfoRLMWJ4jn3dpA9gRVsgd5bx`, never deployed) |
| `agent402-bond-v2-tests/` | LiteSVM flow tests, Token-2022 mint tests and a differential fuzz against the rules model |

Client: [`packages/bond-client`](../packages/bond-client) exports `./v2` (instruction builders, decoders, rules, events) and `./job-v2` (job and output hashes, signatures).

## Verify the deployed code

```sh
solana program dump Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev bond-v2.so --url mainnet-beta
sha256sum bond-v2.so   # a87a1830fd24d5aadeec0e91ed4678bc62c6e695a824d4ffba14d385c00aa739
solana program show Dpvdw53zwFbNhNp4KiTBXS1SNge467M8frtHn2Gr36Ev --url mainnet-beta   # Authority: none
```

Rebuild from this folder (Agave 4.4.1, platform-tools v1.58, default features):

```sh
cargo-build-sbf --tools-version v1.58 --manifest-path programs-v2/agent402-bond-v2/Cargo.toml
sha256sum programs-v2/target/deploy/agent402_bond_v2.so
```

The GitHub Actions workflow **Verify build** runs the same recipe and compares the result with the program on mainnet.

## Tests

```sh
cargo test --manifest-path programs-v2/Cargo.toml -p agent402-bond-v2-core --locked
cargo-build-sbf --tools-version v1.58 --manifest-path programs-v2/agent402-bond-v2/Cargo.toml --features test-mints
BOND_V2_SO=programs-v2/target/deploy/agent402_bond_v2.so cargo test --manifest-path programs-v2/Cargo.toml -p agent402-bond-v2-tests --locked
```

## Security

Report suspected vulnerabilities privately first: agent402-security.discern669@passinbox.com. The program embeds a `security.txt` with the same contact.

---
Factual information. Not investment advice.
