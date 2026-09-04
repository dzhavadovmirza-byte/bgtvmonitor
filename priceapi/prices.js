// /api/prices — the price board's OWN service. Runs as container
// bgtv-priceapi from this repo, and is deliberately NOT the trading
// platform's fixgw-priceapi, even though the code began as a copy of it.
//
// They were one service until 2026-09-04. That meant changes made for the
// board — the exchange calendar, the quote-driven OPEN badge — edited a
// service the Telegram Mini App depends on, and every platform rebuild
// blipped the board's feed. The two products carry very different risk: one
// moves real client money, the other is a shop display. They now share no
// files, no image, no container and no state.
//
// Still shared, and not removable from here: the FIX gateway that produces
// the prices, the docker network needed to reach it, and Caddy's TLS/routing.
//
// /api/prices — gateway-first price service for monitor.budgetgold.org.
//
// Response shape is identical to the original Vercel function (api/prices.js
// in bgtvmonitor) so the frontend renders without changes:
//
//   {
//     source: "Gateway" | "LastKnown",
//     sourceMode: "live" | "stale" | "closed" | "error",
//     prices: { XAU: {price,bid,ask,dayHigh,dayLow,dayChange,dayChangePercent,updatedAt}, XAG: {...} },
//     history: { XAU: [{price,ts}, ...], XAG: [...] },   // hourly, last 168
//     marketSummary: { status, untilOpen, untilClose, openTime, closeTime }
//   }
//
// Live tick (price/bid/ask) comes from the FIX gateway. Day aggregates
// (open/high/low/change) are tracked here from the same stream, anchored
// at Dubai 00:00, so we don't need an external source. State is persisted
// to /data so a container restart doesn't lose today's open or week's
// hourly history.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const GATEWAY_URL = process.env.GATEWAY_URL || "http://fixgw-gateway:8080";
// Prefer the scoped read-only token (added 2026-05-21 to stop priceapi
// from holding the full-access gateway token). Fall back to the legacy
// shared token only if the new one isn't set, so deploys don't break
// during the rollover window. Drop the fallback once VPS .env is migrated.
const GATEWAY_TOKEN =
    process.env.GATEWAY_READONLY_TOKEN ||
    process.env.GATEWAY_API_TOKEN ||
    "";
const DATA_DIR = process.env.DATA_DIR || "/data";

// Caches the latest response object so a 100rps poll from a TV dashboard
// doesn't slam the gateway. Frontend polls every 1s; the 1000ms TTL caps
// upstream gateway hits at one per second regardless of client count.
let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 1000;

// Day aggregates — anchored at Dubai-day boundary. Reset when the date
// rolls over. Persisted to dayagg.json.
let dayAgg = {
    XAU: { date: null, open: null, high: null, low: null },
    XAG: { date: null, open: null, high: null, low: null },
};

// Hourly history points (last 168 = 1 week of trend line for charts).
let historyStore = { XAU: [], XAG: [] };
let lastHistoryPush = 0;
const HISTORY_INTERVAL_MS = 3600_000;

// Last live price seen — used as fallback when the gateway is briefly down.
let lastKnown = {
    XAU: { price: null },
    XAG: { price: null },
};

// ── State persistence ────────────────────────────────────
async function loadState() {
    try { await mkdir(DATA_DIR, { recursive: true }); } catch (_) { /* exists */ }
    for (const [name, target] of [
        ["dayagg.json", dayAgg],
        ["history.json", historyStore],
        ["lastknown.json", lastKnown],
    ]) {
        try {
            const raw = await readFile(`${DATA_DIR}/${name}`, "utf8");
            const parsed = JSON.parse(raw);
            for (const k of Object.keys(parsed)) target[k] = parsed[k];
        } catch (_) { /* first boot or unreadable — ignore */ }
    }
}

let persistTimer = null;
function schedulePersist() {
    // Coalesce — many ticks per minute, persist once.
    if (persistTimer) return;
    persistTimer = setTimeout(async () => {
        persistTimer = null;
        try {
            await writeFile(`${DATA_DIR}/dayagg.json`, JSON.stringify(dayAgg));
            await writeFile(`${DATA_DIR}/history.json`, JSON.stringify(historyStore));
            await writeFile(`${DATA_DIR}/lastknown.json`, JSON.stringify(lastKnown));
        } catch (e) { console.warn("persist:", e.message); }
    }, 5_000);
    persistTimer.unref?.();
}

// ── Dubai-time helpers ───────────────────────────────────
// Dubai is UTC+4 year-round, no DST.
function dubaiDateString(ms) {
    const d = new Date(ms + 4 * 3600_000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Trading calendar: the actual spot-metals market, anchored to London.
// XAU/XAG trade Sunday 23:00 -> Friday 22:00 London, with a one-hour break
// each night at 22:00. This deliberately mirrors marketOpenAt() in
// webapp/server.js -- that file gates real order placement and stays
// authoritative -- so the board and the Mini App can never disagree about
// whether the market is open.
//
// Until 2026-09-04 this was a hand-rolled "shop hours" window (Mon-Fri
// 09:00-01:00 Dubai) that matched our own FIX session rather than the
// exchange, so the board announced a schedule a customer could not verify
// against any other source.
//
// BST runs 01:00 UTC on the last Sunday of March to 01:00 UTC on the last
// Sunday of October (GOV.UK). Dubai is UTC+4 all year, so the Dubai
// wall-clock time of these boundaries moves by an hour twice a year --
// which is why the labels below are derived from the instant, never fixed.
const MKT_CLOSE_MIN = 22 * 60;  // 22:00 London -- daily close
const MKT_OPEN_MIN  = 23 * 60;  // 23:00 London -- daily reopen
const DUBAI_OFFSET_MS = 4 * 3600_000;

function londonWall(nowMs) {
    const y = new Date(nowMs).getUTCFullYear();
    const lastSun = (m) => {
        const last = new Date(Date.UTC(y, m + 1, 0));
        return last.getUTCDate() - last.getUTCDay();
    };
    const bst = nowMs >= Date.UTC(y, 2, lastSun(2), 1, 0) &&
                nowMs <  Date.UTC(y, 9, lastSun(9), 1, 0);
    const d = new Date(nowMs + (bst ? 3600_000 : 0));
    return { day: d.getUTCDay(), mins: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function marketOpenLondon(day, mins) {
    if (day >= 1 && day <= 4) return mins < MKT_CLOSE_MIN || mins >= MKT_OPEN_MIN;
    if (day === 5) return mins < MKT_CLOSE_MIN;   // Friday: shuts for the week
    if (day === 0) return mins >= MKT_OPEN_MIN;   // Sunday: the week opens
    return false;                                 // Saturday
}

// Each assumes the state it is named for; call the one matching marketOpenLondon().
function minsToNextClose(mins) {
    // Day session -> tonight's 22:00. Evening session -> tomorrow's 22:00.
    return mins < MKT_CLOSE_MIN ? MKT_CLOSE_MIN - mins : (1440 - mins) + MKT_CLOSE_MIN;
}
function minsToNextOpen(day, mins) {
    if (day === 6) return (1440 - mins) + MKT_OPEN_MIN;          // Sat -> Sun 23:00
    if (day === 5) return (1440 - mins) + 1440 + MKT_OPEN_MIN;   // Fri close -> Sun 23:00
    return MKT_OPEN_MIN - mins;                                  // tonight's reopen
}

// A quote this old still counts as "the venue is streaming". Deliberately
// far looser than the 10s staleness that drives the LIVE/DELAYED pill: the
// badge must not flap on a brief blip (a FIX session timeout + reconnect
// takes ~10-40s), while a real outage is still noticed within two minutes.
const QUOTES_FRESH_SEC = 120;

function fmtDelta(m) {
    if (m < 0) m += 7 * 1440;
    const h = Math.floor(m / 60), mm = m % 60;
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${mm}m`;
}

// Boundaries are announced in Dubai wall-clock, the clock the people standing
// in front of the board are actually on. Computed from the instant, so
// London's DST switch moves the label instead of silently invalidating it.
function dubaiLabel(targetMs, withWeekday) {
    const d = new Date(targetMs + DUBAI_OFFSET_MS);
    let h = d.getUTCHours();
    const suffix = h < 12 ? "AM" : "PM";
    h = h % 12 || 12;
    const time = `${h}:${String(d.getUTCMinutes()).padStart(2, "0")} ${suffix} Dubai`;
    const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
    return withWeekday ? `${wd} ${time}` : time;
}

// Quotes are arriving even though the calendar says the market is shut.
// Trust the data and report open -- but with no countdown, because the
// calendar we would count against is the very thing the feed contradicted.
function openSummaryFromQuotes() {
    return { status: "open", untilOpen: "", untilClose: "", closeTime: null, openTime: null };
}

// nowMs is injectable so the calendar can be unit-tested across a whole week
// without touching the clock. Production callers pass nothing.
function getMarketSummary(nowMs = Date.now()) {
    const { day, mins } = londonWall(nowMs);
    const open = marketOpenLondon(day, mins);
    const delta = open ? minsToNextClose(mins) : minsToNextOpen(day, mins);
    const label = dubaiLabel(nowMs + delta * 60_000, delta >= 1440);
    return {
        status: open ? "open" : "closed",
        untilOpen:  open ? "" : fmtDelta(delta),
        untilClose: open ? fmtDelta(delta) : "",
        closeTime:  open ? label : null,
        openTime:   open ? null : label,
    };
}

// ── Aggregates ───────────────────────────────────────────
function updateDayAgg(sym, price, nowMs) {
    const today = dubaiDateString(nowMs);
    const a = dayAgg[sym];
    if (a.date !== today) {
        a.date = today;
        a.open = price;
        a.high = price;
        a.low = price;
        return;
    }
    if (price > a.high) a.high = price;
    if (price < a.low) a.low = price;
}

// Maximum acceptable jump between two consecutive hourly history points,
// expressed as a fraction of the previous price. Anything beyond this is
// rejected — it's almost always either a feed glitch or a session-gap
// (weekend close → Monday open) and would render as a visible spike on
// the chart. The next hour will try again with a fresh tick.
//
// 0.4% is intentionally tight: under normal precious-metal volatility
// hourly moves stay well below this. The downside is that real intraday
// rallies of >0.4%/hour will skip a sample (be re-acquired the following
// hour), but the chart use-case is a smooth visual trend — a missed
// hourly point is far less harmful than a vertical wall.
const MAX_HISTORY_JUMP_PCT = 0.004;

const HISTORY_MAX_AGE_MS = 7 * 24 * 3600_000;

function pushHistory(prices, nowMs) {
    if (nowMs - lastHistoryPush < HISTORY_INTERVAL_MS && historyStore.XAU.length > 0) return;
    lastHistoryPush = nowMs;
    for (const sym of ["XAU", "XAG"]) {
        const p = prices[sym]?.price;
        if (!p) continue;
        // Drop anything older than the window the charts claim to show.
        // Without this, low push frequency stretches "last 168 points"
        // across months of stale data.
        let arr = historyStore[sym].filter(pt => nowMs - pt.ts <= HISTORY_MAX_AGE_MS);
        const last = arr.length > 0 ? arr[arr.length - 1] : null;
        // Glitch guard applies ONLY against a FRESH tip. If the tip itself
        // is stale (feed outage, weekend), the gap is real and must be
        // accepted — the old unconditional guard froze history forever
        // after any >0.4% move across a gap (frozen 2026-05-14 → 07-06).
        const tipFresh = last && nowMs - last.ts < 2 * HISTORY_INTERVAL_MS;
        if (tipFresh && Math.abs(p - last.price) / last.price > MAX_HISTORY_JUMP_PCT) {
            console.warn(`history: skipping ${sym} ${last.price}→${p} (jump exceeds ${(MAX_HISTORY_JUMP_PCT*100).toFixed(1)}%)`);
            historyStore[sym] = arr;
            continue;
        }
        arr.push({ price: p, ts: nowMs });
        historyStore[sym] = arr.slice(-168);
    }
}

// Bootstrap synthetic history if empty so the chart has something to draw
// on first boot. Real points replace these as time passes (one per hour).
//
// Previously this also regenerated when |cur - tip| / tip > 1.5% — i.e. on
// any large gap between the stored history and the live price. That turned
// every Monday-morning weekend gap into a wholesale wipe of real data and
// substitution with a random-walk fake. Removed that trigger: only an
// empty/<2-point history triggers regeneration now. Large gaps are
// handled by pushHistory's per-tick threshold instead.
function ensureHistory(prices, nowMs) {
    for (const sym of ["XAU", "XAG"]) {
        const store = historyStore[sym];
        const cur = prices[sym]?.price;
        if (!cur) continue;
        const needsRegen = store.length < 2 ||
            (store.length > 0 && nowMs - store[store.length - 1].ts > HISTORY_MAX_AGE_MS);
        if (!needsRegen) continue;
        const base = cur;
        const vol = base * 0.002;
        let s = Math.floor(nowMs / 86400_000) + (sym === "XAU" ? 1 : 2);
        const rand = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
        const pts = [];
        let p = base;
        const decimals = sym === "XAU" ? 2 : 4;
        for (let i = 167; i >= 0; i--) {
            p += (rand() - 0.5) * vol;
            p += (base - p) * 0.15;
            pts.push({ price: +p.toFixed(decimals), ts: nowMs - i * HISTORY_INTERVAL_MS });
        }
        pts.push({ price: base, ts: nowMs });
        historyStore[sym] = pts;
    }
}

// ── Gateway fetch ────────────────────────────────────────
async function fetchGateway() {
    const headers = {};
    if (GATEWAY_TOKEN) headers.Authorization = `Bearer ${GATEWAY_TOKEN}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
        const res = await fetch(`${GATEWAY_URL}/prices`, { headers, signal: ctrl.signal });
        if (!res.ok) throw new Error(`gateway HTTP ${res.status}`);
        const list = await res.json();
        const map = {};
        for (const q of list) map[q.symbol] = q;
        const out = {};
        for (const [sym, gwSym] of [["XAU", "XAU/USD"], ["XAG", "XAG/USD"]]) {
            const q = map[gwSym];
            if (!q) throw new Error(`gateway: missing ${gwSym}`);
            // Stale = no quote update for 10s+. We still render but mark sourceMode.
            if (!q.bid || !q.ask) throw new Error(`gateway: ${gwSym} no bid/ask`);
            // Main displayed price = raw bid from FIX feed. No mid math, no
            // rounding — frontend formats decimals on display.
            out[sym] = {
                price: q.bid,
                bid: q.bid,
                ask: q.ask,
                staleSeconds: q.stale_seconds || 0,
            };
        }
        return out;
    } finally {
        clearTimeout(timer);
    }
}

// ── Handler ──────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("content-type", "application/json");

    const nowMs = Date.now();
    const schedule = getMarketSummary();

    if (cache.data && nowMs - cache.ts < CACHE_TTL_MS) {
        res.statusCode = 200;
        // Serve the cached payload whole: it already carries the summary that
        // matched those prices. Recomputing it here could report "open" next
        // to a body built a moment earlier, while we still thought we were shut.
        return res.end(JSON.stringify(cache.data));
    }

    // Is the venue actually streaming right now? The clock alone is not
    // trustworthy — this window and the FIX session drifted apart once
    // already, and the board showed "MARKET CLOSED" over four hours of live
    // ticks every evening. Probing is free: the gateway's /prices is an
    // in-memory snapshot of quotes pushed to it, so asking sends nothing
    // upstream to Integral no matter the hour.
    let live = null;
    let gatewayErr = null;
    try {
        live = await fetchGateway();
    } catch (err) {
        gatewayErr = err;
    }
    const stalest = live ? Math.max(live.XAU.staleSeconds, live.XAG.staleSeconds) : Infinity;
    const quotesFlowing = stalest <= QUOTES_FRESH_SEC;

    // Closed only when the clock says so AND nothing is streaming: a real
    // price always wins, so the board can never again hide one it has.
    // The reverse case — schedule open, feed briefly down — deliberately
    // stays "open": the LIVE/DELAYED pill already reports staleness, and
    // flipping the badge on every blip would just make it flap.
    const marketSummary = schedule.status === "open"
        ? schedule
        : quotesFlowing ? openSummaryFromQuotes() : schedule;

    if (!quotesFlowing && schedule.status === "closed") {
        const decimals = (sym) => sym === "XAU" ? 2 : 4;
        const buildClosed = (sym) => {
            const lk = lastKnown[sym].price;
            const a = dayAgg[sym];
            if (!lk) return null;
            return {
                price: lk,
                bid: +(lk - (sym === "XAU" ? 0.5 : 0.06)).toFixed(decimals(sym)),
                ask: +(lk + (sym === "XAU" ? 0.5 : 0.06)).toFixed(decimals(sym)),
                dayHigh: a.high ?? lk,
                dayLow: a.low ?? lk,
                dayChange: 0,
                dayChangePercent: 0,
                updatedAt: new Date(nowMs).toISOString(),
            };
        };
        const response = {
            source: "LastKnown",
            sourceMode: "closed",
            prices: { XAU: buildClosed("XAU"), XAG: buildClosed("XAG") },
            history: {
                XAU: historyStore.XAU.slice(-168),
                XAG: historyStore.XAG.slice(-168),
            },
            marketSummary,
        };
        cache = { data: response, ts: nowMs };
        res.statusCode = 200;
        return res.end(JSON.stringify(response));
    }

    let source = "Gateway";
    let sourceMode = "live";

    if (live) {
        if (stalest > 10) sourceMode = "stale";
    } else {
        console.warn("gateway fetch failed:", gatewayErr && gatewayErr.message);
        if (lastKnown.XAU.price && lastKnown.XAG.price) {
            source = "LastKnown";
            sourceMode = "stale";
            live = {
                XAU: {
                    price: lastKnown.XAU.price,
                    bid: +(lastKnown.XAU.price - 0.5).toFixed(2),
                    ask: +(lastKnown.XAU.price + 0.5).toFixed(2),
                },
                XAG: {
                    price: lastKnown.XAG.price,
                    bid: +(lastKnown.XAG.price - 0.06).toFixed(4),
                    ask: +(lastKnown.XAG.price + 0.06).toFixed(4),
                },
            };
        } else {
            res.statusCode = 503;
            return res.end(JSON.stringify({
                error: "Gateway unavailable, no cached data",
                sourceMode: "error",
                marketSummary,
            }));
        }
    }

    // Only genuine, fresh quotes may move persisted state. On the exchange
    // calendar the board reports "open" for ~23h a day, but our FIX session
    // is still only up 09:00-01:00 Dubai; in the hours between, `live` is the
    // lastKnown fallback below. Writing that back would replay a flat price
    // into the chart once an hour and recreate the frozen-history bug that
    // 1dd5157 fixed, and would smear dayHigh/dayLow across a dead feed.
    if (quotesFlowing) {
        for (const sym of ["XAU", "XAG"]) {
            const p = live[sym].price;
            if (p > 0) {
                updateDayAgg(sym, p, nowMs);
                lastKnown[sym].price = p;
            }
        }
        pushHistory(live, nowMs);
        ensureHistory(live, nowMs);
        schedulePersist();
    }

    const buildEntry = (sym) => {
        const p = live[sym];
        const a = dayAgg[sym];
        const decimals = sym === "XAU" ? 2 : 4;
        const open = a.open ?? p.price;
        const change = +(p.price - open).toFixed(decimals);
        const changePct = open > 0 ? +(((p.price - open) / open) * 100).toFixed(2) : 0;
        return {
            price: p.price,
            bid: p.bid,
            ask: p.ask,
            dayHigh: a.high ?? p.price,
            dayLow: a.low ?? p.price,
            dayChange: change,
            dayChangePercent: changePct,
            updatedAt: new Date(nowMs).toISOString(),
        };
    };

    const response = {
        source,
        sourceMode,
        prices: { XAU: buildEntry("XAU"), XAG: buildEntry("XAG") },
        history: {
            XAU: historyStore.XAU.slice(-168),
            XAG: historyStore.XAG.slice(-168),
        },
        marketSummary,
    };

    cache = { data: response, ts: nowMs };
    res.statusCode = 200;
    return res.end(JSON.stringify(response));
}

await loadState();
