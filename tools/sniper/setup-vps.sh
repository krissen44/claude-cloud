#!/usr/bin/env bash
# One-shot setup for a fresh Ubuntu VPS: Node.js 22, .env (asks for the seed), firewall,
# a connection check against the real XRPL, then pm2 so the bot runs 24/7.
#   cd /root/sniper && bash setup-vps.sh
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }

if [ "$(id -u)" != "0" ]; then echo "Please run as root."; exit 1; fi

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

say "3/6 Settings (.env)"
if [ -f .env ] && OK_ADDR=$(node wallet.mjs check 2>/dev/null); then
  echo ".env already exists (bot wallet $OK_ADDR) – kept as it is."
else
  [ -f .env ] && echo "The existing .env has no valid key – creating it again."
  cp .env.example .env
  echo "Use the NEW wallet for the bot only – never your main wallet!"
  while :; do
    read -rp "Address of the bot wallet (starts with r): " ADDRESS
    [[ "$ADDRESS" =~ ^r[1-9A-HJ-NP-Za-km-z]{24,34}$ ]] && break
    echo "That doesn't look like an XRPL address, please try again."
  done
  while :; do
    echo "Now the key: 12/24 words, family seed (s…) or Xaman secret numbers."
    read -rsp "Input (not shown on screen), then Enter: " SECRET; echo
    if FOUND=$(SECRET="$SECRET" ADDRESS="$ADDRESS" node wallet.mjs find 2>/tmp/wallet-why); then break; fi
    echo "❌ Doesn't match the address $ADDRESS."
    echo "   $(cat /tmp/wallet-why)"
    echo "   Please enter it again."
    rm -f /tmp/wallet-why
  done
  KIND=$(cut -f1 <<<"$FOUND"); WPATH=$(cut -f2 <<<"$FOUND")
  CLEAN=$(tr -s '[:space:]' ' ' <<<"$SECRET" | sed 's/^ //; s/ $//')
  sed -i '/^WALLET_SEED=/d; /^WALLET_ADDRESS=/d' .env
  {
    echo "WALLET_ADDRESS=${ADDRESS}"
    case "$KIND" in
      seed) echo "WALLET_SEED=${CLEAN}" ;;
      mnemonic) echo "WALLET_MNEMONIC=${CLEAN,,}"; echo "WALLET_PATH=${WPATH}" ;;
      numbers) echo "WALLET_SECRET_NUMBERS=${CLEAN}" ;;
    esac
  } >> .env
  unset SECRET CLEAN
  echo "✅ Key matches $ADDRESS"
  KEY=$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24)
  IP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
  sed -i "s|^STATUS_KEY=.*|STATUS_KEY=${KEY}|; s|^PUBLIC_URL=.*|PUBLIC_URL=http://${IP}:3100|" .env
  read -rp "Discord webhook for messages (leave empty = none): " HOOK
  if [ -n "$HOOK" ]; then sed -i "s|^DISCORD_WEBHOOK=.*|DISCORD_WEBHOOK=${HOOK}|" .env; fi
fi
chmod 600 .env

say "4/6 Firewall (SSH + status page 3100)"
ufw allow OpenSSH >/dev/null
ufw allow 3100/tcp >/dev/null
ufw --force enable >/dev/null
ufw status | head -5

say "5/6 Connection test with the real XRPL (no buys, 60 s)"
rm -rf /tmp/sniper-check
DRY_RUN=1 PORT= DATA_DIR=/tmp/sniper-check timeout 60 node index.js > /tmp/sniper-check.log 2>&1 || true
grep -E "connected to|Sniper running|Launch|Skip|DRY buy|cannot reach" /tmp/sniper-check.log | head -15 || true
if ! grep -q "Sniper running" /tmp/sniper-check.log; then
  echo; echo "❌ No connection to the XRPL. Log: /tmp/sniper-check.log – please send it to Claude."; exit 1
fi
echo "✅ Connected."

say "6/6 Running 24/7 with pm2"
command -v pm2 >/dev/null || npm install -g pm2 >/dev/null
pm2 delete sniper >/dev/null 2>&1 || true
pm2 start index.js --name sniper --cwd "$DIR" >/dev/null
pm2 save >/dev/null
pm2 startup systemd -u root --hp /root >/dev/null
sleep 5
pm2 status sniper

URL=$(grep '^PUBLIC_URL=' .env | cut -d= -f2-)
KEY=$(grep '^STATUS_KEY=' .env | cut -d= -f2-)
ADDR=$(grep '^WALLET_ADDRESS=' .env | cut -d= -f2- | awk '{print $1}')
cat <<EOF

========================================================
 Done! The bot is running.

 Bot-Wallet:   ${ADDR}
   → send the XRP there (e.g. 50). Without a balance it buys nothing.

 Status page:  ${URL}
   → login password: ${KEY}
     (set your own password: bash set-password.sh)

 Live log:     pm2 logs sniper      (Ctrl+C only closes the view)
 Restart:      pm2 restart sniper
 Stop:         pm2 stop sniper
========================================================
EOF
