#!/bin/bash
# Bark Arena Shorts factory — setup for a fresh Ubuntu 24.04 VPS. As root:
#   curl -fsSL https://game.scrappyxrp.fun/kit/shorts.sh -o shorts.sh && bash shorts.sh
# Every morning (05:10 UTC) it records the best fights of the last day as 9:16 clips with sound and
# uploads them, with ready-made captions, to /admin → "📱 Clips". Run it again any time to update.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root:  sudo bash shorts.sh"; exit 1; }
GAME=${GAME_URL:-https://game.scrappyxrp.fun}
DIR=/opt/barkarena-shorts ENVF=/etc/barkarena-shorts.env

if [ -f "$ENVF" ] && grep -q '^ADMIN_KEY=.' "$ENVF"; then
  echo "Settings found in $ENVF (keeping them)."
else
  read -rsp "ADMIN_KEY of the game (the same one you use for /admin): " KEY; echo
  [ -n "$KEY" ] || { echo "No key given."; exit 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' "$GAME/api/admin/clips?key=$KEY" || true)
  [ "$code" = 200 ] || { echo "The game answered $code for this key — wrong key, or the game update with the clips isn't live yet."; exit 1; }
  cat > "$ENVF" <<EOF
# Bark Arena Shorts factory — after a change nothing needs restarting (it runs once a day)
GAME_URL=$GAME
ADMIN_KEY=$KEY
CLIPS=3
MUSIC=1
EOF
fi

echo "== Installing packages (a few minutes)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ffmpeg curl ca-certificates fonts-noto-color-emoji fonts-dejavu-core >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
id shorts >/dev/null 2>&1 || useradd -m -s /bin/bash shorts
chown root:shorts "$ENVF"; chmod 640 "$ENVF"
mkdir -p "$DIR"
curl -fsSL "$GAME/kit/factory.mjs" -o "$DIR/factory.mjs"
echo '{ "private": true, "type": "module", "dependencies": { "playwright": "1.48.2" } }' > "$DIR/package.json"
cd "$DIR"
npm install --silent --no-audit --no-fund >/dev/null
PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers" npx --yes playwright install --with-deps chromium >/dev/null
chown -R shorts:shorts "$DIR"

cat > /etc/systemd/system/barkarena-shorts.service <<'EOF'
[Unit]
Description=Bark Arena Shorts factory (makes today's clips)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=shorts
EnvironmentFile=/etc/barkarena-shorts.env
Environment=PLAYWRIGHT_BROWSERS_PATH=/opt/barkarena-shorts/browsers WORK_DIR=/opt/barkarena-shorts/work STATE_FILE=/opt/barkarena-shorts/state.json
WorkingDirectory=/opt/barkarena-shorts
ExecStartPre=/usr/bin/curl -fsSL -o /opt/barkarena-shorts/factory.mjs ${GAME_URL}/kit/factory.mjs
ExecStart=/usr/bin/node /opt/barkarena-shorts/factory.mjs
TimeoutStartSec=1800
EOF
cat > /etc/systemd/system/barkarena-shorts.timer <<'EOF'
[Unit]
Description=Bark Arena Shorts factory, every morning

[Timer]
OnCalendar=*-*-* 05:10:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now barkarena-shorts.timer >/dev/null 2>&1
echo "== Making the first clips now (1–3 minutes)…"
systemctl start barkarena-shorts.service || true
journalctl -u barkarena-shorts.service -n 8 --no-pager -o cat
echo
echo "✅ Shorts factory installed. New clips every morning at 05:10 UTC in /admin → 📱 Clips."
echo "   Make clips now:   systemctl start barkarena-shorts"
echo "   Log:              journalctl -u barkarena-shorts -n 50"
echo "   Settings:         nano $ENVF   (CLIPS per day, MUSIC=0 for game sounds only)"
