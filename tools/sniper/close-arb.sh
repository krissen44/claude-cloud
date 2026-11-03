#!/bin/bash
# Puts the arbitrage bot to sleep: stops it (and keeps it stopped after a reboot), then empties its
# wallet – tickets used up, offers cancelled, tokens sold, trust lines deleted – and, with
# "--send sniper", sends the free XRP to the sniper wallet. "--dry" only shows what it would do.
#   bash close-arb.sh --dry
#   bash close-arb.sh --send sniper
set -e
cd "$(dirname "$0")"
if [ "$1" != "--dry" ]; then
  pm2 stop arb >/dev/null 2>&1 && echo "⏸ arb bot stopped" || echo "(arb bot was not running)"
  pm2 save >/dev/null 2>&1 || true
fi
node close-arb.mjs "$@"
