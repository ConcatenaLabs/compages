#!/usr/bin/env bash
# Compages end-to-end test: anvil (local Ethereum) + Sequentia elementsregtest
# + the real daemon + real contract deployments, driven by driver.mjs.
#
# Requires: foundry (anvil/forge/cast), node >= 20, a Sequentia build
# (elementsd/elements-cli), the daemon's node_modules installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
RUN="$HERE/run"
SEQ_REPO="${SEQ_REPO:-$HOME/SequentiaByClaude}"
ELD="$SEQ_REPO/build-linux/src/elementsd"
ELC="$SEQ_REPO/build-linux/src/elements-cli"

ANVIL_PORT=8545
SEQ_RPC=18892
SEQ_P2P=18893
API_PORT=9950
REGISTRY_PORT=13005
REGISTRY_REPO="${REGISTRY_REPO:-$HOME/sequentia-registry}"
REGISTRY_TOKEN=e2e-admin-token

# anvil's deterministic test accounts
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
USER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
USER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

seqcli() { "$ELC" -datadir="$RUN/seq" -chain=elementsregtest -rpcport=$SEQ_RPC -rpcuser=e2e -rpcpassword=e2e "$@"; }

cleanup() {
  set +e
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
  [ -n "${REGISTRY_PID:-}" ] && kill "$REGISTRY_PID" 2>/dev/null
  seqcli stop >/dev/null 2>&1
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null
  sleep 1
}
trap cleanup EXIT

rm -rf "$RUN"
mkdir -p "$RUN/seq"

echo "== starting anvil"
anvil --port $ANVIL_PORT --block-time 1 --silent &
ANVIL_PID=$!
for _ in $(seq 1 50); do
  cast block-number --rpc-url http://127.0.0.1:$ANVIL_PORT >/dev/null 2>&1 && break
  sleep 0.2
done

echo "== deploying CompagesVault + MockERC20"
cd "$REPO/contracts"
VAULT=$(forge create src/CompagesVault.sol:CompagesVault \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args $OPERATOR_ADDR \
  | awk '/Deployed to:/ {print $3}')
MUSD=$(forge create test/mocks/MockTokens.sol:MockERC20 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args "Mock USD" "MUSD" 6 \
  | awk '/Deployed to:/ {print $3}')
[ -n "$VAULT" ] && [ -n "$MUSD" ] || { echo "deploy failed"; exit 1; }
echo "   vault: $VAULT   musd: $MUSD"
cast send "$MUSD" "mint(address,uint256)" $USER_ADDR 1000000000 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY >/dev/null

echo "== starting Sequentia elementsregtest node"
"$ELD" -datadir="$RUN/seq" -chain=elementsregtest \
  -rpcport=$SEQ_RPC -port=$SEQ_P2P -rpcuser=e2e -rpcpassword=e2e \
  -validatepegin=0 -con_blocksubsidy=5000000000 \
  -signblockscript=51 -blindedaddresses=0 -con_default_blinded_addresses=0 \
  -fallbackfee=0.0001 -walletrbf=1 -txindex=1 -acceptnonstdtxn=1 \
  -con_any_asset_fees=1 -server -daemon -printtoconsole=0
for _ in $(seq 1 100); do seqcli getblockcount >/dev/null 2>&1 && break; sleep 0.3; done

seqcli createwallet miner  >/dev/null   # holds the policy asset (block subsidy)
seqcli createwallet compages >/dev/null  # the bridge: will hold ONLY a non-policy fee asset
seqcli createwallet user   >/dev/null
# Mine the block subsidy into the miner wallet (matures after 100 blocks).
MINE_ADDR=$(seqcli -rpcwallet=miner getnewaddress)
seqcli generatetoaddress 110 "$MINE_ADDR" >/dev/null

# The miner issues a dedicated fee asset FEEX (paying that one bootstrap fee in
# the policy asset), registers it as an accepted fee asset on the node, then
# funds the bridge and the user with FEEX. From here on NOTHING but the miner
# holds the policy asset, so if any bridge step secretly needed it, it fails.
FEEX=$(seqcli -rpcwallet=miner issueasset 1000000 0 false | python3 -c "import json,sys;print(json.load(sys.stdin)['asset'])")
seqcli setfeeexchangerates "{\"$FEEX\": 100000000}" >/dev/null
seqcli generatetoaddress 1 "$MINE_ADDR" >/dev/null
BRIDGE_FEE_ADDR=$(seqcli -rpcwallet=compages getnewaddress)
USER_FEE_ADDR=$(seqcli -rpcwallet=user getnewaddress)
seqcli -rpcwallet=miner sendtoaddress "$BRIDGE_FEE_ADDR" 100000 "" "" false false 1 unset false "$FEEX" >/dev/null
seqcli -rpcwallet=miner sendtoaddress "$USER_FEE_ADDR"   1000  "" "" false false 1 unset false "$FEEX" >/dev/null
seqcli generatetoaddress 1 "$MINE_ADDR" >/dev/null
echo "   FEEX asset: $FEEX"
echo "   bridge wallet holds ONLY FEEX: $(seqcli -rpcwallet=compages getbalance | tr -d ' \n')"

echo "== starting the Sequentia Asset Registry"
# admin-seed path (REQUIRE_DOMAIN_PROOF=0, no electrs needed for legacy seed).
if [ -f "$REGISTRY_REPO/server.js" ]; then
  PORT=$REGISTRY_PORT DB_DIR="$RUN/registry-db" SEED_FILE=/dev/null \
    ADMIN_TOKEN=$REGISTRY_TOKEN REQUIRE_DOMAIN_PROOF=0 SEQ_ELECTRS_URL=http://127.0.0.1:1 \
    node "$REGISTRY_REPO/server.js" > "$RUN/registry.log" 2>&1 &
  REGISTRY_PID=$!
  for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$REGISTRY_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
  REGISTRY_URL="http://127.0.0.1:$REGISTRY_PORT"
  echo "   registry up: $(curl -s http://127.0.0.1:$REGISTRY_PORT/health)"
else
  echo "   (registry repo not found at $REGISTRY_REPO; skipping registry checks)"
  REGISTRY_URL=""
fi

echo "== writing daemon config"
cat > "$RUN/config.json" <<EOF
{
  "ethChainName": "anvil",
  "ethChainId": 31337,
  "ethRpcUrl": "http://127.0.0.1:$ANVIL_PORT",
  "vaultAddress": "$VAULT",
  "vaultDeployBlock": 1,
  "ethConfirmations": 2,
  "ethLogChunk": 5000,
  "operatorKeyFile": "operator.key",
  "seqRpcUrl": "http://e2e:e2e@127.0.0.1:$SEQ_RPC",
  "seqWallet": "compages",
  "seqChainLabel": "elementsregtest",
  "seqConfirmations": 2,
  "seqFeeAsset": "$FEEX",
  "registryUrl": "$REGISTRY_URL",
  "registryAdminToken": "$REGISTRY_TOKEN",
  "assetDomain": "bridge.compages.test",
  "apiHost": "127.0.0.1",
  "apiPort": $API_PORT,
  "pollIntervalMs": 1500,
  "stateFile": "state.json"
}
EOF
echo "$OPERATOR_KEY" > "$RUN/operator.key"

echo "== starting compagesd"
node "$REPO/daemon/compagesd.js" "$RUN/config.json" > "$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 2
kill -0 $DAEMON_PID 2>/dev/null || { echo "daemon died:"; cat "$RUN/daemon.log"; exit 1; }

echo "== running driver"
ln -sfn "$REPO/daemon/node_modules" "$HERE/node_modules"
VAULT=$VAULT MUSD=$MUSD USER_KEY=$USER_KEY FEEX=$FEEX \
SEQ_RPC=$SEQ_RPC API_PORT=$API_PORT ANVIL_PORT=$ANVIL_PORT \
REGISTRY_URL=$REGISTRY_URL \
node "$HERE/driver.mjs"
RC=$?

echo "== daemon log tail"
tail -20 "$RUN/daemon.log"
exit $RC
