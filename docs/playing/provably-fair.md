# Provably fair — MegaPush

MegaPush uses **commit–reveal**, a **reverse hash chain** of server seeds, and a **future Base block hash**. A saved pre-round commitment lets a player check the later reveal. This design still trusts the operator's runtime, the RPC data, and Base's block production. Once the target block is available, the server can calculate the crash point, including during flight.

Origin: `https://megapush.xnoxseyi.workers.dev`  
Network: Base Sepolia

---

## What you see during a hand

| Phase | Public | Hidden |
|--------|--------|--------|
| **Betting** | `serverSeedHash`, `targetBlock`, chain head / anchor | `serverSeed`, `blockHash`, crash mult |
| **Waiting** (for target block) | same as betting; window closed | same |
| **Flying** | live mult on the shared curve; target block hash is independently readable on Base | seed, crash mult / crash time |
| **After crash** | full reveal: seed, block hash, crash mult | — |

If the target block cannot be read within 40 seconds after betting ends, or its timestamp is not after the betting deadline, the hand is **voided** and stakes are returned. The server never substitutes another target or a server-only result.

Cashout responses never contain the secret seed, crash point, crash time, or block hash, including error responses.

---

## Crash derivation

After reveal, recompute as follows. Hex strings are **lowercase, without `0x`**, unless noted.

### 1. Commit

```text
sha256(serverSeed)  ===  serverSeedHash
```

`sha256` here is SHA-256 over the **UTF-8 bytes of the hex string** (same as the Worker and the in-game verifier).

### 2. Block hash

`blockHash` must equal the real Base Sepolia block hash at `targetBlock`:

- Basescan: `https://sepolia.basescan.org/block/<targetBlock>`
- Or `eth_getBlockByNumber`

### 3. Entropy + Bustabit crash

```text
material = sha256( lowercaseHex(serverSeed) || lowercaseHex(blockHash) )

n = int(material[0:13], 16)   // first 52 bits as hex
if n % 33 == 0:
  crash = 1.00
else:
  crash = floor( (100 * 2^52 - n) / (2^52 - n) ) / 100
  crash = min(10000, max(1, round(crash, 2)))
```

Confirm `crash` matches the published `crashMult` (allow about `0.015` float tolerance).  
Flight length is capped at the same curve limit the TV uses; settlement cashout mult is that curve at **server arrival time**.

**House edge flavor** is unchanged: the `n % 33 == 0` branch is an instant bust (~1/33). The 10,000× ceiling is unchanged.

### 4. Hash-chain link

Seeds are drawn from a reverse chain:

```text
terminal = seed[N]              // random; never revealed
seed[i]  = sha256(seed[i+1])    // i = N-1 … 0
head     = seed[0]
```

Rounds use `seed[1]`, then `seed[2]`, … through `seed[N-1]`, in order. `seed[0]` is the public commitment and is never a playable seed. This leaves `N-1` playable seeds. An existing unused index-zero chain is advanced to index one without changing its anchor.

- **Link:** `sha256(seed[i]) === seed[i-1]` (previous round’s seed, when `i > 0`)
- **Head:** hash `seed[i]` exactly **`i` times** → must equal the published **chain head**

Default `N` = **10000** (`SEED_CHAIN_LENGTH`). When the chain is exhausted, MegaPush **refuses to open rounds** and does **not** silently mint a new unanchored sequence.

---

## Chain head (on-chain anchor)

The chain head is published **once** on Base Sepolia before the first hand that uses the chain: a **0-value transaction** from the house wallet to `0x000000000000000000000000000000000000dEaD` whose **calldata** is `0x` + the 32-byte head. Betting stays closed if the anchor cannot be confirmed. Exhaustion also closes betting; rotation must be an explicit operator procedure with a new anchor.

### Live values

Query (no secrets in the response):

```bash
curl -sS 'https://megapush.xnoxseyi.workers.dev/api/round?chain=1'
```

| Field | Meaning |
|--------|---------|
| `chainHead` | `seed[0]` (64 hex chars) |
| `chainAnchorTx` | Transaction hash that published the head |
| `chainAnchorBlock` | Block number of that tx (if known) |
| `chainLength` | `N` |
| `chainNextIndex` / `chainRemaining` | Consumption progress |
| `basescanTx` | Explorer link for the anchor |

### Historical anchor example

> This is a historical testnet example, not verification of the current deployment. Retrieve the current head and transaction from the live status and independently check the transaction's calldata and receipt.

| | |
|--|--|
| **Chain head** | `7ff84bbe7bb771179e868b7dde3347750d4cc2aff5ea0e7e03be141080d09c34` |
| **Anchor tx** | `0x2b36f1b6a8f1f97d957c74b9c7ba487e8b9c802fd88e4c646a92b339e4f3815d` |
| **Basescan** | https://sepolia.basescan.org/tx/0x2b36f1b6a8f1f97d957c74b9c7ba487e8b9c802fd88e4c646a92b339e4f3815d |

Live status always: `GET https://megapush.xnoxseyi.workers.dev/api/round?chain=1`

Anyone can:

1. Read calldata of the anchor tx → 32-byte head  
2. From any revealed seed + `chainIndex`, hash `index` times → must match that head  

---

## How to verify (one call)

```bash
ORIGIN=https://megapush.xnoxseyi.workers.dev

curl -sS -X POST "$ORIGIN/api/verify" \
  -H 'Content-Type: application/json' \
  -d '{
    "serverSeed": "…",
    "serverSeedHash": "…",
    "crashMult": 2.58,
    "targetBlock": 12345678,
    "blockHash": "0x…",
    "chainPrevSeed": "…",
    "chainHead": "…",
    "chainIndex": 3
  }'
```

Response flags (each independent):

| Flag | Check |
|------|--------|
| `commitOk` | `sha256(serverSeed) == serverSeedHash` |
| `blockOk` | `blockHash` matches Base at `targetBlock` |
| `crashOk` | Bustabit on `sha256(serverSeed \|\| blockHash)` matches `crashMult` |
| `chainOk` | Link to previous seed and/or walk to `chainHead` |

The game UI runs the same checks automatically after every reveal (`verifyFairRound` + `POST /api/verify`). Round **History** shows seed, commit, `targetBlock` (Basescan), `blockHash`, chain index, head, and anchor tx.

Optional: pass `flyStart` + `cashoutAt` (+ `expectedSettlementMult`) to check that a cashout sits on the **same** exponential curve at server arrival time.

## Cashout timing and retries

A manual cashout is timed when its complete request body reaches the Worker. It must arrive strictly before `crashAt`. Client timestamps and claimed multipliers cannot backdate a request or choose its payout. A slow upload also cannot reserve an earlier time.

RoundDO binds the request to the registered entry, player, round and stake, and persists the first accepted settlement receipt before ticket fulfillment. A retry retrieves that same receipt even after the crash or a Worker restart; a new request after the crash loses. Receipts remain subject to the current entry/history retention limits.

Auto-cashout uses the target stored with the bet before flight. If that target was reached strictly before the crash, a delayed alarm can still settle it at the registered target. Manual cashout after that target also uses the registered auto result.

---

## Timing constants (fairness-relevant)

| Constant | Value | Role |
|----------|--------|------|
| Betting window | **5 s** | Max time bets are accepted for a hand |
| Target block offset | **5** Base blocks | ~10 s at ~2 s/block — longer than the betting window so the target cannot exist at commit time |
| Entropy wait max | **40 s** after betting ends | Then void + refund if the block is still missing |
| Client backdating grace | **0 s** | Only a stored receipt can recover an earlier accepted cashout |

---

## Policy: no staking with seed access

Anyone who can read live server seeds or the chain terminal **must not stake**. That includes operators, anyone with Worker/DO admin access, and anyone who could observe secrets in logs.

Once the target block exists, seed access reveals the outcome. Hiding a block hash from the API does not hide it from the blockchain. This is a real trust boundary, not something commit–reveal eliminates.

The chain anchor commits the seed sequence, not every round's deadline, target selection, or cashout ordering. Those currently live in the Worker/DO. A malicious operator could also suppress service or alter code. Independent per-round publication, stronger secret isolation, enforceable settlement, and an external security review remain production work. See [the hardening notes](../FAIRNESS-HARDENING.md).

---

## Secrets (operators)

| Secret | Role |
|--------|------|
| `ROUND_SECRET` | Required to run the round engine (≥16 chars). **Not** derived from the house key. Without it, betting stays closed. |
| Stored chain `terminal` | Random 32-byte source of future seeds, stored inside RoundDO. This is the live fairness secret; it is not derived from `ROUND_SECRET`. |
| `HOUSE_PRIVATE_KEY` | Ticket buys, bank USDC outflows, and **one-time** chain-head anchor tx. Separate from fairness material. |

Never commit `.dev.vars`, private keys, or the chain **terminal**.

---

## Related

- Deploy / verify recipes: repository root [`README.md`](../../README.md)
- Product hardening notes: [`docs/HARDENING.md`](../HARDENING.md)
- Play: `https://megapush.xnoxseyi.workers.dev/game`
