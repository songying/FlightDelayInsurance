Flight delay insurance: the raw idea
Anyone can act as an insurer or a policyholder.
An insurer creates a policy offer for a flight number (e.g. SQ8385), sets the payout odds, and designates an oracle.
A policyholder can buy a policy up to 12 hours before departure. The payout is capped at the price of one full-fare business-class ticket on that flight.
If the flight is delayed by more than 30 minutes, the claim is triggered automatically.

---

# Implementation

The full requirements are in [SPEC.md](SPEC.md).

| Path | What |
|---|---|
| `contracts/` | Solidity contract `FlightDelayInsurance` + Foundry tests (unit + invariant fuzz) + deploy script |
| `web/` | Next.js + wagmi/viem + RainbowKit front end: Browse, Insurer, My policies, Oracle |
| `oracle-bot/` | Reference oracle: Node/TS (viem) cron job reading AeroDataBox via RapidAPI |
| `scripts/export-abi.mjs` | Copies the compiled ABI into `web/` and `oracle-bot/` |

## Prerequisites
[Foundry](https://getfoundry.sh) and Node.js 20+. After cloning: `git submodule update --init`.

## Contracts
```sh
cd contracts
forge test                       # 46 tests incl. invariants
anvil                            # in another terminal
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# Sepolia (needs SEPOLIA_RPC_URL, ETHERSCAN_API_KEY):
forge script script/Deploy.s.sol --rpc-url sepolia --broadcast --verify --private-key $DEPLOYER_PRIVATE_KEY
```
After changing the contract, run `node scripts/export-abi.mjs` from the repo root.

## Web
```sh
cd web
cp .env.example .env.local       # set NEXT_PUBLIC_FDI_ADDRESS_<chainId>
npm install
npm run dev                      # http://localhost:3000
npm test                         # domain-logic unit tests
```
The `@x402/*` dependencies exist only so the bundler can resolve optional imports from the
Coinbase wallet connector; the app does not use them.

## Oracle bot
```sh
cd oracle-bot
cp .env.example .env             # ORACLE_PRIVATE_KEY, RPC_URL, CONTRACT_ADDRESS, RAPIDAPI_KEY
npm install
node --env-file=.env node_modules/.bin/tsx src/run.ts         # one run (schedule with cron)
node --env-file=.env node_modules/.bin/tsx src/run.ts --loop  # or keep running
npm test
```
For each unsettled offer naming the bot as oracle, inside `[departure, departure + 48h]`, the bot
reports once the actual departure (or cancellation/diversion) is known, with
`delayMinutes = floor(max(0, actual − scheduled) / 60)`. If there is still no data 47h after the
scheduled departure, it logs an `ALERT` and never reports a guess.
