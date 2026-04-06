// Budget Gold Monitor — Frontend
// Compatible with old TV browsers: ES5 only, XMLHttpRequest, no modern APIs

// Polyfills for very old browsers
if (!Date.now) { Date.now = function() { return new Date().getTime(); }; }
if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = function(cb) { return setTimeout(cb, 16); };
}

// Apply "big" mode for old TVs: add ?big=1 to URL
try {
  if (String(window.location.search).indexOf("big") >= 0) {
    document.documentElement.className += " big-tv";
  }
} catch (e) {}

// ── Prayer Times (Dubai) ───────────────────────────────
var PRAYER_ORDER = ["Fajr", "Dhuhr", "Asr", "Maghrib", "Isha"];
var prayerTimings = null;
var prayerFetchedDate = "";

function getDubaiNow() {
  var now = new Date();
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 4 * 3600000); // UTC+4
}

function prayerToMinutes(timeStr) {
  var clean = timeStr.split(" ")[0]; // strip "(WIB)" etc
  var parts = clean.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function updatePrayerWidget() {
  if (!prayerTimings) return;
  var dubai = getDubaiNow();
  var nowMins = dubai.getHours() * 60 + dubai.getMinutes();
  var nextName = null;
  var nextMins = null;
  for (var i = 0; i < PRAYER_ORDER.length; i++) {
    var name = PRAYER_ORDER[i];
    var pm = prayerToMinutes(prayerTimings[name]);
    if (pm > nowMins) { nextName = name; nextMins = pm; break; }
  }
  if (!nextName) { // after Isha — show tomorrow's Fajr
    nextName = "Fajr";
    nextMins = prayerToMinutes(prayerTimings["Fajr"]) + 1440;
  }
  var diff = nextMins - nowMins;
  var h = Math.floor(diff / 60);
  var m = diff % 60;
  var countdown = h > 0 ? (h + "h " + m + "m") : (m + "m");
  var nameEl = document.getElementById("prayerName");
  var countEl = document.getElementById("prayerCountdown");
  if (nameEl) nameEl.textContent = nextName.toUpperCase();
  if (countEl) countEl.textContent = countdown;
}

function fetchPrayerTimes() {
  var dubai = getDubaiNow();
  var dateKey = dubai.getFullYear() + "-" + (dubai.getMonth() + 1) + "-" + dubai.getDate();
  if (prayerFetchedDate === dateKey && prayerTimings) { updatePrayerWidget(); return; }
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "https://api.aladhan.com/v1/timingsByCity?city=Dubai&country=AE&method=16", true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    try {
      var data = JSON.parse(xhr.responseText);
      var t = data.data.timings;
      prayerTimings = { Fajr: t.Fajr, Dhuhr: t.Dhuhr, Asr: t.Asr, Maghrib: t.Maghrib, Isha: t.Isha };
      prayerFetchedDate = dateKey;
      updatePrayerWidget();
    } catch(e) {}
  };
  try { xhr.send(); } catch(e) {}
}

fetchPrayerTimes();
setInterval(function() { fetchPrayerTimes(); updatePrayerWidget(); }, 60000);

var POLL_MS = 1000;
var MICRO_TICK_MS = 400;
var SYMBOLS = ["XAU", "XAG"];
var CHART_COLORS = {
  XAU: { line: "#e8b931", fill: "232, 185, 49" },
  XAG: { line: "#a8b8d0", fill: "168, 184, 208" },
};

// Micro-tick noise amplitude (realistic spread simulation)
var NOISE = { XAU: 0.35, XAG: 0.008 };

var serverPrices = {};   // last price from server
var serverBidAsk = {};   // last bid/ask from server
var displayPrices = {};  // current displayed price (with micro-ticks)
var prevDisplay = {};    // previous display for flash direction
var lastData = null;
var marketOpen = true;    // track market status — freeze indicators when closed
var lastFetchTime = null;
var chartDataCache = {};
var microTickHistory = { XAU: [], XAG: [] };
var MICRO_HIST_MAX = 60;

// ── Clock ──────────────────────────────────────────────
function tickClock() {
  var now = new Date();
  var time = now.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var date = now.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  document.getElementById("clock").textContent = time + "  " + date;
}
setInterval(tickClock, 500);
tickClock();

// ── Formatting ─────────────────────────────────────────
function fmt(n, d) {
  if (d === undefined) d = 3;
  if (n == null || isNaN(n)) return "--";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}

function fmtDelta(change, pct) {
  if (change == null || isNaN(change)) return "--";
  var sign = change >= 0 ? "+" : "";
  return sign + fmt(change) + " (" + sign + fmt(pct) + "%)";
}

// ── Safe property access helper ────────────────────────
function get(obj, key1, key2) {
  if (!obj) return undefined;
  var v = obj[key1];
  if (key2 !== undefined && v) return v[key2];
  return v;
}

// ── Micro-tick engine ──────────────────────────────────
function microTick() {
  if (!marketOpen) return;

  for (var s = 0; s < SYMBOLS.length; s++) {
    var sym = SYMBOLS[s];
    var base = serverPrices[sym];
    if (!base) continue;

    var prev = displayPrices[sym] || base;
    var drift = (base - prev) * 0.3;
    var noise = (Math.random() - 0.5) * 2 * NOISE[sym];
    var newPrice = +(prev + drift + noise).toFixed(3);

    prevDisplay[sym] = displayPrices[sym];
    displayPrices[sym] = newPrice;

    var el = document.getElementById("price-" + sym);
    if (el) {
      el.textContent = "$" + fmt(newPrice, 3);

      el.classList.remove("flash-up", "flash-down");
      if (prevDisplay[sym] != null && Math.abs(newPrice - prevDisplay[sym]) > 0.001) {
        el.offsetHeight; // force reflow
        el.classList.add(newPrice > prevDisplay[sym] ? "flash-up" : "flash-down");
        (function(e) {
          setTimeout(function() { e.classList.remove("flash-up", "flash-down"); }, 400);
        })(el);
      }
    }

    var ba = serverBidAsk[sym];
    if (ba) {
      var spread = ba.ask - ba.bid;
      var bidEl = document.getElementById("bid-" + sym);
      var askEl = document.getElementById("ask-" + sym);
      var microBid = +(newPrice - spread / 2).toFixed(3);
      var microAsk = +(newPrice + spread / 2).toFixed(3);
      if (bidEl) bidEl.textContent = "$" + fmt(microBid);
      if (askEl) askEl.textContent = "$" + fmt(microAsk);
    }

    microTickHistory[sym].push(newPrice);
    if (microTickHistory[sym].length > MICRO_HIST_MAX) {
      microTickHistory[sym].shift();
    }
  }
}

setInterval(microTick, MICRO_TICK_MS);

// ── Chart drawing ──────────────────────────────────────
var pulsePhase = 0;
function drawChart(symbol, history) {
  var canvas = document.getElementById("chart-" + symbol);
  if (!canvas || !history || history.length < 2) return;

  var ctx = canvas.getContext("2d");
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  var rect = canvas.getBoundingClientRect();
  var W = rect.width;
  var H = rect.height;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);

  var values = [];
  var timestamps = [];
  for (var i = 0; i < history.length; i++) {
    var p = history[i];
    values.push(typeof p === "object" ? p.price : p);
    timestamps.push(typeof p === "object" && p.ts ? new Date(p.ts) : null);
  }

  var dataMin = values[0], dataMax = values[0];
  for (var i = 1; i < values.length; i++) {
    if (values[i] < dataMin) dataMin = values[i];
    if (values[i] > dataMax) dataMax = values[i];
  }
  var dataRange = dataMax - dataMin || 1;
  var minRange = symbol === "XAU" ? 40 : 1.5;
  var range = Math.max(dataRange, minRange);
  var mid = (dataMin + dataMax) / 2;
  var min = mid - range / 2;
  var max = mid + range / 2;

  var pad = { t: 16, b: 28, l: 8, r: 8 };
  var cW = W - pad.l - pad.r;
  var cH = H - pad.t - pad.b;
  var xStep = cW / (values.length - 1);

  function toX(idx) { return pad.l + idx * xStep; }
  function toY(v) { return pad.t + cH - ((v - min) / range) * cH; }

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = "rgba(255, 255, 255, 0.025)";
  ctx.lineWidth = 1;
  for (var g = 1; g < 4; g++) {
    var y = pad.t + (cH / 4) * g;
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
  ctx.fillText(max.toFixed(3), W - 4, pad.t + 4);
  ctx.fillText(min.toFixed(3), W - 4, H - pad.b - 4);

  var colors = CHART_COLORS[symbol];
  var lineColor = colors.line;
  var fillRGB = colors.fill;

  // Build points
  var points = [];
  for (var i = 0; i < values.length; i++) {
    points.push({ x: toX(i), y: toY(values[i]) });
  }

  // Smooth bezier path helper
  function traceSmoothPath(pts) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (var j = 1; j < pts.length; j++) {
      var prev = pts[j - 1], cur = pts[j];
      var mx = (prev.x + cur.x) / 2;
      var my = (prev.y + cur.y) / 2;
      ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
    }
    var last = pts[pts.length - 1];
    ctx.lineTo(last.x, last.y);
  }

  // Gradient fill
  var grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
  grad.addColorStop(0, "rgba(" + fillRGB + ", 0.12)");
  grad.addColorStop(0.5, "rgba(" + fillRGB + ", 0.03)");
  grad.addColorStop(1, "rgba(" + fillRGB + ", 0)");

  ctx.beginPath();
  traceSmoothPath(points);
  var lastPt = points[points.length - 1];
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
  var ex = lastPt.x, ey = lastPt.y;
  var glowR = 7 + Math.sin(pulsePhase) * 3;
  ctx.beginPath();
  ctx.arc(ex, ey, glowR, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(" + fillRGB + ", 0.12)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 3, 0, Math.PI * 2);
  ctx.fillStyle = lineColor;
  ctx.fill();

  // Day labels
  var dayLabels = getDayLabels(timestamps, values.length);
  if (dayLabels.length) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (var d = 0; d < dayLabels.length; d++) {
      ctx.fillText(dayLabels[d].label, toX(dayLabels[d].idx), H - pad.b + 8);
    }
  }

  chartDataCache[symbol] = { points: points, values: values, timestamps: timestamps, min: min, max: max, pad: pad, W: W, H: H, toX: toX, toY: toY, xStep: xStep };
}

function getDayLabels(timestamps, count) {
  if (!timestamps || !timestamps[0]) return [];
  var seen = {};
  var order = [];
  for (var i = 0; i < count; i++) {
    var ts = timestamps[i];
    if (!ts) continue;
    var key = ts.toISOString().slice(0, 10);
    if (!(key in seen)) {
      seen[key] = i;
      order.push({ key: key, idx: i });
    }
  }
  var last7 = order.slice(-7);
  var result = [];
  for (var j = 0; j < last7.length; j++) {
    result.push({
      label: timestamps[last7[j].idx].toLocaleDateString("en-US", { weekday: "short" }),
      idx: last7[j].idx,
    });
  }
  return result;
}

// ── Pulse animation ────────────────────────────────────
var lastChartDraw = 0;
function animLoop() {
  pulsePhase += 0.08;
  var now = Date.now();
  if (now - lastChartDraw > 100 && lastData) {
    lastChartDraw = now;
    for (var s = 0; s < SYMBOLS.length; s++) {
      var sym = SYMBOLS[s];
      var hist = lastData.history && lastData.history[sym];
      if (hist && hist.length > 1) drawChart(sym, hist);
    }
  }
  requestAnimationFrame(animLoop);
}
requestAnimationFrame(animLoop);

// ── Chart hover ────────────────────────────────────────
SYMBOLS.forEach(function(sym) {
  var chartEl = document.querySelector('.card[data-symbol="' + sym + '"] .card__chart');
  if (!chartEl) return;

  var tooltip = document.getElementById("tooltip-" + sym);
  var canvas = document.getElementById("chart-" + sym);

  chartEl.addEventListener("mousemove", function(e) {
    var data = chartDataCache[sym];
    if (!data || !data.points.length) return;

    var rect = canvas.getBoundingClientRect();
    var mx = e.clientX - rect.left;

    var closest = 0, minDist = Infinity;
    data.points.forEach(function(pt, i) {
      var dist = Math.abs(pt.x - mx);
      if (dist < minDist) { minDist = dist; closest = i; }
    });

    var pt = data.points[closest];
    var val = data.values[closest];
    var ts = data.timestamps[closest];

    // Redraw then overlay crosshair
    var h = lastData && lastData.history && lastData.history[sym];
    if (h) drawChart(sym, h);
    var ctx = canvas.getContext("2d");
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
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
    var text = "$" + fmt(val, 3);
    if (ts) {
      text += "  " + ts.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + ts.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    }
    tooltip.textContent = text;
    tooltip.style.display = "block";
  });

  chartEl.addEventListener("mouseleave", function() {
    tooltip.style.display = "none";
  });
});

// ── Apply server data ──────────────────────────────────
function applyData(data) {
  lastFetchTime = Date.now();

  // Market status
  var ml = document.getElementById("marketLine");
  if (data.marketSummary) {
    var ms = data.marketSummary;
    marketOpen = ms.status === "open";
    var label = ml.querySelector(".market-badge__label");
    var value = ml.querySelector(".market-badge__value");
    if (label) label.textContent = marketOpen ? "MARKET OPEN" : "MARKET CLOSED";
    if (value) {
      if (ms.untilClose) {
        value.textContent = "closes in " + ms.untilClose + " (" + ms.closeTime + ")";
      } else if (ms.untilOpen) {
        value.textContent = "opens in " + ms.untilOpen + " (" + ms.openTime + ")";
      } else {
        value.textContent = "";
      }
    }
  }

  // When market is closed and we already have data, keep old prices
  if (!marketOpen && lastData) {
    lastData.marketSummary = data.marketSummary;
    var pill = document.getElementById("statusPill");
    var connText = document.getElementById("connection");
    pill.classList.remove("is-error");
    connText.textContent = "Closed";
    return;
  }

  lastData = data;

  for (var s = 0; s < SYMBOLS.length; s++) {
    var sym = SYMBOLS[s];
    var p = data.prices && data.prices[sym];
    if (!p) continue;

    serverPrices[sym] = p.price;
    if (p.bid && p.ask) serverBidAsk[sym] = { bid: p.bid, ask: p.ask };
    if (!displayPrices[sym]) displayPrices[sym] = p.price;

    var bidEl = document.getElementById("bid-" + sym);
    var askEl = document.getElementById("ask-" + sym);
    if (bidEl) bidEl.textContent = "$" + fmt(p.bid);
    if (askEl) askEl.textContent = "$" + fmt(p.ask);

    var deltaEl = document.getElementById("delta-" + sym);
    if (deltaEl) {
      deltaEl.textContent = fmtDelta(p.dayChange, p.dayChangePercent);
      deltaEl.classList.remove("is-up", "is-down", "is-flat");
      deltaEl.classList.add(
        p.dayChange > 0 ? "is-up" : p.dayChange < 0 ? "is-down" : "is-flat"
      );
    }

    var arrow = document.getElementById("arrow-" + sym);
    if (arrow) {
      arrow.classList.remove("is-down");
      if (p.dayChange < 0) arrow.classList.add("is-down");
    }

    var rangeEl = document.getElementById("range-" + sym);
    if (rangeEl) rangeEl.textContent = "$" + fmt(p.dayLow, 3) + " – $" + fmt(p.dayHigh, 3);

    var spreadEl = document.getElementById("spread-" + sym);
    if (spreadEl && p.dayHigh != null && p.dayLow != null) {
      spreadEl.textContent = "$" + fmt(p.dayHigh - p.dayLow, 3);
    }
  }

  // Status pill
  var pill = document.getElementById("statusPill");
  var connText = document.getElementById("connection");
  pill.classList.remove("is-error");
  connText.textContent = data.sourceMode === "live" ? "Live" : "Delayed";

  // Footer
  document.getElementById("sourceInfo").textContent = "Source: " + (data.source || "--");
  document.getElementById("lastRefresh").textContent = new Date().toLocaleTimeString("en-US", { hour12: false });
}

// ── Tick age ───────────────────────────────────────────
setInterval(function() {
  var el = document.getElementById("tickAge");
  if (!lastFetchTime) return;
  var ago = ((Date.now() - lastFetchTime) / 1000).toFixed(0);
  el.textContent = ago + "s ago";
}, 200);

// ── Fetch loop (XMLHttpRequest for max compatibility) ──
function fetchPrices() {
  var xhr = new XMLHttpRequest();
  xhr.open("GET", "/api/prices?t=" + Date.now(), true);
  xhr.timeout = 4000;
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        var data = JSON.parse(xhr.responseText);
        applyData(data);
      } catch (e) {
        showError();
      }
    } else {
      showError();
    }
  };
  xhr.ontimeout = function() { showError(); };
  xhr.onerror = function() { showError(); };
  xhr.send();
}

function showError() {
  var pill = document.getElementById("statusPill");
  var connText = document.getElementById("connection");
  if (pill) pill.className = "status-pill is-error";
  if (connText) connText.textContent = "Reconnecting";
}

fetchPrices();
// Poll every second when open, every 30s when closed
setInterval(function() {
  var interval = marketOpen ? POLL_MS : 30000;
  if (Date.now() - lastFetchTime >= interval) fetchPrices();
}, POLL_MS);

// Redraw on resize
window.addEventListener("resize", function() {
  if (!lastData) return;
  for (var s = 0; s < SYMBOLS.length; s++) {
    var sym = SYMBOLS[s];
    var hist = lastData.history && lastData.history[sym];
    if (hist && hist.length > 1) drawChart(sym, hist);
  }
});
