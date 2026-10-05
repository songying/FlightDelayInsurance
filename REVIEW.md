# Review of PR #9: `FlightDelayInsurance` contract

Reviewed at `db4561e` on `feat/2-contract`, checked against SPEC.md and PLAN.md.
Baseline: `forge test` passes all 46 tests (45 unit/fuzz tests and 1 invariant suite).
The reproducing tests are in `contracts/test/Review.t.sol`. All 7 fail against this PR, and that is intended:
`forge test --match-contract ReviewTest -vv`

**Summary:** I found no High-severity issues and no way to steal funds, break solvency or double-spend. There are 5 findings: 1 Medium (the `maxPremium` view) and 4 Low (spec conformance). Nothing has been fixed.

---

## R1 — Insurer push actually gets 32,300 gas, not 30,000 (Low)

- **File:** `contracts/src/FlightDelayInsurance.sol:376-378` (`_payInsurer`)
- **Spec:** B22 says "a 30,000-gas stipend". AC27 says an insurer that "uses more than 30,000 gas" gets credited.
- **Failure scenario:** `call(30_000, insurer, amount, …)` sends a non-zero value, so the EVM adds the 2,300-gas `CALL` stipend and the callee receives 32,300 gas. If the insurer's `receive` uses between about 30,000 and 32,300 gas, the push succeeds (`InsurerPaid(pushed=true)`) when AC27 says it should be credited (`pushed=false`). No funds are lost because the insurer still gets paid. But the behaviour does not match the acceptance criterion, and the existing test (`test_report_gasHungryInsurerGetsCredit`, about 110k gas) is far from the edge, so it doesn't catch this.
- **Suggested direction:** pass `INSURER_PUSH_GAS - 2300` as the gas argument, or change the spec to say "30,000 + 2,300 stipend".
- **Failing test:** `test_review_pushGivesInsurerMoreThan30kGas`

## R2 — `maxPremium` can return a premium that cannot be bought (Medium)

- **File:** `contracts/src/FlightDelayInsurance.sol:322-331`, `_largestBelow` at `:360-363`
- **Spec:** §4 defines `maxPremium` as the largest buyable premium. AC42 has the UI block premiums above `maxPremium`.
- **Failure scenario:** `maxPremium` bounds the premium by cap and by reservation, but it never applies B7's `payout > premium`.
  - An offer with odds 1.5x and 0 collateral (allowed by AC6) has nothing buyable, because any purchase needs a reservation of at least 1 wei. `maxPremium` still returns `1`, and `buyPolicy{value: 1}` reverts with `PayoutNotAbovePremium`. In general, when free collateral is 0 and `oddsBps < 20_000`, it returns `floor(9_999 / (odds − 10_000)) > 0`.
  - With a cap of 1 wei and odds 1.5x, `byCap = 1`, but a premium of 1 pays 1, which is not above the premium, so it reverts.

  The front end then shows a buyable range in which every purchase reverts.
- **Why the suite misses it:** `test_maxPremium_isBuyable_fuzz` (`contracts/test/FlightDelayInsurance.t.sol:326`) does `vm.assume(payout > m)`, which skips exactly the inputs where `maxPremium` is wrong.
- **Failing tests:** `test_review_maxPremiumNonZeroWithZeroCollateral`, `test_review_maxPremiumNotBuyableWhenCapBinds`

## R3 — `maxPremium` cap bound differs from the SPEC.md formula (Low, needs a spec decision)

- **File:** `contracts/src/FlightDelayInsurance.sol:327`
- **Spec:** §4 says `maxPremium = min(floor(cap×10000/odds), …)`.
- **Failure scenario:** the code uses `floor(((cap+1)×10000 − 1)/odds)`, which is the largest `p` with `floor(p×odds/10000) ≤ cap`. With cap = 10 wei and odds = 15,000, the spec formula gives 6 and the code gives 7. A premium of 7 pays `floor(10.5) = 10 ≤ cap`, so it really is buyable under B7. The code is arguably more correct than the spec, but the two disagree. Under CLAUDE.md ("if code and spec disagree, stop and ask"), the owner should either amend §4 or change the code.
- **Failing test:** `test_review_maxPremiumMatchesSpecFormula` (encodes the spec as written)

## R4 — `deposit`, `closeSales`, `buyPolicy` and `createOffer` have no reentrancy guard (Low)

- **File:** `contracts/src/FlightDelayInsurance.sol:136`, `:166`, `:186`, `:210`
- **Spec:** §4 says "All state-changing functions use checks-effects-interactions and a reentrancy guard."
- **Failure scenario:** only the six functions that send ETH are `nonReentrant`. During an outgoing `_send`, a receiver can re-enter the unguarded functions:
  - an insurer contract can call `deposit` and `closeSales` on another offer from inside `withdrawCollateral`;
  - a holder contract can call `buyPolicy` on another offer from inside `claim`.

  I found no exploit, because each of these functions only adds funds or flips its own flag, and every ETH-sending path updates state before the call. It is still a literal contradiction of §4, and it leaves the safety argument resting on CEI alone.
- **Failing tests:** `test_review_depositAndCloseSalesLackReentrancyGuard`, `test_review_buyPolicyLacksReentrancyGuard`

## R5 — Different rules share one custom error (Low)

- **File:** `contracts/src/FlightDelayInsurance.sol:212`
- **Spec:** §4 says "Errors are custom errors, one per failed rule."
- **Failure scenario:** `buyPolicy` reverts with `SalesNotOpen` for three different rules: sales closed (B21), cutoff passed (B6) and offer settled. `AlreadySettled` and `ZeroAmount` are also shared across several functions. Callers and the UI cannot tell from the revert why a purchase failed.
- **Failing test:** `test_review_closedSalesAndCutoffShareOneError`

---

## Checked and found correct

**Re-entrancy**
- The custom `nonReentrant` (`:126-131`) is correct. It checks, sets 2, and resets to 1 on success. A revert rolls the lock back, and it starts at 1.
- It is applied to every function that sends ETH: `withdrawCollateral`, `sweep`, `claim`, `report`, `expire` and `withdrawCredit`.
- The insurer push inside `report`, `expire` and implicit expiry in `claim` runs while the lock is held. The insurer cannot re-enter any ETH-sending function, and if it tries, the push fails and is credited.
- `outcome` and `settledAt` are written before the push. `claimed`, `claimedAmount`, `swept`, `collateral` and `credit = 0` are all written before `_send`.
- The only write after the push is `credit += amount`. It runs only when the call failed, and the lock is held, so it is safe.

**Access control**
- `report` checks `msg.sender == o.oracle` and `outcome == None`.
- `deposit`, `withdrawCollateral`, `closeSales` and `sweep` all go through `_insurerOffer`.
- `buyPolicy` blocks both the insurer and the oracle (B9).
- `expire` is open to anyone, and `withdrawCredit` is keyed on `msg.sender`.
- There is no owner, admin or pause.

**Unbounded loops**
- There are no loops in the contract. `flightNumber` is capped at 8 bytes.

**Solvency**
- Purchases check reservation ≤ `collateral − reserved`, and withdrawals check `amount ≤ collateral − reserved`, so `reserved ≤ collateral` always holds and locked collateral can never be withdrawn.
- **Payout:** the push of `collateral − reserved` leaves `reserved + premiums = totalPayout` in the contract.
- **NoPayout:** the insurer is pushed everything and nothing is owed.
- **Expired:** the insurer is pushed `collateral` and `premiums` stay for refunds.
- **Sweep:** pays `entitlement − claimedAmount` once.
- **Failed push:** the ETH stays in the contract and is matched by `credit`.
- No path pays out more than it holds. The 30k-gas push cannot be griefed into blocking settlement: forcing the callee below 30k would leave the caller too little gas for the `credit` SSTORE, so the whole transaction reverts.

**Rounding**
- `payout = floor(premium × odds / 10000)`, and `payout > premium` and `payout ≤ cap` are checked on the floored value.
- `reservation = payout − premium` equals `floor(p(odds−10000)/10000)`, so the derivation behind `byCollateral` is right.
- There is no overflow: the premium is bounded by ETH supply and the odds are at most 1e6. `_largestBelow` saturates before `(limit+1)×BPS` could overflow.

**Time edges (all match SPEC)**
- create: `now < cutoff`
- buy: `now ≤ cutoff`
- report: `dep ≤ now ≤ D`
- expire and implicit expiry: `now > D`
- claim: `now ≤ settledAt + 90d`
- sweep: `now > settledAt + 90d`

The report and expiry windows don't overlap at D, and the claim and sweep windows don't overlap at S. A departure before `SALES_CUTOFF` is guarded against underflow.

**State machine**
- Claiming before a report reverts with `NotSettled` while `now ≤ D`.
- `report` after expiry and `expire` after a report both revert with `AlreadySettled`.
- A second claim reverts with `AlreadyClaimed`, and a claim on a NoPayout offer reverts with `NothingToClaim`.
- `deposit`, `withdrawCollateral` and `closeSales` revert after settlement, and `buyPolicy` reverts after settlement.
- A second sweep reverts with `AlreadySwept`, and claiming after a sweep reverts.
- A sweep on NoPayout or with everything claimed reverts with `NothingToSweep`.

**Credit fallback (AC27)**
- An insurer that rejects ETH or uses well over the limit gets credited, `InsurerPaid(false)` is emitted, and `withdrawCredit` pays with full gas.
- Returndata is not copied, so a return bomb has no effect.

**ETH sending**
- ETH is sent with `call` everywhere. There is no `transfer` or `send`.

## Test-suite observations (not separate findings)

- `invariant_solvent` leaves out `Σ credit`, and the handler never uses contract insurers, so the credit path is never exercised under the invariants. Its exact-equality assert would break if it were.
- The handler has no re-entrant actors, so AC40 is covered only by the single `test_reentrantClaimCannotDoubleSpend`. Nothing tests re-entry on `sweep`, `withdrawCollateral` or `withdrawCredit`.
- `getOffer` still returns the pre-settlement `collateral` after settlement, even though it has been pushed. That is harmless on-chain, but the AC43 dashboard should read `freeCollateral` or `outcome` and not show `collateral` as held funds.
