# How MegaPush Works

Ten dollars buys you ten Megapot tickets. Anywhere. Always.

MegaPush makes that ten dollars the _starting_ number instead of the final one.

## The loop

{% stepper %}
{% step %}
### Deposit USDC

Funds go into your play balance, held in an escrow contract on Base. Anything you haven't staked, you can withdraw at any time without our permission.
{% endstep %}

{% step %}
### Stake into a round

Everyone plays the same synchronised round. A betting window opens, everyone stakes, then the round flies. Minimum stake is $1.
{% endstep %}

{% step %}
### Watch the multiplier climb

It starts at 1.00x and accelerates. At some point, decided before the round began and cryptographically committed to, it crashes.
{% endstep %}

{% step %}
### Bank, or bust

Under the multiplier, a live ticket count shows what you'd receive right now. Bank at 3.4x on a $10 stake and the button reads _Bank 34 tickets_. Get caught by the crash and your stake is gone.
{% endstep %}

{% step %}
### Your tickets enter today's drawing

They land in your own wallet and play in the same Megapot drawing as everyone else's.
{% endstep %}
{% endstepper %}

## Tickets, not cash

{% hint style="info" %}
**Money you haven't staked, you can withdraw. Anything that goes through a round comes back as tickets.**
{% endhint %}

Deposit $50 and stake $20, and the other $30 stays withdrawable. Sub-dollar remainders accumulate as [ticket progress](file:///8667273/playing/tickets-and-claiming.md) and convert into free tickets.

## What MegaPush controls, and what it doesn't

|                         | Controlled by                                        |
| ----------------------- | ---------------------------------------------------- |
| The crash point         | MegaPush, committed in advance and verifiable by you |
| Your play balance       | An escrow contract you can exit unilaterally         |
| Ticket ownership        | You. Tickets are bought to your address              |
| Drawing odds and prizes | Megapot                                              |
| Your winnings           | You. Claimed from the Megapot contract               |

## What it costs

A 3% house edge on the game, giving 97% RTP, the crash-game standard. No deposit fee, no withdrawal fee, no cut of your tickets, no cut of your winnings.

Megapot also pays us a referral fee on tickets you bank. That comes out of their fee structure, not your pocket, so you pay the same $1 per ticket you'd pay anywhere.

[How MegaPush makes money](file:///8667273/learn/how-megapush-makes-money.md)
