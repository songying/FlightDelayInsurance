// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FlightDelayInsurance as FDI} from "../src/FlightDelayInsurance.sol";

/// Insurer contract that rejects ETH (exercises the credit fallback).
contract RejectingInsurer {
    FDI immutable fdi;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function create(uint64 dep, address oracle) external payable returns (uint256) {
        return fdi.createOffer{value: msg.value}("SQ8385", dep, 50_000, 1 ether, oracle);
    }

    function withdrawCredit() external {
        fdi.withdrawCredit();
    }

    bool public accept;

    function setAccept(bool a) external {
        accept = a;
    }

    receive() external payable {
        require(accept, "no");
    }
}

/// Insurer contract that burns more than the 30k stipend on receive.
contract GasHungryInsurer {
    FDI immutable fdi;
    mapping(uint256 => uint256) public sink;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function create(uint64 dep, address oracle) external payable returns (uint256) {
        return fdi.createOffer{value: msg.value}("SQ8385", dep, 50_000, 1 ether, oracle);
    }

    receive() external payable {
        for (uint256 i = 0; i < 5; i++) {
            sink[i] = i + 1; // 5 fresh-slot SSTOREs (~110k gas) > 30k stipend
        }
    }
}

/// Holder that re-enters claim from receive.
contract ReentrantHolder {
    FDI immutable fdi;
    uint256 public offerId;
    uint256 public reentries;

    constructor(FDI _fdi) {
        fdi = _fdi;
    }

    function buy(uint256 id) external payable {
        offerId = id;
        fdi.buyPolicy{value: msg.value}(id);
    }

    function doClaim() external {
        fdi.claim(offerId);
    }

    receive() external payable {
        reentries++;
        // Any re-entry must revert; swallow so the outer call can observe it.
        try fdi.claim(offerId) {
            revert("reentered");
        } catch {}
    }
}

contract FlightDelayInsuranceTest is Test {
    FDI fdi;

    address insurer = makeAddr("insurer");
    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address stranger = makeAddr("stranger");

    uint64 constant T0 = 1_800_000_000;
    uint64 dep; // scheduled departure
    uint256 cutoff;
    uint256 deadline; // D

    uint32 constant ODDS = 50_000; // 5.00x
    uint256 constant CAP = 1 ether;

    function setUp() public {
        vm.warp(T0);
        fdi = new FDI();
        dep = T0 + 3 days;
        cutoff = dep - 12 hours;
        deadline = uint256(dep) + 48 hours;
        vm.deal(insurer, 1000 ether);
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(oracle, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    // ---------------------------------------------------------------- helpers

    function _create(uint256 collateral) internal returns (uint256) {
        vm.prank(insurer);
        return fdi.createOffer{value: collateral}("SQ8385", dep, ODDS, CAP, oracle);
    }

    function _buy(uint256 id, address who, uint256 premium) internal {
        vm.prank(who);
        fdi.buyPolicy{value: premium}(id);
    }

    function _report(uint256 id, FDI.FlightStatus s, uint32 mins) internal {
        vm.warp(dep);
        vm.prank(oracle);
        fdi.report(id, s, mins);
    }

    function _settledAt(uint256 id) internal view returns (uint256) {
        return fdi.getOffer(id).settledAt;
    }

    // ------------------------------------------------------------- creation

    // AC1
    function test_create_justBeforeCutoff() public {
        vm.warp(cutoff - 1);
        vm.expectEmit(true, true, true, true);
        emit FDI.OfferCreated(0, insurer, oracle, "SQ8385", dep, ODDS, CAP, 2 ether);
        uint256 id = _create(2 ether);
        assertEq(id, 0);
        assertEq(fdi.offerCount(), 1);
        FDI.Offer memory o = fdi.getOffer(id);
        assertEq(o.insurer, insurer);
        assertEq(o.oracle, oracle);
        assertEq(o.collateral, 2 ether);
        assertEq(o.flightNumber, "SQ8385");
    }

    // AC2
    function test_create_atCutoffReverts() public {
        vm.warp(cutoff);
        vm.prank(insurer);
        vm.expectRevert(FDI.TooLateToCreate.selector);
        fdi.createOffer("SQ8385", dep, ODDS, CAP, oracle);
    }

    // AC3 / AC4
    function test_create_oddsBounds() public {
        vm.startPrank(insurer);
        vm.expectRevert(FDI.InvalidOdds.selector);
        fdi.createOffer("SQ8385", dep, 10_000, CAP, oracle);
        fdi.createOffer("SQ8385", dep, 10_001, CAP, oracle);
        fdi.createOffer("SQ8385", dep, 1_000_000, CAP, oracle);
        vm.expectRevert(FDI.InvalidOdds.selector);
        fdi.createOffer("SQ8385", dep, 1_000_001, CAP, oracle);
        vm.stopPrank();
    }

    // AC5
    function test_create_invalidParams() public {
        vm.startPrank(insurer);
        vm.expectRevert(FDI.InvalidCap.selector);
        fdi.createOffer("SQ8385", dep, ODDS, 0, oracle);
        vm.expectRevert(FDI.InvalidOracle.selector);
        fdi.createOffer("SQ8385", dep, ODDS, CAP, address(0));
        vm.expectRevert(FDI.InvalidFlightNumber.selector);
        fdi.createOffer("", dep, ODDS, CAP, oracle);
        vm.expectRevert(FDI.InvalidFlightNumber.selector);
        fdi.createOffer("ABCDEFGHI", dep, ODDS, CAP, oracle);
        fdi.createOffer("ABCDEFGH", dep, ODDS, CAP, oracle);
        vm.stopPrank();
    }

    function test_create_departureTooSmallReverts() public {
        vm.prank(insurer);
        vm.expectRevert(FDI.TooLateToCreate.selector);
        fdi.createOffer("SQ8385", 100, ODDS, CAP, oracle);
    }

    // AC6
    function test_create_zeroDeposit() public {
        uint256 id = _create(0);
        assertEq(fdi.getOffer(id).collateral, 0);
        assertEq(fdi.freeCollateral(id), 0);
    }

    function test_unknownOfferReverts() public {
        vm.expectRevert(FDI.OfferNotFound.selector);
        fdi.getOffer(0);
        vm.expectRevert(FDI.OfferNotFound.selector);
        fdi.buyPolicy{value: 1}(7);
    }

    // ------------------------------------------------------------- purchase

    // AC7
    function test_buy_atCutoff() public {
        uint256 id = _create(10 ether);
        vm.warp(cutoff);
        vm.expectEmit(true, true, false, true);
        emit FDI.PolicyPurchased(id, alice, 0.1 ether, 0.5 ether);
        _buy(id, alice, 0.1 ether);
        FDI.Offer memory o = fdi.getOffer(id);
        assertEq(o.reserved, 0.4 ether);
        assertEq(o.premiums, 0.1 ether);
        assertEq(o.policyCount, 1);
        FDI.Policy memory p = fdi.getPolicy(id, alice);
        assertEq(p.premium, 0.1 ether);
        assertEq(p.payout, 0.5 ether);
    }

    // AC8
    function test_buy_afterCutoffReverts() public {
        uint256 id = _create(10 ether);
        vm.warp(cutoff + 1);
        vm.prank(alice);
        vm.expectRevert(FDI.SalesCutoffPassed.selector);
        fdi.buyPolicy{value: 0.1 ether}(id);
    }

    // AC9
    function test_buy_capBoundary() public {
        uint256 id = _create(10 ether);
        _buy(id, alice, 0.2 ether); // payout == cap
        assertEq(fdi.getPolicy(id, alice).payout, CAP);
        vm.prank(bob);
        vm.expectRevert(FDI.PayoutExceedsCap.selector);
        fdi.buyPolicy{value: 0.2 ether + 1}(id);
    }

    // AC10
    function test_buy_zeroPremiumAndRounding() public {
        uint256 id = _create(10 ether);
        vm.prank(alice);
        vm.expectRevert(FDI.ZeroAmount.selector);
        fdi.buyPolicy{value: 0}(id);

        vm.prank(insurer);
        uint256 id2 = fdi.createOffer{value: 1 ether}("SQ8385", dep, 10_001, CAP, oracle);
        vm.prank(alice);
        vm.expectRevert(FDI.PayoutNotAbovePremium.selector);
        fdi.buyPolicy{value: 1}(id2);
    }

    // AC11
    function test_buy_collateralBoundary() public {
        uint256 id = _create(0.4 ether); // exactly one 0.1 -> 0.5 reservation
        vm.prank(alice);
        vm.expectRevert(FDI.InsufficientFreeCollateral.selector);
        fdi.buyPolicy{value: 0.1 ether + 1}(id); // reservation 0.4 ether + 4 wei
        _buy(id, alice, 0.1 ether);
        assertEq(fdi.freeCollateral(id), 0);

        uint256 id2 = _create(0.4 ether - 1);
        vm.prank(alice);
        vm.expectRevert(FDI.InsufficientFreeCollateral.selector);
        fdi.buyPolicy{value: 0.1 ether}(id2);
    }

    // AC12
    function test_buy_onePolicyPerWallet() public {
        uint256 id = _create(10 ether);
        uint256 id2 = _create(10 ether);
        _buy(id, alice, 0.1 ether);
        vm.prank(alice);
        vm.expectRevert(FDI.AlreadyHasPolicy.selector);
        fdi.buyPolicy{value: 0.1 ether}(id);
        _buy(id2, alice, 0.1 ether);
    }

    // AC13
    function test_buy_insurerAndOracleBlocked() public {
        uint256 id = _create(10 ether);
        vm.prank(insurer);
        vm.expectRevert(FDI.InsurerOrOracleCannotBuy.selector);
        fdi.buyPolicy{value: 0.1 ether}(id);
        vm.prank(oracle);
        vm.expectRevert(FDI.InsurerOrOracleCannotBuy.selector);
        fdi.buyPolicy{value: 0.1 ether}(id);
    }

    // AC14
    function test_buy_afterCloseSalesReverts() public {
        uint256 id = _create(10 ether);
        vm.prank(insurer);
        fdi.closeSales(id);
        vm.prank(alice);
        vm.expectRevert(FDI.SalesClosedByInsurer.selector);
        fdi.buyPolicy{value: 0.1 ether}(id);
    }

    function test_maxPremium() public {
        uint256 id = _create(10 ether);
        // cap-limited: largest p with floor(5p) <= 1e18 -> 0.2 ether
        assertEq(fdi.maxPremium(id), 0.2 ether);
        uint256 id2 = _create(0.4 ether);
        // collateral-limited: largest p with floor(4p) <= 0.4e18 -> 0.1 ether
        assertEq(fdi.maxPremium(id2), 0.1 ether);
        _buy(id2, alice, fdi.maxPremium(id2));
        assertEq(fdi.maxPremium(id2), 0);
        vm.warp(cutoff + 1);
        assertEq(fdi.maxPremium(id), 0);
    }

    function test_maxPremium_isBuyable_fuzz(uint32 odds, uint96 cap, uint96 collateral) public {
        odds = uint32(bound(odds, 10_001, 1_000_000));
        cap = uint96(bound(cap, 1, 1000 ether));
        collateral = uint96(bound(collateral, 0, 1000 ether));
        vm.prank(insurer);
        uint256 id = fdi.createOffer{value: collateral}("SQ8385", dep, odds, cap, oracle);
        uint256 m = fdi.maxPremium(id);
        vm.assume(m > 0 && m <= 50 ether);
        uint256 payout = (m * odds) / 10_000;
        vm.assume(payout > m);
        _buy(id, alice, m); // max must be buyable
    }

    // ---------------------------------------------------- insurer lifecycle

    // AC15
    function test_withdrawCollateral_boundary() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether); // reserves 0.4
        uint256 free = fdi.freeCollateral(id);
        assertEq(free, 0.6 ether);
        vm.prank(insurer);
        vm.expectRevert(FDI.InsufficientFreeCollateral.selector);
        fdi.withdrawCollateral(id, free + 1);
        uint256 before = insurer.balance;
        vm.prank(insurer);
        fdi.withdrawCollateral(id, free);
        assertEq(insurer.balance - before, free);
        assertEq(fdi.freeCollateral(id), 0);
    }

    function test_depositTopsUp() public {
        uint256 id = _create(0);
        vm.prank(insurer);
        fdi.deposit{value: 3 ether}(id);
        assertEq(fdi.freeCollateral(id), 3 ether);
        vm.prank(insurer);
        vm.expectRevert(FDI.ZeroAmount.selector);
        fdi.deposit{value: 0}(id);
    }

    // AC16
    function test_insurerOnlyFunctions() public {
        uint256 id = _create(1 ether);
        vm.startPrank(stranger);
        vm.expectRevert(FDI.NotInsurer.selector);
        fdi.deposit{value: 1 ether}(id);
        vm.expectRevert(FDI.NotInsurer.selector);
        fdi.withdrawCollateral(id, 1);
        vm.expectRevert(FDI.NotInsurer.selector);
        fdi.closeSales(id);
        vm.expectRevert(FDI.NotInsurer.selector);
        fdi.sweep(id);
        vm.stopPrank();
    }

    // AC17
    function test_closeSales_twiceReverts_policiesUnaffected() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        vm.prank(insurer);
        vm.expectEmit(true, false, false, false);
        emit FDI.SalesClosed(id);
        fdi.closeSales(id);
        vm.prank(insurer);
        vm.expectRevert(FDI.SalesAlreadyClosed.selector);
        fdi.closeSales(id);
        assertEq(fdi.getPolicy(id, alice).payout, 0.5 ether);
        _report(id, FDI.FlightStatus.Departed, 31);
        vm.prank(alice);
        fdi.claim(id);
    }

    // AC18
    function test_depositWithdrawAfterSettlementRevert() public {
        uint256 id = _create(1 ether);
        _report(id, FDI.FlightStatus.Departed, 0);
        vm.startPrank(insurer);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.deposit{value: 1 ether}(id);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.withdrawCollateral(id, 1);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.closeSales(id);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- report

    // AC19
    function test_report_windowOpen() public {
        uint256 id = _create(1 ether);
        vm.warp(dep - 1);
        vm.prank(oracle);
        vm.expectRevert(FDI.ReportWindowNotOpen.selector);
        fdi.report(id, FDI.FlightStatus.Departed, 0);
        vm.warp(dep);
        vm.prank(oracle);
        fdi.report(id, FDI.FlightStatus.Departed, 0);
    }

    // AC20
    function test_report_windowClose() public {
        uint256 id = _create(1 ether);
        uint256 id2 = _create(1 ether);
        vm.warp(deadline);
        vm.prank(oracle);
        fdi.report(id, FDI.FlightStatus.Departed, 0);
        vm.warp(deadline + 1);
        vm.prank(oracle);
        vm.expectRevert(FDI.ReportWindowClosed.selector);
        fdi.report(id2, FDI.FlightStatus.Departed, 0);
    }

    // AC21
    function test_report_onlyOracle() public {
        uint256 id = _create(1 ether);
        vm.warp(dep);
        vm.prank(insurer);
        vm.expectRevert(FDI.NotOracle.selector);
        fdi.report(id, FDI.FlightStatus.Cancelled, 0);
    }

    // AC22
    function test_report_onlyOnce() public {
        uint256 id = _create(1 ether);
        uint256 id2 = _create(1 ether);
        _report(id, FDI.FlightStatus.Departed, 0);
        vm.prank(oracle);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.report(id, FDI.FlightStatus.Departed, 45);

        vm.warp(deadline + 1);
        fdi.expire(id2);
        vm.warp(deadline);
        vm.prank(oracle);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.report(id2, FDI.FlightStatus.Departed, 0);
    }

    // AC23
    function test_report_thresholdBoundary() public {
        uint256 a = _create(1 ether);
        uint256 b = _create(1 ether);
        uint256 c = _create(1 ether);
        vm.warp(dep);
        vm.startPrank(oracle);
        fdi.report(a, FDI.FlightStatus.Departed, 30);
        fdi.report(b, FDI.FlightStatus.Departed, 31);
        fdi.report(c, FDI.FlightStatus.Departed, 0);
        vm.stopPrank();
        assertEq(uint8(fdi.getOffer(a).outcome), uint8(FDI.Outcome.NoPayout));
        assertEq(uint8(fdi.getOffer(b).outcome), uint8(FDI.Outcome.Payout));
        assertEq(uint8(fdi.getOffer(c).outcome), uint8(FDI.Outcome.NoPayout));
        assertEq(fdi.getOffer(b).reportedDelayMinutes, 31);
    }

    // AC24
    function test_report_cancelledOrDivertedPays() public {
        uint256 a = _create(1 ether);
        uint256 b = _create(1 ether);
        vm.warp(dep);
        vm.startPrank(oracle);
        fdi.report(a, FDI.FlightStatus.Cancelled, 0);
        fdi.report(b, FDI.FlightStatus.Diverted, 0);
        vm.stopPrank();
        assertEq(uint8(fdi.getOffer(a).outcome), uint8(FDI.Outcome.Payout));
        assertEq(uint8(fdi.getOffer(b).outcome), uint8(FDI.Outcome.Payout));
    }

    // AC25
    function test_report_payoutPushesFreeCollateral() public {
        uint256 id = _create(2 ether);
        _buy(id, alice, 0.1 ether); // reserve 0.4
        _buy(id, bob, 0.2 ether); // reserve 0.8
        uint256 before = insurer.balance;
        vm.warp(dep);
        vm.expectEmit(true, false, false, true);
        emit FDI.InsurerPaid(id, 0.8 ether, true);
        vm.prank(oracle);
        fdi.report(id, FDI.FlightStatus.Departed, 120);
        assertEq(insurer.balance - before, 0.8 ether);
        assertEq(address(fdi).balance, 1.5 ether); // 0.5 + 1.0 owed
    }

    // AC26
    function test_report_noPayoutPushesEverything() public {
        uint256 id = _create(2 ether);
        _buy(id, alice, 0.1 ether);
        _buy(id, bob, 0.2 ether);
        uint256 before = insurer.balance;
        _report(id, FDI.FlightStatus.Departed, 10);
        assertEq(insurer.balance - before, 2.3 ether);
        assertEq(address(fdi).balance, 0);
    }

    // AC27
    function test_report_rejectingInsurerGetsCredit() public {
        RejectingInsurer ri = new RejectingInsurer(fdi);
        uint256 id = ri.create{value: 1 ether}(dep, oracle);
        _buy(id, alice, 0.1 ether);
        vm.warp(dep);
        vm.expectEmit(true, false, false, true);
        emit FDI.InsurerPaid(id, 1.1 ether, false);
        vm.prank(oracle);
        fdi.report(id, FDI.FlightStatus.Departed, 0);
        assertEq(fdi.credit(address(ri)), 1.1 ether);

        ri.setAccept(true);
        ri.withdrawCredit();
        assertEq(address(ri).balance, 1.1 ether);
        assertEq(fdi.credit(address(ri)), 0);
        vm.expectRevert(FDI.ZeroAmount.selector);
        ri.withdrawCredit();
    }

    function test_report_gasHungryInsurerGetsCredit() public {
        GasHungryInsurer gi = new GasHungryInsurer(fdi);
        uint256 id = gi.create{value: 1 ether}(dep, oracle);
        _report(id, FDI.FlightStatus.Departed, 0);
        assertEq(fdi.credit(address(gi)), 1 ether);
        assertEq(address(gi).balance, 0);
    }

    // ---------------------------------------------------------------- expiry

    // AC28
    function test_expire_boundary() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        vm.warp(deadline);
        vm.prank(stranger);
        vm.expectRevert(FDI.ReportDeadlineNotPassed.selector);
        fdi.expire(id);
        vm.warp(deadline + 1);
        uint256 before = insurer.balance;
        vm.prank(stranger);
        fdi.expire(id);
        FDI.Offer memory o = fdi.getOffer(id);
        assertEq(uint8(o.outcome), uint8(FDI.Outcome.Expired));
        assertEq(o.settledAt, deadline + 1);
        assertEq(insurer.balance - before, 1 ether);
        assertEq(address(fdi).balance, 0.1 ether);
    }

    // AC29
    function test_claim_implicitExpiry() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        vm.warp(deadline + 1);
        uint256 before = alice.balance;
        vm.prank(alice);
        fdi.claim(id);
        assertEq(alice.balance - before, 0.1 ether);
        assertEq(uint8(fdi.getOffer(id).outcome), uint8(FDI.Outcome.Expired));
    }

    // AC30
    function test_expire_afterSettlementReverts() public {
        uint256 id = _create(1 ether);
        _report(id, FDI.FlightStatus.Departed, 0);
        vm.warp(deadline + 1);
        vm.expectRevert(FDI.AlreadySettled.selector);
        fdi.expire(id);
    }

    // ------------------------------------------------------- claims & sweep

    // AC31
    function test_claim_payout() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        _report(id, FDI.FlightStatus.Departed, 45);
        uint256 before = alice.balance;
        vm.prank(alice);
        fdi.claim(id);
        assertEq(alice.balance - before, 0.5 ether);
        vm.prank(alice);
        vm.expectRevert(FDI.AlreadyClaimed.selector);
        fdi.claim(id);
    }

    // AC32
    function test_claim_noPayoutReverts() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        _report(id, FDI.FlightStatus.Departed, 30);
        vm.prank(alice);
        vm.expectRevert(FDI.NothingToClaim.selector);
        fdi.claim(id);
    }

    // AC33
    function test_claim_refundAfterExplicitExpiry() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.15 ether);
        vm.warp(deadline + 1);
        fdi.expire(id);
        uint256 before = alice.balance;
        vm.prank(alice);
        fdi.claim(id);
        assertEq(alice.balance - before, 0.15 ether);
    }

    // AC34
    function test_claim_noPolicyOrUnsettled() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        vm.warp(deadline);
        vm.prank(alice);
        vm.expectRevert(FDI.NotSettled.selector);
        fdi.claim(id);
        _report(id, FDI.FlightStatus.Cancelled, 0);
        vm.prank(stranger);
        vm.expectRevert(FDI.NoPolicy.selector);
        fdi.claim(id);
    }

    // AC35
    function test_claim_windowBoundary() public {
        uint256 id = _create(2 ether);
        _buy(id, alice, 0.1 ether);
        _buy(id, bob, 0.1 ether);
        _report(id, FDI.FlightStatus.Cancelled, 0);
        uint256 s = _settledAt(id) + 90 days;
        vm.warp(s);
        vm.prank(alice);
        fdi.claim(id);
        vm.warp(s + 1);
        vm.prank(bob);
        vm.expectRevert(FDI.ClaimWindowClosed.selector);
        fdi.claim(id);
    }

    // AC36
    function test_sweep_boundary() public {
        uint256 id = _create(2 ether);
        _buy(id, alice, 0.1 ether);
        _buy(id, bob, 0.2 ether);
        _report(id, FDI.FlightStatus.Diverted, 0);
        vm.prank(alice);
        fdi.claim(id); // 0.5 claimed, bob's 1.0 unclaimed
        uint256 s = _settledAt(id) + 90 days;
        vm.warp(s);
        vm.prank(insurer);
        vm.expectRevert(FDI.ClaimWindowOpen.selector);
        fdi.sweep(id);
        vm.warp(s + 1);
        uint256 before = insurer.balance;
        vm.prank(insurer);
        fdi.sweep(id);
        assertEq(insurer.balance - before, 1 ether);
        assertEq(address(fdi).balance, 0);
        vm.prank(insurer);
        vm.expectRevert(FDI.AlreadySwept.selector);
        fdi.sweep(id);
        vm.prank(bob);
        vm.expectRevert(FDI.ClaimWindowClosed.selector);
        fdi.claim(id);
    }

    function test_sweep_expiredRefunds() public {
        uint256 id = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        vm.warp(deadline + 1);
        fdi.expire(id);
        vm.warp(block.timestamp + 90 days + 1);
        uint256 before = insurer.balance;
        vm.prank(insurer);
        fdi.sweep(id);
        assertEq(insurer.balance - before, 0.1 ether);
    }

    // AC37
    function test_sweep_nothingToSweep() public {
        uint256 id = _create(1 ether);
        uint256 id2 = _create(1 ether);
        _buy(id, alice, 0.1 ether);
        _report(id, FDI.FlightStatus.Departed, 31);
        vm.prank(alice);
        fdi.claim(id);
        vm.prank(oracle);
        fdi.report(id2, FDI.FlightStatus.Departed, 0); // NoPayout: nothing owed to holders
        vm.warp(_settledAt(id) + 90 days + 1);
        vm.prank(insurer);
        vm.expectRevert(FDI.NothingToSweep.selector);
        fdi.sweep(id);

        vm.prank(insurer);
        vm.expectRevert(FDI.NothingToSweep.selector);
        fdi.sweep(id2);
    }

    function test_sweep_unsettledReverts() public {
        uint256 id = _create(1 ether);
        vm.prank(insurer);
        vm.expectRevert(FDI.NotSettled.selector);
        fdi.sweep(id);
    }

    // AC40
    function test_reentrantClaimCannotDoubleSpend() public {
        uint256 id = _create(1 ether);
        ReentrantHolder rh = new ReentrantHolder(fdi);
        rh.buy{value: 0.1 ether}(id);
        _report(id, FDI.FlightStatus.Cancelled, 0);
        rh.doClaim();
        assertEq(address(rh).balance, 0.5 ether);
        assertEq(rh.reentries(), 1);
        assertEq(address(fdi).balance, 0);
    }
}
