# Fairness hardening — local implementation

These changes harden the existing manual crash game. They do not deploy a new
contract or Worker, change the crash distribution, or establish mainnet readiness.

## Implemented

- Cashout responses use an explicit public-field allowlist. Invalid and successful
  requests cannot disclose the seed, target block hash, crash multiplier or time.
- Manual cashout uses the time the complete body reaches the Worker, carried over
  its private Durable Object binding. Client timestamps and multiplier claims do
  not determine eligibility or payout. An unfinished upload cannot reserve a time.
- RoundDO checks the registered entry, recipient, round and stake, stores the first
  receipt, and returns it on retries. Released/refunded entries cannot settle.
  Ticket purchases stop if the receipt cannot be committed. Receipts contain no
  hidden outcome data and survive object restarts within current retention limits.
- Auto-cashout uses the target registered with the stake. A due auto target takes
  precedence over a later manual cashout, and delayed alarms can process archived
  rounds. Calls run under the same state queue as stake and settlement decisions.
- The published seed-chain head is never played. New chains start at index one;
  unused legacy index-zero chains skip that index without replacing the anchor.
- Anchor failure closes betting. Exhaustion stops the engine instead of silently
  generating a new sequence. An explicit rotation process remains operational work.
- The target offset is five full Base blocks. A resolved block must have the
  committed number and a timestamp after betting closes; otherwise the round is
  voided. Voiding refunds without recursively entering its own round lock.
- Verification rejects invalid/unbounded chain indices and cannot approve a
  claimed winning settlement outside the flight window.

## Validation

Run `npm run test:fairness` and `npm run build` at repository root. Tests use real
handler and RoundDO code with simulated storage, clocks, RPC and ticket purchases.
They never use a real key, contact the live game or send transactions.

The suite covers early-result leakage, invalid numeric input, post-crash claims,
slow uploads, wrong recipients/rounds, inflated client stakes, restart/retry
behavior, concurrent requests, auto targets, anchoring, chain exhaustion, external
entropy checks and refund deadlock prevention. This is not a production load test
or an independent security audit.

## Release considerations

Deploy during a controlled break between rounds. A manual request arriving after
the crash is now rejected even if the browser previously displayed a successful
click; clients should use server confirmations and pre-registered auto-cashout.
The five-block offset also adds a longer wait between betting and flight.

Existing anchored chains retain their identity and index. Legacy index-zero rounds
already in flight are not retroactively secured; finish/void them before rollout.
Reaching the end of a chain closes new betting and requires explicit rotation.

## Remaining trust and engineering work

The server and anyone with access to the chain terminal can know the crash point
after the target block appears. The API hiding that block does not make the block
private. Secrets and the transaction signer still share a Worker trust boundary.

The anchor binds a sequence of seeds. It does not independently timestamp every
round's block selection, rule version, betting deadline, entry list or cashout
order. Before claiming stronger operator-independent fairness, implement public
per-round commitments and an independently verifiable record of every completion,
void and rotation. Suppression or selective aborts need enforceable economic and
settlement rules, not just logs or refunds.

The bank and ticket-delivery subsystems still require a separate security pass:
wallet authentication, atomic accounting instead of KV read/modify/write, receipt
retention, durable fulfillment recovery, and end-to-end on-chain idempotency.
These tests mock ticket purchasing and do not certify those guarantees.

## SPRIBE comparison

[SPRIBE's public explanation](https://spribe.co/provably-fair) describes publishing
a hashed server seed before the round, combining it with player-generated client
seeds using SHA-512, and exposing seeds, hash and result for verification afterward.
Its settings expose the next server seed's SHA-256 commitment and allow changing
the client seed. This is a provider-level explanation, not a full specification of
Aviator's backend, player-selection rules, or hash-to-multiplier calculation.

MegaPush can independently implement these public cryptographic principles.
Changing SHA-256 to SHA-512 alone does not fix secrecy, timing or operator control.
Adding player seeds requires a fixed, auditable inclusion/order rule and a policy
for absent players; it should preserve independent external entropy. The current
patch intentionally retains the published MegaPush formula. No SPRIBE code,
assets, branding or undocumented multiplier formula has been copied.
