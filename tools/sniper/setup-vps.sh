#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VPS: Node.js 22, .env (asks for the seed), firewall,
# a connection check against the real XRPL, then pm2 so the bot runs 24/7.
#   cd /root/sniper && bash setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

if [ "$(id -u)" != "0" ]; then echo "Bitte als root ausführen."; exit 1; fi

say "1/6 System-Pakete"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates ufw >/dev/null

say "2/6 Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v
[ -d node_modules/xrpl ] || npm install --omit=dev --no-audit --no-fund

say "3/6 Einstellungen (.env)"
if [ -f .env ] && grep -q '^WALLET_SEED=s' .env; then
  echo ".env ist schon da – bleibt wie sie ist."
else
  cp .env.example .env
  while :; do
    read -rsp "Family Seed der NEUEN Bot-Wallet (beginnt mit s, wird nicht angezeigt): " SEED; echo
    ADDR=$(SEED="$SEED" node -e "import('xrpl').then(({Wallet})=>{try{console.log(Wallet.fromSeed(process.env.SEED.trim()).address)}catch{process.exit(1)}})" 2>/dev/null) && break
    echo "Das ist kein gültiger Seed, bitte nochmal."
  done
  KEY=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  sed -i "s|^WALLET_SEED=.*|WALLET_SEED=${SEED}|; s|^STATUS_KEY=.*|STATUS_KEY=${KEY}|; s|^PUBLIC_URL=.*|PUBLIC_URL=http://${IP}:3100|" .env
  unset SEED
  read -rp "Discord-Webhook für Meldungen (leer lassen = keiner): " HOOK
  [ -n "$HOOK" ] && sed -i "s|^DISCORD_WEBHOOK=.*|DISCORD_WEBHOOK=${HOOK}|" .env
  echo "Bot-Wallet: $ADDR"
fi
chmod 600 .env

say "4/6 Firewall (SSH + Statusseite 3100)"
ufw allow OpenSSH >/dev/null
ufw allow 3100/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

say "5/6 Verbindungstest mit dem echten XRPL (ohne Käufe, 60 s)"
rm -rf /tmp/sniper-check
DRY_RUN=1 PORT= DATA_DIR=/tmp/sniper-check timeout 60 node index.js > /tmp/sniper-check.log 2>&1 || true
grep -E "connected to|Sniper running|Launch|Skip|DRY buy|cannot reach" /tmp/sniper-check.log | head -15 || true
if ! grep -q "Sniper running" /tmp/sniper-check.log; then
  echo; echo "❌ Keine Verbindung zum XRPL. Log: /tmp/sniper-check.log – bitte an Claude schicken."; exit 1
fi
echo "✅ Verbindung steht."

say "6/6 Dauerbetrieb mit pm2"
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null
pm2 delete sniper >/dev/null 2>&1 || true
pm2 start index.js --name sniper --cwd "$DIR" >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null
sleep 5
pm2 status sniper

URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)
KEY=$(grep '^STATUS_KEY=' .env | cut -d= -f2-)
ADDR=$(S="$(grep '^WALLET_SEED=' .env | cut -d= -f2-)" node -e "import('xrpl').then(({Wallet})=>console.log(Wallet.fromSeed(process.env.S.trim()).address))" 2>/dev/null || true)
cat <<EOF

========================================================
 Fertig! Der Bot läuft.

 Bot-Wallet:   ${ADDR}
   → dorthin die XRP schicken (z. B. 50). Ohne Guthaben kauft er nichts.

 Statusseite:  ${URL}/?key=${KEY}
   → als Lesezeichen aufs Handy. Den Link niemandem geben.

 Live-Log:     pm2 logs sniper      (Strg+C beendet nur die Anzeige)
 Neustart:     pm2 restart sniper
 Stoppen:      pm2 stop sniper
========================================================
EOF
