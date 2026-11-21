#!/bin/sh
# Copies the code to the home server and rebuilds wxboard there.
# Usage (from ~/repos/wxboard on the Mac):  ./deploy.sh
# Keeps the server's own config/, data/ and .env untouched.
set -e
# The VM's Tailscale name, so this only ever reaches your own server, from home or away. Don't use a
# 192.168.x.x address: other networks (e.g. a crew house) reuse the same numbers for their own devices.
# Override for one run with:  WX_SERVER=joe@100.x.y.z ./deploy.sh
SERVER="${WX_SERVER:-joe@wxboard}"
DIR=/opt/wxboard
cd "$(dirname "$0")"

rsync -av --exclude .git --exclude data --exclude test --exclude node_modules \
  --exclude config.json --exclude config --exclude .env --exclude deploy.sh --exclude deploy.ps1 \
  ./ "$SERVER:$DIR/"

ssh "$SERVER" "cd $DIR && docker compose up -d --build && docker compose ps"
echo
echo "Deployed. Open https://wxboard.app and reload the page."
