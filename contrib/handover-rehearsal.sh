#!/usr/bin/env bash
# Rehearse the Ethereum side of handing the vault's USDC escrow to Circle,
# against the live Sepolia vault and USDC on a local fork. Nothing is sent to
# any network: every role is impersonated on the fork.
#
#   contrib/handover-rehearsal.sh            fork the latest Sepolia block
#   FORK_BLOCK=11796086 contrib/handover-rehearsal.sh
#
# Environment:
#   REHEARSAL_RPC_URL  Sepolia RPC to fork (default: Tenderly's public gateway)
#   FORK_BLOCK         pin the fork to a block (default: latest)
#   VAULT, USDC        override the vault and USDC addresses
#   CIRCLE_BURNER      the burner address Circle names (default: a fresh one)
# Extra arguments are passed to `forge test` (for example -vvvv for traces).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v forge >/dev/null || { echo "forge not found: install Foundry (https://getfoundry.sh)" >&2; exit 1; }
[ -e "$here/contracts/lib/forge-std/src/Test.sol" ] || {
  echo "forge-std missing: run 'git submodule update --init' first" >&2; exit 1; }

export REHEARSAL_RPC_URL="${REHEARSAL_RPC_URL:-https://sepolia.gateway.tenderly.co}"

cd "$here/contracts"
exec forge test --match-path test/fork/HandoverRehearsal.t.sol -vv "$@"
