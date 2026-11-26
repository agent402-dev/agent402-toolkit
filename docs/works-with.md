# Works with

A read-only compatibility check of `@agent402-dev/pay-mcp` against public x402 sellers. For each seller, the `x402_quote` path was run on a public endpoint: it reads the HTTP 402 answer (price, network, asset, recipient, discovery metadata) and pays nothing. No wallet was configured and nothing was signed.

Checked on 2026-11-26. Sellers came from the pay.sh catalog (solana-foundation/pay-skills) and the public x402 discovery list. Listing here only means the 402 answer was read correctly at that time; it is not an endorsement of the seller, and no paid request was made. Sellers change their endpoints, so results can go out of date.

| Seller | Networks read from the 402 answer |
|---|---|
| Blocksize Market Data | Base, Solana |
| CoinGecko Onchain DEX API (via PaySponge) | Base, Solana |
| RentCast API (via PaySponge) | Base, Solana |
| Wolfram Alpha (via PaySponge) | Base, Solana |
| Syntalic | Base, Solana |
| Vybe Solana Analytics API (x402) | Base, Solana |
| EarnFi Agent API | Base, Solana |
| Social Intel | Base, Solana |
| Venice.ai — Private AI Inference | Base, Solana |
| Agentic Reservations | Base, Solana |
| keyring-agent.blockchhub.link | Base |
| x402.tbs-digital.com | Base |
| www.api-xpay.com | Base |
| api.agents-trust.com | Base, Solana |
| blockrun.ai | Base |
| crypto.apitoll.cloud | Base, Solana |

Options on other networks (for example Polygon or Arbitrum) are shown by `x402_quote` but never paid: pay-mcp pays only on Solana, and on Base when you turn it on.

Whether a quote turns into a payment still depends on your own settings: allowed domains, trusted recipients, per-payment and daily limits, and confirmation. All of them are off (refuse everything) until you set them.

Run the check yourself: call `x402_quote` with the seller URL. It never pays.

Internal review only, not independently audited.
