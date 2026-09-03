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
var prayerTimings = null;      // today's timings
var prayerTimingsTmrw = null;  // tomorrow's Fajr (for after-Isha countdown)
var prayerFetchedDate = "";
var prayerNotifiedToday = {};  // { "Fajr": true, ... } — avoid re-triggering
var azanAudio = null;
var prayerPopupTimer = null;   // safety fallback: auto-close even if audio.onended never fires

function getAzanAudio() {
  if (!azanAudio) {
    azanAudio = document.getElementById("azanAudio");
  }
  return azanAudio;
}

function showPrayerPopup(name, timeStr) {
  var popup = document.getElementById("prayerPopup");
  var nameEl = document.getElementById("popupName");
  var timeEl = document.getElementById("popupTime");
  var bar = document.getElementById("popupBar");
  if (!popup) return;
  if (nameEl) nameEl.textContent = name.toUpperCase();
  if (timeEl) timeEl.textContent = timeStr;
  popup.className = "prayer-popup is-visible";

  // Play azan
  var audio = getAzanAudio();
  if (audio) {
    audio.currentTime = 0;
    try { audio.play(); } catch(e) {}

    // Progress bar driven by audio duration
    if (bar) {
      bar.style.transition = "none";
      bar.style.transform = "scaleX(1)";
      setTimeout(function() {
        var dur = audio.duration || 203; // fallback 3m23s
        bar.style.transition = "transform " + dur + "s linear";
        bar.style.transform = "scaleX(0)";
      }, 80);
    }

    // Close when azan ends
    audio.onended = function() { hidePrayerPopup(); };

    // Safety fallback: some TV browsers (Samsung/Tizen) don't reliably fire
    // "onended", or block autoplay so it never fires at all — which left the
    // popup stuck open until closed by remote. Force-close after the azan
    // length (+10s buffer) no matter what.
    if (prayerPopupTimer) { clearTimeout(prayerPopupTimer); }
    var fallbackSec = (audio.duration && isFinite(audio.duration)) ? (audio.duration + 10) : 213;
    prayerPopupTimer = setTimeout(function() { hidePrayerPopup(); }, fallbackSec * 1000);
  } else {
    // No audio element at all — still auto-close after ~azan length.
    if (prayerPopupTimer) { clearTimeout(prayerPopupTimer); }
    prayerPopupTimer = setTimeout(function() { hidePrayerPopup(); }, 213000);
  }

  // Close button
  var closeBtn = document.getElementById("popupClose");
  if (closeBtn) {
    closeBtn.onclick = function() { hidePrayerPopup(); };
  }
  popup.onclick = function(e) {
    if (e.target === popup) hidePrayerPopup();
  };
}

function hidePrayerPopup() {
  if (prayerPopupTimer) { clearTimeout(prayerPopupTimer); prayerPopupTimer = null; }
  var popup = document.getElementById("prayerPopup");
  if (popup) popup.className = "prayer-popup";
  var audio = getAzanAudio();
  if (audio && !audio.paused) {
    audio.pause();
    audio.currentTime = 0;
  }
}

function checkPrayerAlert() {
  if (!prayerTimings) return;
  var dubai = getDubaiNow();
  var nowMins = dubai.getHours() * 60 + dubai.getMinutes();
  var nowSecs = dubai.getSeconds();
  // Fire in the first 5 seconds of the prayer minute
  if (nowSecs > 5) return;
  for (var i = 0; i < PRAYER_ORDER.length; i++) {
    var name = PRAYER_ORDER[i];
    var pm = prayerToMinutes(prayerTimings[name]);
    if (pm === nowMins && !prayerNotifiedToday[name]) {
      prayerNotifiedToday[name] = true;
      showPrayerPopup(name, prayerTimings[name].split(" ")[0]);
      break;
    }
  }
}

function getDubaiNow() {
  var now = new Date();
  var utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 4 * 3600000); // UTC+4 fixed (Dubai never observes DST)
}

function dubaiDateStr(d) {
  // Returns DD-MM-YYYY for Aladhan API
  var day = d.getDate();
  var mon = d.getMonth() + 1;
  return (day < 10 ? "0" + day : day) + "-" +
         (mon < 10 ? "0" + mon : mon) + "-" +
         d.getFullYear();
}

function prayerToMinutes(timeStr) {
  var clean = timeStr.split(" ")[0];
  var parts = clean.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

function fetchTimingsForDate(dateStr, cb) {
  var url = "https://api.aladhan.com/v1/timingsByCity/" + dateStr +
            "?city=Dubai&country=AE&method=16";
  var xhr = new XMLHttpRequest();
  xhr.open("GET", url, true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4) return;
    try {
      var data = JSON.parse(xhr.responseText);
      var t = data.data.timings;
      cb({ Fajr: t.Fajr, Dhuhr: t.Dhuhr, Asr: t.Asr, Maghrib: t.Maghrib, Isha: t.Isha });
    } catch(e) {}
  };
  try { xhr.send(); } catch(e) {}
}

function updatePrayerWidget() {
  if (!prayerTimings) return;
  var dubai = getDubaiNow();
  var nowSecs = dubai.getHours() * 3600 + dubai.getMinutes() * 60 + dubai.getSeconds();
  var nextName = null;
  var nextSecs = null;
  for (var i = 0; i < PRAYER_ORDER.length; i++) {
    var name = PRAYER_ORDER[i];
    var ps = prayerToMinutes(prayerTimings[name]) * 60;
    if (ps > nowSecs) { nextName = name; nextSecs = ps; break; }
  }
  if (!nextName) {
    // After Isha — show tomorrow's Fajr with real fetched time
    nextName = "Fajr";
    var fajrMins = prayerTimingsTmrw
      ? prayerToMinutes(prayerTimingsTmrw.Fajr)
      : prayerToMinutes(prayerTimings.Fajr);
    nextSecs = fajrMins * 60 + 86400;
  }
  var diff = nextSecs - nowSecs;
  var h = Math.floor(diff / 3600);
  var m = Math.floor((diff % 3600) / 60);
  var s = diff % 60;
  var pad = function(n) { return n < 10 ? "0" + n : "" + n; };
  var countdown = h > 0
    ? (h + "h " + pad(m) + "m " + pad(s) + "s")
    : (m + "m " + pad(s) + "s");
  var nameEl = document.getElementById("prayerName");
  var countEl = document.getElementById("prayerCountdown");
  if (nameEl) nameEl.textContent = nextName.toUpperCase();
  if (countEl) countEl.textContent = countdown;
}

function fetchPrayerTimes() {
  var dubai = getDubaiNow();
  var dateKey = dubai.getFullYear() + "-" + (dubai.getMonth() + 1) + "-" + dubai.getDate();
  if (prayerFetchedDate === dateKey && prayerTimings) { updatePrayerWidget(); return; }
  var todayStr = dubaiDateStr(dubai);
  fetchTimingsForDate(todayStr, function(timings) {
    prayerTimings = timings;
    prayerFetchedDate = dateKey;
    prayerNotifiedToday = {}; // new day — reset notifications
    updatePrayerWidget();
    // Also fetch tomorrow for accurate after-Isha Fajr countdown
    var tmrw = new Date(dubai.getTime() + 86400000);
    fetchTimingsForDate(dubaiDateStr(tmrw), function(t) { prayerTimingsTmrw = t; });
  });
}

fetchPrayerTimes();
setInterval(function() { updatePrayerWidget(); checkPrayerAlert(); }, 1000);

// ── Eid Takbeer scheduler ──────────────────────────────
// Plays takbeer.mp3 twice in a row every 15 minutes (Dubai time),
// from TAKBEER_START to TAKBEER_END inclusive, skipping any slot
// that overlaps with the azan / a prayer time (±5..+10 min window).
var TAKBEER_START = "2026-05-25";
var TAKBEER_END   = "2026-05-30";
var TAKBEER_INTERVAL_MIN = 15;
var takbeerAudio = null;
var takbeerPlaying = false;
var takbeerPlayCount = 0;
var takbeerLastTrigger = "";

function getTakbeerAudio() {
  if (!takbeerAudio) takbeerAudio = document.getElementById("takbeerAudio");
  return takbeerAudio;
}

function showTakbeerBanner() {
  var el = document.getElementById("takbeerBanner");
  if (el) el.className = "takbeer-popup is-visible";
}
function hideTakbeerBanner() {
  var el = document.getElementById("takbeerBanner");
  if (el) el.className = "takbeer-popup";
}

function isAzanBusy() {
  var azan = getAzanAudio();
  if (azan && !azan.paused) return true;
  if (!prayerTimings) return false;
  var now = getDubaiNow();
  var nowMins = now.getHours() * 60 + now.getMinutes();
  // takbeer cycle ~8 min + azan ~4 min — block slots within -5..+10 of a prayer
  for (var i = 0; i < PRAYER_ORDER.length; i++) {
    var pm = prayerToMinutes(prayerTimings[PRAYER_ORDER[i]]);
    var diff = pm - nowMins;
    if (diff >= -5 && diff <= 10) return true;
  }
  return false;
}

function playTakbeer() {
  if (takbeerPlaying) return;
  var audio = getTakbeerAudio();
  if (!audio) return;
  takbeerPlaying = true;
  takbeerPlayCount = 0;
  showTakbeerBanner();
  function playOnce() {
    try { audio.currentTime = 0; } catch(e) {}
    try { audio.play(); } catch(e) {}
  }
  audio.onended = function() {
    takbeerPlayCount++;
    if (takbeerPlayCount < 1) {
      playOnce();
    } else {
      takbeerPlaying = false;
      hideTakbeerBanner();
    }
  };
  playOnce();
}

function checkTakbeerSchedule() {
  var now = getDubaiNow();
  // ISO YYYY-MM-DD for date-range compare (dubaiDateStr returns DD-MM-YYYY for the Aladhan API)
  var yyyy = now.getFullYear();
  var mm = now.getMonth() + 1; if (mm < 10) mm = "0" + mm;
  var dd = now.getDate();      if (dd < 10) dd = "0" + dd;
  var dateKey = yyyy + "-" + mm + "-" + dd;
  if (dateKey < TAKBEER_START || dateKey > TAKBEER_END) return;
  // Only between 09:00 and 20:00 (Dubai). Last slot 20:00 inclusive.
  var h = now.getHours();
  var m = now.getMinutes();
  var minsOfDay = h * 60 + m;
  if (minsOfDay < 9 * 60 || minsOfDay > 20 * 60) return;
  var s = now.getSeconds();
  if (m % TAKBEER_INTERVAL_MIN !== 0) return;
  if (s > 5) return;
  var triggerKey = dateKey + " " + now.getHours() + ":" + m;
  if (takbeerLastTrigger === triggerKey) return;
  if (takbeerPlaying) return;
  if (isAzanBusy()) {
    takbeerLastTrigger = triggerKey; // skip — let azan run
    return;
  }
  takbeerLastTrigger = triggerKey;
  playTakbeer();
}

setInterval(checkTakbeerSchedule, 1000);

setInterval(fetchPrayerTimes, 60000);

var POLL_MS = 1000;
var SYMBOLS = ["XAU", "XAG"];
var CHART_COLORS = {
  XAU: { line: "#e8b931", fill: "232, 185, 49" },
  XAG: { line: "#a8b8d0", fill: "168, 184, 208" },
};

// Real-time prices from the FIX gateway (1Hz). No synthetic noise — every
// displayed value comes from a live Integral OCX quote.
var serverPrices = {};   // last price from server
var serverBidAsk = {};   // last bid/ask from server
var prevServerPrice = {}; // previous server price, for flash-up/down direction
var lastData = null;
var marketOpen = true;    // track market status — freeze indicators when closed
var lastFetchTime = null;
var chartDataCache = {};

// ── Clock ──────────────────────────────────────────────
function tickClock() {
  var now = new Date();
  var time = now.toLocaleTimeString("en-US", {
    hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  var date = now.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
  var tEl = document.getElementById("clockTime");
  var dEl = document.getElementById("clockDate");
  if (tEl) tEl.textContent = time;
  if (dEl) dEl.textContent = date;
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

// updatePriceCell — render one symbol's price cell from a real server tick,
// with a brief flash-up/down animation on the direction of change. Called
// from applyData on every successful /api/prices response (1Hz).
function updatePriceCell(sym, price) {
  if (price == null || isNaN(price)) return;
  var el = document.getElementById("price-" + sym);
  if (!el) return;
  el.textContent = "$" + fmt(price, 3);
  var prev = prevServerPrice[sym];
  if (prev != null && Math.abs(price - prev) > 0.0001) {
    el.classList.remove("flash-up", "flash-down");
    el.offsetHeight; // force reflow so the animation re-triggers
    el.classList.add(price > prev ? "flash-up" : "flash-down");
    (function(e) {
      setTimeout(function() { e.classList.remove("flash-up", "flash-down"); }, 400);
    })(el);
  }
  prevServerPrice[sym] = price;
}

// smoothSeries — light moving-average smoothing over the price series.
//
// Why: even after suppressOutliers removes single-tick glitches, the
// chart can still show jagged "staircase" patterns caused by 2-5 point
// bursts (UAT feed occasionally produces a short cluster of off-market
// prices). A 3-point centered moving average flattens those bursts
// while preserving multi-tick legitimate moves (the average lags by
// at most one tick).
//
// First and last points are kept as-is so the head/tail of the chart
// shows the actual current price (important for the user — they're
// looking at "current state", not a smoothed history).
function smoothSeries(arr) {
  if (!arr || arr.length < 3) return arr.slice();
  var out = arr.slice();
  for (var i = 1; i < arr.length - 1; i++) {
    out[i] = (arr[i - 1] + arr[i] + arr[i + 1]) / 3;
  }
  return out;
}

// suppressOutliers — removes single-tick spikes from a price series.
//
// We use a robust statistics approach: compute the median absolute
// deviation (MAD) of the difference series, then flag any point whose
// jump from BOTH neighbours exceeds K * MAD. K=8 is intentionally loose
// — we don't want to smooth over real fast moves (e.g., a 30-second
// 0.3% lurch on gold), only the protocol-level glitches that show up
// as a single point thousands of pips away.
//
// Replacement is linear interpolation between the two neighbours so the
// chart line stays continuous. Endpoints are never replaced (no neighbours
// to interpolate from) — if the very last tick is a glitch, the user
// will see it briefly until the next tick lands, which is acceptable.
function suppressOutliers(arr) {
  if (!arr || arr.length < 5) return arr.slice();
  var out = arr.slice();
  // First-order differences |x[i] - x[i-1]|.
  var diffs = [];
  for (var i = 1; i < out.length; i++) {
    diffs.push(Math.abs(out[i] - out[i - 1]));
  }
  // Median absolute deviation of diffs — robust to outliers themselves.
  var sortedDiffs = diffs.slice(0).sort(function(a, b) { return a - b; });
  var median = sortedDiffs[Math.floor(sortedDiffs.length / 2)];
  // If the series is constant or near-constant, no outliers to find.
  if (!median || median < 1e-9) return out;
  var threshold = median * 8;

  for (var j = 1; j < out.length - 1; j++) {
    var prev = out[j - 1];
    var next = out[j + 1];
    var cur = out[j];
    var jumpPrev = Math.abs(cur - prev);
    var jumpNext = Math.abs(cur - next);
    // Both sides must show an unusually large jump — that's the signature
    // of a single-point spike. A real move would only have ONE large jump
    // (entry into the new level), the other being normal.
    if (jumpPrev > threshold && jumpNext > threshold) {
      out[j] = (prev + next) / 2;
    }
  }
  return out;
}

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

  // Outlier suppression. Single-tick spikes in the history (upstream feed
  // glitches) produce a tall narrow tower on the chart that doesn't reflect
  // what actually happened in the market. We replace such points with the
  // linear interpolation of their neighbours. Legitimate fast moves persist
  // across multiple ticks and are preserved.
  values = suppressOutliers(values);
  // Light smoothing on top. suppressOutliers catches lone spikes; this
  // catches short 2-5 point bursts that the outlier filter leaves alone
  // (because the burst's neighbours are themselves spiky, so MAD-based
  // detection is fooled). A 3-point moving average lags by at most one
  // tick and produces visibly cleaner lines for the dashboard use case.
  values = smoothSeries(values);

  // P5-P95 percentile Y-axis: one outlier won't compress the rest of the chart.
  // Values outside the range are clamped visually; tooltips still show real prices.
  var sorted = values.slice(0).sort(function(a, b) { return a - b; });
  var p5idx  = Math.max(0, Math.floor(sorted.length * 0.05));
  var p95idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  var dataRange = sorted[p95idx] - sorted[p5idx] || 1;
  var minRange = symbol === "XAU" ? 40 : 1.5;
  var range = Math.max(dataRange, minRange);
  var mid = (sorted[p5idx] + sorted[p95idx]) / 2;
  var min = mid - range / 2;
  var max = mid + range / 2;

  var pad = { t: 16, b: 28, l: 8, r: 8 };
  var cW = W - pad.l - pad.r;
  var cH = H - pad.t - pad.b;
  var xStep = cW / (values.length - 1);

  function toX(idx) { return pad.l + idx * xStep; }
  function toY(v) { var c = v < min ? min : v > max ? max : v; return pad.t + cH - ((c - min) / range) * cH; }

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
  // The pulsing endpoint dot is pinned to the right edge (x = W - pad.r) and
  // is painted *after* these labels, so whenever the latest price sits near
  // the top or bottom of the range the dot lands straight on top of a
  // right-aligned label and hides the number. Flip only the label it would
  // collide with over to the left edge instead.
  var endLabelY = values.length ? toY(values[values.length - 1]) : -999;
  function drawRangeLabel(text, ly) {
    var collides = Math.abs(ly - endLabelY) < 16; // dot glow (<=10) + text half-height
    ctx.textAlign = collides ? "left" : "right";
    ctx.fillText(text, collides ? pad.l + 4 : W - 4, ly);
  }
  drawRangeLabel(max.toFixed(3), pad.t + 4);
  drawRangeLabel(min.toFixed(3), H - pad.b - 4);

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

  // Day labels — render with a minimum-pixel-distance guard so that days
  // close together on the X axis (common when the history has uneven
  // coverage across the week) don't overlap into unreadable "FMonTue".
  // We greedy-keep the leftmost label and drop any subsequent label
  // whose center is within MIN_PX of the previous one we kept.
  var dayLabels = getDayLabels(timestamps, values.length);
  if (dayLabels.length) {
    ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
    ctx.font = "600 11px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // The first day's marker sits at x = pad.l, so a centred label used to
    // spill past the left edge and render clipped ("Mon" showing as "on").
    // Clamp every label fully inside the plot area, and space them by their
    // measured width instead of a fixed guess so wider labels never touch.
    var lastDrawnRight = -Infinity;
    for (var d = 0; d < dayLabels.length; d++) {
      var xPos = toX(dayLabels[d].idx);
      var halfW = ctx.measureText(dayLabels[d].label).width / 2;
      var drawX = Math.min(Math.max(xPos, pad.l + halfW), W - pad.r - halfW);
      if (drawX - halfW < lastDrawnRight + 8) continue; // 8px breathing room
      ctx.fillText(dayLabels[d].label, drawX, H - pad.b + 8);
      lastDrawnRight = drawX + halfW;
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
  // A 7-day window can open and close on the same weekday (Mon 17 ... Mon 24),
  // which renders as two identical "Mon" labels with no way to tell them
  // apart. Add the day of the month to just those; unique weekdays stay short.
  var counts = {};
  for (var c = 0; c < result.length; c++) {
    counts[result[c].label] = (counts[result[c].label] || 0) + 1;
  }
  for (var m = 0; m < result.length; m++) {
    if (counts[result[m].label] > 1) {
      result[m].label += " " + timestamps[last7[m].idx].getDate();
    }
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

    updatePriceCell(sym, p.price);

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

    // Spread is ask - bid. This used to render dayHigh - dayLow, i.e. the
    // *width of the day's range* - a duplicate of the RANGE field sitting
    // right next to it, shown under the wrong label.
    var spreadEl = document.getElementById("spread-" + sym);
    if (spreadEl && p.ask != null && p.bid != null) {
      spreadEl.textContent = "$" + fmt(p.ask - p.bid, 3);
    }

    // High-Low: the width of the day's range, i.e. how far the metal has
    // travelled today. RANGE next to it shows the two bounds themselves.
    var hlEl = document.getElementById("hl-" + sym);
    if (hlEl && p.dayHigh != null && p.dayLow != null) {
      hlEl.textContent = "$" + fmt(p.dayHigh - p.dayLow, 3);
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

// ── ?debug=1 — on-screen viewport readout ───────────────
// Lets us see what CSS viewport a TV actually reports, so layout//font
// breakpoints can be tuned to the real device instead of guessed.
try {
  if (String(window.location.search).indexOf("debug") >= 0) {
    var dbgBox = document.createElement("div");
    dbgBox.style.cssText =
      "position:fixed;left:10px;bottom:10px;z-index:99999;" +
      "background:rgba(0,0,0,0.85);color:#0f0;font:16px monospace;" +
      "padding:8px 12px;border:1px solid #0f0;border-radius:4px;";
    var dbgUpdate = function() {
      dbgBox.innerHTML =
        "CSS viewport: " + window.innerWidth + " x " + window.innerHeight + "<br>" +
        "devicePixelRatio: " + (window.devicePixelRatio || 1) + "<br>" +
        "screen: " + screen.width + " x " + screen.height + "<br>" +
        "2-col active: " + (window.innerWidth > 700 ? "YES" : "no");
    };
    dbgUpdate();
    setInterval(dbgUpdate, 2000);
    document.body.appendChild(dbgBox);
  }
} catch (e) {}


// -- Market news ticker ----------------------------------
// Yahoo's RSS feed carries no CORS header, so the page cannot read it
// directly. A cron job on the host (scripts/fetch-news.py) republishes the
// headlines as same-origin /news.json, which is what we poll here.
var NEWS_URL = "/news.json";
var NEWS_REFRESH_MS = 600000;  // 10 min - matches the cron cadence
var TICKER_PX_PER_SEC = 55;    // reading speed, independent of headline count

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildTicker(items) {
  var bar = document.getElementById("ticker");
  var track = document.getElementById("tickerTrack");
  if (!bar || !track || !items.length) return;

  var html = "";
  for (var pass = 0; pass < 2; pass++) {       // two copies -> seamless loop
    for (var i = 0; i < items.length; i++) {
      html += '<span class="ticker__item"><i class="ticker__dot"></i>' +
              escapeHtml(items[i].title) + "</span>";
    }
  }
  track.innerHTML = html;
  bar.className = "ticker is-ready";

  var half = track.offsetWidth / 2;
  var dur = Math.max(20, Math.round(half / TICKER_PX_PER_SEC));
  track.style.animationDuration = dur + "s";
  track.style.webkitAnimationDuration = dur + "s";
}

function fetchNews() {
  var xhr = new XMLHttpRequest();
  // Cache-buster: TV browsers hold on to static files aggressively.
  xhr.open("GET", NEWS_URL + "?t=" + Date.now(), true);
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== 4 || xhr.status !== 200) return;
    try {
      var data = JSON.parse(xhr.responseText);
      if (data && data.items && data.items.length) buildTicker(data.items);
    } catch (e) {}   // on any failure keep whatever is already scrolling
  };
  xhr.send();
}

fetchNews();
setInterval(fetchNews, NEWS_REFRESH_MS);
