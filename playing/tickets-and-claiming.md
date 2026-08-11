# Tickets and Claiming

## What you receive

Bank at 3.4x on a $10 stake and you get **34 tickets**. Your stake times the multiplier, rounded down to whole tickets.

Megapot tickets cost exactly $1 and can't be split, so MegaPush never issues fractions. The number on the bank button is the number that arrives in your wallet.

## Change becomes ticket progress

Cashouts rarely land on whole dollars. Bank at 3.47x on $10 and you've earned $34.70, which is 34 tickets and 70 cents left over.

That 70 cents goes to your **ticket progress**, shown as a meter in the interface:

> Ticket progress: **$0.70**, 30¢ to your next free ticket

Accumulate $1.00 across rounds and it converts to a free ticket, bought to your wallet like any other. The meter then resets to whatever's left.

**We never keep the change.** It's your value, and it stays in the only unit MegaPush deals in. If you close your account or self-exclude with progress outstanding, we round it up to a free ticket.

{% hint style="info" %}
The remainder is always under $1, whatever you stake. At $1 it's noticeable; at $50 it's a rounding crumb. Nothing scales with your stake size.
{% endhint %}

## The tickets go to your wallet, not ours

When you bank, MegaPush calls Megapot's `purchaseTickets` function with two separate addresses:

* **recipient**: your wallet. The tickets belong to you the moment they're bought.
* **referrer**: the MegaPush wallet. This is how we get paid. It costs you nothing.

We pay the USDC. You own the entry. There's no intermediate step where MegaPush holds your tickets.

## Which drawing you enter

Megapot draws once per day. Your tickets enter **the drawing that's open at the moment you bank.**

If you bank shortly before a drawing closes, MegaPush shows a countdown. If a round settles after the cutoff, your tickets enter the next drawing. They're never lost, only delayed.

## Claiming winnings

Because your tickets are in your own wallet, your winnings are yours to claim directly from the Megapot contract. MegaPush isn't involved and can't block, delay, or take a cut.

Three ways, all doing exactly the same thing:

{% stepper %}
{% step %}
## On MegaPush

Connect your wallet and tap Claim. We just call `withdrawWinnings` for you.
{% endstep %}

{% step %}
## On megapot.io

Same button, someone else's website.
{% endstep %}

{% step %}
## Directly on Basescan

Call `withdrawWinnings` on the contract yourself. No website needed.
{% endstep %}
{% endstepper %}

{% hint style="success" %}
**If MegaPush shuts down tomorrow, you lose nothing.** Your tickets, your entries, and your winnings all live on the Megapot contract under your own address. Options 2 and 3 still work.
{% endhint %}

To check whether you've won without connecting anywhere, read `usersInfo(yourAddress)` on the Megapot contract and look at `winningsClaimable`.

## Verification on large prizes

Megapot is a licensed gaming operator and their compliance policy requires identity verification for large transactions through their app.

That check is between you and Megapot. MegaPush isn't part of it, can't complete it for you, and can't bypass it. Claiming through the contract directly is also available, as described above.

[How the crash curve works](the-crash-curve.md)
