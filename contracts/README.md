# MegaPush Escrow (Base Sepolia)

Escrow-backed play bank. Real USDC locked in-contract; per-hand debits require EIP-712 player signatures.

## Contract: `MegaPushEscrow`

| Function | Who | Purpose |
|----------|-----|---------|
| `deposit(amount)` | Player | Lock USDC; credit `balanceOf[player]` |
| `settleBatch(intents[], sigs[])` | House | Debit signed hand intents; send USDC to house |
| `requestWithdraw()` | Player | Start 5m challenge window; blocks new deposits |
| `cancelWithdraw()` | Player | Cancel pending exit |
| `withdraw()` | Player | After delay, pull remaining balance |

### HandIntent (EIP-712)

```
HandIntent(address player, bytes32 entryId, uint256 amount, uint256 balanceNonce, uint256 deadline)
```

- `entryId` — unique per hand (consumed forever once settled)
- `balanceNonce` — must equal `balanceNonce[player]`, then increments
- House cannot debit without a valid player signature

### Base Sepolia USDC

`0x036CbD53842c5426634e7929541eC2318f3dCF7e`

## Commands

```bash
cd contracts
forge test -vv

# Deploy (set env first)
export PRIVATE_KEY=0x...
export HOUSE_ADDRESS=0x...
export BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
forge script script/DeployMegaPushEscrow.s.sol:DeployMegaPushEscrow \
  --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast
```

## Tests covered

- Deposit bounds + withdraw-pending blocks deposit  
- Signature forgery rejected  
- Nonce replay rejected  
- entryId replay rejected  
- Expired intent rejected  
- Overdraft rejected  
- Non-house `settleBatch` rejected  
- Withdraw before delay reverts  
- Settle during challenge window reduces withdrawable amount  
- Cancel withdraw re-enables deposit  
