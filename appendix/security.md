# Security

## How your funds are held

**Unstaked balance.** Held in the MegaPush escrow contract on Base. Withdrawable by you via `requestWithdraw()` then `withdraw()`, without our cooperation, after the five-minute challenge window.

**Tickets and winnings.** Not held by MegaPush at all. Tickets are purchased directly to your wallet address; winnings are claimed by you from the Megapot contract.

{% hint style="warning" %}
**The most a MegaPush compromise can cost you is your unstaked balance.**
{% endhint %}

## No insider play

Nobody with access to round seeds is permitted to stake on MegaPush: not the team, not contractors, not friends or family.

Once the target Base block is available, the server can combine it with its secret seed to compute the crash point during flight. A saved commitment lets players detect a changed seed; it cannot prove nobody learned the outcome early. We consider insider play a serious breach. [More detail](../playing/provably-fair.md)

## Key separation

MegaPush uses separate fairness material and payment credentials:

| Secret              | Role                                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Chain `terminal`    | Random 32-byte secret in RoundDO storage from which future seeds are derived.                            |
| `ROUND_SECRET`      | Required runtime configuration gate. It is not the source of seeds in the current hash-chain engine.     |
| `HOUSE_PRIVATE_KEY` | Signs ticket purchases and house USDC outflows.                                                          |

The fairness seed is **not derived from the house key**. They serve separate purposes, but both are currently accessible to the Worker deployment. A compromise of that runtime can expose both; independent secret generation is not operational isolation.

## Known risk, stated plainly

{% hint style="info" %}
**Testnet status.** MegaPush currently runs on Base Sepolia. Testnet tickets have no value.
{% endhint %}

## Reporting a vulnerability

Email `[SECURITY EMAIL]`. Please include reproduction steps and give us reasonable time to respond before disclosing publicly.

We are particularly interested in: anything affecting crash-point predictability, anything allowing withdrawal of another user's balance, anything causing the fairness commitment to be bypassable, and any discrepancy between the published house edge and observed round outcomes.

## What we will never ask you for

Your seed phrase, your private key, or a signature on a transaction you did not initiate. Nobody from MegaPush will ever DM you first.
