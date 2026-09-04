# monitor.budgetgold.org — how it runs

This repo is the **source of truth for the TV price board**. It is a static
site (`web/`) plus one cron script. It is deliberately independent of the
trading platform repo (`bgtradingplatform`): deploying either one cannot
break the other.

## On the VPS (167.235.29.135)

```
/opt/bgtvmonitor        <- this repo: web/ + priceapi/ + its own compose + .env
/opt/fix-gateway        <- bgtradingplatform: FIX gateway, its own priceapi, Mini App, Caddy
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

## Price API — ours

`bgtv-priceapi`, built from `priceapi/` in this repo, serving `/api/prices`.

It used to be the trading platform's `fixgw-priceapi`, shared by both
products. That coupling was real and it bit: changes made for the board (the
exchange calendar, the quote-driven OPEN badge) were edits to a service the
Telegram Mini App depends on, and every platform rebuild blipped the board's
price feed. Since 2026-09-04 the two share no files, no image, no container
and no state volume. The platform keeps its own copy for the Mini App.

The response shape both still produce:

`GET /api/prices` -> `{ source, sourceMode: live|stale|closed|error,
prices: { XAU, XAG: { price, bid, ask, dayHigh, dayLow, dayChange,
dayChangePercent, updatedAt } }, history: { XAU, XAG: [{ price, ts }] },
marketSummary: { status, untilOpen, untilClose, openTime, closeTime } }`

The OPEN/CLOSED badge is `marketSummary`: the real spot-metals week (Sunday
23:00 -> Friday 22:00 London, one-hour break nightly) OR live quotes — a real
price always wins. Changing that is now a change to *this* repo alone.

### What is still shared, and why

* **`fixgw-gateway`** — the FIX session that produces the prices. If it stops,
  both products lose live quotes; the board keeps serving last-known prices
  and marks itself DELAYED. Removing this would mean a second, different price
  source for the board.
* **the `fixgw` docker network** — declared `external` in our compose purely so
  we can reach that gateway. `docker compose down` here cannot delete it.
* **Caddy** — one TLS terminator and router for the single domain. If it dies,
  both go down. Fixing that properly means a second domain for the Mini App.

The board holds only `GATEWAY_READONLY_TOKEN`, which the gateway restricts to
`/prices`. It deliberately does not hold `GATEWAY_API_TOKEN`, so nothing in
this repo can place or cancel an order.

### Secrets

`.env` on the VPS holds `GATEWAY_READONLY_TOKEN`; see `.env.example`. It is
gitignored — **this repository is public**.

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
