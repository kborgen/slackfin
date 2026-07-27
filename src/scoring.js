/* ---------------------------------------------------------------
   slackfin scoring core

   Pure, dependency-free helpers shared by the app (src/App.jsx) and
   the offline analysis scripts (scripts/). Nothing in here may touch
   React, the DOM, or import.meta.env — scripts/sample-best-raw.mjs
   imports this file directly under plain Node.

   The normalization step that turns `raw` into the 0-100 score lives
   in buildSeries in App.jsx. Only the raw math lives here, so the
   calibration script measures exactly what the app computes.
------------------------------------------------------------------ */

/* NOAA and Open-Meteo are both asked for local time, and the app works
   in "pseudo ms": the wall clock read as if it were UTC. That keeps
   every comparison in one frame regardless of the viewer's timezone. */
export function parseWallClock(str) {
  const clean = str.replace("T", " ");
  const [datePart, timePart] = clean.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = (timePart || "00:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm || 0);
}

export function toNOAADateStr(pseudoMs) {
  const d = new Date(pseudoMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

/* ---------------- moon phase (no API needed) ---------------- */

export function moonPhase(pseudoMs) {
  const synodic = 29.530588853;
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14, 0);
  const diffDays = (pseudoMs - knownNewMoon) / 86400000;
  let phase = (diffDays % synodic) / synodic;
  if (phase < 0) phase += 1;
  const illumination = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  let name;
  if (phase < 0.03 || phase > 0.97) name = "New Moon";
  else if (phase < 0.22) name = "Waxing Crescent";
  else if (phase < 0.28) name = "First Quarter";
  else if (phase < 0.47) name = "Waxing Gibbous";
  else if (phase < 0.53) name = "Full Moon";
  else if (phase < 0.72) name = "Waning Gibbous";
  else if (phase < 0.78) name = "Last Quarter";
  else name = "Waning Crescent";
  const emojiMap = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
  const idx = Math.round(phase * 8) % 8;
  return { phase, illumination, name, emoji: emojiMap[idx] };
}

/* Below this, the whole 42h window is genuinely flat and we stop grading
   on a curve — otherwise every day's peak would read as excellent.
   This is the one tuning knob in the model. Run
   `npm run sample:best-raw` to see how it sits against the historical
   distribution of bestRaw before changing it. */
export const DECENT_RAW = 0.58;

/* First pass of the scoring model: everything that depends only on this
   day's own tide and weather, with no reference to the rest of the window.
   Returns one point per tide sample carrying `raw` plus the fields the UI
   and the Claude prompt read. buildSeries normalizes `raw` into `score`. */
export function computeRawPoints(curve, wx) {
  const n = curve.length;
  const rates = curve.map((p, i) => {
    const prev = curve[Math.max(0, i - 2)];
    const next = curve[Math.min(n - 1, i + 2)];
    const dtHrs = (next.t - prev.t) / 3600000;
    return dtHrs > 0 ? (next.v - prev.v) / dtHrs : 0;
  });
  const maxAbsRate = Math.max(...rates.map((r) => Math.abs(r)), 0.01);

  const sunEvents = [];
  (wx.daily?.sunrise || []).forEach((s) => sunEvents.push(parseWallClock(s)));
  (wx.daily?.sunset || []).forEach((s) => sunEvents.push(parseWallClock(s)));

  const wxTimes = (wx.hourly?.time || []).map(parseWallClock);
  const findWxIdx = (t) => {
    let bestI = 0, bestDiff = Infinity;
    for (let i = 0; i < wxTimes.length; i++) {
      const diff = Math.abs(wxTimes[i] - t);
      if (diff < bestDiff) { bestDiff = diff; bestI = i; }
    }
    return bestI;
  };

  return curve.map((p, i) => {
    const rate = rates[i];
    const normRate = Math.min(Math.abs(rate) / maxAbsRate, 1);
    const movement = normRate * (rate < 0 ? 1 : 0.7);

    let minDist = Infinity;
    for (const ev of sunEvents) {
      const d = Math.abs(p.t - ev) / 60000;
      if (d < minDist) minDist = d;
    }
    const lightBonus = minDist <= 120 ? Math.pow(1 - minDist / 120, 0.7) : 0;

    const idx = findWxIdx(p.t);
    const pressureNow = wx.hourly?.pressure_msl?.[idx] ?? null;
    const idxPrev = Math.max(0, idx - 3);
    const pressureDelta = pressureNow != null ? pressureNow - wx.hourly.pressure_msl[idxPrev] : 0;
    const pressureFactor = pressureDelta <= -1 ? 1 : pressureDelta >= 2 ? -1 : 0.65;
    const windSpeed = wx.hourly?.wind_speed_10m?.[idx] ?? 0;
    const windFactor = windSpeed > 18 ? Math.min((windSpeed - 18) / 12, 1) : 0;

    // Distance to the nearest new or full moon, 0 at either, 0.25 at a quarter.
    const moon = moonPhase(p.t);
    const moonDist = Math.min(moon.phase, Math.abs(moon.phase - 0.5), 1 - moon.phase);
    const moonBonus = Math.pow(1 - moonDist / 0.25, 0.8);

    const raw =
      0.1 +
      0.4 * movement +
      0.2 * lightBonus +
      0.15 * Math.max(pressureFactor, 0) +
      (pressureFactor < 0 ? pressureFactor * 0.15 : 0) +
      0.05 * moonBonus -
      0.15 * windFactor;

    return { ...p, raw, rate, windSpeed, pressureNow, pressureDelta };
  });
}
