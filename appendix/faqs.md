# FAQs

<details>

<summary>Is MegaPush run by Megapot?</summary>

No. MegaPush is an independent application built on the Megapot protocol. Megapot doesn't operate or endorse it. [More on the relationship](../learn/megapush-and-megapot.md)

</details>

<details>

<summary>Can I cash out to USDC instead of tickets?</summary>

No. Anything staked returns as tickets only. Your unstaked deposit balance can be withdrawn as USDC at any time. [The full rule](../playing/deposits-and-withdrawals.md)

</details>

<details>

<summary>What happens to the change if I bank at 3.47x?</summary>

On a $10 stake that's $34.70, so you get 34 tickets, and $0.70 goes to your ticket progress. When progress reaches $1.00 it becomes another free ticket. Nothing is kept by the house.

</details>

<details>

<summary>Why can't I get half a ticket?</summary>

Megapot tickets cost exactly $1 and can't be split. That's a property of the protocol, not a MegaPush choice, which is why we use the progress meter instead.

</details>

<details>

<summary>Where do my tickets go?</summary>

Directly to your own wallet, the moment you bank. MegaPush never holds them.

</details>

<details>

<summary>Do I need MegaPush to claim my winnings?</summary>

No. Your tickets live in your own wallet on the Megapot contract, so you can claim from MegaPush, from megapot.io, or straight from Basescan. Same for your unstaked balance: the escrow's `withdraw()` is yours to call. [How claiming works](../playing/tickets-and-claiming.md)

</details>

<details>

<summary>Is the crash point decided before I bet?</summary>

It's locked before you bet, but nobody can read it yet. We publish a hash of the round's seed and a future Base block number before betting closes. Both feed the result, and since that block isn't mined yet, the outcome can't be computed by anyone. Nothing during the round can change it either. [Verify a round](../playing/provably-fair.md)

</details>

<details>

<summary>Can MegaPush see the crash point during the round?</summary>

No. The crash point derives partly from a Base block that hasn't been mined when betting opens, so it's unknowable to us at the moment you stake. We publish the block number in advance and reveal its hash afterwards, so you can check. [How it works](../playing/provably-fair.md)

</details>

<details>

<summary>Does my stake size affect when the round crashes?</summary>

No. The crash point is fixed before betting opens and doesn't depend on stakes, players, or history.

</details>

<details>

<summary>Is there a strategy?</summary>

No. Every multiplier has a fixed probability and no banking pattern changes the expected result. [Why](../learn/odds-and-payouts.md)

</details>

<details>

<summary>The multiplier crashed at 1.00x. Is that a bug?</summary>

No. About 1 round in 33 crashes immediately. That's the 3% house edge and it happens to everyone, including us. [How the curve works](../playing/the-crash-curve.md)

</details>

<details>

<summary>What's your RTP?</summary>

97%, the crash-game standard. And unlike most operators, you can verify it: the formula is public and every seed is revealed. [Check it yourself](../playing/provably-fair.md)

</details>

<details>

<summary>How does this compare to buying tickets directly?</summary>

Buying direct gets you a fixed number of tickets. MegaPush trades that certainty for upside. A good round turns $5 into far more entries than $5 would ever buy. [The numbers](../learn/odds-and-payouts.md)

</details>

<details>

<summary>Can I raise my stake limit?</summary>

No. The caps are the same for everyone and can't be raised on request.

</details>

<details>

<summary>What's the maximum I can win in one round?</summary>

`[MAXWIN]` tickets. It's shown in the stake panel before you commit and live during the round, so you'll never discover it after banking. We raise it as the bankroll grows. [Why it exists](../learn/limits-and-exposure.md)

</details>

<details>

<summary>How long does a withdrawal take?</summary>

Five minutes from when you request it, then the funds are yours to pull. The delay lets rounds still in flight settle cleanly. [Details](../playing/deposits-and-withdrawals.md)

</details>

<details>

<summary>Which drawing do my tickets enter?</summary>

Whichever Megapot drawing is open when you bank. If a round settles after the cutoff they roll to the next one. They're never lost.

</details>

<details>

<summary>Do I need to verify my identity?</summary>

Not to sign up, and not to deposit under $3,000 in total. Above that, MegaPush asks for a one-time identity check, matching the threshold our ticket provider applies. [Details](../playing/deposits-and-withdrawals.md)

Separately, Megapot may require their own verification for large prize claims through their app. That one is between you and them. [More](../playing/tickets-and-claiming.md)

</details>

<details>

<summary>Is MegaPush available in my country?</summary>

`[JURISDICTION LIST]` See [Terms of service](terms-of-service.md).

</details>

<details>

<summary>I think something is wrong with a round.</summary>

Verify it first: [here's how](../playing/provably-fair.md). If the check fails, contact us immediately at `[SECURITY EMAIL]`.

</details>
