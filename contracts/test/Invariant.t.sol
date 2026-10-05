// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlightDelayInsurance as FDI} from "../src/FlightDelayInsurance.sol";

/// Drives random but valid-ish sequences of actions and tracks ETH in/out.
contract Handler is Test {
    FDI public fdi;
    address[] public actors;
    address public oracle = makeAddr("inv-oracle");
    uint256[] public offerIds;

    uint256 public ethIn;
    uint256 public ethOut;

    constructor(FDI _fdi) {
        fdi = _fdi;
        for (uint256 i = 0; i < 5; i++) {
            address a = makeAddr(string(abi.encodePacked("actor", vm.toString(i))));
            vm.deal(a, 1_000_000 ether);
            actors.push(a);
        }
    }

    function offersLength() external view returns (uint256) {
        return offerIds.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _offer(uint256 seed) internal view returns (uint256) {
        return offerIds[seed % offerIds.length];
    }

    function createOffer(uint256 actorSeed, uint32 odds, uint96 cap, uint96 deposit, uint32 depOffset) external {
        address a = _actor(actorSeed);
        odds = uint32(bound(odds, 10_001, 1_000_000));
        cap = uint96(bound(cap, 1, 100 ether));
        deposit = uint96(bound(deposit, 0, 100 ether));
        uint64 dep = uint64(block.timestamp + 12 hours + 1 + bound(depOffset, 0, 10 days));
        vm.prank(a);
        uint256 id = fdi.createOffer{value: deposit}("SQ8385", dep, odds, cap, oracle);
        ethIn += deposit;
        offerIds.push(id);
    }

    function deposit(uint256 offerSeed, uint96 amount) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        amount = uint96(bound(amount, 1, 50 ether));
        FDI.Offer memory o = fdi.getOffer(id);
        vm.prank(o.insurer);
        try fdi.deposit{value: amount}(id) {
            ethIn += amount;
        } catch {}
    }

    function withdraw(uint256 offerSeed, uint256 amount) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        FDI.Offer memory o = fdi.getOffer(id);
        uint256 before = o.insurer.balance;
        vm.prank(o.insurer);
        try fdi.withdrawCollateral(id, bound(amount, 1, 100 ether)) {} catch {}
        ethOut += o.insurer.balance - before;
    }

    function buy(uint256 offerSeed, uint256 actorSeed, uint96 premium) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        address a = _actor(actorSeed);
        premium = uint96(bound(premium, 1, 20 ether));
        vm.prank(a);
        try fdi.buyPolicy{value: premium}(id) {
            ethIn += premium;
        } catch {}
    }

    function closeSales(uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        vm.prank(fdi.getOffer(id).insurer);
        try fdi.closeSales(id) {} catch {}
    }

    function report(uint256 offerSeed, uint8 status, uint32 mins) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        address ins = fdi.getOffer(id).insurer;
        uint256 before = ins.balance;
        vm.prank(oracle);
        try fdi.report(id, FDI.FlightStatus(status % 3), uint32(bound(mins, 0, 120))) {} catch {}
        ethOut += ins.balance - before;
    }

    function expire(uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        address ins = fdi.getOffer(id).insurer;
        uint256 before = ins.balance;
        try fdi.expire(id) {} catch {}
        ethOut += ins.balance - before;
    }

    function claim(uint256 offerSeed, uint256 actorSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        address a = _actor(actorSeed);
        address ins = fdi.getOffer(id).insurer;
        uint256 beforeA = a.balance;
        uint256 beforeI = ins.balance;
        vm.prank(a);
        try fdi.claim(id) {} catch {}
        // implicit expiry may push to the insurer
        ethOut += a.balance - beforeA;
        if (ins != a) ethOut += ins.balance - beforeI;
    }

    function sweep(uint256 offerSeed) external {
        if (offerIds.length == 0) return;
        uint256 id = _offer(offerSeed);
        address ins = fdi.getOffer(id).insurer;
        uint256 before = ins.balance;
        vm.prank(ins);
        try fdi.sweep(id) {} catch {}
        ethOut += ins.balance - before;
    }

    function warp(uint32 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 30 days));
    }
}

contract InvariantTest is Test {
    FDI fdi;
    Handler handler;

    function setUp() public {
        vm.warp(1_800_000_000);
        fdi = new FDI();
        handler = new Handler(fdi);
        targetContract(address(handler));
    }

    /// AC38: the contract balance covers every outstanding obligation.
    function invariant_solvent() public view {
        uint256 owed;
        uint256 n = fdi.offerCount();
        for (uint256 i = 0; i < n; i++) {
            FDI.Offer memory o = fdi.getOffer(i);
            if (o.outcome == FDI.Outcome.None) {
                owed += o.collateral + o.premiums;
            } else if (!o.swept) {
                uint256 ent = o.outcome == FDI.Outcome.Payout
                    ? o.totalPayout
                    : (o.outcome == FDI.Outcome.Expired ? o.premiums : 0);
                owed += ent - o.claimedAmount;
            }
        }
        assertGe(address(fdi).balance, owed);
        // Without credit fallbacks (EOAs only), balance equals obligations exactly.
        assertEq(address(fdi).balance, owed);
    }

    /// AC38: ETH out never exceeds ETH in.
    function invariant_noValueCreated() public view {
        assertLe(handler.ethOut(), handler.ethIn());
        assertEq(handler.ethIn() - handler.ethOut(), address(fdi).balance);
    }

    /// AC39: reserved never exceeds collateral before settlement.
    function invariant_reservedWithinCollateral() public view {
        uint256 n = fdi.offerCount();
        for (uint256 i = 0; i < n; i++) {
            FDI.Offer memory o = fdi.getOffer(i);
            if (o.outcome == FDI.Outcome.None) assertLe(o.reserved, o.collateral);
            assertEq(o.totalPayout, o.reserved + o.premiums);
        }
    }
}
