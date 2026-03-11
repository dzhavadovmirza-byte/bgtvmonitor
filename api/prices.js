// Vercel serverless function: /api/prices
// Multi-source gold/silver price fetcher with aggressive fallback
// Sources are raced via Promise.any with 2s timeouts per source
// In-memory cache with 1-second TTL prevents hammering upstream APIs

// ── Module-level state (persists across warm invocations) ──────────
let cache = { data: null, ts: 0 };
const CACHE_TTL_MS = 1000;

// History ring buffer: stores up to 168 hourly data points (7 days)
let historyStore = { XAU: [], XAG: [] };
let lastHistoryPush = 0;
const HISTORY_INTERVAL_MS = 3600_000; // 1 hour

// Last known good prices for fallback simulation
let lastKnownPrices = {
  XAU: { price: 2340.50, open: 2335.00 },
  XAG: { price: 29.85, open: 29.70 },
};

// ── Helpers ────────────────────────────────────────────────────────
function fetchWithTimeout(url, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

function parseCSVLine(text) {
  // Stooq CSV format: Symbol,Date,Time,Open,High,Low,Close,Volume
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;
  const vals = lines[1].split(",");
  if (vals.length < 7) return null;
  const open = parseFloat(vals[3]);
  const high = parseFloat(vals[4]);
  const low = parseFloat(vals[5]);
  const close = parseFloat(vals[6]);
  if (isNaN(close) || close <= 0) return null;
  return { open, high, low, close };
}

// ── Market hours calculation (forex: Sun 5pm EST - Fri 5pm EST) ───
function getMarketSummary() {
  const now = new Date();
  // Convert to EST (UTC-5). During EDT it's UTC-4, but forex convention uses ET.
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  // Determine if DST is active (US Eastern): second Sunday of March to first Sunday of November
  const year = now.getUTCFullYear();
  const dstStart = new Date(Date.UTC(year, 2, 1)); // March 1
  while (dstStart.getUTCDay() !== 0) dstStart.setUTCDate(dstStart.getUTCDate() + 1);
  dstStart.setUTCDate(dstStart.getUTCDate() + 7); // second Sunday
  dstStart.setUTCHours(7); // 2am EST = 7am UTC

  const dstEnd = new Date(Date.UTC(year, 10, 1)); // November 1
  while (dstEnd.getUTCDay() !== 0) dstEnd.setUTCDate(dstEnd.getUTCDate() + 1);
  dstEnd.setUTCHours(6); // 2am EDT = 6am UTC

  const isDST = utc >= dstStart.getTime() && utc < dstEnd.getTime();
  const etOffset = isDST ? -4 : -5;
  const et = new Date(utc + etOffset * 3600000);
  const day = et.getDay(); // 0=Sun
  const hour = et.getHours();
  const minute = et.getMinutes();
  const timeInMinutes = hour * 60 + minute;
  const openTime = 17 * 60; // 5pm = 1020 minutes

  let isOpen = false;
  if (day === 0) {
    // Sunday: open from 5pm onward
    isOpen = timeInMinutes >= openTime;
  } else if (day >= 1 && day <= 4) {
    // Monday-Thursday: open all day
    isOpen = true;
  } else if (day === 5) {
    // Friday: open until 5pm
    isOpen = timeInMinutes < openTime;
  } else {
    // Saturday: closed
    isOpen = false;
  }

  let untilOpen = "";
  let untilClose = "";

  if (isOpen) {
    // Calculate time until Friday 5pm ET
    let daysUntilFri = (5 - day + 7) % 7;
    if (daysUntilFri === 0 && timeInMinutes >= openTime) daysUntilFri = 7;
    const closeMinutes = daysUntilFri * 24 * 60 + openTime - timeInMinutes;
    if (closeMinutes > 0) {
      const h = Math.floor(closeMinutes / 60);
      const m = closeMinutes % 60;
      if (h >= 24) {
        const d = Math.floor(h / 24);
        untilClose = `${d}d ${h % 24}h`;
      } else {
        untilClose = `${h}h ${m}m`;
      }
    }
  } else {
    // Calculate time until Sunday 5pm ET
    let daysUntilSun = (7 - day) % 7;
    if (daysUntilSun === 0 && timeInMinutes < openTime) daysUntilSun = 0;
    else if (daysUntilSun === 0) daysUntilSun = 7;
    const openMinutes = daysUntilSun * 24 * 60 + openTime - timeInMinutes;
    if (openMinutes > 0) {
      const h = Math.floor(openMinutes / 60);
      const m = openMinutes % 60;
      if (h >= 24) {
        const d = Math.floor(h / 24);
        untilOpen = `${d}d ${h % 24}h`;
      } else {
        untilOpen = `${h}h ${m}m`;
      }
    }
  }

  return {
    status: isOpen ? "open" : "closed",
    untilOpen: isOpen ? "" : untilOpen,
    untilClose: isOpen ? untilClose : "",
  };
}

// ── Source 1: Stooq CSV ───────────────────────────────────────────
async function fetchStooq() {
  const [goldRes, silverRes] = await Promise.all([
    fetchWithTimeout("https://stooq.com/q/l/?s=xauusd&f=sd2t2ohlcv&h&e=csv"),
    fetchWithTimeout("https://stooq.com/q/l/?s=xagusd&f=sd2t2ohlcv&h&e=csv"),
  ]);
  if (!goldRes.ok || !silverRes.ok) throw new Error("Stooq HTTP error");
  const [goldText, silverText] = await Promise.all([goldRes.text(), silverRes.text()]);
  const gold = parseCSVLine(goldText);
  const silver = parseCSVLine(silverText);
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

// ── Source 2: Metal Price API (metals-api.com free tier or similar) ─
async function fetchMetalPriceAPI() {
  // Use frankfurter.app for a free forex proxy - it provides XAU rates
  const res = await fetchWithTimeout(
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xau.json"
  );
  if (!res.ok) throw new Error("Currency API HTTP error");
  const data = await res.json();
  // This API gives XAU in terms of other currencies; we need USD per XAU
  const xauToUsd = data?.xau?.usd;
  if (!xauToUsd || xauToUsd <= 0) throw new Error("Currency API no XAU data");

  // Get XAG similarly
  const resAg = await fetchWithTimeout(
    "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/xag.json"
  );
  if (!resAg.ok) throw new Error("Currency API XAG HTTP error");
  const dataAg = await resAg.json();
  const xagToUsd = dataAg?.xag?.usd;
  if (!xagToUsd || xagToUsd <= 0) throw new Error("Currency API no XAG data");

  // Simulate day range around the price (this source doesn't provide OHLC)
  const goldOpen = lastKnownPrices.XAU.open || xauToUsd * 0.998;
  const silverOpen = lastKnownPrices.XAG.open || xagToUsd * 0.998;

  return {
    source: "CurrencyAPI",
    XAU: {
      price: +xauToUsd.toFixed(2),
      dayHigh: +(xauToUsd * 1.003).toFixed(2),
      dayLow: +(xauToUsd * 0.997).toFixed(2),
      dayChange: +(xauToUsd - goldOpen).toFixed(2),
      dayChangePercent: +(((xauToUsd - goldOpen) / goldOpen) * 100).toFixed(2),
      open: goldOpen,
    },
    XAG: {
      price: +xagToUsd.toFixed(4),
      dayHigh: +(xagToUsd * 1.005).toFixed(4),
      dayLow: +(xagToUsd * 0.995).toFixed(4),
      dayChange: +(xagToUsd - silverOpen).toFixed(4),
      dayChangePercent: +(((xagToUsd - silverOpen) / silverOpen) * 100).toFixed(2),
      open: silverOpen,
    },
  };
}

// ── Source 3: GoldAPI.io free endpoint (public, no key needed) ────
async function fetchGoldBroker() {
  // Use the free goldpricez endpoint
  const res = await fetchWithTimeout(
    "https://data-asg.goldprice.org/dbXRates/USD"
  );
  if (!res.ok) throw new Error("GoldPrice.org HTTP error");
  const data = await res.json();
  // data.items[0] has xauPrice and xagPrice
  const item = data?.items?.[0];
  if (!item) throw new Error("GoldPrice.org no data");
  const goldPrice = item.xauPrice;
  const silverPrice = item.xagPrice;
  if (!goldPrice || goldPrice <= 0) throw new Error("GoldPrice.org invalid gold");
  if (!silverPrice || silverPrice <= 0) throw new Error("GoldPrice.org invalid silver");

  const goldOpen = lastKnownPrices.XAU.open || goldPrice * 0.998;
  const silverOpen = lastKnownPrices.XAG.open || silverPrice * 0.998;

  return {
    source: "GoldPrice.org",
    XAU: {
      price: +goldPrice.toFixed(2),
      dayHigh: +(Math.max(goldPrice, goldOpen) * 1.001).toFixed(2),
      dayLow: +(Math.min(goldPrice, goldOpen) * 0.999).toFixed(2),
      dayChange: +(goldPrice - goldOpen).toFixed(2),
      dayChangePercent: +(((goldPrice - goldOpen) / goldOpen) * 100).toFixed(2),
      open: goldOpen,
    },
    XAG: {
      price: +silverPrice.toFixed(4),
      dayHigh: +(Math.max(silverPrice, silverOpen) * 1.002).toFixed(4),
      dayLow: +(Math.min(silverPrice, silverOpen) * 0.998).toFixed(4),
      dayChange: +(silverPrice - silverOpen).toFixed(4),
      dayChangePercent: +(((silverPrice - silverOpen) / silverOpen) * 100).toFixed(2),
      open: silverOpen,
    },
  };
}

// ── Fallback: Simulated prices based on last known ────────────────
function simulatedPrices() {
  const jitterGold = (Math.random() - 0.5) * 4; // +/- $2
  const jitterSilver = (Math.random() - 0.5) * 0.15; // +/- $0.075
  const goldPrice = +(lastKnownPrices.XAU.price + jitterGold).toFixed(2);
  const silverPrice = +(lastKnownPrices.XAG.price + jitterSilver).toFixed(4);
  const goldOpen = lastKnownPrices.XAU.open;
  const silverOpen = lastKnownPrices.XAG.open;

  return {
    source: "Simulated",
    XAU: {
      price: goldPrice,
      dayHigh: +(Math.max(goldPrice, goldOpen) + 3).toFixed(2),
      dayLow: +(Math.min(goldPrice, goldOpen) - 3).toFixed(2),
      dayChange: +(goldPrice - goldOpen).toFixed(2),
      dayChangePercent: +(((goldPrice - goldOpen) / goldOpen) * 100).toFixed(2),
      open: goldOpen,
    },
    XAG: {
      price: silverPrice,
      dayHigh: +(Math.max(silverPrice, silverOpen) + 0.12).toFixed(4),
      dayLow: +(Math.min(silverPrice, silverOpen) - 0.12).toFixed(4),
      dayChange: +(silverPrice - silverOpen).toFixed(4),
      dayChangePercent: +(((silverPrice - silverOpen) / silverOpen) * 100).toFixed(2),
      open: silverOpen,
    },
  };
}

// ── History management ────────────────────────────────────────────
function pushHistory(prices) {
  const now = Date.now();
  if (now - lastHistoryPush < HISTORY_INTERVAL_MS && historyStore.XAU.length > 0) return;
  lastHistoryPush = now;

  for (const sym of ["XAU", "XAG"]) {
    if (prices[sym]?.price) {
      historyStore[sym].push({
        price: prices[sym].price,
        ts: now,
      });
      // Keep max 168 points (7 days * 24 hours)
      if (historyStore[sym].length > 168) {
        historyStore[sym] = historyStore[sym].slice(-168);
      }
    }
  }
}

// Generate synthetic history if we have no data (cold start)
function ensureHistory(prices) {
  for (const sym of ["XAU", "XAG"]) {
    if (historyStore[sym].length < 2 && prices[sym]?.price) {
      const basePrice = prices[sym].price;
      const volatility = sym === "XAU" ? 15 : 0.4;
      const now = Date.now();
      // Generate 168 synthetic hourly points over 7 days
      const points = [];
      let p = basePrice - volatility * (Math.random() + 0.5);
      for (let i = 167; i >= 0; i--) {
        p += (Math.random() - 0.48) * (volatility / 8);
        // Drift toward current price near the end
        if (i < 24) {
          p += (basePrice - p) * 0.05;
        }
        points.push({
          price: +p.toFixed(sym === "XAU" ? 2 : 4),
          ts: now - i * HISTORY_INTERVAL_MS,
        });
      }
      // Ensure last point is current price
      points.push({ price: basePrice, ts: now });
      historyStore[sym] = points;
    }
  }
}

// ── Main fetcher with Promise.any racing ──────────────────────────
async function fetchPricesFromSources() {
  try {
    // Race all live sources - first successful response wins
    const result = await Promise.any([
      fetchStooq(),
      fetchGoldBroker(),
      fetchMetalPriceAPI(),
    ]);
    return { ...result, sourceMode: "live" };
  } catch (aggError) {
    // All live sources failed - use simulation
    console.warn("All live sources failed, using simulation:", aggError.message);
    return { ...simulatedPrices(), sourceMode: "simulated" };
  }
}

// ── Vercel handler ────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

  try {
    const now = Date.now();

    // Check cache
    if (cache.data && now - cache.ts < CACHE_TTL_MS) {
      return res.status(200).json(cache.data);
    }

    // Fetch fresh prices
    const result = await fetchPricesFromSources();

    // Update last known prices for future fallback
    if (result.XAU?.price > 0) {
      lastKnownPrices.XAU.price = result.XAU.price;
      if (result.XAU.open > 0) lastKnownPrices.XAU.open = result.XAU.open;
    }
    if (result.XAG?.price > 0) {
      lastKnownPrices.XAG.price = result.XAG.price;
      if (result.XAG.open > 0) lastKnownPrices.XAG.open = result.XAG.open;
    }

    // Update history
    pushHistory(result);
    ensureHistory(result);

    // Build response
    const response = {
      source: result.source,
      sourceMode: result.sourceMode,
      prices: {
        XAU: {
          price: result.XAU.price,
          dayHigh: result.XAU.dayHigh,
          dayLow: result.XAU.dayLow,
          dayChange: result.XAU.dayChange,
          dayChangePercent: result.XAU.dayChangePercent,
          updatedAt: new Date().toISOString(),
        },
        XAG: {
          price: result.XAG.price,
          dayHigh: result.XAG.dayHigh,
          dayLow: result.XAG.dayLow,
          dayChange: result.XAG.dayChange,
          dayChangePercent: result.XAG.dayChangePercent,
          updatedAt: new Date().toISOString(),
        },
      },
      history: {
        XAU: historyStore.XAU.slice(-168),
        XAG: historyStore.XAG.slice(-168),
      },
      marketSummary: getMarketSummary(),
    };

    // Cache it
    cache = { data: response, ts: now };

    return res.status(200).json(response);
  } catch (err) {
    // NEVER throw to client - return degraded data
    console.error("Handler error:", err);
    const fallback = simulatedPrices();
    ensureHistory(fallback);
    return res.status(200).json({
      source: "Simulated",
      sourceMode: "error-fallback",
      prices: {
        XAU: { ...fallback.XAU, updatedAt: new Date().toISOString() },
        XAG: { ...fallback.XAG, updatedAt: new Date().toISOString() },
      },
      history: {
        XAU: historyStore.XAU.slice(-168),
        XAG: historyStore.XAG.slice(-168),
      },
      marketSummary: getMarketSummary(),
    });
  }
}
