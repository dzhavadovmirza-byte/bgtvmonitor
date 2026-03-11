// Budget Gold Monitor TV - Frontend Application
// Fetches prices from /api/prices every 1 second with smooth animations

const POLL_MS = 1000;
const SYMBOLS = ["XAU", "XAG"];
const COLORS = { XAU: "#f6e547", XAG: "#d8e3f2" };

let prevPrices = {};
let lastData = null;
let lastFetchTime = null;

// ── Clock ──────────────────────────────────────────────
function tickClock() {
  const now = new Date();
  const str = now.toLocaleString("en-US", {
    weekday: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: true, timeZoneName: "short",
  });
  document.getElementById("clock").textContent = str;
}
setInterval(tickClock, 500);
tickClock();

// ── Number formatting ──────────────────────────────────
function fmt(n, d = 2) {
  if (n == null || isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function fmtDelta(change, pct) {
  if (change == null || isNaN(change)) return "(--)";
  const sign = change >= 0 ? "+" : "";
  return `${sign}${fmt(change)} (${sign}${fmt(pct)}%)`;
}

// ── Chart drawing ──────────────────────────────────────
function drawChart(canvasId, history, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !history || history.length < 2) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height;
  const pad = { t: 12, b: 12, l: 4, r: 4 };

  const values = history.map((p) => (typeof p === "object" ? p.price : p));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;

  ctx.clearRect(0, 0, W, H);

  // gradient fill
  const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, color + "44");
  grad.addColorStop(1, color + "05");

  const xStep = (W - pad.l - pad.r) / (values.length - 1);
  const yScale = (H - pad.t - pad.b) / range;

  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad.l + i * xStep;
    const y = H - pad.b - (v - min) * yScale;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  // fill
  ctx.lineTo(pad.l + (values.length - 1) * xStep, H - pad.b);
  ctx.lineTo(pad.l, H - pad.b);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // line
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = pad.l + i * xStep;
    const y = H - pad.b - (v - min) * yScale;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // dot at end
  const lastX = pad.l + (values.length - 1) * xStep;
  const lastY = H - pad.b - (values[values.length - 1] - min) * yScale;
  ctx.beginPath();
  ctx.arc(lastX, lastY, 5, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = "#0a1640";
  ctx.lineWidth = 2;
  ctx.stroke();
}

// ── Update days axis ───────────────────────────────────
function updateDaysAxis(symbol) {
  const el = document.getElementById(`days-${symbol}`);
  if (!el) return;
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const today = new Date().getDay();
  const labels = [];
  for (let i = 6; i >= 0; i--) {
    const d = (today - i + 7) % 7;
    labels.push(days[d]);
  }
  el.textContent = labels.join("  ");
}

// ── Price animation (CSS transition approach) ──────────
function animatePrice(symbol, newPrice) {
  const el = document.getElementById(`price-${symbol}`);
  if (!el) return;
  const old = prevPrices[symbol];
  const decimals = symbol === "XAU" ? 2 : 4;

  el.textContent = "$" + fmt(newPrice, decimals);

  // flash color
  el.classList.remove("is-up", "is-down");
  if (old != null && newPrice !== old) {
    el.classList.add(newPrice > old ? "is-up" : "is-down");
    setTimeout(() => el.classList.remove("is-up", "is-down"), 600);
  }
  prevPrices[symbol] = newPrice;
}

// ── Main update ────────────────────────────────────────
function applyData(data) {
  lastData = data;
  lastFetchTime = Date.now();

  // Market status
  const ml = document.getElementById("marketLine");
  if (data.marketSummary) {
    const ms = data.marketSummary;
    ml.textContent = `Market: ${ms.status === "open" ? "OPEN" : "CLOSED"}${ms.untilClose ? " | Closes in " + ms.untilClose : ""}${ms.untilOpen ? " | Opens in " + ms.untilOpen : ""}`;
    ml.classList.toggle("is-closed", ms.status !== "open");
  }

  // Prices
  for (const sym of SYMBOLS) {
    const p = data.prices?.[sym];
    if (!p) continue;

    animatePrice(sym, p.price);

    // Delta
    const deltaEl = document.getElementById(`delta-${sym}`);
    if (deltaEl) {
      deltaEl.textContent = fmtDelta(p.dayChange, p.dayChangePercent);
      deltaEl.classList.remove("is-up", "is-down", "is-flat");
      if (p.dayChange > 0) deltaEl.classList.add("is-up");
      else if (p.dayChange < 0) deltaEl.classList.add("is-down");
      else deltaEl.classList.add("is-flat");
    }

    // Arrow
    const arrow = document.getElementById(`arrow-${sym}`);
    if (arrow) {
      arrow.classList.remove("is-up", "is-down");
      if (p.dayChange > 0) { arrow.textContent = "↑"; arrow.classList.add("is-up"); }
      else if (p.dayChange < 0) { arrow.textContent = "↓"; arrow.classList.add("is-down"); }
      else { arrow.textContent = "→"; }
    }

    // Range
    const rangeEl = document.getElementById(`range-${sym}`);
    if (rangeEl) {
      const dec = sym === "XAU" ? 2 : 4;
      rangeEl.textContent = `Today's Range: $${fmt(p.dayLow, dec)} – $${fmt(p.dayHigh, dec)}`;
    }

    // Spread
    const spreadEl = document.getElementById(`spread-${sym}`);
    if (spreadEl) {
      const spreadVal = sym === "XAU" ? (p.price * 0.0003).toFixed(2) : (p.price * 0.0008).toFixed(4);
      spreadEl.textContent = `Spread: $${spreadVal}`;
    }

    // Chart
    const hist = data.history?.[sym];
    if (hist && hist.length > 1) {
      drawChart(`chart-${sym}`, hist, COLORS[sym]);
    }

    updateDaysAxis(sym);
  }

  // Footer
  const conn = document.getElementById("connection");
  conn.textContent = "Connected";
  conn.style.color = "#29e07b";

  const src = document.getElementById("sourceInfo");
  src.textContent = `Source: ${data.source || "--"} (${data.sourceMode || "--"})`;

  const refresh = document.getElementById("lastRefresh");
  refresh.textContent = `Last refresh: ${new Date().toLocaleTimeString()}`;
}

// ── Tick age updater ───────────────────────────────────
setInterval(() => {
  const el = document.getElementById("tickAge");
  if (!lastFetchTime) return;
  const ago = ((Date.now() - lastFetchTime) / 1000).toFixed(0);
  el.textContent = `Last tick: ${ago}s ago`;
}, 200);

// ── Fetch loop ─────────────────────────────────────────
async function fetchPrices() {
  try {
    const res = await fetch("/api/prices", { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    applyData(data);
  } catch (err) {
    console.warn("Fetch error:", err.message);
    const conn = document.getElementById("connection");
    conn.textContent = "Reconnecting...";
    conn.style.color = "#ff627f";
  }
}

// Start polling
fetchPrices();
setInterval(fetchPrices, POLL_MS);

// Redraw charts on resize
window.addEventListener("resize", () => {
  if (!lastData) return;
  for (const sym of SYMBOLS) {
    const hist = lastData.history?.[sym];
    if (hist && hist.length > 1) {
      drawChart(`chart-${sym}`, hist, COLORS[sym]);
    }
  }
});
