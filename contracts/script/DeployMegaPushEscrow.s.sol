// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MegaPushEscrow} from "../src/MegaPushEscrow.sol";

/**
 * Deploy MegaPushEscrow on Base Sepolia.
 *
 *   forge script script/DeployMegaPushEscrow.s.sol:DeployMegaPushEscrow \
 *     --rpc-url $BASE_SEPOLIA_RPC_URL --broadcast --verify
 *
 * Env:
 *   HOUSE_ADDRESS  — hot wallet (backend signer / settler)
 *   MIN_DEPOSIT    — optional, default 1e6 ($1)
 *   MAX_DEPOSIT    — optional, default 10_000e6 ($10k)
 */
contract DeployMegaPushEscrow is Script {
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        address house = vm.envAddress("HOUSE_ADDRESS");
        uint256 minDep = vm.envOr("MIN_DEPOSIT", uint256(1_000_000)); // $1
        uint256 maxDep = vm.envOr("MAX_DEPOSIT", uint256(10_000_000_000)); // $10,000

        uint256 pk = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(pk);
        MegaPushEscrow escrow = new MegaPushEscrow(BASE_SEPOLIA_USDC, house, minDep, maxDep);
        vm.stopBroadcast();

        console2.log("MegaPushEscrow", address(escrow));
        console2.log("USDC", address(escrow.usdc()));
        console2.log("house", escrow.house());
        console2.log("minDeposit", escrow.minDeposit());
        console2.log("maxDeposit", escrow.maxDeposit());
    }
}
