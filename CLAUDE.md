# FlightDelayInsurance

Peer-to-peer flight-delay insurance DApp: Solidity/Foundry in `contracts/`, Next.js in `web/`, oracle bot in `oracle-bot/`. Plan: PLAN.md.

## Commands (contracts: run from `contracts/`)
- `forge build` / `forge test` (`-vvv` for traces, `--match-test <regex>` for one area)
- `forge coverage`
- `forge fmt` (CI runs `forge fmt --check`)
- `anvil` (local chain, port 8545)
- `npm run dev` in `web/` (http://localhost:3000)

## Workflow rules
- Every change starts from a GitHub issue.
- Work on a branch `feat/<issue>-<slug>`; land on `main` only through a pull request whose body says `Closes #<issue>`.
- Never commit to `main`. Never force-push.
- Commit tests before the implementation they test.
- CI must be green before merge.

## Engineering rules
- SPEC.md is the source of truth. If code and spec disagree, stop and ask.
- Never edit a test to make it pass without asking.
- Checks-effects-interactions in every state-changing function.
- Send ETH with `call`, never `transfer` or `send`.
- No unbounded loops over user-controlled data.
- Local Anvil chain only; never deploy to or send transactions on a public network.
- Never read or print `.env` files or private keys.
