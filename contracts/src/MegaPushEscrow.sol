// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "openzeppelin-contracts/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "openzeppelin-contracts/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "openzeppelin-contracts/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "openzeppelin-contracts/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "openzeppelin-contracts/contracts/utils/ReentrancyGuard.sol";

/**
 * @title MegaPushEscrow
 * @notice Escrow-backed play bank for MegaPush (Base Sepolia).
 *
 * Flow:
 *  - Player `deposit(amount)` — real USDC locked in this contract.
 *  - Per-hand debits via house `settleBatch(intents, sigs)` with EIP-712 player signatures.
 *  - Player `requestWithdraw()` → challenge window → `withdraw()` (no house coop).
 *
 * Guarantees:
 *  - House cannot debit without a valid player signature.
 *  - entryId and balanceNonce cannot be replayed.
 *  - Deposits blocked while a withdrawal is pending.
 *  - Withdraw amount is current balance after house settles outstanding hands.
 */
contract MegaPushEscrow is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Base Sepolia USDC (Circle). Constructor also accepts a mock for tests.
    address public constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    /// @dev EIP-712 type for a single hand debit intent.
    /// Player authorizes house to debit `amount` for unique `entryId`.
    bytes32 public constant HAND_INTENT_TYPEHASH = keccak256(
        "HandIntent(address player,bytes32 entryId,uint256 amount,uint256 balanceNonce,uint256 deadline)"
    );

    uint256 public constant WITHDRAW_DELAY = 1 hours;
    uint256 public immutable minDeposit;
    uint256 public immutable maxDeposit;

    IERC20 public immutable usdc;
    address public house;

    mapping(address => uint256) public balanceOf;
    /// @dev Next expected balanceNonce for player (must match intent.balanceNonce).
    mapping(address => uint256) public balanceNonce;
    /// @dev entryId already settled — prevents double debit of same hand.
    mapping(bytes32 => bool) public entryConsumed;

    struct WithdrawRequest {
        bool active;
        uint64 unlockTime;
    }

    mapping(address => WithdrawRequest) public withdrawRequest;

    event Deposited(address indexed player, uint256 amount, uint256 newBalance);
    event Settled(
        address indexed player,
        bytes32 indexed entryId,
        uint256 amount,
        uint256 balanceNonce,
        uint256 newBalance
    );
    event WithdrawRequested(address indexed player, uint64 unlockTime, uint256 balanceSnapshot);
    event WithdrawCancelled(address indexed player);
    event Withdrawn(address indexed player, uint256 amount);
    event HouseUpdated(address indexed previousHouse, address indexed newHouse);

    error ZeroAddress();
    error ZeroAmount();
    error AmountOutOfBounds();
    error WithdrawPending();
    error NoWithdrawPending();
    error WithdrawNotReady();
    error Unauthorized();
    error InvalidSignature();
    error IntentExpired();
    error BadBalanceNonce();
    error EntryAlreadyConsumed();
    error InsufficientBalance();
    error EmptyBatch();
    error LengthMismatch();

    modifier onlyHouse() {
        if (msg.sender != house) revert Unauthorized();
        _;
    }

    /**
     * @param usdc_ Token address (use BASE_SEPOLIA_USDC on Base Sepolia; mock in tests).
     * @param house_ Hot wallet that may settle batches.
     * @param minDeposit_ Min deposit (USDC 6 decimals).
     * @param maxDeposit_ Max deposit (USDC 6 decimals).
     */
    constructor(address usdc_, address house_, uint256 minDeposit_, uint256 maxDeposit_)
        EIP712("MegaPushEscrow", "1")
    {
        if (usdc_ == address(0) || house_ == address(0)) revert ZeroAddress();
        if (minDeposit_ == 0 || maxDeposit_ < minDeposit_) revert AmountOutOfBounds();
        usdc = IERC20(usdc_);
        house = house_;
        minDeposit = minDeposit_;
        maxDeposit = maxDeposit_;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Player: deposit / withdraw
    // ═══════════════════════════════════════════════════════════════════════

    /// @notice Lock USDC into the play bank. Blocked while a withdraw is pending.
    function deposit(uint256 amount) external nonReentrant {
        if (withdrawRequest[msg.sender].active) revert WithdrawPending();
        if (amount < minDeposit || amount > maxDeposit) revert AmountOutOfBounds();

        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 newBal = balanceOf[msg.sender] + amount;
        balanceOf[msg.sender] = newBal;
        emit Deposited(msg.sender, amount, newBal);
    }

    /// @notice Start unilateral exit. New deposits blocked; house can still settle.
    function requestWithdraw() external nonReentrant {
        if (withdrawRequest[msg.sender].active) revert WithdrawPending();
        if (balanceOf[msg.sender] == 0) revert InsufficientBalance();

        uint64 unlock = uint64(block.timestamp + WITHDRAW_DELAY);
        withdrawRequest[msg.sender] = WithdrawRequest({active: true, unlockTime: unlock});
        emit WithdrawRequested(msg.sender, unlock, balanceOf[msg.sender]);
    }

    /// @notice Cancel a pending withdraw so the player can deposit/stake again.
    function cancelWithdraw() external nonReentrant {
        if (!withdrawRequest[msg.sender].active) revert NoWithdrawPending();
        delete withdrawRequest[msg.sender];
        emit WithdrawCancelled(msg.sender);
    }

    /// @notice After challenge window, withdraw remaining balance (post any settles).
    function withdraw() external nonReentrant {
        WithdrawRequest memory req = withdrawRequest[msg.sender];
        if (!req.active) revert NoWithdrawPending();
        if (block.timestamp < req.unlockTime) revert WithdrawNotReady();

        uint256 amount = balanceOf[msg.sender];
        delete withdrawRequest[msg.sender];
        if (amount == 0) {
            emit Withdrawn(msg.sender, 0);
            return;
        }

        balanceOf[msg.sender] = 0;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // House: settle signed hand intents
    // ═══════════════════════════════════════════════════════════════════════

    struct HandIntent {
        address player;
        bytes32 entryId;
        uint256 amount;
        uint256 balanceNonce;
        uint256 deadline;
    }

    /**
     * @notice Debit one or more player-signed hand intents and send USDC to house.
     * @dev Each intent: entryId unique, balanceNonce must equal current player nonce (then ++).
     */
    function settleBatch(HandIntent[] calldata intents, bytes[] calldata signatures)
        external
        onlyHouse
        nonReentrant
    {
        uint256 n = intents.length;
        if (n == 0) revert EmptyBatch();
        if (n != signatures.length) revert LengthMismatch();

        uint256 totalToHouse;
        for (uint256 i = 0; i < n; i++) {
            totalToHouse += _settleOne(intents[i], signatures[i]);
        }
        if (totalToHouse > 0) {
            usdc.safeTransfer(house, totalToHouse);
        }
    }

    function _settleOne(HandIntent calldata intent, bytes calldata signature)
        internal
        returns (uint256 amount)
    {
        if (intent.amount == 0) revert ZeroAmount();
        if (block.timestamp > intent.deadline) revert IntentExpired();
        if (entryConsumed[intent.entryId]) revert EntryAlreadyConsumed();
        if (intent.balanceNonce != balanceNonce[intent.player]) revert BadBalanceNonce();

        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    HAND_INTENT_TYPEHASH,
                    intent.player,
                    intent.entryId,
                    intent.amount,
                    intent.balanceNonce,
                    intent.deadline
                )
            )
        );
        address signer = ECDSA.recover(digest, signature);
        if (signer != intent.player) revert InvalidSignature();

        uint256 bal = balanceOf[intent.player];
        if (bal < intent.amount) revert InsufficientBalance();

        entryConsumed[intent.entryId] = true;
        balanceNonce[intent.player] = intent.balanceNonce + 1;
        uint256 newBal = bal - intent.amount;
        balanceOf[intent.player] = newBal;

        emit Settled(intent.player, intent.entryId, intent.amount, intent.balanceNonce, newBal);
        return intent.amount;
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Admin
    // ═══════════════════════════════════════════════════════════════════════

    function setHouse(address newHouse) external onlyHouse {
        if (newHouse == address(0)) revert ZeroAddress();
        address prev = house;
        house = newHouse;
        emit HouseUpdated(prev, newHouse);
    }

    /// @notice Domain separator for off-chain EIP-712 signing helpers.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function hashIntent(HandIntent calldata intent) external view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    HAND_INTENT_TYPEHASH,
                    intent.player,
                    intent.entryId,
                    intent.amount,
                    intent.balanceNonce,
                    intent.deadline
                )
            )
        );
    }
}
