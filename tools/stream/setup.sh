#!/bin/bash
# Bark Arena TV — 24/7 YouTube live stream of https://game.scrappyxrp.fun/tv
# For a fresh Ubuntu 24.04 VPS. Run as root:   bash setup.sh
# It asks for the YouTube stream key, installs everything and starts the stream as a service
# that restarts itself (after a crash, a lost connection or a reboot). Run it again to update.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Please run as root:  sudo bash setup.sh"; exit 1; }
DIR=/opt/barkarena-tv ENVF=/etc/barkarena-tv.env

if [ -f "$ENVF" ] && grep -q '^YT_KEY=.' "$ENVF"; then
  echo "Existing stream key found in $ENVF (keeping it)."
else
  read -rsp "YouTube stream key (YouTube Studio → Go live → Stream → Stream key): " KEY; echo
  [ -n "$KEY" ] || { echo "No key given."; exit 1; }
  cat > "$ENVF" <<EOF
# Bark Arena TV settings — after a change:  systemctl restart barkarena-tv
YT_KEY=$KEY
TV_URL=https://game.scrappyxrp.fun/tv
FPS=30
VIDEO_KBPS=3000
EOF
fi

echo "== Installing packages (a few minutes)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq xvfb pulseaudio pulseaudio-utils ffmpeg curl ca-certificates fonts-noto-color-emoji fonts-dejavu-core >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
id tv >/dev/null 2>&1 || useradd -m -s /bin/bash tv
chown root:tv "$ENVF"; chmod 640 "$ENVF"
mkdir -p "$DIR"

cat > "$DIR/package.json" <<'EOF'
{ "private": true, "type": "module", "dependencies": { "playwright": "1.48.2" } }
EOF

cat > "$DIR/browser.mjs" <<'EOF'
// Opens the TV page full-screen on the virtual display and keeps it healthy:
// reloads every 6 hours and restarts the browser if the page stops moving.
import { chromium } from "playwright";
const url = process.env.TV_URL || "https://game.scrappyxrp.fun/tv";
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (;;) {
  let br;
  try {
    br = await chromium.launch({headless: false, ignoreDefaultArgs: ["--enable-automation"], executablePath: process.env.CHROMIUM || undefined,
      args: ["--kiosk", "--window-position=0,0", "--window-size=1280,720", "--force-device-scale-factor=1.6",
             "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--noerrdialogs", "--disable-infobars",
             "--hide-scrollbars", "--disable-features=Translate", "--disable-session-crashed-bubble"]});
    const page = await (await br.newContext({viewport: null})).newPage();
    await page.goto(url, {waitUntil: "load", timeout: 60000});
    console.log(new Date().toISOString(), "TV page open:", url);
    const until = Date.now() + 6 * 3600e3;
    while (Date.now() < until) {
      await sleep(30000);
      const beat = await page.evaluate(() => typeof TV === "object" ? TV.beat : 0).catch(() => 0);
      if (!beat || Date.now() - beat > 4 * 60e3) { console.log(new Date().toISOString(), "page stalled — restarting"); break; }
    }
  } catch (e) { console.error(new Date().toISOString(), "browser:", e.message); }
  await br?.close().catch(() => {});
  await sleep(5000);
}
EOF

cat > "$DIR/run.sh" <<'EOF'
#!/bin/bash
# virtual screen + virtual speaker → browser → ffmpeg → YouTube
set -u
source /etc/barkarena-tv.env
export DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/tv-runtime PLAYWRIGHT_BROWSERS_PATH=/opt/barkarena-tv/browsers
mkdir -p -m 700 "$XDG_RUNTIME_DIR"
pkill -u "$(id -u)" -x Xvfb 2>/dev/null; pulseaudio -k 2>/dev/null; sleep 1
Xvfb :99 -screen 0 1280x720x24 -nolisten tcp & XVFB=$!
pulseaudio -D --exit-idle-time=-1 --disallow-exit
sleep 2
pactl load-module module-null-sink sink_name=tv sink_properties=device.description=BarkArenaTV >/dev/null
pactl set-default-sink tv
node /opt/barkarena-tv/browser.mjs & BROWSER=$!
trap 'kill $BROWSER $XVFB 2>/dev/null; pulseaudio -k 2>/dev/null' EXIT
sleep 15
OUT="${STREAM_OUT:-rtmp://a.rtmp.youtube.com/live2/$YT_KEY}"
while kill -0 $BROWSER 2>/dev/null; do
  ffmpeg -hide_banner -loglevel warning \
    -thread_queue_size 1024 -f x11grab -video_size 1280x720 -framerate "$FPS" -draw_mouse 0 -i :99 \
    -thread_queue_size 1024 -f pulse -i tv.monitor \
    -c:v libx264 -preset veryfast -b:v "${VIDEO_KBPS}k" -maxrate "${VIDEO_KBPS}k" -bufsize "$((VIDEO_KBPS * 2))k" \
    -pix_fmt yuv420p -g "$((FPS * 2))" -c:a aac -b:a 128k -ar 44100 -f flv "$OUT"
  echo "$(date -Is) stream stopped — reconnecting in 5 s"; sleep 5
done
EOF
chmod 755 "$DIR/run.sh"

echo "== Installing the browser…"
cd "$DIR"
npm install --silent --no-audit --no-fund >/dev/null
PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers" npx --yes playwright install --with-deps chromium >/dev/null
chown -R tv:tv "$DIR"

cat > /etc/systemd/system/barkarena-tv.service <<'EOF'
[Unit]
Description=Bark Arena TV — 24/7 YouTube stream
After=network-online.target
Wants=network-online.target

[Service]
User=tv
ExecStart=/opt/barkarena-tv/run.sh
Restart=always
RestartSec=10
KillMode=control-group

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable barkarena-tv >/dev/null 2>&1
systemctl restart barkarena-tv
sleep 20
echo
systemctl --no-pager --lines=0 status barkarena-tv | head -4
echo
echo "✅ Bark Arena TV is running and streaming to YouTube."
echo "   It may take 20–30 s until YouTube Studio shows the picture."
echo "   Live log:        journalctl -u barkarena-tv -f"
echo "   Restart:         systemctl restart barkarena-tv"
echo "   Stop / start:    systemctl stop barkarena-tv / systemctl start barkarena-tv"
echo "   New stream key:  nano $ENVF   then   systemctl restart barkarena-tv"
