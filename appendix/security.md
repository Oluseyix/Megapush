# Security

## How your funds are held

**Unstaked balance.** Held in the MegaPush escrow contract on Base. Withdrawable by you via `requestWithdraw()` then `withdraw()`, without our cooperation, after the five-minute challenge window.

**Tickets and winnings.** Not held by MegaPush at all. Tickets are purchased directly to your wallet address; winnings are claimed by you from the Megapot contract.

{% hint style="warning" %}
**The most a MegaPush compromise can cost you is your unstaked balance.**
{% endhint %}

## No insider play

Nobody with access to round seeds is permitted to stake on MegaPush: not the team, not contractors, not friends or family.

This matters because the server generates the seed and can therefore compute the crash point during the betting window. The commitment stops us changing it; policy stops anyone acting on it. We consider a breach of this the most serious thing that could happen to the product, and we'd disclose it publicly. [More detail](../playing/provably-fair.md)

## Key separation

MegaPush uses two independent secrets:

| Secret              | Role                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `ROUND_SECRET`      | Fairness seed material. Determines crash points. The server refuses to open a betting window without it. |
| `HOUSE_PRIVATE_KEY` | Signs ticket purchases and house USDC outflows.                                                          |

The fairness seed is **not derived from the house key**. Compromising one does not give an attacker the other. Predicting crash points and moving funds are separate capabilities requiring separate breaches.

## Known risk, stated plainly

{% hint style="info" %}
**Testnet status.** MegaPush currently runs on Base Sepolia. Testnet tickets have no value.
{% endhint %}

## Reporting a vulnerability

Email `[SECURITY EMAIL]`. Please include reproduction steps and give us reasonable time to respond before disclosing publicly.

We are particularly interested in: anything affecting crash-point predictability, anything allowing withdrawal of another user's balance, anything causing the fairness commitment to be bypassable, and any discrepancy between the published house edge and observed round outcomes.

## What we will never ask you for

Your seed phrase, your private key, or a signature on a transaction you did not initiate. Nobody from MegaPush will ever DM you first.
