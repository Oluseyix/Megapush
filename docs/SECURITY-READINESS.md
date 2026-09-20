# MegaPush security-readiness plan

This is the practical security work required before a real-money mainnet launch.
The crash-fairness hardening is complete locally and pushed to `main`; this plan
covers the remaining infrastructure, wallet, contract, and operations risks.

## Completed in this pass

- Crash settlement uses server-recorded arrival time and registered stake.
- Seed-chain anchoring failure and exhaustion close betting.
- Live crash results are not exposed before reveal.
- The private-key bootstrap route is now fail-closed unless both
  `BOOTSTRAP_ENABLED=true` and a token of at least 32 characters are configured.
- The repository scan found no literal private key in tracked source.

## Before any public testnet money

- Remove `BOOTSTRAP_ENABLED`, `BOOTSTRAP_TOKEN`, and the bootstrap route after
  any migration; do not leave a wallet key in general-purpose KV.
- Rotate every existing deployment secret and confirm none has appeared in shell
  history, CI logs, issue comments, chat, or browser network logs.
- Use a dedicated low-balance hot wallet for automated payouts. Keep treasury
  funds in a multisig or cold wallet with explicit spending limits.
- Restrict `ADMIN_TOKEN` to private operational access and verify admin routes
  are not reachable without it.
- Add Cloudflare WAF/rate limits for cashout, refund, bank, and verification
  endpoints; alert on bursts, failed auth, payout spikes, and repeated errors.
- Enable MFA/security keys for GitHub, Cloudflare, RPC providers, and all wallet
  signers. Review active sessions, deploy tokens, and collaborators.
- Pin and audit dependencies, run secret scanning in CI, and require protected
  branches plus review for deployment changes.

## Before mainnet

- Complete an independent review of `MegaPushEscrow.sol` and all payout paths.
- Verify the deployed contract addresses, chain IDs, token addresses, and
  allowances from a clean machine.
- Test key compromise, RPC outage, sequencer failure, KV outage, replayed
  cashouts, and the kill switch in a staging environment.
- Add immutable audit/reconciliation records for every stake, settlement,
  refund, ticket purchase, and wallet transfer.
- Prepare an incident runbook: pause betting, revoke/rotate secrets, disable
  payouts, preserve logs, notify users, and recover funds.
- Run a time-boxed testnet launch with capped exposure before accepting mainnet
  funds.

This document is a checklist, not a security certification. A public code review
and an infrastructure/contract audit are still required for meaningful assurance.
