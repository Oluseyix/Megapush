// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {MegaPushEscrow} from "../src/MegaPushEscrow.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

contract MegaPushEscrowTest is Test {
    uint256 internal constant MIN_DEP = 1e6; // $1
    uint256 internal constant MAX_DEP = 10_000e6;

    MockUSDC internal usdc;
    MegaPushEscrow internal escrow;

    address internal house;
    uint256 internal housePk;
    address internal player;
    uint256 internal playerPk;
    address internal attacker;
    uint256 internal attackerPk;

    function setUp() public {
        housePk = 0xA11CE;
        house = vm.addr(housePk);
        playerPk = 0xB0B;
        player = vm.addr(playerPk);
        attackerPk = 0xBAD;
        attacker = vm.addr(attackerPk);

        usdc = new MockUSDC();
        escrow = new MegaPushEscrow(address(usdc), house, MIN_DEP, MAX_DEP);

        usdc.mint(player, 100_000e6);
        usdc.mint(attacker, 100_000e6);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    function _deposit(address who, uint256 amount) internal {
        vm.startPrank(who);
        usdc.approve(address(escrow), amount);
        escrow.deposit(amount);
        vm.stopPrank();
    }

    function _signIntent(MegaPushEscrow.HandIntent memory intent, uint256 pk)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = escrow.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _intent(address who, bytes32 entryId, uint256 amount, uint256 nonce, uint256 deadline)
        internal
        pure
        returns (MegaPushEscrow.HandIntent memory)
    {
        return MegaPushEscrow.HandIntent({
            player: who,
            entryId: entryId,
            amount: amount,
            balanceNonce: nonce,
            deadline: deadline
        });
    }

    function _settleOne(MegaPushEscrow.HandIntent memory intent, bytes memory sig) internal {
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent;
        sigs[0] = sig;
        vm.prank(house);
        escrow.settleBatch(intents, sigs);
    }

    // ── deposit ──────────────────────────────────────────────────────────

    function test_deposit_creditsBalance() public {
        _deposit(player, 25e6);
        assertEq(escrow.balanceOf(player), 25e6);
        assertEq(usdc.balanceOf(address(escrow)), 25e6);
    }

    function test_deposit_revertsBelowMin() public {
        vm.startPrank(player);
        usdc.approve(address(escrow), MIN_DEP - 1);
        vm.expectRevert(MegaPushEscrow.AmountOutOfBounds.selector);
        escrow.deposit(MIN_DEP - 1);
        vm.stopPrank();
    }

    function test_deposit_revertsAboveMax() public {
        vm.startPrank(player);
        usdc.approve(address(escrow), MAX_DEP + 1);
        vm.expectRevert(MegaPushEscrow.AmountOutOfBounds.selector);
        escrow.deposit(MAX_DEP + 1);
        vm.stopPrank();
    }

    function test_deposit_blockedWhileWithdrawPending() public {
        _deposit(player, 10e6);
        vm.prank(player);
        escrow.requestWithdraw();

        vm.startPrank(player);
        usdc.approve(address(escrow), 5e6);
        vm.expectRevert(MegaPushEscrow.WithdrawPending.selector);
        escrow.deposit(5e6);
        vm.stopPrank();
    }

    // ── settleBatch ──────────────────────────────────────────────────────

    function test_settleBatch_debitsAndPaysHouse() public {
        _deposit(player, 50e6);
        uint256 houseBefore = usdc.balanceOf(house);

        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-1"), 10e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        _settleOne(intent, sig);

        assertEq(escrow.balanceOf(player), 40e6);
        assertEq(escrow.balanceNonce(player), 1);
        assertTrue(escrow.entryConsumed(keccak256("entry-1")));
        assertEq(usdc.balanceOf(house), houseBefore + 10e6);
    }

    function test_settleBatch_rejectsForgedSignature() public {
        _deposit(player, 50e6);
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-2"), 10e6, 0, block.timestamp + 1 hours);
        // attacker signs
        bytes memory sig = _signIntent(intent, attackerPk);

        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent;
        sigs[0] = sig;

        vm.prank(house);
        vm.expectRevert(MegaPushEscrow.InvalidSignature.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_rejectsNonceReplay() public {
        _deposit(player, 50e6);
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-3"), 5e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        _settleOne(intent, sig);

        // same nonce, different entryId
        MegaPushEscrow.HandIntent memory intent2 =
            _intent(player, keccak256("entry-3b"), 5e6, 0, block.timestamp + 1 hours);
        bytes memory sig2 = _signIntent(intent2, playerPk);

        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent2;
        sigs[0] = sig2;
        vm.prank(house);
        vm.expectRevert(MegaPushEscrow.BadBalanceNonce.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_rejectsEntryIdReplay() public {
        _deposit(player, 50e6);
        bytes32 entryId = keccak256("entry-dup");
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, entryId, 5e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        _settleOne(intent, sig);

        // correct next nonce but same entryId
        MegaPushEscrow.HandIntent memory intent2 =
            _intent(player, entryId, 5e6, 1, block.timestamp + 1 hours);
        bytes memory sig2 = _signIntent(intent2, playerPk);
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent2;
        sigs[0] = sig2;
        vm.prank(house);
        vm.expectRevert(MegaPushEscrow.EntryAlreadyConsumed.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_rejectsExpiredIntent() public {
        _deposit(player, 50e6);
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-exp"), 5e6, 0, block.timestamp - 1);
        bytes memory sig = _signIntent(intent, playerPk);
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent;
        sigs[0] = sig;
        vm.prank(house);
        vm.expectRevert(MegaPushEscrow.IntentExpired.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_rejectsOverdraft() public {
        _deposit(player, 10e6);
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-big"), 11e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent;
        sigs[0] = sig;
        vm.prank(house);
        vm.expectRevert(MegaPushEscrow.InsufficientBalance.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_rejectsNonHouseCaller() public {
        _deposit(player, 50e6);
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-nh"), 5e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](1);
        bytes[] memory sigs = new bytes[](1);
        intents[0] = intent;
        sigs[0] = sig;
        vm.prank(attacker);
        vm.expectRevert(MegaPushEscrow.Unauthorized.selector);
        escrow.settleBatch(intents, sigs);
    }

    function test_settleBatch_batchMultipleIntents() public {
        _deposit(player, 100e6);
        MegaPushEscrow.HandIntent memory a =
            _intent(player, keccak256("e-a"), 10e6, 0, block.timestamp + 1 hours);
        MegaPushEscrow.HandIntent memory b =
            _intent(player, keccak256("e-b"), 15e6, 1, block.timestamp + 1 hours);
        MegaPushEscrow.HandIntent[] memory intents = new MegaPushEscrow.HandIntent[](2);
        bytes[] memory sigs = new bytes[](2);
        intents[0] = a;
        intents[1] = b;
        sigs[0] = _signIntent(a, playerPk);
        sigs[1] = _signIntent(b, playerPk);
        uint256 houseBefore = usdc.balanceOf(house);
        vm.prank(house);
        escrow.settleBatch(intents, sigs);
        assertEq(escrow.balanceOf(player), 75e6);
        assertEq(escrow.balanceNonce(player), 2);
        assertEq(usdc.balanceOf(house), houseBefore + 25e6);
    }

    // ── withdraw challenge window ────────────────────────────────────────

    function test_withdraw_requiresDelay() public {
        _deposit(player, 20e6);
        vm.prank(player);
        escrow.requestWithdraw();

        vm.prank(player);
        vm.expectRevert(MegaPushEscrow.WithdrawNotReady.selector);
        escrow.withdraw();
    }

    function test_withdraw_afterDelay() public {
        _deposit(player, 20e6);
        vm.prank(player);
        escrow.requestWithdraw();

        vm.warp(block.timestamp + escrow.WITHDRAW_DELAY());
        uint256 before = usdc.balanceOf(player);
        vm.prank(player);
        escrow.withdraw();
        assertEq(escrow.balanceOf(player), 0);
        assertEq(usdc.balanceOf(player), before + 20e6);
        (bool active,) = escrow.withdrawRequest(player);
        assertFalse(active);
    }

    function test_withdraw_settleDuringWindow_reducesPayout() public {
        _deposit(player, 50e6);
        vm.prank(player);
        escrow.requestWithdraw();

        // House settles an outstanding hand during the challenge window
        MegaPushEscrow.HandIntent memory intent =
            _intent(player, keccak256("entry-window"), 30e6, 0, block.timestamp + 1 hours);
        bytes memory sig = _signIntent(intent, playerPk);
        _settleOne(intent, sig);
        assertEq(escrow.balanceOf(player), 20e6);

        vm.warp(block.timestamp + escrow.WITHDRAW_DELAY());
        uint256 before = usdc.balanceOf(player);
        vm.prank(player);
        escrow.withdraw();
        // Player only gets remaining 20, not the original 50
        assertEq(usdc.balanceOf(player), before + 20e6);
        assertEq(escrow.balanceOf(player), 0);
    }

    function test_cancelWithdraw_allowsDepositAgain() public {
        _deposit(player, 10e6);
        vm.prank(player);
        escrow.requestWithdraw();
        vm.prank(player);
        escrow.cancelWithdraw();

        _deposit(player, 5e6);
        assertEq(escrow.balanceOf(player), 15e6);
    }

    function test_requestWithdraw_revertsIfZeroBalance() public {
        vm.prank(player);
        vm.expectRevert(MegaPushEscrow.InsufficientBalance.selector);
        escrow.requestWithdraw();
    }

    // ── house transfer ───────────────────────────────────────────────────

    function test_setHouse_onlyHouse() public {
        vm.prank(attacker);
        vm.expectRevert(MegaPushEscrow.Unauthorized.selector);
        escrow.setHouse(attacker);

        vm.prank(house);
        escrow.setHouse(attacker);
        assertEq(escrow.house(), attacker);
    }
}
