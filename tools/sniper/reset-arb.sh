#!/bin/bash
# Hard reset of the arbitrage bot: stops it, deletes everything it learned and recorded (stats, trades,
# opportunities, rivals, learning, pool cache, settings changed on the page) and starts it fresh.
# The wallet (.env) stays. Trust lines of tokens that aren't on the list are given back by the bot itself
# once it runs (each frees 0.2 XRP).
set -e
cd "$(dirname "$0")"
DATA=$(grep -E '^ARB_DATA_DIR=' .env 2>/dev/null | cut -d= -f2-)
DATA=${DATA:-$HOME/xrpl-arb-data}
echo "This deletes everything in $DATA (stats, trades, learning, settings changed on the page)."
read -r -p "Type WIPE to continue: " ok
[ "$ok" = "WIPE" ] || { echo "Cancelled."; exit 1; }
pm2 stop arb >/dev/null 2>&1 || true
rm -rf "$DATA"
echo "✅ Wiped. Starting fresh …"
pm2 start arb >/dev/null 2>&1 || pm2 start arb.js --name arb
pm2 save >/dev/null 2>&1 || true
echo "Done – open /arb. The bot reads the pools again (1–3 min) and fixes its trust lines by itself."
