# MegaPush and Megapot

MegaPush is built on Megapot. It is not run by Megapot, and Megapot does not endorse, operate, or take responsibility for it.

Understanding the boundary matters, because it determines who you're trusting with what.

## Two different things

[**Megapot**](https://megapot.io/) is a daily on-chain lottery on Base. The protocol is a set of smart contracts: permissionless, publicly verifiable, and open to anyone who wants to call them directly. The Megapot application at [megapot.io](https://megapot.io) is a licensed gaming operator with its own compliance obligations.

**MegaPush** is a third-party application built on the Megapot protocol. We buy real tickets from the same contracts you would buy from yourself.

## Who is responsible for what

|                              | MegaPush | Megapot            |
| ---------------------------- | -------- | ------------------ |
| The crash game               | Yes      | No                 |
| Your play balance and escrow | Yes      | No                 |
| Buying your tickets          | Yes      | No                 |
| Ticket price ($1)            | No       | Yes                |
| Drawing odds and prize tiers | No       | Yes                |
| Running the drawing          | No       | Yes                |
| Holding your tickets         | No       | You do             |
| Paying your winnings         | No       | Yes, direct to you |

Read across that table and the shape of the thing becomes clear: **MegaPush decides how many tickets you get. Megapot decides what those tickets are worth.**

## What this means if something goes wrong

{% hint style="warning" %}
**If MegaPush has a bug or maintenance:** your tickets and winnings are unaffected. They're on the Megapot contract under your address, so claim at megapot.io or on Basescan. Your unstaked balance comes out via the escrow's `withdraw()` path, which doesn't need us.
{% endhint %}

{% hint style="info" %}
**If Megapot changes its odds, fees, or prize structure:** MegaPush has no say. We'll update these docs, but the underlying terms are theirs.
{% endhint %}

{% hint style="info" %}
**If you have a question about a drawing result:** that's Megapot. We can't look up, verify, or influence drawing outcomes.
{% endhint %}

{% hint style="info" %}
**If you have a question about a crash round:** that's us, and you can verify it yourself. [Provably fair](../playing/provably-fair.md)
{% endhint %}

## Regulatory position

Megapot's own documentation draws a line between the permissionless protocol and applications built on it, and notes that those applications may carry their own compliance obligations. MegaPush takes that seriously.

Our position rests on three structural choices, not on legal wording:

{% stepper %}
{% step %}
### We never pay out cash from gameplay

Staked funds return only as tickets. There is no path from a round to withdrawable USDC.
{% endstep %}

{% step %}
### We never hold your tickets or winnings

Tickets are bought to your wallet; you claim from the contract yourself.
{% endstep %}

{% step %}
### We cap stakes and wins

We enforce deposit limits, loss limits and self-exclusion.
{% endstep %}
{% endstepper %}

Availability is restricted in some jurisdictions. See [Terms of service](file:///8667273/appendix/terms-of-service.md).
