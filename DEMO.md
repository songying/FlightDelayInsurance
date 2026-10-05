# Classroom demo (local Anvil)

Demo mode lets one browser act as three Anvil accounts, with no wallet extension or WalletConnect:

| Anvil account | Role in the demo |
|---|---|
| (0) | **Insurer**: creates and funds the offer |
| (1) | **Alice**: the policyholder |
| (2) | **Oracle**: reports the flight outcome |

A **Demo** panel at the top of every page shows the chain's current time and the selected offer's
sales cutoff, scheduled departure and report deadline. Its buttons move chain time forward with
`evm_increaseTime` followed by `evm_mine`:

| Button | Moves chain time to |
|---|---|
| advance 1 hour | now + 3,600 s |
| advance to cutoff + 1 s | departure − 12 h + 1 s: sales are closed |
| advance to departure + 1 h | inside the 48 h report window |
| advance to deadline + 1 s | departure + 48 h + 1 s: the offer can be expired |

Chain time only moves forward. A button is disabled once its target has passed. The new block can land a few
seconds after the target, because Anvil adds the wall-clock time since the last block.

Demo mode is on **only** when the app is on chain 31337 and the three demo keys are set. On any other
network the switcher and the panel are hidden. With `NEXT_PUBLIC_WC_PROJECT_ID` set, RainbowKit's
connect button remains next to the switcher.

## One-time setup

1. Terminal 1: start the chain and keep it running.
   ```sh
   anvil
   ```
   Anvil prints *Available Accounts* (0)–(9) and *Private Keys* (0)–(9).

2. Terminal 2: deploy the contract from account (0). Anvil's accounts are unlocked, so no key is needed.
   ```sh
   cd contracts
   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
     --unlocked --sender <Available Accounts (0)>
   ```
   On a fresh Anvil, the first deployment from (0) lands at `0x5FbDB2315678afecb367f032d93F642f64180aa3`.

3. Configure the web app:
   ```sh
   cd web
   cp .env.example .env.local
   ```
   In `web/.env.local`, set:
   - `NEXT_PUBLIC_FDI_ADDRESS_31337` to the deployed address from step 2.
   - `NEXT_PUBLIC_DEMO_INSURER_PK` to Anvil's *Private Keys* (0).
   - `NEXT_PUBLIC_DEMO_ALICE_PK` to Anvil's *Private Keys* (1).
   - `NEXT_PUBLIC_DEMO_ORACLE_PK` to Anvil's *Private Keys* (2).

   > `NEXT_PUBLIC_*` values are bundled into the page's JavaScript. Use Anvil's dev keys only, never a key
   > that holds real funds. `.env.local` is git-ignored; never commit it.

4. Start the app and open http://localhost:3000.
   ```sh
   npm install
   npm run dev
   ```
   The header shows **Demo account**, and the **Demo (Anvil 31337)** panel appears above each page.

If you restart Anvil, the chain resets: redeploy (step 2) and reload the page.

## Creating an offer (used by every scenario)

Time only moves forward, so each scenario uses a **new offer** whose departure is later than the
chain time shown in the Demo panel.

1. **Demo account → Insurer (#0)**. Open **Insurer**.
2. Fill in **Create offer**:
   - Flight number: `SQ8385` (use a different one per scenario if you like, e.g. `SQ8386`)
   - Scheduled departure: a date **at least 1 day after the Demo panel's chain time**, e.g. 10:00
   - Airport time zone: `UTC`
   - Payout odds: `5.00`
   - Business-class full fare cap: `1`
   - Oracle address: Anvil's *Available Accounts* (2) (shown in the Demo account list as *Oracle (#2)*)
   - Initial collateral: `10`
3. Click **Create offer** and wait for **✓ confirmed**.
4. In the Demo panel, pick the new offer in **Offer**. Its cutoff, departure and report deadline appear.

Alice buys a policy the same way in every scenario:

5. **Demo account → Alice (#1)**. Open **Browse offers**, enter premium `0.1` on the new offer, click **Buy**.
   The hint shows the payout: 0.1 × 5.00 = **0.5 ETH**.

## Scenario A: a 45-minute delay pays out and Alice claims

1. Create an offer (steps 1–4) and buy as Alice (step 5).
2. Demo panel: **advance to departure + 1 h**. The offer's phase becomes *AwaitingReport*.
3. **Demo account → Oracle (#2)**. Open **Oracle**. On the offer choose **Departed**, Delay `45`.
   The preview says *Outcome: PAYOUT*. Click **Submit final report**.
4. **Demo account → Alice (#1)**. Open **My policies**. The status is **Won**.
   Click **Claim 0.5 ETH**. After confirmation the status is **Claimed**.

## Scenario B: a 20-minute delay pays nothing

1. Create an offer and buy as Alice.
2. Demo panel: **advance to departure + 1 h**.
3. **Oracle (#2)** → **Oracle** page: **Departed**, Delay `20`. The preview says *Outcome: NO PAYOUT*.
   Click **Submit final report**.
4. **Alice (#1)** → **My policies**: the status is **Lost** and there is no claim button.
   (The threshold is strictly more than 30 minutes: 30 does not pay, 31 does.)

## Scenario C: buying after the cutoff reverts

1. Create an offer (as Insurer). Do **not** buy yet.
2. Demo panel: **advance to cutoff + 1 s**. The phase becomes *SalesEnded*.
3. **Alice (#1)** → **Browse offers**, tick **Include closed and settled**.
   In demo mode the buy form stays visible on the closed offer. Enter `0.1` and click **Buy**.
4. The button shows the contract's revert reason: **SalesCutoffPassed**. The call is simulated first,
   so no transaction is mined and Alice keeps her ETH.
   (At exactly the cutoff a purchase still succeeds; one second later it reverts.)

## Scenario D: no report by the deadline, expire, Alice is refunded

1. Create an offer and buy as Alice.
2. Demo panel: **advance to deadline + 1 s**. The oracle never reported, so the phase is *Expirable*.
3. Any account, e.g. **Insurer (#0)** → **Browse offers**, tick **Include closed and settled**, click
   **Expire (oracle missed deadline)**. The insurer gets all 10 ETH of collateral back.
4. **Alice (#1)** → **My policies**: the status is **Refundable**. Click **Refund 0.1 ETH**.
   After confirmation the status is **Refunded**.

   (Skipping step 3 also works: Alice's refund claim expires the offer implicitly.)

## Optional: the 90-day claim window

After scenario A or D, click **advance 1 hour** repeatedly, or use `cast rpc evm_increaseTime 7776001`
then `cast rpc evm_mine`, to pass the 90-day claim window. An unclaimed policy shows **Forfeited**, and the
insurer can **Sweep** it on the Insurer page.
