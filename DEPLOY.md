# monitor.budgetgold.org — how it runs

This repo is the **source of truth for the TV price board**. It is a static
site (`web/`) plus one cron script. It is deliberately independent of the
trading platform repo (`bgtradingplatform`): deploying either one cannot
break the other.

## On the VPS (167.235.29.135)

```
/opt/bgtvmonitor        <- this repo (public; plain `git clone`, no keys)
/opt/fix-gateway        <- bgtradingplatform: FIX gateway, priceapi, Mini App, Caddy
```

The platform's Caddy serves `monitor.budgetgold.org`:

| path        | served from                         | owned by            |
|-------------|-------------------------------------|---------------------|
| `/`         | `/opt/bgtvmonitor/web` (bind-mount → `/srv`, read-only) | **this repo** |
| `/api/*`    | `fixgw-priceapi:8081`               | bgtradingplatform   |
| `/app/*`    | `fixgw-webapp:8082` (Telegram Mini App) | bgtradingplatform |

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

## Retired

`api/prices.js`, `vercel.json`, `package.json` are the 2026-Q1 Vercel
deployment. Kept for reference; nothing uses them.
