# Deposits and Withdrawals

## The rule

> **Money you haven't staked, you can withdraw. Anything that goes through a round comes back as tickets.**

MegaPush never pays out cash from gameplay. Deposit $50, stake $20, and $30 stays withdrawable, permanently. The $20 can only return to you as tickets, either directly or through [ticket progress](tickets-and-claiming.md).

This is deliberate. MegaPush is a way to acquire lottery entries, not a casino that pays out money. [Why](file:///8667273/start-here/why-megapush-exists.md)

## Depositing

Send USDC on Base to the MegaPush escrow. It becomes your play balance immediately.

* Daily deposit cap: `[MAXDEP]`, or lower if you've set your own limit
* No deposit fee
* You can't deposit while a withdrawal is pending

## Identity verification

Deposits are unverified up to **$3,000 in total**. Past that, MegaPush asks you to verify your identity before depositing further.

This matches the threshold our ticket provider applies, and it's a one-time check. Your existing balance, your tickets, and any winnings are unaffected while you complete it, and you can still withdraw and still claim.

Nothing is required to sign up, and nothing is required to deposit below the threshold.

You'll see the tickets-only rule stated on the deposit screen before funds move. It's not buried in the terms, because it's the thing you most need to know before depositing.

## Withdrawing

{% stepper %}
{% step %}
### `requestWithdraw()`

You signal that you want out. Deposits are blocked until the withdrawal resolves.
{% endstep %}

{% step %}
### Wait five minutes

This challenge window lets any rounds still in flight settle cleanly before funds move. It stops someone staking, seeing the round go badly, and pulling their balance before settlement.
{% endstep %}

{% step %}
### `withdraw()`

After `unlockTime` passes, you pull your withdrawable balance to your own wallet.

{% hint style="success" %}
**This doesn't require MegaPush to cooperate.** You call the contract directly. If our servers are down, if the team disappears, if the website never loads again, your funds still come out. This is the single most important property of the escrow design.
{% endhint %}
{% endstep %}
{% endstepper %}

## Cancelling a withdrawal

Changed your mind during the five minutes? Use the contract's cancel path, or simply wait it out and withdraw.

## What about my tickets?

Tickets aren't in the escrow. They were bought to your own wallet the moment you banked, and nothing you do with your play balance affects them. [More on claiming](tickets-and-claiming.md)
