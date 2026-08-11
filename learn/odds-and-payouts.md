# Odds and Payouts

Everything you need to work out what a stake is worth.

## The crash game

|                         |                    |
| ----------------------- | ------------------ |
| House edge              | **3%**             |
| RTP                     | **97%**            |
| Minimum multiplier      | 1.00x              |
| Maximum multiplier      | 10,000x            |
| Minimum stake           | `[MINSTAKE]`       |
| Maximum stake per round | `[MAXSTAKE]`       |
| Maximum win per round   | `[MAXWIN]` tickets |

97% is the crash-game standard. We don't go below it, and we don't need to, because most of our revenue comes from Megapot referral fees rather than your losses. [How that works](how-megapush-makes-money.md)

## Chance of reaching a multiplier

At 97% RTP, the probability of a round reaching any given multiple is roughly `0.97 ÷ N`:

| Reach | Chance |
| ----- | ------ |
| 1.5x  | \~65%  |
| 2x    | \~49%  |
| 3x    | \~32%  |
| 5x    | \~19%  |
| 10x   | \~10%  |
| 50x   | \~2%   |

## What doesn't affect the crash point

Your stake size. Your win history. How long you've played. How many players are in the round. Whether you're up or down.

The seed is fixed and its hash published before betting opens. Nothing that happens during a round can move it.

## The drawing

Once you hold tickets, MegaPush is out of the picture. Your odds are Megapot's odds, published in full in [their documentation](https://docs.megapot.io/getting-started/how-to-play/prize-structure).

The headline numbers:

* **1 in 4 tickets wins something**, good odds by lottery standards
* 10 prize tiers, from free tickets up to the jackpot
* Jackpot requires 5 numbers plus the bonusball
* Prizes claimable instantly, direct to your wallet

The jackpot tier often goes unclaimed and rolls forward, which is why the pool stays large.

[Why the caps exist](limits-and-exposure.md) · [Play responsibly](file:///8667273/appendix/responsible-gaming.md)
