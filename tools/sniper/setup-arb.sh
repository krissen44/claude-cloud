#!/usr/bin/env bash
# Sets up the arbitrage bot next to the sniper: its own wallet (ARB_WALLET_* in the same .env),
# a connection test, then pm2 process "arb". Its pages appear at <status site>/arb.
#   cd /root/sniper && bash setup-arb.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
if [ "$(id -u)" != "0" ]; then echo "Please run as root."; exit 1; fi
if [ ! -f .env ]; then echo "Run setup-vps.sh first (the sniper)."; exit 1; fi
[ -d node_modules/xrpl ] || npm install --omit=dev --no-audit --no-fund

say "1/3 Arbitrage wallet"
setv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
if grep -q '^ARB_WALLET_ADDRESS=r' .env; then
  echo "ARB wallet already set: $(grep '^ARB_WALLET_ADDRESS=' .env | cut -d= -f2-) – kept."
else
  echo "Use a NEW wallet just for arbitrage – not the sniper's, not your main wallet!"
  SNIPER=$(grep '^WALLET_ADDRESS=' .env | cut -d= -f2- || true)
  while :; do
    read -rp "Address of the arbitrage wallet (starts with r): " ADDRESS
    [[ "$ADDRESS" =~ ^r[1-9A-HJ-NP-Za-km-z]{24,34}$ ]] || { echo "That doesn't look like an XRPL address."; continue; }
    [ "$ADDRESS" = "$SNIPER" ] && { echo "That's the sniper's wallet – the two bots must not share one."; continue; }
    break
  done
  while :; do
    echo "Now the key: 12/24 words, family seed (s…) or Xaman secret numbers."
    read -rsp "Input (not shown on screen), then Enter: " SECRET; echo
    if FOUND=$(SECRET="$SECRET" ADDRESS="$ADDRESS" node wallet.mjs find 2>/tmp/wallet-why); then break; fi
    echo "❌ Doesn't match the address $ADDRESS."; echo "   $(cat /tmp/wallet-why)"; rm -f /tmp/wallet-why
  done
  KIND=$(cut -f1 <<<"$FOUND"); WPATH=$(cut -f2 <<<"$FOUND")
  CLEAN=$(tr -s '[:space:]' ' ' <<<"$SECRET" | sed 's/^ //; s/ $//')
  sed -i '/^ARB_WALLET_/d' .env
  {
    echo "ARB_WALLET_ADDRESS=${ADDRESS}"
    case "$KIND" in
      seed) echo "ARB_WALLET_SEED=${CLEAN}" ;;
      mnemonic) echo "ARB_WALLET_MNEMONIC=${CLEAN,,}"; echo "ARB_WALLET_PATH=${WPATH}" ;;
      numbers) echo "ARB_WALLET_SECRET_NUMBERS=${CLEAN}" ;;
    esac
  } >> .env
  unset SECRET CLEAN
  echo "✅ Key matches $ADDRESS"
fi
grep -q '^ARB_PORT=' .env || setv ARB_PORT 3101
chmod 600 .env

say "2/3 Connection test (no trades, 60 s)"
ARB_DRY_RUN=1 ARB_PORT=3199 ARB_DATA_DIR=/tmp/arb-check timeout 60 node arb.js > /tmp/arb-check.log 2>&1 || true
grep -E "connected to|Arb bot running|pools|cannot reach|error" /tmp/arb-check.log | head -10 || true
if ! grep -q "Arb bot running" /tmp/arb-check.log; then echo "❌ Arb bot didn't start. Log: /tmp/arb-check.log – please send it to Claude."; exit 1; fi
echo "✅ Connected."

say "3/3 Running 24/7 with pm2"
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null
pm2 delete arb >/dev/null 2>&1 || true
pm2 start arb.js --name arb --cwd "$DIR" >/dev/null
pm2 restart sniper --update-env >/dev/null 2>&1 || true   # the sniper's site serves /arb
pm2 save >/dev/null
sleep 5
pm2 status
URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)
cat <<DONE

========================================================
 Done! The arbitrage bot is running.

 Arbitrage wallet: $(grep '^ARB_WALLET_ADDRESS=' .env | cut -d= -f2-)
   → send the XRP there (e.g. 50).
 Page:  ${URL}/arb   (same login as the sniper)

 The first start reads all AMM pools of the ledger – that takes a while;
 the page shows the progress. Live log: pm2 logs arb
========================================================
DONE
