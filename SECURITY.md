# Security and trust boundaries

Ikenga has deployed Celo contracts and can move real funds. The original skeleton-stage notes no longer describe the running application. This repository does not include an independent smart-contract security audit report.

## Two different money flows

- **Creative jobs:** the customer funds a per-job `JobEscrow`. Only the saved customer can accept or reject. Acceptance requires a submitted deliverable fingerprint and releases the price to the appropriate vault. Rejection refunds the escrow price; new jobs use a zero bond. After 48 hours **from funding**, anyone can call `deadlineRelease()` to release the price to the vault. This path does not require customer acceptance, and time passing alone does not broadcast the transaction.
- **Ikenga Pay:** a bill is funded by a verified USDT transfer into the operator-controlled agent wallet. The worker converts it through Textile FX and pays cNGN to the supplier's Celo wallet. This is not the job escrow and has no equivalent automatic escrow refund. A rate change can require a top-up; surplus funding is not automatically returned. A due date does not guarantee a fill when funding, liquidity, gas, or an executable quote is unavailable.

## Keys and authority

- Customers confirm their transactions through their own wallets. Wallet sign-in is a separate message and does not grant token-spending permission.
- OpenAI credentials, database credentials, and session secrets belong only in server-side configuration. The boss signing key belongs in the worker runtime, not in the browser or web build.
- Keep actual environment files ignored. Never expose secrets through a `NEXT_PUBLIC_` variable, a screenshot, a debug response, or an issue report. `.env.example` contains configuration names and development placeholders only.
- The worker signs scoped API requests. Its authority is checked against the configured vault's on-chain boss, not accepted from a claimed address header alone.
- The worker checks chain configuration and per-escrow vault references. An environment must not reuse mainnet addresses as testnet defaults.

## Access and privacy

- Job history and private job details require a verified wallet session or an authorized scoped worker request. Private job responses use private/no-store caching.
- Bill history is filtered by verified funding ownership. Bill-detail routes currently serve records by bill ID; treat those links as receipt access, not as wallet-protected job pages.
- Aggregate activity is public. On-chain addresses, movements, transaction inputs, and hashes remain public. Published customer content is public wherever it is hosted.
- A hash-chained ledger detects inconsistencies relative to stored chain data. It is not an independent factual audit, and the current decision ledger does not cryptographically sign every entry.

## Generated work and payments

Generated websites are previewed in sandboxed frames with scripts disabled. Content remains model output and should be reviewed before use. Source URLs, unsupported claims, and commercial facts require particular attention.

CFO pricing and FX decisions use deterministic code; transaction rules live in code and contracts. Application spending reservations constrain workflow calls, but they are not a provider-enforced billing limit. Interrupted or uncertain calls can still be billed.

x402 support is for approved tool sellers and spending caps. It does not imply that all model usage is settled on-chain. Self Agent ID verification and ERC-8004 registration are distinct: registration alone does not prove a current human-backed verification.

## Reporting

Share a minimal, redacted reproduction with the project maintainer. Do not post wallet keys, API credentials, signed session material, private customer briefs, or exploitable details in a public issue. Use an available private reporting channel for sensitive findings.

See the [README](README.md) for current product flows and [contract source](contracts/src/JobEscrow.sol) for the exact settlement conditions. Tests and successful deployments do not replace an independent audit.

