# The Crash Curve

## How the multiplier moves

The multiplier starts at 1.00x and rises on a continuous exponential curve: early gains slow, later gains accelerating. The curve is identical every round. Only the stopping point changes.

## Where the crash point comes from

Before betting opens, the server publishes two things: the SHA-256 hash of a secret seed, and the number of a future Base block. The crash point derives from both, so it's fixed before anyone stakes and unknowable to anyone until that block is mined.

The derivation is the standard Bustabit method:

```
n = first 52 bits of sha256(serverSeed + blockHash)

if n mod 33 == 0:
    crash = 1.00
else:
    crash = floor( (100 * 2^52 - n) / (2^52 - n) ) / 100

crash is clamped between 1.00x and 10,000x
```

The `n mod 33 == 0` branch is the house edge. Roughly 1 round in 33 crashes instantly at 1.00x and everyone staked in it loses. That single line is the entire mechanism by which MegaPush earns from the game. There are no other adjustments anywhere in the system.

That works out to a **3% edge, or 97% RTP**, the crash-game standard.

{% hint style="info" %}
An instant bust at 1.00x is normal, expected, and happens to everyone. It isn't a sign that something is wrong.
{% endhint %}

## Roughly what to expect

At 97% RTP, the chance of a round reaching any given multiple is about `0.97 ÷ N`:

| Reach | Roughly |
| ----- | ------- |
| 2x    | \~49%   |
| 3x    | \~32%   |
| 5x    | \~19%   |
| 10x   | \~10%   |

## What this implies

**The crash point doesn't depend on you.** Not on your stake, your history, whether you're up or down, or how many people are in the round. It was fixed before you clicked anything.

**There's no strategy.** Every multiplier has a fixed probability. Banking at 1.2x every round and at 50x every round produce very different-looking sessions and the same long-run result. Martingale doesn't work here and empties a balance faster.

**Past rounds tell you nothing.** Ten bad rounds don't make the eleventh more likely to fly. Each seed is independent.

## Limits

|                       |                    |
| --------------------- | ------------------ |
| Minimum multiplier    | 1.00x              |
| Maximum multiplier    | 10,000x            |
| Maximum win per round | `[MAXWIN]` tickets |

The max win cap is shown in the interface before you stake and displayed live during the round. You'll never discover it after banking. [Why it exists](file:///8667273/learn/limits-and-exposure.md)

[Verify a round yourself](provably-fair.md)
