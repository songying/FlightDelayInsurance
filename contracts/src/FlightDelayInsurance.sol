// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FlightDelayInsurance
/// @notice Peer-to-peer flight-delay insurance settled in native ETH. See SPEC.md.
/// @dev Fully collateralized, permissionless, non-upgradeable. No owner, no fee.
contract FlightDelayInsurance {
    // ---------------------------------------------------------------- constants

    uint256 public constant BPS = 10_000;
    uint32 public constant MAX_ODDS_BPS = 1_000_000; // 100.00x
    uint64 public constant SALES_CUTOFF = 12 hours; // 43_200
    uint64 public constant REPORT_WINDOW = 48 hours; // 172_800
    uint64 public constant CLAIM_WINDOW = 90 days; // 7_776_000
    uint32 public constant DELAY_THRESHOLD_MINUTES = 30;
    uint256 public constant INSURER_PUSH_GAS = 30_000;
    uint256 public constant MAX_FLIGHT_NUMBER_LENGTH = 8;

    // -------------------------------------------------------------------- types

    enum FlightStatus {
        Departed,
        Cancelled,
        Diverted
    }

    enum Outcome {
        None,
        Payout,
        NoPayout,
        Expired
    }

    struct Offer {
        address insurer;
        address oracle;
        uint64 scheduledDeparture;
        uint32 oddsBps;
        bool salesClosed;
        bool swept;
        Outcome outcome;
        FlightStatus reportedStatus;
        uint32 reportedDelayMinutes;
        uint64 settledAt;
        uint256 capWei;
        uint256 collateral; // insurer funds: deposits - withdrawals
        uint256 reserved; // sum of (payout - premium)
        uint256 premiums; // sum of premiums
        uint256 totalPayout; // sum of payouts
        uint256 claimedAmount; // paid out to holders after settlement
        uint256 policyCount;
        string flightNumber;
    }

    struct Policy {
        uint256 premium; // 0 means no policy
        uint256 payout;
        bool claimed;
    }

    // -------------------------------------------------------------------- state

    Offer[] private _offers;
    mapping(uint256 offerId => mapping(address holder => Policy)) private _policies;
    mapping(address account => uint256) public credit;
    uint256 private _locked = 1;

    // ------------------------------------------------------------------- events

    event OfferCreated(
        uint256 indexed offerId,
        address indexed insurer,
        address indexed oracle,
        string flightNumber,
        uint64 scheduledDeparture,
        uint32 oddsBps,
        uint256 capWei,
        uint256 initialDeposit
    );
    event CollateralDeposited(uint256 indexed offerId, uint256 amount);
    event CollateralWithdrawn(uint256 indexed offerId, uint256 amount);
    event SalesClosed(uint256 indexed offerId);
    event PolicyPurchased(uint256 indexed offerId, address indexed holder, uint256 premium, uint256 payout);
    event Reported(uint256 indexed offerId, FlightStatus status, uint32 delayMinutes, Outcome outcome);
    event Expired(uint256 indexed offerId);
    event InsurerPaid(uint256 indexed offerId, uint256 amount, bool pushed);
    event Claimed(uint256 indexed offerId, address indexed holder, uint256 amount);
    event Swept(uint256 indexed offerId, uint256 amount);
    event CreditWithdrawn(address indexed account, uint256 amount);

    // ------------------------------------------------------------------- errors

    error Reentrancy();
    error OfferNotFound();
    error InvalidFlightNumber();
    error InvalidOdds();
    error InvalidCap();
    error InvalidOracle();
    error TooLateToCreate();
    error NotInsurer();
    error NotOracle();
    error ZeroAmount();
    error AlreadySettled();
    error InsufficientFreeCollateral();
    error SalesAlreadyClosed();
    error SalesNotOpen();
    error InsurerOrOracleCannotBuy();
    error AlreadyHasPolicy();
    error PayoutNotAbovePremium();
    error PayoutExceedsCap();
    error ReportWindowNotOpen();
    error ReportWindowClosed();
    error ReportDeadlineNotPassed();
    error NoPolicy();
    error NotSettled();
    error NothingToClaim();
    error AlreadyClaimed();
    error ClaimWindowClosed();
    error ClaimWindowOpen();
    error NothingToSweep();
    error AlreadySwept();
    error TransferFailed();

    // ---------------------------------------------------------------- modifiers

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ------------------------------------------------------------------ insurer

    /// @notice Create an offer for one flight instance. msg.value is the initial collateral (may be 0).
    function createOffer(
        string calldata flightNumber,
        uint64 scheduledDeparture,
        uint32 oddsBps,
        uint256 capWei,
        address oracle
    ) external payable returns (uint256 offerId) {
        uint256 len = bytes(flightNumber).length;
        if (len == 0 || len > MAX_FLIGHT_NUMBER_LENGTH) revert InvalidFlightNumber();
        if (oddsBps <= BPS || oddsBps > MAX_ODDS_BPS) revert InvalidOdds();
        if (capWei == 0) revert InvalidCap();
        if (oracle == address(0)) revert InvalidOracle();
        if (uint256(scheduledDeparture) < SALES_CUTOFF || block.timestamp >= scheduledDeparture - SALES_CUTOFF) {
            revert TooLateToCreate();
        }

        offerId = _offers.length;
        Offer storage o = _offers.push();
        o.insurer = msg.sender;
        o.oracle = oracle;
        o.scheduledDeparture = scheduledDeparture;
        o.oddsBps = oddsBps;
        o.capWei = capWei;
        o.collateral = msg.value;
        o.flightNumber = flightNumber;

        emit OfferCreated(offerId, msg.sender, oracle, flightNumber, scheduledDeparture, oddsBps, capWei, msg.value);
    }

    /// @notice Top up an offer's collateral. Allowed any time before settlement.
    function deposit(uint256 offerId) external payable {
        Offer storage o = _insurerOffer(offerId);
        if (msg.value == 0) revert ZeroAmount();
        if (o.outcome != Outcome.None) revert AlreadySettled();
        o.collateral += msg.value;
        emit CollateralDeposited(offerId, msg.value);
    }

    /// @notice Withdraw unreserved collateral. Allowed any time before settlement.
    function withdrawCollateral(uint256 offerId, uint256 amount) external nonReentrant {
        Offer storage o = _insurerOffer(offerId);
        if (amount == 0) revert ZeroAmount();
        if (o.outcome != Outcome.None) revert AlreadySettled();
        if (amount > o.collateral - o.reserved) revert InsufficientFreeCollateral();
        o.collateral -= amount;
        emit CollateralWithdrawn(offerId, amount);
        _send(msg.sender, amount);
    }

    /// @notice Irreversibly stop new sales. Sold policies stay in force.
    function closeSales(uint256 offerId) external {
        Offer storage o = _insurerOffer(offerId);
        if (o.outcome != Outcome.None) revert AlreadySettled();
        if (o.salesClosed) revert SalesAlreadyClosed();
        o.salesClosed = true;
        emit SalesClosed(offerId);
    }

    /// @notice After the 90-day claim window, collect all unclaimed holder entitlements.
    function sweep(uint256 offerId) external nonReentrant {
        Offer storage o = _insurerOffer(offerId);
        if (o.outcome == Outcome.None) revert NotSettled();
        if (o.swept) revert AlreadySwept();
        if (block.timestamp <= uint256(o.settledAt) + CLAIM_WINDOW) revert ClaimWindowOpen();
        uint256 amount = _entitlementTotal(o) - o.claimedAmount;
        if (amount == 0) revert NothingToSweep();
        o.swept = true;
        emit Swept(offerId, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------- policyholder

    /// @notice Buy one policy. msg.value is the premium; payout = floor(premium * oddsBps / 10_000).
    function buyPolicy(uint256 offerId) external payable {
        Offer storage o = _offer(offerId);
        if (o.outcome != Outcome.None || o.salesClosed || block.timestamp > _cutoff(o)) revert SalesNotOpen();
        if (msg.sender == o.insurer || msg.sender == o.oracle) revert InsurerOrOracleCannotBuy();
        Policy storage p = _policies[offerId][msg.sender];
        if (p.premium != 0) revert AlreadyHasPolicy();
        if (msg.value == 0) revert ZeroAmount();

        uint256 payout = (msg.value * o.oddsBps) / BPS;
        if (payout <= msg.value) revert PayoutNotAbovePremium();
        if (payout > o.capWei) revert PayoutExceedsCap();
        uint256 reservation = payout - msg.value;
        if (reservation > o.collateral - o.reserved) revert InsufficientFreeCollateral();

        o.reserved += reservation;
        o.premiums += msg.value;
        o.totalPayout += payout;
        o.policyCount += 1;
        p.premium = msg.value;
        p.payout = payout;

        emit PolicyPurchased(offerId, msg.sender, msg.value, payout);
    }

    /// @notice Claim a payout (Payout outcome) or premium refund (Expired outcome).
    /// @dev If the report deadline has passed with no report, expires the offer first.
    function claim(uint256 offerId) external nonReentrant {
        Offer storage o = _offer(offerId);
        Policy storage p = _policies[offerId][msg.sender];
        if (p.premium == 0) revert NoPolicy();

        if (o.outcome == Outcome.None) {
            if (block.timestamp <= _reportDeadline(o)) revert NotSettled();
            _expire(offerId, o);
        }
        if (o.outcome == Outcome.NoPayout) revert NothingToClaim();
        if (p.claimed) revert AlreadyClaimed();
        if (o.swept || block.timestamp > uint256(o.settledAt) + CLAIM_WINDOW) revert ClaimWindowClosed();

        uint256 amount = o.outcome == Outcome.Payout ? p.payout : p.premium;
        p.claimed = true;
        o.claimedAmount += amount;
        emit Claimed(offerId, msg.sender, amount);
        _send(msg.sender, amount);
    }

    // ------------------------------------------------------------------- oracle

    /// @notice Submit the single, final flight report. Window: [departure, departure + 48h].
    function report(uint256 offerId, FlightStatus status, uint32 delayMinutes) external nonReentrant {
        Offer storage o = _offer(offerId);
        if (msg.sender != o.oracle) revert NotOracle();
        if (o.outcome != Outcome.None) revert AlreadySettled();
        if (block.timestamp < o.scheduledDeparture) revert ReportWindowNotOpen();
        if (block.timestamp > _reportDeadline(o)) revert ReportWindowClosed();

        bool pays = status != FlightStatus.Departed || delayMinutes > DELAY_THRESHOLD_MINUTES;
        Outcome outcome = pays ? Outcome.Payout : Outcome.NoPayout;
        o.outcome = outcome;
        o.reportedStatus = status;
        o.reportedDelayMinutes = delayMinutes;
        o.settledAt = uint64(block.timestamp);
        emit Reported(offerId, status, delayMinutes, outcome);

        // Payout: holders are owed totalPayout = reserved + premiums; insurer gets free collateral.
        // NoPayout: insurer gets everything.
        uint256 insurerShare = pays ? o.collateral - o.reserved : o.collateral + o.premiums;
        _payInsurer(offerId, o.insurer, insurerShare);
    }

    // ------------------------------------------------------------------- anyone

    /// @notice Expire an offer whose oracle missed the report deadline. Holders get refunds.
    function expire(uint256 offerId) external nonReentrant {
        Offer storage o = _offer(offerId);
        if (o.outcome != Outcome.None) revert AlreadySettled();
        if (block.timestamp <= _reportDeadline(o)) revert ReportDeadlineNotPassed();
        _expire(offerId, o);
    }

    /// @notice Withdraw ETH credited after a failed push to an insurer.
    function withdrawCredit() external nonReentrant {
        uint256 amount = credit[msg.sender];
        if (amount == 0) revert ZeroAmount();
        credit[msg.sender] = 0;
        emit CreditWithdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    // -------------------------------------------------------------------- views

    function offerCount() external view returns (uint256) {
        return _offers.length;
    }

    function getOffer(uint256 offerId) external view returns (Offer memory) {
        return _offer(offerId);
    }

    function getPolicy(uint256 offerId, address holder) external view returns (Policy memory) {
        _offer(offerId);
        return _policies[offerId][holder];
    }

    function freeCollateral(uint256 offerId) public view returns (uint256) {
        Offer storage o = _offer(offerId);
        if (o.outcome != Outcome.None) return 0;
        return o.collateral - o.reserved;
    }

    /// @notice Largest premium buyable right now, limited by both the cap and free collateral.
    ///         Returns 0 when sales are not open.
    function maxPremium(uint256 offerId) external view returns (uint256) {
        Offer storage o = _offer(offerId);
        if (o.outcome != Outcome.None || o.salesClosed || block.timestamp > _cutoff(o)) return 0;
        uint256 odds = o.oddsBps;
        // Largest p with floor(p * odds / BPS) <= cap  <=>  p * odds < (cap + 1) * BPS
        uint256 byCap = _largestBelow(o.capWei, odds);
        // Largest p with floor(p * (odds - BPS) / BPS) <= free  (the reservation)
        uint256 byCollateral = _largestBelow(o.collateral - o.reserved, odds - BPS);
        return byCap < byCollateral ? byCap : byCollateral;
    }

    // ----------------------------------------------------------------- internal

    function _offer(uint256 offerId) internal view returns (Offer storage) {
        if (offerId >= _offers.length) revert OfferNotFound();
        return _offers[offerId];
    }

    function _insurerOffer(uint256 offerId) internal view returns (Offer storage o) {
        o = _offer(offerId);
        if (msg.sender != o.insurer) revert NotInsurer();
    }

    function _cutoff(Offer storage o) internal view returns (uint256) {
        return uint256(o.scheduledDeparture) - SALES_CUTOFF;
    }

    function _reportDeadline(Offer storage o) internal view returns (uint256) {
        return uint256(o.scheduledDeparture) + REPORT_WINDOW;
    }

    function _entitlementTotal(Offer storage o) internal view returns (uint256) {
        if (o.outcome == Outcome.Payout) return o.totalPayout;
        if (o.outcome == Outcome.Expired) return o.premiums;
        return 0;
    }

    /// @dev Largest p such that floor(p * mul / BPS) <= limit, saturating on overflow.
    function _largestBelow(uint256 limit, uint256 mul) internal pure returns (uint256) {
        if (limit >= type(uint256).max / BPS - 1) return type(uint256).max / BPS;
        return ((limit + 1) * BPS - 1) / mul;
    }

    function _expire(uint256 offerId, Offer storage o) internal {
        o.outcome = Outcome.Expired;
        o.settledAt = uint64(block.timestamp);
        emit Expired(offerId);
        _payInsurer(offerId, o.insurer, o.collateral);
    }

    /// @dev Push with a gas stipend; on failure credit the insurer so settlement can never be blocked.
    function _payInsurer(uint256 offerId, address insurer, uint256 amount) internal {
        bool ok = true;
        if (amount != 0) {
            uint256 gasLimit = INSURER_PUSH_GAS;
            assembly {
                ok := call(gasLimit, insurer, amount, 0, 0, 0, 0)
            }
            if (!ok) credit[insurer] += amount;
        }
        emit InsurerPaid(offerId, amount, ok);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
