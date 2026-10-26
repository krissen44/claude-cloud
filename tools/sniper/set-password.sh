#!/usr/bin/env bash
# Sets your own login password for the status page (logs out all devices).
#   cd /root/sniper && bash set-password.sh
set -euo pipefail
cd "$(dirname "$0")"
while :; do
  read -rsp "New password (at least 12 characters, no spaces): " P1; echo
  read -rsp "Again: " P2; echo
  if [ "$P1" != "$P2" ]; then echo "They don't match."; continue; fi
  if [ ${#P1} -lt 12 ] || [[ "$P1" =~ [[:space:]] ]]; then echo "Too short or contains spaces."; continue; fi
  if [[ "$P1" == \#* || "$P1" == [\"\']* || "$P1" == *[\"\'] ]]; then echo "Please don't start with # or start/end with quotes."; continue; fi
  break
done
sed -i '/^STATUS_PASSWORD=/d' .env
echo "STATUS_PASSWORD=$P1" >> .env
unset P1 P2
chmod 600 .env
pm2 restart sniper --update-env >/dev/null
echo "✅ Password set. All devices are logged out – log in with the new password."
