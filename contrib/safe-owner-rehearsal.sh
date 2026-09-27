#!/usr/bin/env bash
# Rehearse moving the vault's owner role to a Safe multisig, against the live
# Sepolia vault and the canonical Safe contracts on a local fork. Nothing is
# sent to any network: the current owner is impersonated on the fork and the
# Safe's signers are throwaway test keys. contrib/safe-owner.md is the runbook.
#
#   contrib/safe-owner-rehearsal.sh            fork the latest Sepolia block
#   FORK_BLOCK=11796257 contrib/safe-owner-rehearsal.sh
#
# Environment:
#   REHEARSAL_RPC_URL  Sepolia RPC to fork (default: Tenderly's public gateway)
#   FORK_BLOCK         pin the fork to a block (default: latest)
#   VAULT              override the vault address
# Extra arguments are passed to `forge test` (for example -vvvv for traces).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command -v forge >/dev/null || { echo "forge not found: install Foundry (https://getfoundry.sh)" >&2; exit 1; }
[ -e "$here/contracts/lib/forge-std/src/Test.sol" ] || {
  echo "forge-std missing: run 'git submodule update --init' first" >&2; exit 1; }

export REHEARSAL_RPC_URL="${REHEARSAL_RPC_URL:-https://sepolia.gateway.tenderly.co}"

cd "$here/contracts"
exec forge test --match-path test/fork/SafeOwnerRehearsal.t.sol -vv "$@"
