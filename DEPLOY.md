# monitor.budgetgold.org — how it runs

This repo is the **source of truth for the TV price board**. It is a static
site (`web/`) plus one cron script. It is deliberately independent of the
trading platform repo (`bgtradingplatform`): deploying either one cannot
break the other.

## On the VPS (167.235.29.135)

```
/opt/bgtvmonitor        <- this repo, checked out over SSH with its OWN deploy key
/opt/fix-gateway        <- bgtradingplatform: FIX gateway, priceapi, Mini App, Caddy
```

The checkout's `origin` is `git@github-bgtvmonitor:dzhavadovmirza-byte/bgtvmonitor.git`
— an alias in `/root/.ssh/config` that pins `IdentityFile /root/.ssh/id_ed25519_bgtvmonitor`
with `IdentitiesOnly yes`. That is deliberate: the plain `github.com` host on the box is
bound to the trading platform's deploy key, and without the alias git silently
authenticated the board's pulls with the platform's credentials. The two projects must
not share a key. (Anonymous HTTPS is not used because GitHub intermittently answers
401 to unauthenticated git traffic from this cloud IP.)

One-time setup per new key: add the contents of `/root/.ssh/id_ed25519_bgtvmonitor.pub`
under **bgtvmonitor → Settings → Deploy keys** (read-only). Until then `deploy.sh`
fails at `git pull` with `Permission denied (publickey)` and the site keeps serving the
last checkout — nothing breaks.

The platform's Caddy serves `monitor.budgetgold.org`:

| path        | served from                         | owned by            |
|-------------|-------------------------------------|---------------------|
| `/`         | `/opt/bgtvmonitor/web` (compose bind-mount → `/srv`, read-only) | **this repo** |
| `/api/*`    | `fixgw-priceapi:8081`               | bgtradingplatform   |
| `/app/*`    | `fixgw-webapp:8082` (Telegram Mini App) | bgtradingplatform |

The only line the platform holds about this repo is the bind-mount in its
`docker-compose.yml` (`/opt/bgtvmonitor/web:/srv:ro`). Residual coupling: a platform
deploy that changes the Caddyfile recreates Caddy (~3 s blip for the board), and a
broken Caddyfile takes both down — that is the platform's responsibility to validate.

## Deploy

```
/opt/bgtvmonitor/deploy.sh      # git pull --ff-only, refresh news.json, curl check
```
No docker, no restarts. Bump `?v=` in `web/index.html` when `app.js` /
`styles.css` change — TVs cache aggressively.

## Price API contract (consumed, not owned)

`GET /api/prices` → `{ source, sourceMode: live|stale|closed|error,
prices: { XAU, XAG: { price, bid, ask, dayHigh, dayLow, dayChange,
dayChangePercent, updatedAt } }, history: { XAU, XAG: [{ price, ts }] },
marketSummary: { status, untilOpen, untilClose, openTime, closeTime } }`.

The board's OPEN/CLOSED badge is `marketSummary` from priceapi: Mon–Fri
09:00 → 01:00 Dubai (the FIX session window). Changing that schedule is a
platform change (`priceapi/prices.js` in bgtradingplatform), not a monitor one.

## News ticker

`scripts/fetch-news.py` (stdlib only) pulls Yahoo Finance RSS for gold/silver
and writes `web/news.json` atomically; on failure it keeps the previous
file. Browser can't read the RSS directly (no CORS), hence the cron hop:

```
*/10 * * * * /opt/bgtvmonitor/scripts/fetch-news.py >> /var/log/fix-news.log 2>&1
```

## Rollback (cutover of 2026-09-03)

Pre-cutover copies of the board as it lived inside the platform tree:
`/opt/fix-gateway-attic/web-20260903-*.tar.gz`; the platform's compose before the
mount change: `/opt/fix-gateway/docker-compose.yml.bak-decouple-*`. To roll back,
restore that compose line and `docker compose up -d --force-recreate --no-deps caddy`.

## Retired

`api/prices.js`, `vercel.json`, `package.json` are the 2026-Q1 Vercel
deployment. Kept for reference; nothing uses them.
