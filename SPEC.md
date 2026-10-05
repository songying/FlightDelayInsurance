# Flight-Delay Insurance DApp — Specification

Settlement: native ETH on EVM. Stack: Solidity 0.8.x + Foundry; Next.js (TypeScript) + wagmi/viem + RainbowKit; Node/TS oracle bot (viem); local Anvil + Sepolia.

## 1. Roles
| Role | Who | Powers |
|---|---|---|
| **Insurer** | Any address that calls `createOffer` | Funds, tops up and withdraws free collateral for its own offers. Closes sales. Sweeps unclaimed funds after the claim deadline. Withdraws its credit balance. |
| **Policyholder** | Any address except that offer's insurer and oracle | Buys at most one policy per offer. Claims a payout or refund. |
| **Oracle** | The address the insurer names when creating the offer (EOA or contract; may be the insurer itself) | Submits exactly one final report per offer, inside the report window. Trusted, with no dispute. |
| **Anyone** | Any address | May call `expire` after the report deadline. Reads all views. |
| *(none)* | There is no owner, admin, pause, upgrade or protocol fee. | — |

## 2. Business rules
**Offer and flight identity**
- B1. One offer covers exactly one flight instance: `flightNumber` (string, 1–8 bytes, non-empty) plus `scheduledDeparture` (UTC unix seconds). The UI enforces the IATA format `^[A-Z0-9]{2}[0-9]{1,4}[A-Z]?$` and converts airport-local time + timezone into UTC. The contract does not validate the format.
- B2. These terms are immutable after creation: flightNumber, scheduledDeparture, oddsBps, capWei, oracle. To change terms, the insurer closes sales and creates a new offer.
- B3. Odds are in basis points: `10_000 < oddsBps ≤ 1_000_000` (more than 1.00x, at most 100.00x).
- B4. `capWei > 0` is the insurer's declared price of one full-fare business-class ticket on that flight, in ETH. The contract trusts it.
- B5. Creation requires `block.timestamp < scheduledDeparture − 43_200` (strictly before the sales cutoff), `oracle ≠ address(0)`, and the B1/B3/B4 checks. The initial deposit (`msg.value`) may be 0.

**Purchase**
- B6. Sales cutoff = `scheduledDeparture − 43_200` (12h). Purchase is allowed iff `block.timestamp ≤ cutoff` (inclusive), sales are not closed, and the offer is not settled.
- B7. `payout = floor(premium × oddsBps / 10_000)`. Requirements: `premium > 0`, `payout > premium`, `payout ≤ capWei` (otherwise revert; no clamping).
- B8. One policy per wallet per offer. A second purchase by the same address reverts.
- B9. The offer's insurer and the offer's oracle cannot buy on that offer.
- B10. Full collateralization: a purchase requires `freeCollateral ≥ payout − premium`. On success, `reserved += payout − premium`.
- B11. Policies cannot be transferred or cancelled.

**Delay and outcome**
- B12. Delay is the departure delay, measured against the `scheduledDeparture` stored in the offer. Later airline reschedules count as delay.
- B13. The oracle reports `(status ∈ {Departed, Cancelled, Diverted}, delayMinutes uint32)`. delayMinutes are whole minutes, floored. The contract stores both.
- B14. **Payout outcome** iff `status == Cancelled || status == Diverted || delayMinutes > 30` (strict). Otherwise the outcome is **NoPayout**. 30 minutes does not pay; 31 does.
- B15. The report window is `scheduledDeparture ≤ block.timestamp ≤ scheduledDeparture + 172_800` (48h, both ends inclusive). Only the oracle may report, only once, and the report is final.
- B16. Expiry: iff `block.timestamp > scheduledDeparture + 172_800` and no report exists, anyone may call `expire`. A holder's `claim` in that condition triggers expiry implicitly. The outcome is **Expired**: every holder gets a full premium refund, and the insurer gets all its collateral back.

**Claims and deadlines**
- B17. Claims are pull-based. "Triggered automatically" means the oracle report alone sets entitlement, and no claim form or proof is needed.
- B18. Claim window: `block.timestamp ≤ settledAt + 7_776_000` (90 days, inclusive). `settledAt` is the timestamp of the report tx or the expiry tx (explicit or implicit). This applies to both payouts and refunds.
- B19. Sweep: iff `block.timestamp > settledAt + 7_776_000`, the insurer may sweep all unclaimed holder entitlements once. Any later claim reverts.

**Insurer lifecycle**
- B20. `deposit` (top-up) is allowed any time before settlement. `withdrawCollateral(amount)` is allowed any time before settlement, for `amount ≤ freeCollateral`.
- B21. `closeSales` is insurer-only and irreversible, allowed iff sales are not already closed and the offer is not settled. Sold policies stay in force.
- B22. At settlement, the insurer's share is pushed in the same tx with a 30,000-gas stipend. If that transfer fails, the amount is credited to `credit[insurer]` (withdraw via `withdrawCredit`). Settlement can never be blocked by the insurer.

## 3. Money flows
Per-offer accounting: `collateral` (insurer funds: deposits − withdrawals), `premiums` (sum of premiums), `reserved` (sum of `payout − premium`), `totalPayout` (sum of payouts). `freeCollateral = collateral − reserved`. The pool balance is `collateral + premiums`.

| Event | Policyholder | Insurer | Stays in contract |
|---|---|---|---|
| createOffer / deposit | — | pays `msg.value` → collateral | +msg.value |
| withdrawCollateral | — | receives amount ≤ free | −amount |
| purchase | pays premium | reserved += payout − premium | +premium |
| report → Payout | each holder may claim `payout` | pushed `collateral − reserved` (free collateral) | totalPayout (owed to holders) |
| report → NoPayout | nothing | pushed `collateral + premiums` | 0 |
| expire | each holder may claim `premium` refund | pushed `collateral` (all of it, reserved included) | premiums (owed to holders) |
| claim | receives payout or refund | — | −amount |
| sweep (after 90 days) | forfeits unclaimed | receives unclaimed remainder | 0 |
| push failure | — | amount → `credit[insurer]`, later `withdrawCredit` | until withdrawn |

**Invariant:** contract balance ≥ Σ(unsettled offers: collateral + premiums) + Σ(settled offers: unclaimed and unswept holder entitlements) + Σ credit. Rounding is always floor, so leftover wei goes to the insurer's side, never to the holder's.

## 4. Public interface (contract `FlightDelayInsurance`)
Enums: `FlightStatus { Departed, Cancelled, Diverted }`, `Outcome { None, Payout, NoPayout, Expired }`.

| Function | Params | Caller | Notes |
|---|---|---|---|
| `createOffer` payable → `offerId` | `string flightNumber, uint64 scheduledDeparture, uint32 oddsBps, uint256 capWei, address oracle` | anyone (becomes insurer) | B1–B5. msg.value = initial collateral |
| `deposit` payable | `offerId` | insurer | B20. msg.value > 0 |
| `withdrawCollateral` | `offerId, uint256 amount` | insurer | B20 |
| `closeSales` | `offerId` | insurer | B21 |
| `buyPolicy` payable | `offerId` | anyone except insurer/oracle | B6–B10. msg.value = premium |
| `report` | `offerId, FlightStatus status, uint32 delayMinutes` | oracle | B13–B15, B22 |
| `expire` | `offerId` | anyone | B16, B22 |
| `claim` | `offerId` | policyholder | B16–B18. Pays payout (Payout) or premium (Expired). Reverts on NoPayout |
| `sweep` | `offerId` | insurer | B19. Reverts if there is nothing to sweep |
| `withdrawCredit` | — | anyone with credit > 0 | B22 |
| Views | `getOffer(offerId)`, `getPolicy(offerId, holder)`, `freeCollateral(offerId)`, `maxPremium(offerId)` = min(floor(cap×10000/odds), largest premium whose reservation fits in free collateral), `offerCount()`, `credit(addr)` | anyone | |

**Events:** `OfferCreated(offerId, insurer, oracle, flightNumber, scheduledDeparture, oddsBps, capWei, initialDeposit)`, `CollateralDeposited(offerId, amount)`, `CollateralWithdrawn(offerId, amount)`, `SalesClosed(offerId)`, `PolicyPurchased(offerId, holder, premium, payout)`, `Reported(offerId, status, delayMinutes, outcome)`, `Expired(offerId)`, `InsurerPaid(offerId, amount, pushed bool)`, `Claimed(offerId, holder, amount)`, `Swept(offerId, amount)`, `CreditWithdrawn(account, amount)`.

All state-changing functions use checks-effects-interactions and a reentrancy guard. Errors are custom errors, one per failed rule.

## 5. State machine
**Offer** (stored: `salesClosed`, `outcome`, `settledAt`, `swept`; phase derived from time):
```
Open ──closeSales / now > cutoff──▶ SalesEnded ──now ≥ dep──▶ AwaitingReport
AwaitingReport ──report (oracle, dep ≤ now ≤ dep+48h)──▶ Settled(Payout | NoPayout)
AwaitingReport ──now > dep+48h, expire / implicit via claim──▶ Settled(Expired)
Settled ──now > settledAt+90d, sweep──▶ Swept (terminal)
```
deposit and withdrawCollateral work in Open, SalesEnded and AwaitingReport. buyPolicy works only in Open.

**Policy:** `Active` → (Payout) `Won` → `Claimed` | `Forfeited` (swept); (NoPayout) `Lost` (terminal); (Expired) `Refundable` → `Refunded` | `Forfeited`.

## 6. Acceptance criteria (Given / When / Then)
Notation: `dep` = scheduledDeparture, `cutoff` = dep − 43,200, `D` = dep + 172,800, `S` = settledAt + 7,776,000.

**Creation**
1. Given now = cutoff − 1, when createOffer with valid params, then an offer is created and `OfferCreated` is emitted.
2. Given now = cutoff, when createOffer, then it reverts.
3. Given oddsBps = 10,000, when createOffer, then it reverts. Given 10,001, it succeeds.
4. Given oddsBps = 1,000,000, it succeeds. Given 1,000,001, it reverts.
5. Given capWei = 0, oracle = 0x0, an empty flightNumber, or a 9-byte flightNumber, when createOffer, then it reverts in each case. Given an 8-byte flightNumber, it succeeds.
6. Given msg.value = 0, when createOffer, then it succeeds with collateral = 0.

**Purchase**
7. Given now = cutoff and enough free collateral, when a buyer pays a valid premium, then the policy is created and `reserved` increases by payout − premium.
8. Given now = cutoff + 1, when buyPolicy, then it reverts.
9. Given odds 5.00x and cap 1 ETH, when premium = 0.2 ETH (payout = 1 ETH = cap), then it succeeds. When premium = 0.2 ETH + 1 wei, then it reverts.
10. Given premium = 0, then it reverts. Given oddsBps = 10,001 and premium = 1 wei (payout floors to 1 = premium), then it reverts.
11. Given free collateral = payout − premium exactly, then it succeeds and free becomes 0. Given free 1 wei less, it reverts.
12. Given the buyer already holds a policy on the offer, when buying again, then it reverts. Buying on a different offer succeeds.
13. Given msg.sender is the offer's insurer or its oracle, when buyPolicy, then it reverts.
14. Given sales were closed, when buyPolicy before the cutoff, then it reverts.

**Insurer lifecycle**
15. Given free = X before settlement, when withdrawCollateral(X), then it succeeds. withdrawCollateral(X + 1) reverts.
16. Given a non-insurer, when deposit, withdrawCollateral, closeSales or sweep, then it reverts.
17. Given closeSales already called, when closeSales again, then it reverts. Existing policies are unaffected.
18. Given the offer is settled, when deposit or withdrawCollateral, then it reverts.

**Report**
19. Given now = dep − 1, when the oracle reports, then it reverts. Given now = dep, it succeeds.
20. Given now = D, when the oracle reports, then it succeeds. Given now = D + 1, it reverts.
21. Given a non-oracle caller, when report, then it reverts.
22. Given the offer is already reported or expired, when report, then it reverts.
23. Given Departed with delayMinutes = 30, then the outcome is NoPayout. Given 31, the outcome is Payout. Given 0, NoPayout.
24. Given Cancelled or Diverted (any delayMinutes, including 0), then the outcome is Payout.
25. Given outcome Payout, then the insurer is pushed `collateral − reserved` in the same tx and `InsurerPaid(pushed=true)` is emitted.
26. Given outcome NoPayout, then the insurer is pushed `collateral + premiums`.
27. Given an insurer contract that reverts on receive (or uses more than 30,000 gas), when the oracle reports, then the report still succeeds, `credit[insurer]` grows by the share, `InsurerPaid(pushed=false)` is emitted, and withdrawCredit later pays it out.

**Expiry**
28. Given no report and now = D, when expire, then it reverts. Given now = D + 1, anyone may expire: outcome Expired, insurer pushed all `collateral`, settledAt = now.
29. Given no report, now > D and expire not yet called, when a holder claims, then expiry happens implicitly and the holder is refunded the premium.
30. Given the offer is already settled, when expire, then it reverts.

**Claims and sweep**
31. Given outcome Payout, when a holder claims, then they receive exactly their `payout`, and a second claim reverts.
32. Given outcome NoPayout, when a holder claims, then it reverts.
33. Given outcome Expired, when a holder claims, then they receive exactly their `premium`.
34. Given an address without a policy, when claim, then it reverts. Given an unsettled offer with now ≤ D, claim reverts.
35. Given now = S, when a holder claims, then it succeeds. Given now = S + 1, claim reverts.
36. Given now = S, when sweep, then it reverts. Given now = S + 1, the insurer receives exactly the unclaimed entitlements and a second sweep reverts.
37. Given every holder has claimed, when sweep after S, then it reverts (nothing to sweep).

**Invariants (fuzz)**
38. Given any sequence of valid actions, the contract balance always covers every outstanding obligation (the §3 invariant), and the total ETH paid out never exceeds the total ETH paid in.
39. Given any offer, `reserved ≤ collateral` always holds before settlement.
40. Given re-entrant receivers on claim, sweep, withdrawCollateral or withdrawCredit, then a re-entrant call reverts or cannot extract extra funds.

**Front end**
41. Given a connected wallet, the Browse view lists offers with flight number, date, departure in local time and UTC, odds (×), cap, max premium, free capacity, oracle address, sales-close countdown and phase. It can filter by flight number and date.
42. Given an offer in Open, the buy form shows the computed payout live, blocks premiums above `maxPremium`, and hides itself for the insurer and oracle wallets.
43. Given an insurer wallet, the Insurer dashboard creates offers (IATA validation, local time + timezone → UTC, rejects departures within 12h) and supports deposit, withdraw free collateral, close sales and sweep (enabled only after S). It shows collateral, reserved, free, premiums, policy count, outcome and credit balance with a withdraw-credit button.
44. Given a holder wallet, the Policyholder dashboard lists its policies with premium, payout, status (Active/Won/Lost/Refundable/Claimed/Refunded/Forfeited), a claim/refund button, and a countdown to S.
45. Given the oracle wallet, the Oracle console lists the offers that name it, enables reporting only while dep ≤ now ≤ D, and takes status + delayMinutes, showing the resulting outcome before submission.
46. The UI uses only on-chain data, with no external flight API.

**Oracle bot**
47. Given env `ORACLE_PRIVATE_KEY`, `RPC_URL`, `CONTRACT_ADDRESS` and `RAPIDAPI_KEY`, when the cron run executes, then for every unsettled offer naming the bot's address with dep ≤ now ≤ D, it queries AeroDataBox. Once actual departure (or cancelled/diverted) is known, it reports `delayMinutes = floor(max(0, actual − dep) / 60)`.
48. Given no data is available by dep + 47h, then the bot logs an alert and does not report a guessed value.
49. Given the offer has already been reported, the bot skips it (idempotent).

**Deployment**
50. A Foundry deploy script deploys to Sepolia and verifies the source. The front end reads the address from config for Anvil (31337) and Sepolia (11155111).

## 7. Out of scope
KYC or identity (per-wallet caps are bypassable with multiple wallets, accepted). ERC-20 or stablecoin payments. Fiat price feeds or verifying the business-fare cap. Oracle disputes, arbitration, multi-oracle consensus, oracle staking or reputation. Arrival delay. Policy transfer or a secondary market. Holder cancellation. Editing offer terms. Admin, pause, upgradeability, protocol fees. Push payouts to holders. Offers covering multiple dates. Live flight status in the UI. Mainnet deployment. Security audit. Mobile apps. Notifications.

## 8. Open questions
None.
