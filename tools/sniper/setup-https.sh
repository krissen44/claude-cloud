#!/usr/bin/env bash
# HTTPS for the status page: Caddy (free certificate from Let's Encrypt) in front of the bot.
#   cd /root/sniper && bash setup-https.sh xrpsnipes.tech
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
DOMAIN="${1:-}"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
if [ -z "$DOMAIN" ]; then echo "Usage: bash setup-https.sh your-domain.tld"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Please run as root."; exit 1; fi
if [ ! -f .env ]; then echo "Run setup-vps.sh first."; exit 1; fi

say "1/5 Does $DOMAIN point to this server?"
MYIP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
echo "Server: $MYIP   $DOMAIN: ${DNSIP:-(no record)}"
if [ "$DNSIP" != "$MYIP" ]; then
  cat <<MSG
❌ $DOMAIN doesn't point to this server yet.
   In Hostinger: Domains → $DOMAIN → DNS / Nameservers → DNS records:
     A record  Name: @   Points to: $MYIP   (delete other A records for @)
   Then wait 5–30 minutes and run this script again.
MSG
  exit 1
fi
WWW=""
if [ "$(getent ahostsv4 "www.$DOMAIN" | awk '{print $1; exit}' || true)" = "$MYIP" ]; then WWW=", www.$DOMAIN"; fi

say "2/5 Caddy (web server with automatic HTTPS)"
if ! command -v caddy >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi
caddy version
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN$WWW {
	encode gzip
	header {
		X-Robots-Tag "noindex, nofollow"
		Referrer-Policy "no-referrer"
		Strict-Transport-Security "max-age=31536000"
	}
	reverse_proxy 127.0.0.1:3100
}
CADDY
systemctl enable caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "3/5 Bot: status page over HTTPS only"
setv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
setv PORT 3100
setv BIND 127.0.0.1
setv PUBLIC_URL "https://$DOMAIN"
pm2 restart sniper --update-env >/dev/null
pm2 save >/dev/null

say "4/5 Firewall: 80/443 open, 3100 closed"
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw delete allow 3100/tcp >/dev/null 2>&1 || true
ufw status | head -8

say "5/5 Getting the certificate and testing (up to 60 s)"
CODE=""
for i in $(seq 1 12); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "https://$DOMAIN/" || true)
  [ "$CODE" = "403" ] || [ "$CODE" = "200" ] && break
  sleep 5
done
KEY=$(grep '^STATUS_KEY=' .env | cut -d= -f2- | awk '{print $1}')
if [ "$CODE" = "403" ] || [ "$CODE" = "200" ]; then
  cat <<DONE

========================================================
 ✅ HTTPS is running.

 Status page:  https://$DOMAIN
   → log in with your password (set your own: bash set-password.sh)
   → delete the old bookmark (http://…:3100).
========================================================
DONE
else
  echo "❌ https://$DOMAIN doesn't answer yet (code: ${CODE:-none})."
  echo "   Log: journalctl -u caddy --no-pager | tail -20  → send it to Claude."
  echo "   Is there a firewall in the Hostinger panel? Open 80 and 443 there."
  exit 1
fi
