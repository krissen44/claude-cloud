#!/usr/bin/env bash
# Sets your own login password for the status page (logs out all devices).
#   cd /root/sniper && bash set-password.sh
set -euo pipefail
cd "$(dirname "$0")"
while :; do
  read -rsp "Neues Passwort (mind. 12 Zeichen, keine Leerzeichen): " P1; echo
  read -rsp "Nochmal: " P2; echo
  if [ "$P1" != "$P2" ]; then echo "Stimmt nicht überein."; continue; fi
  if [ ${#P1} -lt 12 ] || [[ "$P1" =~ [[:space:]] ]]; then echo "Zu kurz oder mit Leerzeichen."; continue; fi
  if [[ "$P1" == \#* || "$P1" == [\"\']* || "$P1" == *[\"\'] ]]; then echo "Bitte nicht mit # oder Anführungszeichen beginnen/enden."; continue; fi
  break
done
sed -i '/^STATUS_PASSWORD=/d' .env
echo "STATUS_PASSWORD=$P1" >> .env
unset P1 P2
chmod 600 .env
pm2 restart sniper --update-env >/dev/null
echo "✅ Passwort gesetzt. Alle Geräte sind abgemeldet – mit dem neuen Passwort anmelden."
