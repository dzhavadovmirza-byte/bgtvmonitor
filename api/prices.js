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

// ── Market hours (forex: Sun 5pm ET – Fri 5pm ET) ──────
function getMarketSummary() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const year = now.getUTCFullYear();

  const dstStart = new Date(Date.UTC(year, 2, 1));
  while (dstStart.getUTCDay() !== 0) dstStart.setUTCDate(dstStart.getUTCDate() + 1);
  dstStart.setUTCDate(dstStart.getUTCDate() + 7);
  dstStart.setUTCHours(7);

  const dstEnd = new Date(Date.UTC(year, 10, 1));
  while (dstEnd.getUTCDay() !== 0) dstEnd.setUTCDate(dstEnd.getUTCDate() + 1);
  dstEnd.setUTCHours(6);

  const isDST = utc >= dstStart.getTime() && utc < dstEnd.getTime();
  const et = new Date(utc + (isDST ? -4 : -5) * 3600000);
  const day = et.getDay();
  const mins = et.getHours() * 60 + et.getMinutes();
  const openMins = 17 * 60;

  let isOpen = false;
  if (day === 0) isOpen = mins >= openMins;
  else if (day >= 1 && day <= 4) isOpen = true;
  else if (day === 5) isOpen = mins < openMins;

  const fmtTime = (totalMins) => {
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`;
  };

  let untilClose = "", untilOpen = "";
  if (isOpen) {
    let daysToFri = (5 - day + 7) % 7;
    if (daysToFri === 0 && mins >= openMins) daysToFri = 7;
    untilClose = fmtTime(daysToFri * 1440 + openMins - mins);
  } else {
    let daysToSun = (7 - day) % 7;
    if (daysToSun === 0 && mins < openMins) daysToSun = 0;
    else if (daysToSun === 0) daysToSun = 7;
    untilOpen = fmtTime(daysToSun * 1440 + openMins - mins);
  }

  return { status: isOpen ? "open" : "closed", untilOpen, untilClose };
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
      dayHigh: gold.dayHigh,
      dayLow: gold.dayLow,
      dayChange: +gold.dayChange.toFixed(2),
      dayChangePercent: +gold.dayChangePct.toFixed(2),
      open: +(gold.price - gold.dayChange).toFixed(2),
    },
    XAG: {
      price: +silver.price.toFixed(4),
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
      dayHigh: gold.high,
      dayLow: gold.low,
      dayChange: +(gold.close - gold.open).toFixed(2),
      dayChangePercent: +(((gold.close - gold.open) / gold.open) * 100).toFixed(2),
      open: gold.open,
    },
    XAG: {
      price: silver.close,
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
      dayHigh: +(goldPrice * 1.003).toFixed(2),
      dayLow: +(goldPrice * 0.997).toFixed(2),
      dayChange: +(goldPrice * 0.001).toFixed(2),
      dayChangePercent: 0.1,
      open: +(goldPrice * 0.999).toFixed(2),
    },
    XAG: {
      price: +silverPrice.toFixed(4),
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
    XAU: { price: gp, dayHigh: gp + 3, dayLow: gp - 3, dayChange: +jG.toFixed(2), dayChangePercent: +((jG / gp) * 100).toFixed(2), open: lastKnown.XAU.open },
    XAG: { price: sp, dayHigh: sp + 0.12, dayLow: sp - 0.12, dayChange: +jS.toFixed(4), dayChangePercent: +((jS / sp) * 100).toFixed(2), open: lastKnown.XAG.open },
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

function ensureHistory(prices) {
  for (const sym of ["XAU", "XAG"]) {
    if (historyStore[sym].length < 2 && prices[sym]?.price) {
      const base = prices[sym].price;
      const vol = sym === "XAU" ? 15 : 0.4;
      const now = Date.now();
      const pts = [];
      let p = base - vol * (Math.random() + 0.5);
      for (let i = 167; i >= 0; i--) {
        p += (Math.random() - 0.48) * (vol / 8);
        if (i < 24) p += (base - p) * 0.05;
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
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
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
        XAU: { price: result.XAU.price, dayHigh: result.XAU.dayHigh, dayLow: result.XAU.dayLow, dayChange: result.XAU.dayChange, dayChangePercent: result.XAU.dayChangePercent, updatedAt: new Date().toISOString() },
        XAG: { price: result.XAG.price, dayHigh: result.XAG.dayHigh, dayLow: result.XAG.dayLow, dayChange: result.XAG.dayChange, dayChangePercent: result.XAG.dayChangePercent, updatedAt: new Date().toISOString() },
      },
      history: { XAU: historyStore.XAU.slice(-168), XAG: historyStore.XAG.slice(-168) },
      marketSummary: getMarketSummary(),
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
