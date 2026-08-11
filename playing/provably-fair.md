# Provably Fair

Nobody knows where a round will crash before it starts. Not you, and not MegaPush. You can prove that yourself, after every round.

## The idea in one paragraph

Before betting opens, the server picks a secret seed and publishes its SHA-256 hash, along with the number of a **future Base block** that hasn't been mined yet. The crash point derives from both. Since the block doesn't exist when the commitment goes out, nobody can compute the result during betting, including us. When the round settles we reveal the seed and the block hash, and you can recompute everything.

The commitment stops us changing the outcome. The future block stops us knowing it.

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

The head of that chain is anchored in a public Base transaction: `[CHAIN_HEAD_TX]`.

So every revealed seed can be hashed forward to reach the anchor. That proves the entire sequence was fixed before the first round was ever played. We can't regenerate a seed mid-stream, and we can't swap in a different chain, because the anchor is on-chain and timestamped.

To check: take any revealed seed, hash it repeatedly, and confirm you arrive at the published head.

## The shortcut

```bash
curl -sS -X POST "https://megapush.vercel.app/api/verify" \
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

If the target block can't be read at settlement, the round is **voided and every stake returned.**

We don't fall back to deriving from the seed alone, and we don't substitute a different block. Either would hand us back the ability to know the outcome in advance, which is the whole thing this design exists to prevent. A voided round is an inconvenience. An unverifiable one isn't acceptable.

## Checking the house edge yourself

The 3% edge lives entirely in the `n % 33` branch. Collect revealed rounds across a few thousand results, count how many satisfy `n % 33 == 0`, and confirm the rate. If it doesn't match, that's a serious finding and we want to hear about it.

## Two secrets, two jobs

The seed that determines crash points is **not** the key that signs ticket purchases and moves USDC. Separate secrets, separate roles.

If the fairness seed were derived from the house wallet key, compromising one would give an attacker both. It isn't, and it never will be.

## One policy, kept anyway

Nobody with access to round seeds may stake on MegaPush. Not the team, not contractors, not friends or family.

The block-hash design already makes seed access useless for predicting outcomes, so this is belt and braces rather than a load-bearing safeguard. We keep it because it costs nothing and it's good practice.

## Checking your bank

Pass `flyStart`, `cashoutAt` and `expectedSettlementMult` to the verify endpoint and it confirms the multiplier you were paid sits on the same curve at the moment your instruction reached the server. That's how you check a bank wasn't quietly shaved.

[Deposits and withdrawals](deposits-and-withdrawals.md)
