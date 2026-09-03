#!/usr/bin/env bash
# Deploy monitor.budgetgold.org — the ONLY thing this does is fast-forward
# this checkout on the VPS. No docker: the trading platform's Caddy
# bind-mounts ./web read-only, so files are live the moment they land on
# disk. Nothing here can touch the platform's containers or FIX session.
#
# Usage (on VPS):  /opt/bgtvmonitor/deploy.sh
#
# Remember to bump the ?v= cache-buster in web/index.html for anything the
# TVs have cached (app.js / styles.css).
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"

if [[ -n "$(git status --porcelain)" ]]; then
    echo "deploy: refusing — working tree is not clean:"; git status --short; exit 1
fi
before=$(git rev-parse HEAD)
git pull --ff-only --quiet origin main
after=$(git rev-parse HEAD)
if [[ "$before" == "$after" ]]; then
    echo "deploy: already at ${after:0:7}"
else
    echo "deploy: ${before:0:7} -> ${after:0:7}"; git diff --name-only "$before" "$after" | sed 's/^/  /'
fi
./scripts/fetch-news.py || echo "deploy: news fetch failed (keeping previous news.json)"
echo "deploy: site https://monitor.budgetgold.org/ -> $(curl -s -o /dev/null -w '%{http_code}' -m 10 https://monitor.budgetgold.org/ || echo 000)"
