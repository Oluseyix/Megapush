# How MegaPush Makes Money

Most gambling products have one revenue line: your losses. MegaPush has two, and the bigger one only pays when you win.

## The two lines

**The house edge.** Roughly 1 round in 33 crashes instantly at 1.00x. Those stakes stay with the house. This is money we make when you lose.

**The referral fee.** Megapot pays us a referral fee on every ticket bought through MegaPush. This is money we make when you _bank_. A busted round earns us nothing here at all.

## The numbers

Per $100 staked, at our 3% edge:

|                                     |              |
| ----------------------------------- | ------------ |
| Kept from busted rounds             | $3.00        |
| Referral on \~$97 of tickets bought | \~$9.70      |
| **Total**                           | **\~$12.70** |

{% hint style="info" %}
**We earn roughly three times more when you win than when you lose.**
{% endhint %}

That's why we run 97% RTP rather than squeezing the edge. Pushing it to 10% would add a few dollars per hundred staked and cost us players to competitors running 97%, a bad trade when the referral line is doing most of the work.

## What you pay

|                      |                                  |
| -------------------- | -------------------------------- |
| Deposit fee          | None                             |
| Withdrawal fee       | None (you pay Base gas)          |
| House edge           | 3%                               |
| Cut of your tickets  | None                             |
| Cut of your winnings | None                             |
| Cut of your change   | None, it becomes ticket progress |
| Ticket price         | $1, same as everywhere           |

The referral fee comes out of Megapot's own fee structure. It doesn't raise your ticket price and it doesn't reduce your prize.

## Verifying the edge

You don't have to take 3% on faith. The edge is entirely contained in the `n % 33` branch of the [crash derivation](file:///8667273/playing/the-crash-curve.md). There are no other adjustments in the system. Sample enough published seeds and you can measure it directly.

If the observed rate doesn't match, that's a serious finding and we want to hear about it. [Security](file:///8667273/appendix/security.md)
