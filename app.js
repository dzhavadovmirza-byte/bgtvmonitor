// Budget Gold Monitor — Frontend
// 1-second polling, animated prices, dynamic charts with hover crosshair

const POLL_MS = 1000;
const SYMBOLS = ["XAU", "XAG"];
const CHART_COLORS = {
  XAU: { line: "#e8b931", fill: "232, 185, 49" },
  XAG: { line: "#a8b8d0", fill: "168, 184, 208" },
};

let prevPrices = {};
let lastData = null;
let lastFetchTime = null;
let chartDataCache = {};

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
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
}

function fmtDelta(change, pct) {
  if (change == null || isNaN(change)) return "--";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${fmt(change)} (${sign}${fmt(pct)}%)`;
}

// ── Chart ──────────────────────────────────────────────
function drawChart(symbol, history, animated = false) {
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
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  const pad = { t: 16, b: 28, l: 8, r: 8 };
  const cW = W - pad.l - pad.r;
  const cH = H - pad.t - pad.b;
  const xStep = cW / (values.length - 1);

  const toX = (i) => pad.l + i * xStep;
  const toY = (v) => pad.t + cH - ((v - min) / range) * cH;

  ctx.clearRect(0, 0, W, H);

  // Subtle horizontal grid
  const gridLines = 4;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.03)";
  ctx.lineWidth = 1;
  for (let i = 1; i < gridLines; i++) {
    const y = pad.t + (cH / gridLines) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(W - pad.r, y);
    ctx.stroke();
  }

  // Price labels on right
  ctx.fillStyle = "rgba(255, 255, 255, 0.18)";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const labelDecimals = symbol === "XAU" ? 0 : 2;
  ctx.fillText(max.toFixed(labelDecimals), W - 4, pad.t + 4);
  ctx.fillText(min.toFixed(labelDecimals), W - 4, H - pad.b - 4);

  const { line: lineColor, fill: fillRGB } = CHART_COLORS[symbol];

  // Determine how many points to draw for animation
  const drawCount = animated ? Math.min(values.length, Math.floor(values.length * animProgress)) : values.length;
  if (drawCount < 2) return;

  // Gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, `rgba(${fillRGB}, 0.15)`);
  grad.addColorStop(0.6, `rgba(${fillRGB}, 0.04)`);
  grad.addColorStop(1, `rgba(${fillRGB}, 0)`);

  // Build smooth path using quadratic curves
  const points = [];
  for (let i = 0; i < drawCount; i++) {
    points.push({ x: toX(i), y: toY(values[i]) });
  }

  // Draw filled area
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    ctx.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.8, prev.y, cpx, (prev.y + curr.y) / 2);
    ctx.quadraticCurveTo(curr.x - (curr.x - cpx) * 0.8, curr.y, curr.x, curr.y);
  }
  const lastPt = points[points.length - 1];
  ctx.lineTo(lastPt.x, H - pad.b);
  ctx.lineTo(points[0].x, H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Draw line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const cpx = (prev.x + curr.x) / 2;
    ctx.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.8, prev.y, cpx, (prev.y + curr.y) / 2);
    ctx.quadraticCurveTo(curr.x - (curr.x - cpx) * 0.8, curr.y, curr.x, curr.y);
  }
  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Pulsing dot at the end
  const endX = lastPt.x;
  const endY = lastPt.y;

  // Outer glow
  const glowSize = 8 + Math.sin(Date.now() / 400) * 3;
  ctx.beginPath();
  ctx.arc(endX, endY, glowSize, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${fillRGB}, 0.15)`;
  ctx.fill();

  // Inner dot
  ctx.beginPath();
  ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();

  // Day labels along bottom
  const dayLabels = getDayLabels(timestamps, drawCount);
  if (dayLabels.length) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.2)";
    ctx.font = "500 10px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    dayLabels.forEach(({ label, idx }) => {
      ctx.fillText(label, toX(idx), H - pad.b + 8);
    });
  }

  // Cache for hover
  chartDataCache[symbol] = { points, values, timestamps, min, max, pad, W, H, toX, toY, xStep };
}

let animProgress = 1;

function getDayLabels(timestamps, count) {
  if (!timestamps || !timestamps[0]) return [];
  const seen = new Map();
  for (let i = 0; i < count; i++) {
    const ts = timestamps[i];
    if (!ts) continue;
    const key = ts.toISOString().slice(0, 10);
    if (!seen.has(key)) seen.set(key, i);
  }
  const entries = Array.from(seen.entries()).slice(-7);
  return entries.map(([, idx]) => {
    const d = timestamps[idx];
    return {
      label: d.toLocaleDateString("en-US", { weekday: "short" }),
      idx,
    };
  });
}

// ── Chart hover crosshair ──────────────────────────────
SYMBOLS.forEach((sym) => {
  const chartEl = document.querySelector(`.card[data-symbol="${sym}"] .card__chart`);
  if (!chartEl) return;

  const tooltip = document.getElementById(`tooltip-${sym}`);
  const canvas = document.getElementById(`chart-${sym}`);

  chartEl.addEventListener("mousemove", (e) => {
    const data = chartDataCache[sym];
    if (!data || !data.points.length) return;

    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    // Find closest point
    let closest = 0;
    let minDist = Infinity;
    data.points.forEach((pt, i) => {
      const dist = Math.abs(pt.x - mx);
      if (dist < minDist) { minDist = dist; closest = i; }
    });

    const pt = data.points[closest];
    const val = data.values[closest];
    const ts = data.timestamps[closest];

    // Draw crosshair
    drawChart(sym, lastData?.history?.[sym]);
    const ctx = canvas.getContext("2d");
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    ctx.save();
    ctx.scale(1 / dpr, 1 / dpr);
    ctx.scale(dpr, dpr);

    // Vertical line
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pt.x, data.pad.t);
    ctx.lineTo(pt.x, data.H - data.pad.b);
    ctx.stroke();

    // Horizontal line
    ctx.beginPath();
    ctx.moveTo(data.pad.l, pt.y);
    ctx.lineTo(data.W - data.pad.r, pt.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Highlight dot
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = CHART_COLORS[sym].line;
    ctx.fill();
    ctx.strokeStyle = "rgba(6, 14, 36, 0.8)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();

    // Tooltip
    const dec = sym === "XAU" ? 2 : 4;
    let text = `$${fmt(val, dec)}`;
    if (ts) {
      text += `  ${ts.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
    }
    tooltip.textContent = text;
    tooltip.style.display = "block";
  });

  chartEl.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    if (lastData?.history?.[sym]) {
      drawChart(sym, lastData.history[sym]);
    }
  });
});

// ── Price animation ────────────────────────────────────
function animatePrice(symbol, newPrice) {
  const el = document.getElementById(`price-${symbol}`);
  if (!el) return;
  const old = prevPrices[symbol];
  const decimals = symbol === "XAU" ? 2 : 4;

  el.textContent = "$" + fmt(newPrice, decimals);

  el.classList.remove("flash-up", "flash-down");
  if (old != null && Math.abs(newPrice - old) > 0.001) {
    el.offsetHeight; // force reflow
    el.classList.add(newPrice > old ? "flash-up" : "flash-down");
    setTimeout(() => el.classList.remove("flash-up", "flash-down"), 500);
  }
  prevPrices[symbol] = newPrice;
}

// ── Apply data ─────────────────────────────────────────
function applyData(data) {
  lastData = data;
  lastFetchTime = Date.now();

  // Market status
  const ml = document.getElementById("marketLine");
  if (data.marketSummary) {
    const ms = data.marketSummary;
    const label = ml.querySelector(".market-badge__label");
    const value = ml.querySelector(".market-badge__value");
    if (label) label.textContent = ms.status === "open" ? "MARKET OPEN" : "MARKET CLOSED";
    if (value) {
      value.textContent = ms.untilClose
        ? `closes in ${ms.untilClose}`
        : ms.untilOpen
        ? `opens in ${ms.untilOpen}`
        : "";
    }
  }

  for (const sym of SYMBOLS) {
    const p = data.prices?.[sym];
    if (!p) continue;

    animatePrice(sym, p.price);

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
    const dec = sym === "XAU" ? 2 : 4;
    const rangeEl = document.getElementById(`range-${sym}`);
    if (rangeEl) rangeEl.textContent = `$${fmt(p.dayLow, dec)} – $${fmt(p.dayHigh, dec)}`;

    const spreadEl = document.getElementById(`spread-${sym}`);
    if (spreadEl) {
      const sv = sym === "XAU" ? (p.price * 0.0003).toFixed(2) : (p.price * 0.0008).toFixed(4);
      spreadEl.textContent = `$${sv}`;
    }

    // Chart
    const hist = data.history?.[sym];
    if (hist && hist.length > 1) {
      drawChart(sym, hist);
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

// ── Pulsing dot animation loop ─────────────────────────
function animatePulse() {
  if (lastData) {
    for (const sym of SYMBOLS) {
      const hist = lastData.history?.[sym];
      if (hist && hist.length > 1) drawChart(sym, hist);
    }
  }
  requestAnimationFrame(animatePulse);
}
requestAnimationFrame(animatePulse);

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
setInterval(fetchPrices, POLL_MS);

// Redraw on resize
window.addEventListener("resize", () => {
  if (!lastData) return;
  for (const sym of SYMBOLS) {
    const hist = lastData.history?.[sym];
    if (hist && hist.length > 1) drawChart(sym, hist);
  }
});
