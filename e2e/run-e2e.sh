#!/usr/bin/env bash
# Compages end-to-end test: anvil (local Ethereum) + Sequentia elementsregtest
# + the real daemon + real contract deployments, driven by driver.mjs.
#
# Requires: foundry (anvil/forge/cast), node >= 20, a Sequentia Core build
# (sequentiad/sequentia-cli; builds that still carry the legacy names
# elementsd/elements-cli are accepted as a fallback. Needs 23.3.8 or later:
# earlier consensus rejects the unblinded reissuance the bridge performs),
# the daemon's node_modules installed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
RUN="$HERE/run"
# The node repo lives at ~/Sequentia; the
# binaries sit in build-linux/src on an out-of-tree build, or src/ in-tree.
SEQ_REPO_SET="${SEQ_REPO:-}"
SEQ_REPO="${SEQ_REPO:-$HOME/Sequentia}"
# Prefer the current binary names; fall back to the legacy ones.
node_bin_in() { # <dir> -> prints the node binary path in <dir>, or nothing
  if [ -x "$1/sequentiad" ]; then echo "$1/sequentiad"
  elif [ -x "$1/elementsd" ]; then echo "$1/elementsd"
  fi
}
SEQ_BIN="$SEQ_REPO/build-linux/src"
[ -n "$(node_bin_in "$SEQ_BIN")" ] || SEQ_BIN="$SEQ_REPO/src"
# A downloaded release build (with its shared libs beside it) beats a stale
# in-tree binary; set SEQ_REPO explicitly to override either.
if [ -z "${SEQ_REPO_SET:-}" ] && [ -n "$(node_bin_in "$HOME/seq-binaries-23.3.8/src")" ]; then
  case "$("$(node_bin_in "$SEQ_BIN")" --version 2>/dev/null | head -1)" in
    *v23.3.[89]*|*v23.4*|*v24*) : ;; # in-tree binary is new enough
    *) SEQ_BIN="$HOME/seq-binaries-23.3.8/src"
       export LD_LIBRARY_PATH="$HOME/seq-binaries-23.3.8/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  esac
fi
ELD="$(node_bin_in "$SEQ_BIN")"
if [ -x "$SEQ_BIN/sequentia-cli" ]; then ELC="$SEQ_BIN/sequentia-cli"; else ELC="$SEQ_BIN/elements-cli"; fi
[ -n "$ELD" ] || { echo "no sequentiad (or elementsd) found under $SEQ_REPO; set SEQ_REPO" >&2; exit 1; }

ANVIL_PORT=8545
SEQ_RPC=18892
SEQ_P2P=18893
API_PORT=9950
SOL_PORT=18999
FAULT_PORT=18894
IRIS_PORT=18995
# The remote chain the CCTP checks pretend to bridge from and pay out to.
REMOTE_DOMAIN=6
REMOTE_MESSENGER=0x0000000000000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daa
REMOTE_USDC=0x036CbD53842c5426634e7929541eC2318f3dCF7e
REGISTRY_PORT=13005
REGISTRY_REPO="${REGISTRY_REPO:-$HOME/sequentia-registry}"
REGISTRY_TOKEN=e2e-admin-token

# anvil's deterministic test accounts
OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
USER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
USER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
# The vault's other two roles, kept apart from the operator as on a real
# deployment: the owner sets limits and unpauses, the guardian can only pause.
OWNER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
OWNER_ADDR=0x90F79bf6EB2c4f870365E785982E1f101E93b906
GUARDIAN_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
GUARDIAN_ADDR=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
RELEASE_DELAY=3600

seqcli() { "$ELC" -datadir="$RUN/seq" -chain=elementsregtest -rpcport=$SEQ_RPC -rpcuser=e2e -rpcpassword=e2e "$@"; }

cleanup() {
  set +e
  # The driver may restart the daemon (crash-recovery checks), so the live
  # pid is whatever the pid file says now, not the one started below.
  [ -f "$RUN/daemon.pid" ] && kill "$(cat "$RUN/daemon.pid")" 2>/dev/null
  [ -n "${DAEMON_PID:-}" ] && kill "$DAEMON_PID" 2>/dev/null
  [ -n "${FAULT_PID:-}" ] && kill "$FAULT_PID" 2>/dev/null
  [ -n "${IRIS_PID:-}" ] && kill "$IRIS_PID" 2>/dev/null
  [ -n "${REGISTRY_PID:-}" ] && kill "$REGISTRY_PID" 2>/dev/null
  [ -n "${SOL_PID:-}" ] && kill "$SOL_PID" 2>/dev/null
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
  --constructor-args $OWNER_ADDR $OPERATOR_ADDR $GUARDIAN_ADDR $RELEASE_DELAY \
  | awk '/Deployed to:/ {print $3}')
MUSD=$(forge create test/mocks/MockTokens.sol:MockERC20 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args "Mock USD" "MUSD" 6 \
  | awk '/Deployed to:/ {print $3}')
[ -n "$VAULT" ] && [ -n "$MUSD" ] || { echo "deploy failed"; exit 1; }
# An account that refuses plain ether, like a contract without receive() or an
# EIP-7702 account: a payout to it must become owed and claimable, not stuck.
REJECTOR=$(forge create test/mocks/MockReceivers.sol:RejectingReceiver \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  | awk '/Deployed to:/ {print $3}')
echo "   vault: $VAULT   musd: $MUSD"
cast send "$MUSD" "mint(address,uint256)" $USER_ADDR 1000000000 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY >/dev/null

# A stand-in for Circle's USDC on the Ethereum side of the unified asset. The
# same dollar also arrives from Solana (an SPL mint created below), and both
# must land on ONE Sequentia asset rather than two rival ones.
USDC_ETH=$(forge create test/mocks/MockTokens.sol:MockERC20 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args "USD Coin" "USDC" 6 \
  | awk '/Deployed to:/ {print $3}')
[ -n "$USDC_ETH" ] || { echo "USDC deploy failed"; exit 1; }
cast send "$USDC_ETH" "mint(address,uint256)" $USER_ADDR 1000000000 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY >/dev/null
echo "   usdc(eth): $USDC_ETH"

# Circle's CCTP, as mocks: a transmitter that accepts the attestation "valid"
# and a messenger that burns and mints the test USDC. The vault's owner points
# the vault at them, as on a real deployment.
TRANSMITTER=$(forge create test/mocks/MockCctp.sol:MockMessageTransmitterV2 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args 0 | awk '/Deployed to:/ {print $3}')
MESSENGER=$(forge create test/mocks/MockCctp.sol:MockTokenMessengerV2 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args $TRANSMITTER | awk '/Deployed to:/ {print $3}')
[ -n "$TRANSMITTER" ] && [ -n "$MESSENGER" ] || { echo "CCTP mock deploy failed"; exit 1; }
cast send "$MESSENGER" "addRemote(uint32,bytes32,bytes32,address)" $REMOTE_DOMAIN $REMOTE_MESSENGER \
  "0x000000000000000000000000${REMOTE_USDC:2}" "$USDC_ETH" \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY >/dev/null
cast send "$VAULT" "setCctp(address,address,address)" "$MESSENGER" "$TRANSMITTER" "$USDC_ETH" \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OWNER_KEY >/dev/null
echo "   cctp mocks: transmitter $TRANSMITTER messenger $MESSENGER"

# Release limits, set by the owner. Generous here, so the ordinary checks pay
# out at once; the queue has checks of its own that lower a limit.
for T in 0x0000000000000000000000000000000000000000 "$MUSD" "$USDC_ETH"; do
  cast send "$VAULT" "setReleaseLimit(address,uint256,uint256)" "$T" 1000000000000000000000000 1000000000000000000000 \
    --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OWNER_KEY >/dev/null
done

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
# Current node builds accept a fee asset only if it has an explicit exchange
# rate, INCLUDING the policy asset, so register that before the bootstrap fee;
# and since 23.3.8 no transaction has a default fee asset, so name it always.
seqcli setfeeexchangerates '{"bitcoin": 100000000}' >/dev/null
FEEX=$(seqcli -rpcwallet=miner -named issueasset assetamount=1000000 tokenamount=0 blind=false fee_asset=bitcoin | python3 -c "import json,sys;print(json.load(sys.stdin)['asset'])")
seqcli setfeeexchangerates "{\"bitcoin\": 100000000, \"$FEEX\": 100000000}" >/dev/null
seqcli generatetoaddress 1 "$MINE_ADDR" >/dev/null
BRIDGE_FEE_ADDR=$(seqcli -rpcwallet=compages getnewaddress)
USER_FEE_ADDR=$(seqcli -rpcwallet=user getnewaddress)
seqcli -rpcwallet=miner -named sendtoaddress address="$BRIDGE_FEE_ADDR" amount=100000 assetlabel="$FEEX" fee_asset_label="$FEEX" >/dev/null
seqcli -rpcwallet=miner -named sendtoaddress address="$USER_FEE_ADDR" amount=1000 assetlabel="$FEEX" fee_asset_label="$FEEX" >/dev/null
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

echo "== starting mock solana"
# A mock Solana RPC (in-memory ledger; decodes + signature-checks submitted
# transactions). Must be up before the daemon: compagesd verifies the genesis
# hash at startup.
node "$HERE/mock-solana.mjs" --port $SOL_PORT > "$RUN/solana.log" 2>&1 &
SOL_PID=$!
for _ in $(seq 1 40); do
  curl -s -X POST -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' \
    "http://127.0.0.1:$SOL_PORT" 2>/dev/null | grep -q result && break
  sleep 0.25
done
echo "   $(head -1 "$RUN/solana.log")"

# The Solana side of the unified asset. Its address must be known before the
# daemon starts, because a unified asset's sources are configuration: the
# bridge only ever unifies tokens an operator has explicitly declared to be
# the same money, never tokens that merely share a symbol.
solrpc() {
  curl -s -X POST -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" \
    "http://127.0.0.1:$SOL_PORT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["result"])'
}
USDC_SOL=$(solrpc mockCreateMint '[6]')
solrpc mockSetMetadata "[\"$USDC_SOL\", \"USD Coin\", \"USDC\"]" >/dev/null
echo "   usdc(sol): $USDC_SOL"

echo "== starting the RPC fault proxy"
# The daemon talks to the node through this, so checks can make the node
# stop answering at exactly the moment a bridge is most likely to pay twice.
node "$HERE/fault-proxy.mjs" --port $FAULT_PORT --target "http://127.0.0.1:$SEQ_RPC" > "$RUN/fault-proxy.log" 2>&1 &
FAULT_PID=$!
for _ in $(seq 1 40); do curl -s "http://127.0.0.1:$FAULT_PORT/__fault" >/dev/null 2>&1 && break; sleep 0.25; done

echo "== starting the mock attestation service"
node "$HERE/mock-iris.mjs" --port $IRIS_PORT --eth "http://127.0.0.1:$ANVIL_PORT" --transmitter "$TRANSMITTER" > "$RUN/iris.log" 2>&1 &
IRIS_PID=$!

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
  "seqRpcUrl": "http://e2e:e2e@127.0.0.1:$FAULT_PORT",
  "broadcastWaitMs": 4000,
  "ethFinality": "confirmations",
  "allowUnanchoredFinality": true,
  "adminToken": "e2e-admin",
  "intentLimitPerHour": 1000,
  "invariantIntervalMs": 5000,
  "ethTxWaitMs": 20000,
  "seqWallet": "compages",
  "seqChainLabel": "elementsregtest",
  "seqConfirmations": 2,
  "seqFeeAsset": "$FEEX",
  "registryUrl": "$REGISTRY_URL",
  "registryAdminToken": "$REGISTRY_TOKEN",
  "assetDomain": "bridge.compages.test",
  "solChainName": "mock-solana",
  "solChainLabel": "solana-mock",
  "solRpcUrl": "http://127.0.0.1:$SOL_PORT",
  "solGenesisHash": "3NKPKdsWGec7jmBYUwyXr326VY74s4z8hwu6QAiRco1P",
  "solKeyFile": "solana.key",
  "unified": {
    "USDC": {
      "name": "Bridged USDC (Compages)",
      "ticker": "USDC.e",
      "precision": 6,
      "sources": {
        "31337:$(echo "$USDC_ETH" | tr 'A-Z' 'a-z')": {
          "chainId": 31337,
          "token": "$USDC_ETH",
          "decimals": 6
        },
        "solana-mock:$USDC_SOL": {
          "chainId": "solana-mock",
          "token": "$USDC_SOL",
          "decimals": 6
        }
      }
    }
  },
  "cctp": {
    "enabled": true,
    "messageTransmitter": "$TRANSMITTER",
    "tokenMessengerEvm": "$MESSENGER",
    "irisUrl": "http://127.0.0.1:$IRIS_PORT",
    "solFloatUnits": "1000000000000000",
    "chains": [
      { "domain": $REMOTE_DOMAIN, "name": "Mock Base", "chainId": 84532, "usdc": "$REMOTE_USDC" }
    ]
  },
  "apiHost": "127.0.0.1",
  "apiPort": $API_PORT,
  "pollIntervalMs": 1500,
  "stateFile": "state.json"
}
EOF
echo "$OPERATOR_KEY" > "$RUN/operator.key"

echo "== starting compagesd"
node "$REPO/daemon/compagesd.js" "$RUN/config.json" >> "$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!
echo $DAEMON_PID > "$RUN/daemon.pid"
sleep 2
kill -0 $DAEMON_PID 2>/dev/null || { echo "daemon died:"; cat "$RUN/daemon.log"; exit 1; }

echo "== running driver"
ln -sfn "$REPO/daemon/node_modules" "$HERE/node_modules"
VAULT=$VAULT MUSD=$MUSD USER_KEY=$USER_KEY FEEX=$FEEX \
OWNER_KEY=$OWNER_KEY GUARDIAN_KEY=$GUARDIAN_KEY RELEASE_DELAY=$RELEASE_DELAY REJECTOR=$REJECTOR \
IRIS_PORT=$IRIS_PORT TRANSMITTER=$TRANSMITTER MESSENGER=$MESSENGER REMOTE_DOMAIN=$REMOTE_DOMAIN \
REMOTE_MESSENGER=$REMOTE_MESSENGER REMOTE_USDC=$REMOTE_USDC \
USDC_ETH=$USDC_ETH USDC_SOL=$USDC_SOL \
SEQ_RPC=$SEQ_RPC API_PORT=$API_PORT ANVIL_PORT=$ANVIL_PORT FAULT_PORT=$FAULT_PORT \
RUN_DIR=$RUN DAEMON_JS="$REPO/daemon/compagesd.js" \
REGISTRY_URL=$REGISTRY_URL SOL_RPC=http://127.0.0.1:$SOL_PORT \
node "$HERE/driver.mjs"
RC=$?

echo "== daemon log tail"
tail -20 "$RUN/daemon.log"
exit $RC
