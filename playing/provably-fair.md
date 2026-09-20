# Provably Fair

Every round publishes a seed commitment and a target Base block. After the crash, you can recompute the result and check it against the commitment you saved before playing. This proves consistency of the disclosed inputs; it does not eliminate trust in the operator.

## The idea in one paragraph

Before betting opens, the server selects the next secret seed and publishes its SHA-256 hash, along with the number of a **future Base block**. The crash point derives from both. When the target block is available, the server can calculate the outcome. After the crash it reveals the seed so players can recompute the result.

The commitment lets you detect a changed seed. The future block contributes external data, but the server knows the result during flight. A block hash is not a guarantee against a compromised operator or block producer.

## Verifying a round

{% stepper %}
{% step %}
## Grab the data

After a round settles, the round history contains:

| Field            | What it is                                             |
| ---------------- | ------------------------------------------------------ |
| `serverSeedHash` | The commitment, published before betting closed        |
| `targetBlock`    | The Base block number, published before betting closed |
| `serverSeed`     | The reveal, published after the crash                  |
| `blockHash`      | The hash of `targetBlock`                              |
| `crashMult`      | The crash point that was displayed                     |
{% endstep %}

{% step %}
## Check the commitment

```
sha256(serverSeed) == serverSeedHash
```

If this fails, the seed we revealed isn't the seed we committed to. Tell everyone.
{% endstep %}

{% step %}
## Check the block

Look up `targetBlock` on [Basescan](https://basescan.org/) and confirm `blockHash` matches. Confirm too that the block was mined _after_ the round's commitment was published. The round history links straight to it.
{% endstep %}

{% step %}
## Recompute the crash point

```
h = sha256(serverSeed + blockHash)
n = int(h[0:13], 16)              # first 52 bits

if n % 33 == 0:
    crash = 1.00
else:
    crash = floor((100 * 2**52 - n) / (2**52 - n)) / 100
    crash = min(10000, max(1, round(crash, 2)))
```
{% endstep %}

{% step %}
## Compare

Compare to `crashMult`, allowing about 0.015 for floating-point rounding.
{% endstep %}
{% endstepper %}

## The seed chain

Round seeds aren't generated one at a time. They were pre-generated in reverse before launch, each one hashing to the one before it:

```
seed[i] = sha256(seed[i+1])
```

The head is anchored in a public Base transaction. Get the current head and transaction from `/api/round?chain=1` and check it independently. The public head is never used as a playable seed; play starts with its secret preimage at index one.

Every revealed seed can be hashed forward to reach the anchor. This lets you detect replacement of the committed sequence. New rounds stay closed when anchoring fails or the sequence runs out. Rotation requires an explicit new anchor. The anchor alone does not prove correct selection of each round's target block or fair cashout handling.

To check: take any revealed seed, hash it repeatedly, and confirm you arrive at the published head.

## The shortcut

```bash
curl -sS -X POST "https://megapush.xnoxseyi.workers.dev/api/verify" \
  -H 'Content-Type: application/json' \
  -d '{"serverSeed":"...","serverSeedHash":"...","targetBlock":...,"blockHash":"...","crashMult":2.58}'
```

You get back four separate results, not one verdict:

| Field      | What it confirms                             |
| ---------- | -------------------------------------------- |
| `commitOk` | The seed matches the published hash          |
| `blockOk`  | The block hash matches the real Base block   |
| `crashOk`  | The crash point recomputes correctly         |
| `chainOk`  | The seed chains to the previous round's seed |

They're reported separately so you can see exactly which property held.

{% hint style="info" %}
**Verify the verifier.** An endpoint we run, telling you our own rounds are fair, proves nothing by itself. The point of publishing the algorithm above is that you can check without us. Do it at least once.
{% endhint %}

## When a block is unavailable

If the target block cannot be read within 40 seconds after betting closes, or its timestamp is not after that deadline, the round is **voided and its stakes returned.**

We don't fall back to deriving from the seed alone, and we don't substitute a different block. Either would hand us back the ability to know the outcome in advance, which is the whole thing this design exists to prevent. A voided round is an inconvenience. An unverifiable one isn't acceptable.

## Checking the house edge yourself

The 3% edge lives entirely in the `n % 33` branch. Collect revealed rounds across a few thousand results, count how many satisfy `n % 33 == 0`, and confirm the rate. If it doesn't match, that's a serious finding and we want to hear about it.

## Two secrets, two jobs

The seed that determines crash points is **not** the key that signs ticket purchases and moves USDC. Separate secrets, separate roles.

If the fairness seed were derived from the house wallet key, compromising one would give an attacker both. It isn't, and it never will be.

## One policy, kept anyway

Nobody with access to round seeds may stake on MegaPush. Not the team, not contractors, not friends or family.

Once the target block is available, anyone with the secret seed can calculate the crash point. Preventing insider access and play is therefore essential. Cryptographic verification after a round cannot prove that its seed was kept secret beforehand.

## Checking your bank

Manual cashout must reach the server in full before the crash. The server records an immutable settlement receipt for that entry; retries recover the same receipt. A client timestamp cannot establish an earlier click. Auto-cashout targets are recorded with the bet and remain eligible if their target was reached before the crash, even when processing is delayed.

Pass `flyStart`, `cashoutAt` and `expectedSettlementMult` to the verifier to check the curve calculation at the recorded time. This checks the arithmetic, not independent proof of network arrival time.

[Deposits and withdrawals](deposits-and-withdrawals.md)
