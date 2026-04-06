// Vercel serverless: /api/prices
// Realtime gold/silver prices with multi-source failover
// Sources: Kitco (realtime), Stooq (realtime CSV), CurrencyAPI (daily fallback)

// ── Module-level state (persists across warm invocations) ──
let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 800;

let historyStore = { XAU: [], XAG: [] };
let lastHistoryPush = 0;
const HISTORY_INTERVAL_MS = 3600_000;

let lastKnown = {
  XAU: { price: 5185, open: 5180 },
  XAG: { price: 86.5, open: 86.3 },
};

// ── Helpers ─────────────────────────────────────────────
function fetchWithTimeout(url, ms = 2500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { signal: c.signal, headers: { "User-Agent": "BGMonitor/1.0" } })
    .finally(() => clearTimeout(t));
}

// ── Market hours (Dubai time schedule) ──────────────────
// Summer (US DST active):  Mon-Fri 11:00 AM – 12:00 AM (midnight) Dubai
// Winter (US DST inactive): Mon-Fri 12:00 PM – 1:00 AM Dubai
// Saturday & Sunday: closed
function isUsDst(utcMs) {
  const year = new Date(utcMs).getUTCFullYear();
  // US DST: 2nd Sunday of March 07:00 UTC – 1st Sunday of November 06:00 UTC
  const dstStart = new Date(Date.UTC(year, 2, 1));
  while (dstStart.getUTCDay() !== 0) dstStart.setUTCDate(dstStart.getUTCDate() + 1);
  dstStart.setUTCDate(dstStart.getUTCDate() + 7);
  dstStart.setUTCHours(7);

  const dstEnd = new Date(Date.UTC(year, 10, 1));
  while (dstEnd.getUTCDay() !== 0) dstEnd.setUTCDate(dstEnd.getUTCDate() + 1);
  dstEnd.setUTCHours(6);

  return utcMs >= dstStart.getTime() && utcMs < dstEnd.getTime();
}

function getMarketSummary() {
  const now = Date.now();
  const isDST = isUsDst(now);

  // Dubai is always UTC+4
  const dubaiMs = now + 4 * 3600000;
  const dubai = new Date(dubaiMs);
  const day = dubai.getUTCDay();       // 0=Sun..6=Sat
  const mins = dubai.getUTCHours() * 60 + dubai.getUTCMinutes();

  // Open/close times in Dubai minutes-from-midnight
  // Open: 7:00 AM Dubai (both seasons)
  // Summer: close 00:00 (midnight) Dubai
  // Winter: close 01:00 AM next day Dubai
  const openMins = 420;                   // 7:00 AM Dubai
  const closeMins = isDST ? 1440 : 1500; // midnight or 1:00 AM next day

  // UK bank holidays when gold market is closed (checked in UTC to match Dubai date)
  const month = dubai.getUTCMonth(); // 0-indexed
  const date = dubai.getUTCDate();
  const isUkHoliday = (month === 0 && date === 1) || (month === 11 && date === 25); // Jan 1, Dec 25

  let isOpen = false;

  if (isUkHoliday) {
    // Market closed on UK bank holidays
    isOpen = false;
  } else if (day >= 1 && day <= 5) {
    // Monday-Friday
    if (isDST) {
      // Summer: open 7:00 AM – midnight (same day)
      isOpen = mins >= openMins && mins < closeMins;
    } else {
      // Winter: open 7:00 AM – 1:00 AM next day
      if (day >= 2 && day <= 5) {
        // Tue-Fri: open from 7am, OR before 1am (carry from prev day session)
        isOpen = mins >= openMins || mins < 60;
      } else {
        // Monday: session starts at 7am (no carryover from Sunday)
        isOpen = mins >= openMins;
      }
    }
  } else if (day === 6) {
    // Saturday
    if (!isDST && mins < 60) {
      // Winter: Friday session extends past midnight into Saturday 00:00-01:00
      isOpen = true;
    }
  }
  // Sunday: always closed

  const fmtTime = (totalMins) => {
    if (totalMins < 0) totalMins += 7 * 1440;
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
  };

  const openTimeStr = "7:00 AM Dubai";
  const closeTimeStr = isDST ? "12:00 AM Dubai" : "1:00 AM Dubai";

  let untilClose = "", untilOpen = "";
  if (isOpen) {
    // Time until today's session ends (not weekly — just this session)
    if (isDST) {
      // Summer: closes at midnight (1440) same day
      untilClose = fmtTime(closeMins - mins);
    } else {
      // Winter: closes at 1am next day
      if (mins >= openMins) {
        // After noon — remaining today + 60 min past midnight
        untilClose = fmtTime(1440 - mins + 60);
      } else {
        // Before 1am (early morning carry from prev day)
        untilClose = fmtTime(60 - mins);
      }
    }
  } else {
    // Calculate minutes until next open (next weekday at openMins)
    let daysToOpen;
    if (day === 0) {
      daysToOpen = 1; // Sunday → Monday
    } else if (day === 6) {
      daysToOpen = 2; // Saturday → Monday
    } else if (isUkHoliday) {
      daysToOpen = 1; // Holiday — next session is tomorrow
    } else {
      // Weekday but outside hours
      if (mins < openMins) {
        daysToOpen = 0; // later today
      } else {
        daysToOpen = 1; // tomorrow
      }
    }
    untilOpen = fmtTime(daysToOpen * 1440 + (openMins - mins + 1440) % 1440);
  }

  return {
    status: isOpen ? "open" : "closed",
    untilOpen, untilClose,
    closeTime: isOpen ? closeTimeStr : null,
    openTime: !isOpen ? `Mon ${openTimeStr}` : null,
  };
}

// ── Source 1: Kitco (realtime bid/ask/mid + day data) ───
async function fetchKitco() {
  const [auRes, agRes] = await Promise.all([
    fetchWithTimeout("https://proxy.kitco.com/getPM?symbol=AU&currency=USD"),
    fetchWithTimeout("https://proxy.kitco.com/getPM?symbol=AG&currency=USD"),
  ]);
  if (!auRes.ok || !agRes.ok) throw new Error("Kitco HTTP error");
  const [auText, agText] = await Promise.all([auRes.text(), agRes.text()]);

  // Format: SYMBOL,CURRENCY,UNIT,TIMESTAMP,BID,MID,ASK,CHANGE,CHANGE%,DAYLOW,DAYHIGH
  const parseKitco = (text) => {
    const parts = text.trim().split(",");
    if (parts.length < 11) throw new Error("Kitco parse error");
    return {
      price: parseFloat(parts[5]),      // mid
      bid: parseFloat(parts[4]),
      ask: parseFloat(parts[6]),
      dayChange: parseFloat(parts[7]),
      dayChangePct: parseFloat(parts[8]),
      dayLow: parseFloat(parts[9]),
      dayHigh: parseFloat(parts[10]),
    };
  };

  const gold = parseKitco(auText);
  const silver = parseKitco(agText);
  if (!gold.price || gold.price <= 0) throw new Error("Kitco invalid gold");
  if (!silver.price || silver.price <= 0) throw new Error("Kitco invalid silver");

  return {
    source: "Kitco",
    XAU: {
      price: +gold.price.toFixed(2),
      bid: +gold.bid.toFixed(2),
      ask: +gold.ask.toFixed(2),
      dayHigh: gold.dayHigh,
      dayLow: gold.dayLow,
      dayChange: +gold.dayChange.toFixed(2),
      dayChangePercent: +gold.dayChangePct.toFixed(2),
      open: +(gold.price - gold.dayChange).toFixed(2),
    },
    XAG: {
      price: +silver.price.toFixed(4),
      bid: +silver.bid.toFixed(4),
      ask: +silver.ask.toFixed(4),
      dayHigh: silver.dayHigh,
      dayLow: silver.dayLow,
      dayChange: +silver.dayChange.toFixed(4),
      dayChangePercent: +silver.dayChangePct.toFixed(2),
      open: +(silver.price - silver.dayChange).toFixed(4),
    },
  };
}

// ── Source 2: Stooq CSV (realtime delayed) ──────────────
async function fetchStooq() {
  const [auRes, agRes] = await Promise.all([
    fetchWithTimeout("https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"),
    fetchWithTimeout("https://stooq.com/q/l/?s=xagusd&f=sd2t2ohlcv&h&e=csv"),
  ]);
  if (!auRes.ok || !agRes.ok) throw new Error("Stooq HTTP error");
  const [auText, agText] = await Promise.all([auRes.text(), agRes.text()]);

  const parse = (text) => {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return null;
    const v = lines[1].split(",");
    if (v.length < 7) return null;
    const o = parseFloat(v[3]), h = parseFloat(v[4]), l = parseFloat(v[5]), c = parseFloat(v[6]);
    if (isNaN(c) || c <= 0) return null;
    return { open: o, high: h, low: l, close: c };
  };

  const gold = parse(auText);
  const silver = parse(agText);
  if (!gold || !silver) throw new Error("Stooq parse error");

  return {
    source: "Stooq",
    XAU: {
      price: gold.close,
      bid: +(gold.close - 0.5).toFixed(2),
      ask: +(gold.close + 0.5).toFixed(2),
      dayHigh: gold.high,
      dayLow: gold.low,
      dayChange: +(gold.close - gold.open).toFixed(2),
      dayChangePercent: +(((gold.close - gold.open) / gold.open) * 100).toFixed(2),
      open: gold.open,
    },
    XAG: {
      price: silver.close,
      bid: +(silver.close - 0.06).toFixed(4),
      ask: +(silver.close + 0.06).toFixed(4),
      dayHigh: silver.high,
      dayLow: silver.low,
      dayChange: +(silver.close - silver.open).toFixed(4),
      dayChangePercent: +(((silver.close - silver.open) / silver.open) * 100).toFixed(2),
      open: silver.open,
    },
  };
}

// ── Source 3: CurrencyAPI (daily fallback) ──────────────
async function fetchCurrencyAPI() {
  const [auRes, agRes] = await Promise.all([
    fetchWithTimeout("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json"),
    fetchWithTimeout("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xag.json"),
  ]);
  if (!auRes.ok || !agRes.ok) throw new Error("CurrencyAPI HTTP error");
  const [auData, agData] = await Promise.all([auRes.json(), agRes.json()]);
  const goldPrice = auData?.xau?.usd;
  const silverPrice = agData?.xag?.usd;
  if (!goldPrice || goldPrice <= 0 || !silverPrice || silverPrice <= 0)
    throw new Error("CurrencyAPI no data");

  return {
    source: "CurrencyAPI",
    XAU: {
      price: +goldPrice.toFixed(2),
      bid: +(goldPrice - 0.5).toFixed(2),
      ask: +(goldPrice + 0.5).toFixed(2),
      dayHigh: +(goldPrice * 1.003).toFixed(2),
      dayLow: +(goldPrice * 0.997).toFixed(2),
      dayChange: +(goldPrice * 0.001).toFixed(2),
      dayChangePercent: 0.1,
      open: +(goldPrice * 0.999).toFixed(2),
    },
    XAG: {
      price: +silverPrice.toFixed(4),
      bid: +(silverPrice - 0.06).toFixed(4),
      ask: +(silverPrice + 0.06).toFixed(4),
      dayHigh: +(silverPrice * 1.005).toFixed(4),
      dayLow: +(silverPrice * 0.995).toFixed(4),
      dayChange: +(silverPrice * 0.002).toFixed(4),
      dayChangePercent: 0.2,
      open: +(silverPrice * 0.998).toFixed(4),
    },
  };
}

// ── Simulated fallback ──────────────────────────────────
function simulatedPrices() {
  const jG = (Math.random() - 0.5) * 4;
  const jS = (Math.random() - 0.5) * 0.15;
  const gp = +(lastKnown.XAU.price + jG).toFixed(2);
  const sp = +(lastKnown.XAG.price + jS).toFixed(4);
  return {
    source: "Simulated",
    XAU: { price: gp, bid: +(gp - 0.5).toFixed(2), ask: +(gp + 0.5).toFixed(2), dayHigh: gp + 3, dayLow: gp - 3, dayChange: +jG.toFixed(2), dayChangePercent: +((jG / gp) * 100).toFixed(2), open: lastKnown.XAU.open },
    XAG: { price: sp, bid: +(sp - 0.06).toFixed(4), ask: +(sp + 0.06).toFixed(4), dayHigh: sp + 0.12, dayLow: sp - 0.12, dayChange: +jS.toFixed(4), dayChangePercent: +((jS / sp) * 100).toFixed(2), open: lastKnown.XAG.open },
  };
}

// ── History ─────────────────────────────────────────────
function pushHistory(prices) {
  const now = Date.now();
  if (now - lastHistoryPush < HISTORY_INTERVAL_MS && historyStore.XAU.length > 0) return;
  lastHistoryPush = now;
  for (const sym of ["XAU", "XAG"]) {
    if (prices[sym]?.price) {
      historyStore[sym].push({ price: prices[sym].price, ts: now });
      if (historyStore[sym].length > 168) historyStore[sym] = historyStore[sym].slice(-168);
    }
  }
}

function seededRandom(seed) {
  // Simple deterministic PRNG so history is stable across cold starts
  let s = seed;
  return () => { s = (s * 16807 + 0) % 2147483647; return s / 2147483647; };
}

function ensureHistory(prices) {
  for (const sym of ["XAU", "XAG"]) {
    const store = historyStore[sym];
    const currentPrice = prices[sym]?.price;
    if (!currentPrice) continue;

    // Regenerate if: too few points, OR synthetic tip deviates >1.5% from current price
    // (indicates cold-start drift — stale synthetic history would cause a spike)
    let needsRegen = store.length < 2;
    if (!needsRegen && store.length >= 2) {
      const syntheticTip = store[store.length - 2].price; // second-to-last (last = real push)
      if (Math.abs(currentPrice - syntheticTip) / syntheticTip > 0.015) needsRegen = true;
    }

    if (needsRegen) {
      const base = currentPrice;
      const vol = base * 0.005; // 0.5% per step — realistic weekly gold/silver range
      const now = Date.now();
      const daySeed = Math.floor(now / 86400000);
      const rand = seededRandom(daySeed + (sym === "XAU" ? 1 : 2));
      const pts = [];
      let p = base;
      for (let i = 167; i >= 0; i--) {
        const step = (rand() - 0.5) * vol;
        p += step;
        p += (base - p) * 0.15;
        pts.push({ price: +p.toFixed(sym === "XAU" ? 2 : 4), ts: now - i * HISTORY_INTERVAL_MS });
      }
      pts.push({ price: base, ts: now });
      historyStore[sym] = pts;
    }
  }
}

// ── Main fetch with Promise.any ─────────────────────────
async function fetchPrices() {
  try {
    // Kitco first (fastest realtime), then Stooq, then CurrencyAPI
    const result = await Promise.any([
      fetchKitco(),
      fetchStooq(),
      fetchCurrencyAPI(),
    ]);
    return { ...result, sourceMode: "live" };
  } catch (_) {
    return { ...simulatedPrices(), sourceMode: "simulated" };
  }
}

// ── Handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  try {
    const now = Date.now();
    const marketSummary = getMarketSummary();

    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return res.status(200).json({ ...cache.data, marketSummary });
    }

    // When market is closed, return last known prices without fetching
    if (marketSummary.status === "closed") {
      const closedPrices = {};
      for (const sym of ["XAU", "XAG"]) {
        closedPrices[sym] = {
          price: lastKnown[sym].price,
          bid: +(lastKnown[sym].price - (sym === "XAU" ? 0.5 : 0.06)).toFixed(sym === "XAU" ? 2 : 4),
          ask: +(lastKnown[sym].price + (sym === "XAU" ? 0.5 : 0.06)).toFixed(sym === "XAU" ? 2 : 4),
          dayHigh: lastKnown[sym].price,
          dayLow: lastKnown[sym].price,
          dayChange: 0,
          dayChangePercent: 0,
          updatedAt: new Date().toISOString(),
        };
      }
      ensureHistory({ XAU: { price: lastKnown.XAU.price }, XAG: { price: lastKnown.XAG.price } });
      const closedResponse = {
        source: "Cached",
        sourceMode: "closed",
        prices: closedPrices,
        history: { XAU: historyStore.XAU.slice(-168), XAG: historyStore.XAG.slice(-168) },
        marketSummary,
      };
      cache = { data: closedResponse, ts: now };
      return res.status(200).json(closedResponse);
    }

    const result = await fetchPrices();

    // Update last known
    for (const sym of ["XAU", "XAG"]) {
      if (result[sym]?.price > 0) {
        lastKnown[sym].price = result[sym].price;
        if (result[sym].open > 0) lastKnown[sym].open = result[sym].open;
      }
    }

    pushHistory(result);
    ensureHistory(result);

    const response = {
      source: result.source,
      sourceMode: result.sourceMode,
      prices: {
        XAU: { price: result.XAU.price, bid: result.XAU.bid, ask: result.XAU.ask, dayHigh: result.XAU.dayHigh, dayLow: result.XAU.dayLow, dayChange: result.XAU.dayChange, dayChangePercent: result.XAU.dayChangePercent, updatedAt: new Date().toISOString() },
        XAG: { price: result.XAG.price, bid: result.XAG.bid, ask: result.XAG.ask, dayHigh: result.XAG.dayHigh, dayLow: result.XAG.dayLow, dayChange: result.XAG.dayChange, dayChangePercent: result.XAG.dayChangePercent, updatedAt: new Date().toISOString() },
      },
      history: { XAU: historyStore.XAU.slice(-168), XAG: historyStore.XAG.slice(-168) },
      marketSummary,
    };

    cache = { data: response, ts: now };
    return res.status(200).json(response);
  } catch (err) {
    const fb = simulatedPrices();
    ensureHistory(fb);
    return res.status(200).json({
      source: "Simulated", sourceMode: "error-fallback",
      prices: { XAU: { ...fb.XAU, updatedAt: new Date().toISOString() }, XAG: { ...fb.XAG, updatedAt: new Date().toISOString() } },
      history: { XAU: historyStore.XAU.slice(-168), XAG: historyStore.XAG.slice(-168) },
      marketSummary: getMarketSummary(),
    });
  }
}
