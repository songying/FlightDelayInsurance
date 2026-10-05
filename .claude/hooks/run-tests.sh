#!/usr/bin/env bash
# Stop hook: block Claude from finishing while the Foundry suite is red.
# Exit 0 = allow stop. Exit 2 = block; stderr is fed back to Claude.
set -u

input=$(cat)

# Already continuing because of this hook: don't loop forever.
if printf '%s' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  exit 0
fi

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
contracts="$root/contracts"

# Nothing to test yet.
if ! compgen -G "$contracts/test/*.t.sol" > /dev/null; then
  exit 0
fi

export PATH="$PATH:$HOME/.foundry/bin"
if ! output=$(cd "$contracts" && forge test 2>&1); then
  {
    echo "forge test failed. Last 40 lines:"
    printf '%s\n' "$output" | tail -n 40
  } >&2
  exit 2
fi
exit 0
