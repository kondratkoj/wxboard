#!/bin/sh
# Copies the code to the home server and rebuilds wxboard there.
# Usage (from ~/repos/wxboard on the Mac):  ./deploy.sh
# Keeps the server's own config/, data/ and .env untouched.
set -e
SERVER="${WX_SERVER:-joe@192.168.1.215}"
DIR=/opt/wxboard
cd "$(dirname "$0")"

rsync -av --exclude .git --exclude data --exclude test --exclude node_modules \
  --exclude config.json --exclude config --exclude .env --exclude deploy.sh \
  ./ "$SERVER:$DIR/"

ssh "$SERVER" "cd $DIR && docker compose up -d --build && docker compose ps"
echo
echo "Deployed. Open https://wxboard.app and reload the page."
