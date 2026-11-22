# Agent402 Bond (Solana program, beta)

A performance bond for one deal between a seller and a buyer. The seller locks a bond (at most 20% of the price) and the buyer may lock a deposit. The outcome is decided only by the parties' signatures and the Solana clock; nobody judges quality.

- Program id (mainnet): `9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK`
- On-chain code SHA-256: `abf47892163cda590b22ed662826973df2d0deb90f17f1f1eec6cc8da5836076` (359,072 bytes)
- Upgrade authority: **none**. The code cannot be changed. Fixes ship as new programs.
- Operator: Squads v4 multisig vault `36PdTtqfp4vNvJjn9stRFoymRFdMZ1NHU9kLvb82mScc` (2 of 3). It can only pause new deals, hand over the role in two steps, and move wSOL/PREQ caps within hard bounds (at most 2x per change, 48 hours later). It cannot move locked funds or stop settlement.
- Mints: USDC, wSOL, PREQ. USDC caps: 100 USDC per deal, 2,000 USDC across open deals, +2% per full year.
- Terms: [docs/bond/TERMS.md](../docs/bond/TERMS.md) · Review: [docs/bond/INTERNAL-REVIEW.md](../docs/bond/INTERNAL-REVIEW.md) (internal review, **not an independent audit**)

## What it does not do

It does not judge quality, verify identities, arbitrate disputes or hold the balance payment. If the seller marks delivery and the buyer never confirms, each side gets its own money back. Quality disputes are resolved between the parties.

## Layout

| Path | What |
| --- | --- |
| `agent402-bond-core/` | Pure settlement rules, caps and price record (no Solana dependencies), with property tests |
| `agent402-bond/` | Anchor 1.2.2 program |
| `agent402-bond-tests/` | LiteSVM flow tests, differential fuzzing, and a replay against real mainnet account data (`fixtures/`) |

Client: [`packages/bond-client`](../packages/bond-client) (instruction builders, scripts for setup, smoke tests and Squads admin proposals).

## Verify the deployed code

```sh
solana program dump 9hiCZZ6ddFG9oJBR1Su43Pj4JRFHeHC5cGiCgXtTuAaK bond.so --url mainnet-beta
sha256sum bond.so   # abf47892163cda590b22ed662826973df2d0deb90f17f1f1eec6cc8da5836076
```

The build used Agave platform-tools v1.58 (`cargo build-sbf --tools-version v1.58`). Solana builds are not guaranteed to be byte-for-byte reproducible across machines; the hash above identifies the reviewed binary.

## Test

```sh
cargo test -p agent402-bond-core
cargo build-sbf --manifest-path agent402-bond/Cargo.toml --features test-mints
BOND_SO=target/deploy/agent402_bond.so cargo test -p agent402-bond-tests -- --test-threads=1
```

The mainnet replay test also needs a mainnet build: `BOND_SO_MAINNET=<path to mainnet .so>`.

## Report a problem

Security issues: agent402-security.discern669@passinbox.com (please report privately first). Other issues: GitHub Issues.
