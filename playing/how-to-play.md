# How To Play

## What you need

* A wallet on **Base** (if you don't have one, MegaPush will create one when you sign in with email)
* Some **USDC** on Base
* Nothing else. No account approval, no waiting period.

## Your first round

{% stepper %}
{% step %}
### Deposit

Choose an amount and approve the transaction. Your USDC moves into the MegaPush escrow and shows up as your play balance. Start small. There's no reason to reach the daily cap on day one.
{% endstep %}

{% step %}
### Wait for the betting window

Every player is in the same round. When the window is open you can stake; when it closes, the round flies.
{% endstep %}

{% step %}
### Place your stake

Minimum $1, maximum `[MAXSTAKE]` per round.
{% endstep %}

{% step %}
### Set an auto-bank

Pick a target multiplier in advance and MegaPush banks you automatically when it's reached. This is the recommended way to play. It removes the split-second decision, and because it's evaluated on our server, your connection speed can't cost you anything.
{% endstep %}

{% step %}
### Watch the two numbers

The multiplier climbs continuously. Beneath it, a live ticket count shows what you'd get right now:

```
3.47x
= 34 tickets
```

The ticket count only moves in whole tickets, because Megapot tickets can't be split.
{% endstep %}

{% step %}
### Bank

The button reads the ticket count, not the multiplier: _Bank 34 tickets_. Tap it and that exact number is bought to your wallet.
{% endstep %}
{% endstepper %}

## A note on latency

If you bank manually, your instruction has to reach the server, and if the round crashes while your tap is in flight, the crash wins. This is true of every crash game and there's no way around it.

Auto-bank is evaluated server-side and is unaffected by your connection. **Use it.**

## Reading the interface

| Element         | What it means                                                  |
| --------------- | -------------------------------------------------------------- |
| Multiplier      | Current payout multiple, climbing live                         |
| Ticket count    | What you'd receive if you banked now                           |
| Ticket progress | Sub-dollar change accumulating toward a free ticket            |
| Round players   | Everyone staked into this round                                |
| Banked          | Who has already left, and at what multiple                     |
| Commit hash     | The hash of this round's seed, published before betting closed |
| Max win         | The most any single player can take from one round             |

The commit hash is the important one. [Here's what to do with it](provably-fair.md)
