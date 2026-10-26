#!/usr/bin/env bash
# HTTPS for the status page: Caddy (free certificate from Let's Encrypt) in front of the bot.
#   cd /root/sniper && bash setup-https.sh xrpsnipes.tech
set -euo pipefail
cd "$(dirname "$0")"
say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
DOMAIN="${1:-}"
DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN%%/*}"
if [ -z "$DOMAIN" ]; then echo "Aufruf: bash setup-https.sh deine-domain.tld"; exit 1; fi
if [ "$(id -u)" != "0" ]; then echo "Bitte als root ausführen."; exit 1; fi
if [ ! -f .env ]; then echo "Erst setup-vps.sh ausführen."; exit 1; fi

say "1/5 Zeigt $DOMAIN auf diesen Server?"
MYIP=$(curl -fsS4 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')
DNSIP=$(getent ahostsv4 "$DOMAIN" | awk '{print $1; exit}' || true)
echo "Server: $MYIP   $DOMAIN: ${DNSIP:-(kein Eintrag)}"
if [ "$DNSIP" != "$MYIP" ]; then
  cat <<MSG
❌ $DOMAIN zeigt noch nicht auf diesen Server.
   In Hostinger: Domains → $DOMAIN → DNS / Nameserver → DNS-Einträge:
     A-Eintrag  Name: @   Ziel: $MYIP   (vorhandene A-Einträge für @ löschen)
   Danach 5–30 Minuten warten und dieses Skript nochmal starten.
MSG
  exit 1
fi
WWW=""
if [ "$(getent ahostsv4 "www.$DOMAIN" | awk '{print $1; exit}' || true)" = "$MYIP" ]; then WWW=", www.$DOMAIN"; fi

say "2/5 Caddy (Webserver mit automatischem HTTPS)"
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

say "3/5 Bot: Statusseite nur noch über HTTPS"
setv() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
setv PORT 3100
setv BIND 127.0.0.1
setv PUBLIC_URL "https://$DOMAIN"
pm2 restart sniper --update-env >/dev/null
pm2 save >/dev/null

say "4/5 Firewall: 80/443 auf, 3100 zu"
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw delete allow 3100/tcp >/dev/null 2>&1 || true
ufw status | head -8

say "5/5 Zertifikat holen und testen (bis 60 s)"
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
 ✅ HTTPS läuft.

 Statusseite:  https://$DOMAIN
   → Login mit deinem Passwort (eigenes setzen: bash set-password.sh)
   → altes Lesezeichen (http://…:3100) löschen.
========================================================
DONE
else
  echo "❌ https://$DOMAIN antwortet noch nicht (Code: ${CODE:-keiner})."
  echo "   Log: journalctl -u caddy --no-pager | tail -20  → an Claude schicken."
  echo "   Läuft im Hostinger-Panel eine eigene Firewall? Dort 80 und 443 freigeben."
  exit 1
fi
