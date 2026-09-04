#!/usr/bin/env bash
# Deploy monitor.budgetgold.org.
#
# This script touches ONLY this project: the static site under web/ and our
# own price API container, bgtv-priceapi. It can never rebuild, recreate or
# stop anything belonging to the trading platform in /opt/fix-gateway — no
# shared compose file, no shared image, no shared container.
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
    changed=""
else
    echo "deploy: ${before:0:7} -> ${after:0:7}"
    changed=$(git diff --name-only "$before" "$after")
    echo "$changed" | sed 's/^/  /'
fi

# web/ is a read-only bind-mount into the platform's Caddy, so static changes
# are live the moment they land on disk — nothing to restart for those.
# The price API is ours, and only ours, so rebuild it when its sources move.
if echo "$changed" | grep -qE '^(priceapi/|docker-compose\.yml$|Dockerfile$)'; then
    if [[ ! -f .env ]]; then
        echo "deploy: ERROR — .env missing; bgtv-priceapi needs GATEWAY_READONLY_TOKEN" >&2
        exit 1
    fi
    echo "deploy: priceapi sources changed — rebuilding bgtv-priceapi (this project only)"
    docker compose build priceapi
    # --no-deps is belt-and-braces: this project declares no dependencies, and
    # the fixgw network is external, so compose cannot reach into the platform.
    docker compose up -d --force-recreate --no-deps priceapi
    for _ in $(seq 1 10); do
        docker exec bgtv-priceapi wget -qO- http://127.0.0.1:8081/health >/dev/null 2>&1 && break
        sleep 3
    done
fi

./scripts/fetch-news.py || echo "deploy: news fetch failed (keeping previous news.json)"

site=$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://monitor.budgetgold.org/ || echo 000)
api=$(curl -s -o /dev/null -w '%{http_code}' -m 10 https://monitor.budgetgold.org/api/prices || echo 000)
echo "deploy: site -> $site   /api/prices -> $api"
[[ "$site" == 200 && "$api" == 200 ]] || { echo "deploy: WARNING — expected 200/200"; exit 1; }
