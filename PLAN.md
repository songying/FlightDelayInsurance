# Delivery plan

Source of truth: [SPEC.md](SPEC.md). Milestones follow SPEC.md §6 (acceptance criteria).
Every milestone is tracked as a GitHub issue labelled `milestone` and lands on `main` through a pull request.
Contract commands run from `contracts/`.

## Milestones

| # | Milestone | Criteria | Files | Proving command |
|---|---|---|---|---|
| M1 | Offers, purchases and insurer lifecycle | 1–18 | `contracts/src/FlightDelayInsurance.sol`, `contracts/test/FlightDelayInsurance.t.sol` | `forge test --match-test "test_(create\|buy\|maxPremium\|withdrawCollateral\|deposit\|insurerOnly\|closeSales\|unknownOffer)" -vvv` |
| M2 | Report, expiry, claims and sweep | 19–37 | `contracts/src/FlightDelayInsurance.sol`, `contracts/test/FlightDelayInsurance.t.sol` | `forge test --match-test "test_(report\|expire\|claim\|sweep)" -vvv` |
| M3 | Invariants and re-entrancy fuzz tests | 38–40 | `contracts/test/Invariant.t.sol`, `contracts/test/FlightDelayInsurance.t.sol` | `forge test --match-test "test_reentrant\|invariant_" -vvv` |
| M4 | Front end (Browse, Insurer, My policies, Oracle) | 41–46 | `web/src/app/**`, `web/src/components/**`, `web/src/hooks/useFdi.ts`, `web/src/lib/{domain,config}.ts` | `cd web && npm test && npm run typecheck && npm run build`, plus a manual walkthrough against Anvil |
| M5 | Reference oracle bot | 47–49 | `oracle-bot/src/{run,decide,aerodatabox,flightData}.ts` | `cd oracle-bot && npm test && npm run typecheck` |
| M6 | Sepolia deployment (later; not in this iteration) | 50 | `contracts/script/Deploy.s.sol`, `web/.env.example` | `forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify` |

Full contract suite: `forge test -vvv`. CI (`.github/workflows/test.yml`) runs `forge fmt --check`, `forge build --sizes` and `forge test -vvv` on every push and pull request.

## Risk register

| Risk | What could go wrong | Mitigation | Covered by |
|---|---|---|---|
| Re-entrancy | A holder or insurer re-enters `claim`/`sweep`/`withdraw*` from `receive` and drains funds | `nonReentrant` on every ETH-sending function; state updated before the transfer (checks-effects-interactions) | `test_reentrantClaimCannotDoubleSpend` |
| Oracle access control | Someone other than the designated oracle settles, or the oracle reports twice | `report` requires `msg.sender == oracle` and `outcome == None` | `test_report_onlyOracle`, `test_report_onlyOnce` |
| Solvency | Contract owes more ETH than it holds; insurer withdraws reserved collateral | Full collateralization: purchase reserves `payout − premium`; withdraw limited to free collateral | `invariant_solvent`, `invariant_noValueCreated`, `invariant_reservedWithinCollateral`, `test_buy_collateralBoundary`, `test_withdrawCollateral_boundary` |
| Rounding | Floor division lets payout ≤ premium or exceed the cap by a wei; UI max premium not buyable | Payout floored, `payout > premium` and `payout ≤ cap` checked on the floored value; `maxPremium` derived from the same inequality | `test_buy_zeroPremiumAndRounding`, `test_buy_capBoundary`, `test_maxPremium_isBuyable_fuzz` |
| Time boundaries | Off-by-one at sales cutoff, report window, expiry or 90-day claim deadline | Every edge is inclusive/exclusive exactly as SPEC.md §2 states; each edge tested at `t` and `t ± 1` | `test_create_atCutoffReverts`, `test_buy_atCutoff`, `test_buy_afterCutoffReverts`, `test_report_windowOpen`, `test_report_windowClose`, `test_expire_boundary`, `test_claim_windowBoundary`, `test_sweep_boundary` |
| Push-payment failure | An insurer contract that rejects ETH (or burns gas) blocks the oracle's report | Push to insurer with a 30,000-gas stipend; on failure credit `credit[insurer]` for `withdrawCredit` | `test_report_rejectingInsurerGetsCredit`, `test_report_gasHungryInsurerGetsCredit` |
