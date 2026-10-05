// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FlightDelayInsurance} from "../src/FlightDelayInsurance.sol";

/// Usage:
///   Anvil:   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --private-key <anvil key>
///   Sepolia: forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    function run() external returns (FlightDelayInsurance fdi) {
        vm.startBroadcast();
        fdi = new FlightDelayInsurance();
        vm.stopBroadcast();
        console.log("FlightDelayInsurance deployed at", address(fdi));
    }
}
