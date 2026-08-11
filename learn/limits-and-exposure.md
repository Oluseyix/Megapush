# Limits and Exposure

## Player limits

| Limit                   | Value                    |
| ----------------------- | ------------------------ |
| Minimum stake           | $1                       |
| Maximum stake per round | `[MAXSTAKE]`             |
| Maximum win per round   | `[MAXWIN]` tickets       |
| Maximum deposit per day | `[MAXDEP]`               |
| Daily loss limit        | Set your own in Settings |

{% hint style="info" %}
**These caps can't be raised on request.** There's no VIP tier, no high-roller table, and no support ticket that unlocks bigger stakes.
{% endhint %}

## Maximum win

The single biggest payout any round can produce is `[MAXWIN]` tickets. If your multiplier would pay more than that, you receive the cap.

It's displayed in the stake panel before you commit and shown live during the round, and the counter greys out when you reach it. **You will never discover this cap after banking.**

Why it exists: the curve permits multipliers up to 10,000x, and without a ceiling a single extreme round could exhaust the house wallet and leave other players in that same round unable to be paid. The cap makes our maximum liability per round finite and known.

We raise it as the bankroll grows, and we announce it when we do.

## Round exposure

MegaPush also tracks total potential payout across everyone staked in a round. If it would exceed what the house wallet can cover, the betting window closes early and the interface says so plainly. Stakes already placed are honoured in full.

## What we never do

* **We never adjust the crash point for exposure.** The seed is committed before betting opens and can't be changed. If exposure is a problem we close the window. We never move the crash.
* We never adjust anything based on who you are, how much you've won, or how long you've played.
* We never restrict withdrawals for winning players.

[Provably fair](file:///8667273/playing/provably-fair.md)
