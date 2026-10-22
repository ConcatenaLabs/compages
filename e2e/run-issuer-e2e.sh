#!/usr/bin/env bash
# Compages end-to-end checks of an asset an Arca operator serves
# issuer-operated: anvil (local Ethereum) + a Sequentia proof-of-stake regtest
# chain anchored to a Bitcoin regtest parent + an Arca operator (arcad,
# arca-signer minting through the asset's mint limiter, PostgreSQL) + the real
# daemon, the watcher (reading a small indexer stand-in, mini-esplora.mjs) and
# the reserve snapshot tool, driven by issuer-driver.mjs.
#
# Requires what run-leaf-e2e.sh requires (foundry, node >= 20, the daemon's,
# the watcher's and the reserves tool's node_modules, SEQUENTIAD_EXEC,
# ARCA_BIN_DIR, PG_BIN_DIR), with MINT_LIMITER a mint-limiter tool that has
# `sign` (sequentia-contracts 9d3b569 or later), and AUDIT_SCRIPT (the node
# repository's contrib/asset-supply-audit/audit.py).
# Every port is chosen free at start; everything lives under e2e/run-issuer.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
RUN="$HERE/run-issuer"

: "${SEQUENTIAD_EXEC:?set SEQUENTIAD_EXEC to a sequentiad}"
: "${ARCA_BIN_DIR:?set ARCA_BIN_DIR to a directory holding arca, arcad and arca-signer}"
: "${PG_BIN_DIR:?set PG_BIN_DIR to a directory holding initdb and pg_ctl}"
: "${MINT_LIMITER:?set MINT_LIMITER to the mint-limiter tool, with sign}"
: "${AUDIT_SCRIPT:?set AUDIT_SCRIPT to contrib/asset-supply-audit/audit.py of the node repository}"
ELD="$SEQUENTIAD_EXEC"
ELC="$(dirname "$ELD")/sequentia-cli"
ARCA="$ARCA_BIN_DIR/arca"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])'; }
ANVIL_PORT=$(free_port); PARENT_RPC=$(free_port); SEQ_RPC=$(free_port); SEQ_P2P=$(free_port)
PG_PORT=${PG_PORT:-$(free_port)}; ARCAD_PORT=$(free_port); API_PORT=$(free_port); ESPLORA_PORT=$(free_port); WATCH_PORT=$(free_port)

OPERATOR_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OPERATOR_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
USER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
USER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
OWNER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
OWNER_ADDR=0x90F79bf6EB2c4f870365E785982E1f101E93b906
GUARDIAN_ADDR=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65

seqcli() { "$ELC" -datadir="$RUN/seq" -chain=elementsregtest -rpcport=$SEQ_RPC -rpcuser=e2e -rpcpassword=e2e "$@"; }
parcli() { "$ELC" -datadir="$RUN/parent" -chain=regtest -rpcport=$PARENT_RPC -rpcuser=e2e -rpcpassword=e2e "$@"; }
export SEQ_RPC_URL="http://e2e:e2e@127.0.0.1:$SEQ_RPC/" PARENT_RPC_URL="http://e2e:e2e@127.0.0.1:$PARENT_RPC/"
chain() { node "$HERE/leaf-chain.mjs" "$@"; }

cleanup() {
  set +e
  [ -f "$RUN/daemon.pid" ] && kill "$(cat "$RUN/daemon.pid")" 2>/dev/null
  [ -f "$RUN/watcher.pid" ] && kill "$(cat "$RUN/watcher.pid")" 2>/dev/null
  [ -n "${ESPLORA_PID:-}" ] && kill "$ESPLORA_PID" 2>/dev/null
  # A driver that starts the signer again records its pid here.
  [ -f "$RUN/signer.pid" ] && kill -TERM "$(cat "$RUN/signer.pid")" 2>/dev/null
  [ -n "${ARCAD_PID:-}" ] && kill -INT "$ARCAD_PID" 2>/dev/null
  # A driver that starts arcad again records its pid here.
  [ -f "$RUN/arcad.pid" ] && kill -INT "$(cat "$RUN/arcad.pid")" 2>/dev/null
  [ -n "${SIGNER_PID:-}" ] && kill -TERM "$SIGNER_PID" 2>/dev/null
  seqcli stop >/dev/null 2>&1
  parcli stop >/dev/null 2>&1
  [ -n "${ANVIL_PID:-}" ] && kill "$ANVIL_PID" 2>/dev/null
  [ -d "$RUN/pg" ] && "$PG_BIN_DIR/pg_ctl" -D "$RUN/pg" -m fast stop >/dev/null 2>&1
  sleep 1
}
trap cleanup EXIT

rm -rf "$RUN"
mkdir -p "$RUN/seq" "$RUN/parent" "$RUN/arca"
ln -sfn "$REPO/daemon/node_modules" "$HERE/node_modules"
# The limiter's operator key is the issuer's minting key: the daemon and the
# Arca signer both mint through it, the daemon for deposits, the signer for
# rounds.

"$MINT_LIMITER" key --new --mnemonic-file "$RUN/limiter-operator.words" >/dev/null
COLD_KEY=$("$MINT_LIMITER" key --new --mnemonic-file "$RUN/limiter-cold.words" | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])")

echo "== anvil on $ANVIL_PORT"
# One slot per epoch: anvil then finalizes a block two blocks behind its head.
anvil --port $ANVIL_PORT --block-time 1 --slots-in-an-epoch 1 --silent &
ANVIL_PID=$!
for _ in $(seq 1 50); do cast block-number --rpc-url http://127.0.0.1:$ANVIL_PORT >/dev/null 2>&1 && break; sleep 0.2; done
cd "$REPO/contracts"
VAULT=$(forge create src/CompagesVault.sol:CompagesVault --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args $OWNER_ADDR $OPERATOR_ADDR $GUARDIAN_ADDR 3600 | awk '/Deployed to:/ {print $3}')
MUSD=$(forge create test/mocks/MockTokens.sol:MockERC20 --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY --broadcast \
  --constructor-args "Mock USD" "MUSD" 6 | awk '/Deployed to:/ {print $3}')
[ -n "$VAULT" ] && [ -n "$MUSD" ] || { echo "deploy failed"; exit 1; }
cast send "$MUSD" "mint(address,uint256)" $USER_ADDR 1000000000000 --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OPERATOR_KEY >/dev/null
cast send "$VAULT" "setReleaseLimit(address,uint256,uint256)" "$MUSD" 1000000000000000000000000 1000000000000000000000 \
  --rpc-url http://127.0.0.1:$ANVIL_PORT --private-key $OWNER_KEY >/dev/null
cd "$HERE"
echo "   vault $VAULT, MUSD $MUSD"

echo "== Bitcoin regtest parent"
"$ELD" -datadir="$RUN/parent" -chain=regtest -rpcport=$PARENT_RPC -port=$(free_port) -listen=0 -rpcuser=e2e -rpcpassword=e2e \
  -disablewallet -txindex=1 -server -daemon -printtoconsole=0
for _ in $(seq 1 100); do parcli getblockcount >/dev/null 2>&1 && break; sleep 0.3; done
parcli generatetodescriptor 10 'raw(51)' >/dev/null
PARENT_GENESIS=$(parcli getblockhash 0)

echo "== Sequentia proof-of-stake regtest, anchored"
# The Arca harness's chain (sequentia-ext regtest: CHAIN_ARGS and POS_ARGS),
# with a wallet: the genesis block's free coins are the node wallet's.
"$ELD" -datadir="$RUN/seq" -chain=elementsregtest -rpcport=$SEQ_RPC -port=$SEQ_P2P -listen=0 -rpcuser=e2e -rpcpassword=e2e \
  -server -daemon -printtoconsole=0 -txindex=1 -par=1 \
  -con_bitcoin_anchor=1 -validateanchor=1 -mainchainrpchost=127.0.0.1 -mainchainrpcport=$PARENT_RPC \
  -mainchainrpcuser=e2e -mainchainrpcpassword=e2e -parentgenesisblockhash=$PARENT_GENESIS \
  -initialfreecoins=2100000000000000 -con_default_blinded_addresses=0 -blindedaddresses=0 -validatepegin=0 \
  -con_parent_chain_signblockscript=51 -con_any_asset_fees=1 -evbparams=simplicity:-1::: \
  -anyonecanspendaremine=1 -con_blocksubsidy=0 \
  -con_pos=1 -posvrf=1 -posaggcommittee=1 -poscommitteesize=3 -posslotinterval=1 -anchorpollinterval=1 \
  -anchorminconf=1 -acceptnonstdtxn=1 $(chain stakers) -fallbackfee=0.0001
for _ in $(seq 1 100); do seqcli getblockcount >/dev/null 2>&1 && break; sleep 0.3; done
seqcli createwallet miner >/dev/null
seqcli createwallet compages >/dev/null
seqcli createwallet user >/dev/null
seqcli -rpcwallet=miner rescanblockchain >/dev/null
seqcli setfeeexchangerates '{"bitcoin": 100000000}' >/dev/null
chain produce 2
echo "   miner holds: $(seqcli -rpcwallet=miner getbalance | tr -d ' \n')"
FEEX=$(seqcli -rpcwallet=miner -named issueasset assetamount=1000000 tokenamount=0 blind=false fee_asset=bitcoin | python3 -c "import json,sys;print(json.load(sys.stdin)['asset'])")
seqcli setfeeexchangerates "{\"bitcoin\": 100000000, \"$FEEX\": 100000000}" >/dev/null
chain produce 1
for W in compages user; do
  A=$(seqcli -rpcwallet=$W getnewaddress)
  seqcli -rpcwallet=miner -named sendtoaddress address="$A" amount=10000 assetlabel="$FEEX" fee_asset_label="$FEEX" >/dev/null
done
chain produce 1
echo "   FEEX $FEEX; the bridge wallet holds $(seqcli -rpcwallet=compages getbalance | tr -d ' \n')"
GENESIS=$(seqcli getblockhash 0)

echo "== PostgreSQL on $PG_PORT"
"$PG_BIN_DIR/initdb" -D "$RUN/pg" -U arca --auth=trust >/dev/null
mkdir -p "$RUN/pgsock"
"$PG_BIN_DIR/pg_ctl" -D "$RUN/pg" -l "$RUN/pg.log" -o "-p $PG_PORT -k $RUN/pgsock -c listen_addresses=127.0.0.1" -w start >/dev/null
"$PG_BIN_DIR/createdb" -h 127.0.0.1 -p $PG_PORT -U arca arca

echo "== Arca operator (signer, arcad on $ARCAD_PORT)"
( umask 077; openssl rand -hex 32 > "$RUN/arca/operator.key" )
S=$("$ARCA_BIN_DIR/arca-signer" --key-file "$RUN/arca/operator.key" --pubkey)
"$ARCA_BIN_DIR/arca-signer" --key-file "$RUN/arca/operator.key" --genesis "$GENESIS" --record "$RUN/arca/signer.record" \
  --create-record --no-keepers >/dev/null
"$ARCA_BIN_DIR/arca-signer" --key-file "$RUN/arca/operator.key" --genesis "$GENESIS" --record "$RUN/arca/signer.record" \
  --socket "$RUN/arca/signer.sock" > "$RUN/signer.log" 2>&1 &
SIGNER_PID=$!
for _ in $(seq 1 50); do [ -S "$RUN/arca/signer.sock" ] && break; sleep 0.2; done
( umask 077; echo "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about" > "$RUN/arca/wallet.mnemonic" )
write_arcad_conf() { # <asset>... : the assets served
  {
    echo "listen = \"127.0.0.1:$ARCAD_PORT\""
    echo "database = \"postgres://arca@127.0.0.1:$PG_PORT/arca\""
    echo "signer_socket = \"$RUN/arca/signer.sock\""
    echo "wallet_mnemonic_file = \"$RUN/arca/wallet.mnemonic\""
    echo "fee_multiple = 2"
    echo "max_request_bytes = 65536"
    echo "challenge_ttl_seconds = 120"
    echo "round_interval_seconds = 0"
    echo "[node]"
    echo "rpc_url = \"http://127.0.0.1:$SEQ_RPC/\""
    echo "rpc_user = \"e2e\""
    echo "rpc_password = \"e2e\""
    echo "[finality]"
    echo "anchor_depth = 2"
    echo "certification = \"required\""
    echo "poll_interval_ms = 300"
    echo "[limits]"
    echo "issue_per_second = 10000"
    echo "issue_burst = 10000"
    echo "source_per_second = 10000"
    echo "source_burst = 10000"
    echo "witness_per_second = 10000"
    echo "witness_burst = 10000"
    echo "witness_source_per_second = 10000"
    echo "witness_source_burst = 10000"
    echo "read_per_second = 10000"
    echo "read_burst = 10000"
    echo "read_source_per_second = 10000"
    echo "read_source_burst = 10000"
    for a in "$@"; do
      echo "[[assets]]"
      echo "asset = \"$a\""
      echo "min_leaf = \"1000\""
    done
  } > "$RUN/arca/arcad.toml"
}
write_arcad_conf "$FEEX"
RUST_LOG=info "$ARCA_BIN_DIR/arcad" "$RUN/arca/arcad.toml" > "$RUN/arcad.log" 2>&1 &
ARCAD_PID=$!
for _ in $(seq 1 100); do curl -s "http://127.0.0.1:$ARCAD_PORT/v1/info" >/dev/null 2>&1 && break; sleep 0.3; done
curl -sf "http://127.0.0.1:$ARCAD_PORT/v1/info" >/dev/null || { echo "arcad did not start:"; tail -20 "$RUN/arcad.log"; exit 1; }
OP_ADDR=$("$ARCA_BIN_DIR/arcad" "$RUN/arca/arcad.toml" address 2>/dev/null | tail -1 | python3 -c "import json,sys;v=json.loads(sys.stdin.read());print(v if isinstance(v,str) else v['address'])")
seqcli -rpcwallet=miner -named sendtoaddress address="$OP_ADDR" amount=10000 assetlabel="$FEEX" fee_asset_label="$FEEX" >/dev/null
chain produce 1
echo "   operator $S at http://127.0.0.1:$ARCAD_PORT, its wallet $OP_ADDR"

echo e2e > "$RUN/arca/node.password"

echo "== the indexer stand-in on $ESPLORA_PORT"
node "$HERE/mini-esplora.mjs" $ESPLORA_PORT > "$RUN/esplora.log" 2>&1 &
ESPLORA_PID=$!

echo "== daemon config"
cat > "$RUN/config.json" <<EOF
{
  "ethChainName": "anvil",
  "ethChainId": 31337,
  "ethRpcUrl": "http://127.0.0.1:$ANVIL_PORT",
  "vaultAddress": "$VAULT",
  "vaultDeployBlock": 1,
  "ethConfirmations": 2,
  "ethFinality": "confirmations",
  "operatorKeyFile": "operator.key",
  "seqRpcUrl": "http://e2e:e2e@127.0.0.1:$SEQ_RPC",
  "seqWallet": "compages",
  "seqChainLabel": "elementsregtest",
  "seqConfirmations": 2,
  "seqFeeAsset": "$FEEX",
  "broadcastWaitMs": 4000,
  "adminToken": "e2e-admin",
  "intentLimitPerHour": 1000,
  "invariantIntervalMs": 5000,
  "ethTxWaitMs": 20000,
  "mintLimiter": {
    "tool": "$MINT_LIMITER",
    "operatorMnemonicFile": "$RUN/limiter-operator.words",
    "coldKey": "$COLD_KEY",
    "windowBlocks": 20,
    "recoveryDelay": 2,
    "defaultAllowance": "100000000000000000"
  },
  "seqBlockMs": 1500,
  "apiHost": "127.0.0.1",
  "apiPort": $API_PORT,
  "pollIntervalMs": 1500,
  "stateFile": "state.json"
}
EOF
echo "$OPERATOR_KEY" > "$RUN/operator.key"

echo "== running the issuer-operated driver"
VAULT=$VAULT MUSD=$MUSD USER_KEY=$USER_KEY FEEX=$FEEX GENESIS=$GENESIS OPERATOR_S=$S \
ANVIL_PORT=$ANVIL_PORT API_PORT=$API_PORT ARCAD_PORT=$ARCAD_PORT ARCAD_PID=$ARCAD_PID SIGNER_PID=$SIGNER_PID \
RUN_DIR=$RUN DAEMON_JS="$REPO/daemon/compagesd.js" ARCA="$ARCA" ARCA_BIN_DIR="$ARCA_BIN_DIR" PG_PORT=$PG_PORT \
SEQ_RPC=$SEQ_RPC REPO_DIR="$REPO" AUDIT_SCRIPT="$AUDIT_SCRIPT" MINT_LIMITER="$MINT_LIMITER" \
ESPLORA_PORT=$ESPLORA_PORT WATCH_PORT=$WATCH_PORT ELC="$ELC" \
node "${ISSUER_DRIVER:-$HERE/issuer-driver.mjs}"
RC=$?
echo "== daemon log tail"
tail -20 "$RUN/daemon.log" || true
exit $RC
