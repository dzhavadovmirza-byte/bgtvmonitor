// Budget Gold Monitor — Frontend
// 1s polling + 200ms micro-tick interpolation for smooth live feel

const POLL_MS = 1000;
const MICRO_TICK_MS = 400;
const SYMBOLS = ["XAU", "XAG"];
const CHART_COLORS = {
  XAU: { line: "#e8b931", fill: "232, 185, 49" },
  XAG: { line: "#a8b8d0", fill: "168, 184, 208" },
};

// Micro-tick noise amplitude (realistic spread simulation)
const NOISE = { XAU: 0.35, XAG: 0.008 };

let serverPrices = {};   // last price from server
let serverBidAsk = {};   // last bid/ask from server
let displayPrices = {};  // current displayed price (with micro-ticks)
let prevDisplay = {};    // previous display for flash direction
let lastData = null;
let marketOpen = true;    // track market status — freeze indicators when closed
let lastFetchTime = null;
let chartDataCache = {};
let microTickHistory = { XAU: [], XAG: [] };
const MICRO_HIST_MAX = 60; // last 12 seconds of micro-ticks for mini-chart feel

// ── Clock ──────────────────────────────────────────────
function tickClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const date = now.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  document.getElementById("clock").textContent = `${time}  ${date}`;
}
setInterval(tickClock, 500);
tickClock();

// ── Formatting ─────────────────────────────────────────
function fmt(n, d = 3) {
  if (n == null || isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}

function fmtDelta(change, pct) {
  if (change == null || isNaN(change)) return "--";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${fmt(change)} (${sign}${fmt(pct)}%)`;
}

// ── Micro-tick engine ──────────────────────────────────
// Generates small realistic movements between server ticks
function microTick() {
  // When market is closed, don't generate any movement — prices stay frozen
  if (!marketOpen) return;

  for (const sym of SYMBOLS) {
    const base = serverPrices[sym];
    if (!base) continue;

    const prev = displayPrices[sym] || base;
    // Random walk biased toward server price
    const drift = (base - prev) * 0.3; // pull toward real price
    const noise = (Math.random() - 0.5) * 2 * NOISE[sym];
    const newPrice = +(prev + drift + noise).toFixed(3);

    prevDisplay[sym] = displayPrices[sym];
    displayPrices[sym] = newPrice;

    // Update display
    const el = document.getElementById(`price-${sym}`);
    if (el) {
      const dec = 3;
      el.textContent = "$" + fmt(newPrice, dec);

      // Flash color
      el.classList.remove("flash-up", "flash-down");
      if (prevDisplay[sym] != null && Math.abs(newPrice - prevDisplay[sym]) > 0.001) {
        el.offsetHeight;
        el.classList.add(newPrice > prevDisplay[sym] ? "flash-up" : "flash-down");
        setTimeout(() => el.classList.remove("flash-up", "flash-down"), 400);
      }
    }

    // Update bid/ask with micro-noise
    const ba = serverBidAsk[sym];
    if (ba) {
      const spread = ba.ask - ba.bid;
      const bidEl = document.getElementById(`bid-${sym}`);
      const askEl = document.getElementById(`ask-${sym}`);
      const microBid = +(newPrice - spread / 2).toFixed(3);
      const microAsk = +(newPrice + spread / 2).toFixed(3);
      if (bidEl) bidEl.textContent = `$${fmt(microBid)}`;
      if (askEl) askEl.textContent = `$${fmt(microAsk)}`;
    }

    // Store micro-tick for potential use
    microTickHistory[sym].push(newPrice);
    if (microTickHistory[sym].length > MICRO_HIST_MAX) {
      microTickHistory[sym].shift();
    }
  }
}

setInterval(microTick, MICRO_TICK_MS);

// ── Chart drawing ──────────────────────────────────────
let pulsePhase = 0;
function drawChart(symbol, history) {
  const canvas = document.getElementById(`chart-${symbol}`);
  if (!canvas || !history || history.length < 2) return;

  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const W = rect.width;
  const H = rect.height;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  const values = history.map((p) => (typeof p === "object" ? p.price : p));
  const timestamps = history.map((p) =>
    typeof p === "object" && p.ts ? new Date(p.ts) : null
  );
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const dataRange = dataMax - dataMin || 1;
  // Minimum visible range so small moves don't look like huge swings
  const minRange = symbol === "XAU" ? 40 : 1.5;
  const range = Math.max(dataRange, minRange);
  const mid = (dataMin + dataMax) / 2;
  const min = mid - range / 2;
  const max = mid + range / 2;

  const pad = { t: 16, b: 28, l: 8, r: 8 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;
  const xStep = cW / (values.length - 1);

  const toX = (i) => pad.l + i * xStep;
  const toY = (v) => pad.t + cH - ((v - min) / range) * cH;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = pad.t + (cH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
  }

  // Price labels
  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const ld = 3;
  ctx.fillText(max.toFixed(ld), W - 4, pad.t + 4);
  ctx.fillText(min.toFixed(ld), W - 4, H - pad.b - 4);

  const { line: lineColor, fill: fillRGB } = CHART_COLORS[symbol];

  // Build points
  const points = values.map((v, i) => ({ x: toX(i), y: toY(v) }));

  // Smooth bezier path helper
  function traceSmoothPath(pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i - 1], c = pts[i];
      const mx = (p.x + c.x) / 2;
      const my = (p.y + c.y) / 2;
      ctx.quadraticCurveTo(p.x, p.y, mx, my);
    }
    const last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, `rgba(${fillRGB}, 0.12)`);
  grad.addColorStop(0.5, `rgba(${fillRGB}, 0.03)`);
  grad.addColorStop(1, `rgba(${fillRGB}, 0)`);

  ctx.beginPath();
  traceSmoothPath(points);
  const lastPt = points[points.length - 1];
  ctx.lineTo(lastPt.x, H - pad.b);
  ctx.lineTo(points[0].x, H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line stroke
  ctx.beginPath();
  traceSmoothPath(points);
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Pulsing endpoint
  const ex = lastPt.x, ey = lastPt.y;
  const glowR = 7 + Math.sin(pulsePhase) * 3;
  ctx.beginPath();
  ctx.arc(ex, ey, glowR, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${fillRGB}, 0.12)`;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();

  // Day labels
  const dayLabels = getDayLabels(timestamps, values.length);
  if (dayLabels.length) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    dayLabels.forEach(({ label, idx }) => {
      ctx.fillText(label, toX(idx), H - pad.b + 8);
    });
  }

  chartDataCache[symbol] = { points, values, timestamps, min, max, pad, W, H, toX, toY, xStep };
}

function getDayLabels(timestamps, count) {
  if (!timestamps || !timestamps[0]) return [];
  const seen = new Map();
  for (let i = 0; i < count; i++) {
    const ts = timestamps[i];
    if (!ts) continue;
    const key = ts.toISOString().slice(0, 10);
    if (!seen.has(key)) seen.set(key, i);
  }
  return Array.from(seen.entries()).slice(-7).map(([, idx]) => ({
    label: timestamps[idx].toLocaleDateString("en-US", { weekday: "short" }),
    idx,
  }));
}

// ── Pulse animation (only redraws dot, not whole chart) ─
let lastChartDraw = 0;
function animLoop() {
  pulsePhase += 0.08;
  // Redraw charts at 10fps for pulsing dot (not 60fps)
  const now = Date.now();
  if (now - lastChartDraw > 100 && lastData) {
    lastChartDraw = now;
    for (const sym of SYMBOLS) {
      const hist = lastData.history?.[sym];
      if (hist && hist.length > 1) drawChart(sym, hist);
    }
  }
  requestAnimationFrame(animLoop);
}
requestAnimationFrame(animLoop);

// ── Chart hover ────────────────────────────────────────
SYMBOLS.forEach((sym) => {
  const chartEl = document.querySelector(`.card[data-symbol="${sym}"] .card__chart`);
  if (!chartEl) return;

  const tooltip = document.getElementById(`tooltip-${sym}`);
  const canvas = document.getElementById(`chart-${sym}`);
  let hovering = false;

  chartEl.addEventListener("mousemove", (e) => {
    const data = chartDataCache[sym];
    if (!data || !data.points.length) return;
    hovering = true;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    let closest = 0, minDist = Infinity;
    data.points.forEach((pt, i) => {
      const dist = Math.abs(pt.x - mx);
      if (dist < minDist) { minDist = dist; closest = i; }
    });

    const pt = data.points[closest];
    const val = data.values[closest];
    const ts = data.timestamps[closest];

    // Redraw then overlay crosshair
    drawChart(sym, lastData?.history?.[sym]);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Crosshair
    ctx.strokeStyle = "rgba(255, 255, 255, 0.1)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(pt.x, data.pad.t);
    ctx.lineTo(pt.x, data.H - data.pad.b);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(data.pad.l, pt.y);
    ctx.lineTo(data.W - data.pad.r, pt.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Dot
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = CHART_COLORS[sym].line;
    ctx.fill();
    ctx.strokeStyle = "rgba(6, 14, 36, 0.6)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Tooltip
    const dec = 3;
    let text = `$${fmt(val, dec)}`;
    if (ts) {
      text += `  ${ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
    }
    tooltip.textContent = text;
    tooltip.style.display = "block";
  });

  chartEl.addEventListener("mouseleave", () => {
    hovering = false;
    tooltip.style.display = "none";
  });
});

// ── Apply server data ──────────────────────────────────
function applyData(data) {
  lastFetchTime = Date.now();

  // Market status
  const ml = document.getElementById("marketLine");
  if (data.marketSummary) {
    const ms = data.marketSummary;
    marketOpen = ms.status === "open";
    const label = ml.querySelector(".market-badge__label");
    const value = ml.querySelector(".market-badge__value");
    if (label) label.textContent = marketOpen ? "MARKET OPEN" : "MARKET CLOSED";
    if (value) {
      if (ms.untilClose) {
        value.textContent = `closes in ${ms.untilClose} (${ms.closeTime})`;
      } else if (ms.untilOpen) {
        value.textContent = `opens in ${ms.untilOpen} (${ms.openTime})`;
      } else {
        value.textContent = "";
      }
    }
  }

  // When market is closed and we already have data, keep old prices — don't update
  if (!marketOpen && lastData) {
    // Only update market status display, history and source info, but not prices
    lastData.marketSummary = data.marketSummary;
    // Update status pill to show "Closed"
    const pill = document.getElementById("statusPill");
    const connText = document.getElementById("connection");
    pill.classList.remove("is-error");
    connText.textContent = "Closed";
    return;
  }

  lastData = data;

  for (const sym of SYMBOLS) {
    const p = data.prices?.[sym];
    if (!p) continue;

    // Update server base price (micro-tick will interpolate from here)
    serverPrices[sym] = p.price;
    if (p.bid && p.ask) serverBidAsk[sym] = { bid: p.bid, ask: p.ask };
    // Initialize display price if first load
    if (!displayPrices[sym]) displayPrices[sym] = p.price;

    // Bid / Ask
    const bidEl = document.getElementById(`bid-${sym}`);
    const askEl = document.getElementById(`ask-${sym}`);
    if (bidEl) bidEl.textContent = `$${fmt(p.bid)}`;
    if (askEl) askEl.textContent = `$${fmt(p.ask)}`;

    // Delta badge
    const deltaEl = document.getElementById(`delta-${sym}`);
    if (deltaEl) {
      deltaEl.textContent = fmtDelta(p.dayChange, p.dayChangePercent);
      deltaEl.classList.remove("is-up", "is-down", "is-flat");
      deltaEl.classList.add(
        p.dayChange > 0 ? "is-up" : p.dayChange < 0 ? "is-down" : "is-flat"
      );
    }

    // Arrow
    const arrow = document.getElementById(`arrow-${sym}`);
    if (arrow) {
      arrow.classList.remove("is-down");
      if (p.dayChange < 0) arrow.classList.add("is-down");
    }

    // Range & Spread
    const dec = 3;
    const rangeEl = document.getElementById(`range-${sym}`);
    if (rangeEl) rangeEl.textContent = `$${fmt(p.dayLow, dec)} – $${fmt(p.dayHigh, dec)}`;

    const spreadEl = document.getElementById(`spread-${sym}`);
    if (spreadEl && p.bid && p.ask) {
      const sv = (p.ask - p.bid).toFixed(3);
      spreadEl.textContent = `$${sv}`;
    }
  }

  // Status pill
  const pill = document.getElementById("statusPill");
  const connText = document.getElementById("connection");
  pill.classList.remove("is-error");
  connText.textContent = data.sourceMode === "live" ? "Live" : "Delayed";

  // Footer
  document.getElementById("sourceInfo").textContent = `Source: ${data.source || "--"}`;
  document.getElementById("lastRefresh").textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ── Tick age ───────────────────────────────────────────
setInterval(() => {
  const el = document.getElementById("tickAge");
  if (!lastFetchTime) return;
  const ago = ((Date.now() - lastFetchTime) / 1000).toFixed(0);
  el.textContent = `${ago}s ago`;
}, 200);

// ── Fetch loop ─────────────────────────────────────────
async function fetchPrices() {
  try {
    const res = await fetch(`/api/prices?t=${Date.now()}`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyData(data);
  } catch (err) {
    console.warn("Fetch error:", err.message);
    const pill = document.getElementById("statusPill");
    const connText = document.getElementById("connection");
    pill.classList.add("is-error");
    connText.textContent = "Reconnecting";
  }
}

fetchPrices();
// Poll every second when open, every 30s when closed (just to detect market open)
setInterval(() => {
  const interval = marketOpen ? POLL_MS : 30000;
  if (Date.now() - lastFetchTime >= interval) fetchPrices();
}, POLL_MS);

// Redraw on resize
window.addEventListener("resize", () => {
  if (!lastData) return;
  for (const sym of SYMBOLS) {
    const hist = lastData.history?.[sym];
    if (hist && hist.length > 1) drawChart(sym, hist);
  }
});
