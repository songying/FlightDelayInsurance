// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlightDelayInsurance as FDI} from "../src/FlightDelayInsurance.sol";

/// Insurer whose receive() burns slightly more than 30,000 gas but less than 32,300
/// (the 30,000 requested by `_payInsurer` plus the 2,300 CALL value stipend).
contract SlightlyGasHungryInsurer {
    FDI immutable fdi;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function create(uint64 dep, address oracle) external payable returns (uint256) {
        return fdi.createOffer{value: msg.value}("SQ8385", dep, 50_000, 1 ether, oracle);
    }

    receive() external payable {
        uint256 start = gasleft();
        while (start - gasleft() < 30_500) {}
    }
}

/// Insurer that re-enters unguarded state-changing functions while receiving a withdrawal.
contract ReenteringInsurer {
    FDI immutable fdi;
    uint256 public mainId;
    uint256 public otherId;
    bool public depositReentered;
    bool public closeSalesReentered;
    bool public armed;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function init(uint64 dep, address oracle) external payable {
        mainId = fdi.createOffer{value: msg.value}("SQ8385", dep, 50_000, 1 ether, oracle);
        otherId = fdi.createOffer("SQ8386", dep, 50_000, 1 ether, oracle);
    }

    function withdraw(uint256 amount) external {
        armed = true;
        fdi.withdrawCollateral(mainId, amount);
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        try fdi.deposit{value: msg.value}(otherId) {
            depositReentered = true;
        } catch {}
        try fdi.closeSales(otherId) {
            closeSalesReentered = true;
        } catch {}
    }
}

/// Holder that re-enters buyPolicy on another offer while receiving a claim payout.
contract ReenteringBuyer {
    FDI immutable fdi;
    uint256 public claimId;
    uint256 public otherId;
    bool public buyReentered;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function buy(uint256 id, uint256 other) external payable {
        claimId = id;
        otherId = other;
        fdi.buyPolicy{value: msg.value}(id);
    }

    function doClaim() external {
        fdi.claim(claimId);
    }

    receive() external payable {
        try fdi.buyPolicy{value: 0.01 ether}(otherId) {
            buyReentered = true;
        } catch {}
    }
}

/// Failing tests that reproduce the findings in REVIEW.md. They are expected to fail
/// against the contract as submitted in PR #9.
contract ReviewTest is Test {
    FDI fdi;

    address insurer = makeAddr("insurer");
    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");

    uint64 constant T0 = 1_800_000_000;
    uint64 dep;
    uint256 cutoff;

    function setUp() public {
        vm.warp(T0);
        fdi = new FDI();
        dep = T0 + 3 days;
        cutoff = dep - 12 hours;
        vm.deal(insurer, 1000 ether);
        vm.deal(alice, 100 ether);
    }

    // R1 (AC27 / B22): an insurer that uses more than 30,000 gas must be credited, not paid.
    function test_review_pushGivesInsurerMoreThan30kGas() public {
        SlightlyGasHungryInsurer ins = new SlightlyGasHungryInsurer(fdi);
        uint256 id = ins.create{value: 1 ether}(dep, oracle);
        vm.warp(dep);
        vm.prank(oracle);
        vm.expectEmit(true, true, true, true);
        emit FDI.InsurerPaid(id, 1 ether, false);
        fdi.report(id, FDI.FlightStatus.Departed, 0);
        assertEq(fdi.credit(address(ins)), 1 ether, "insurer burning >30k gas should be credited");
    }

    // R2 (AC42 / §4 maxPremium): with no free collateral nothing is buyable, so maxPremium must be 0.
    function test_review_maxPremiumNonZeroWithZeroCollateral() public {
        vm.prank(insurer);
        uint256 id = fdi.createOffer("SQ8385", dep, 15_000, 1 ether, oracle); // 1.5x, collateral 0
        uint256 m = fdi.maxPremium(id);
        assertEq(m, 0, "maxPremium should be 0 when no premium is buyable");
    }

    // R2 (variant): the value maxPremium returns must itself be buyable.
    function test_review_maxPremiumNotBuyableWhenCapBinds() public {
        vm.prank(insurer);
        uint256 id = fdi.createOffer{value: 1 ether}("SQ8385", dep, 15_000, 1, oracle); // cap = 1 wei
        uint256 m = fdi.maxPremium(id);
        if (m == 0) return;
        vm.prank(alice);
        fdi.buyPolicy{value: m}(id); // reverts PayoutNotAbovePremium for m = 1
    }

    // R3 (§4 maxPremium formula): spec says min(floor(cap * 10000 / odds), ...).
    function test_review_maxPremiumMatchesSpecFormula() public {
        uint256 cap = 10;
        uint32 odds = 15_000;
        vm.prank(insurer);
        uint256 id = fdi.createOffer{value: 1 ether}("SQ8385", dep, odds, cap, oracle);
        uint256 specByCap = (cap * 10_000) / odds; // 6
        assertEq(fdi.maxPremium(id), specByCap, "maxPremium differs from SPEC.md formula");
    }

    // R4 (§4): "All state-changing functions use ... a reentrancy guard." deposit and closeSales do not.
    function test_review_depositAndCloseSalesLackReentrancyGuard() public {
        ReenteringInsurer ins = new ReenteringInsurer(fdi);
        vm.deal(address(this), 1 ether);
        ins.init{value: 1 ether}(dep, oracle);
        ins.withdraw(0.5 ether);
        assertFalse(ins.depositReentered(), "deposit re-entered during withdrawCollateral");
        assertFalse(ins.closeSalesReentered(), "closeSales re-entered during withdrawCollateral");
    }

    // R4 (§4): buyPolicy has no reentrancy guard either.
    function test_review_buyPolicyLacksReentrancyGuard() public {
        vm.startPrank(insurer);
        uint256 id = fdi.createOffer{value: 1 ether}("SQ8385", dep, 50_000, 1 ether, oracle);
        uint64 laterDep = dep + 30 days;
        uint256 other = fdi.createOffer{value: 1 ether}("SQ8386", laterDep, 50_000, 1 ether, oracle);
        vm.stopPrank();

        ReenteringBuyer buyer = new ReenteringBuyer(fdi);
        vm.deal(address(buyer), 1 ether);
        buyer.buy{value: 0.1 ether}(id, other);

        vm.warp(dep);
        vm.prank(oracle);
        fdi.report(id, FDI.FlightStatus.Cancelled, 0);

        buyer.doClaim();
        assertFalse(buyer.buyReentered(), "buyPolicy re-entered during claim");
    }

    // R5 (§4): "Errors are custom errors, one per failed rule." Closed sales and passed cutoff
    // are different rules (B6, B21) but share SalesNotOpen.
    function test_review_closedSalesAndCutoffShareOneError() public {
        vm.prank(insurer);
        uint256 a = fdi.createOffer{value: 1 ether}("SQ8385", dep, 50_000, 1 ether, oracle);
        vm.prank(insurer);
        fdi.closeSales(a);

        bytes4 closedSel;
        vm.prank(alice);
        try fdi.buyPolicy{value: 0.1 ether}(a) {}
        catch (bytes memory err) {
            closedSel = bytes4(err);
        }

        vm.prank(insurer);
        uint256 b = fdi.createOffer{value: 1 ether}("SQ8386", dep, 50_000, 1 ether, oracle);
        vm.warp(cutoff + 1);
        bytes4 cutoffSel;
        vm.prank(alice);
        try fdi.buyPolicy{value: 0.1 ether}(b) {}
        catch (bytes memory err) {
            cutoffSel = bytes4(err);
        }

        assertTrue(closedSel != bytes4(0) && cutoffSel != bytes4(0), "both purchases should revert");
        assertTrue(closedSel != cutoffSel, "closed-sales and past-cutoff reverts use the same error");
    }
}
