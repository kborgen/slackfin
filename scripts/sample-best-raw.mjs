#!/usr/bin/env node
/* ---------------------------------------------------------------
   sample-best-raw

   Measures how `bestRaw` — the maximum raw score across a 42-hour
   window — actually distributes across real historical days at Fox
   Island Pier, so DECENT_RAW can be set from data instead of guessed.

   Run:  npm run sample:best-raw

   Writes scripts/best-raw-sample.json and scripts/best-raw-report.md.
   It does NOT modify DECENT_RAW. Read the report, then make that edit
   deliberately.

   ---- on the two APIs ----

   NOAA tide predictions are astronomical, not observational, so the
   same datagetter endpoint the app uses in fetchTide serves any past
   date with no change in parameters. Station fallback logic mirrors
   fetchTide: Tacoma first, Seattle if Tacoma errors.

   Open-Meteo weather is the part that differs from the live app.
   The forecast endpoint (api.open-meteo.com/v1/forecast) does not
   retain past forecasts, so this script uses the separate ERA5 archive
   endpoint (archive-api.open-meteo.com/v1/archive). Same response
   shape, no key, but note two real differences, which are expected
   behavior and not bugs:
     - It takes explicit start_date/end_date rather than forecast_days.
     - It trails real time by roughly 2 to 5 days, so the sample window
       stops ARCHIVE_LAG_DAYS short of today.
   Archive values are reanalysis, meaning they are the best estimate of
   what actually happened, whereas the live app scores against a
   forecast. For calibrating a threshold on the distribution of bestRaw
   that difference is not material, but it is the reason these numbers
   will not reproduce a specific remembered day exactly.

   ---- on fidelity to the live pipeline ----

   Each sampled date requests the identical window the app would:
   NOAA begin_date=YYYYMMDD&range=42 and archive start_date=date
   through date+2, matching forecast_days=3 from local midnight. That
   means the first few hours of each window hit the same idx-3 pressure
   lookback clamp the live app hits, and the raw math is imported from
   src/scoring.js rather than reimplemented. What is measured here is
   what the app computes.
------------------------------------------------------------------ */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeRawPoints,
  parseWallClock,
  toNOAADateStr,
  moonPhase,
  DECENT_RAW,
} from "../src/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/* Kept in sync with App.jsx by hand — these are deployment facts, not
   scoring math, so they do not belong in src/scoring.js. */
const STATIONS = {
  primary: { id: "9446484", name: "Tacoma" },
  fallback: { id: "9447130", name: "Seattle" },
};
const SITE = { name: "Fox Island Pier", lat: 47.2286, lon: -122.5898 };

const SAMPLE_COUNT = 60;
const STEP_DAYS = 6;      // see pickDates below for why 6 and not 7
const ARCHIVE_LAG_DAYS = 7;
const REQUEST_DELAY_MS = 400;
const DAY_MS = 86400000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Dates are handled in the app's "pseudo ms" frame: the local wall
   clock read as if it were UTC. Every getUTC* call below is deliberate. */
function toISODate(pseudoMs) {
  const d = new Date(pseudoMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function pacificTodayPseudo() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day);
}

/* Walk backward in 6-day steps rather than taking the last 60 days.
   Consecutive days share a weather system and a tide state, so they
   would collapse the sample onto one season and one point in the
   lunar cycle. A 6-day step covers 360 days, and because 6 divides
   into the 29.53-day synodic month unevenly (0.203 of a cycle per
   step) it precesses through every moon phase instead of aliasing
   onto one. Spring/neap coverage is verified in the report. */
function pickDates() {
  const end = pacificTodayPseudo() - ARCHIVE_LAG_DAYS * DAY_MS;
  const dates = [];
  for (let i = 0; i < SAMPLE_COUNT; i++) dates.push(end - i * STEP_DAYS * DAY_MS);
  return dates.reverse();
}

/* Retries only what is worth retrying. A 400 from Open-Meteo means the date
   is outside archive coverage and will never succeed, and its body carries a
   better explanation than the status code, so it is surfaced verbatim into
   the skipped-days table. */
async function getJSON(url, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const reason = await res.json().then((b) => b?.reason).catch(() => null);
        const err = new Error(reason ? `HTTP ${res.status}, ${reason}` : `HTTP ${res.status}`);
        err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
        throw err;
      }
      return await res.json();
    } catch (e) {
      if (attempt === 1 || e.permanent) throw new Error(`${label}: ${e.message}`);
      await sleep(1000);
    }
  }
}

/* Mirrors fetchTide in App.jsx, minus the hilo call the raw math never reads. */
async function fetchTideCurve(pseudoMs) {
  const beginDateStr = toNOAADateStr(pseudoMs);
  const build = (id) =>
    `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${id}&product=predictions&datum=MLLW&time_zone=lst_ldt&units=english&format=json&begin_date=${beginDateStr}&range=42`;

  let station = STATIONS.primary;
  let data;
  try {
    data = await getJSON(build(STATIONS.primary.id), "NOAA primary");
    if (data.error) throw new Error(data.error.message || "NOAA error");
  } catch {
    station = STATIONS.fallback;
    data = await getJSON(build(STATIONS.fallback.id), "NOAA fallback");
    if (data.error) throw new Error(data.error.message || "NOAA error");
  }
  if (!data.predictions?.length) throw new Error("NOAA returned no predictions");

  const curve = data.predictions.map((p) => ({ t: parseWallClock(p.t), v: parseFloat(p.v) }));
  if (curve.some((p) => !Number.isFinite(p.v))) throw new Error("NOAA curve contains non-numeric heights");
  return { curve, station };
}

/* ERA5 archive. start_date..date+2 reproduces forecast_days=3. */
async function fetchArchiveWeather(pseudoMs) {
  const start = toISODate(pseudoMs);
  const end = toISODate(pseudoMs + 2 * DAY_MS);
  const url =
    `https://archive-api.open-meteo.com/v1/archive?latitude=${SITE.lat}&longitude=${SITE.lon}` +
    `&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation` +
    `&daily=sunrise,sunset&timezone=America%2FLos_Angeles&start_date=${start}&end_date=${end}` +
    `&wind_speed_unit=mph&temperature_unit=fahrenheit`;

  const wx = await getJSON(url, "Open-Meteo archive");
  if (wx.error) throw new Error(wx.reason || "archive error");

  // Gaps are reported, never interpolated. computeRawPoints would happily
  // treat a null pressure as a 0 hPa delta and quietly skew bestRaw.
  const h = wx.hourly;
  if (!h?.time?.length) throw new Error("archive returned no hourly data");
  const nullPressure = (h.pressure_msl || []).filter((v) => v == null).length;
  const nullWind = (h.wind_speed_10m || []).filter((v) => v == null).length;
  if (nullPressure) throw new Error(`archive missing ${nullPressure}/${h.time.length} pressure_msl values`);
  if (nullWind) throw new Error(`archive missing ${nullWind}/${h.time.length} wind_speed_10m values`);
  if (!wx.daily?.sunrise?.length || !wx.daily?.sunset?.length) throw new Error("archive missing sunrise/sunset");

  return wx;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return NaN;
  const idx = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function seasonOf(pseudoMs) {
  const m = new Date(pseudoMs).getUTCMonth();
  if (m <= 1 || m === 11) return "winter";
  if (m <= 4) return "spring";
  if (m <= 7) return "summer";
  return "fall";
}

function histogram(values, buckets = 10) {
  const min = Math.min(...values), max = Math.max(...values);
  const width = (max - min) / buckets || 1;
  const counts = new Array(buckets).fill(0);
  for (const v of values) {
    const i = Math.min(buckets - 1, Math.floor((v - min) / width));
    counts[i]++;
  }
  return counts.map((count, i) => ({
    lo: min + i * width,
    hi: min + (i + 1) * width,
    count,
  }));
}

async function main() {
  const dates = pickDates();
  console.log(`Sampling ${dates.length} days from ${toISODate(dates[0])} to ${toISODate(dates[dates.length - 1])}`);
  console.log(`Step ${STEP_DAYS}d, archive lag allowance ${ARCHIVE_LAG_DAYS}d, ~${REQUEST_DELAY_MS}ms between days\n`);

  const samples = [];
  const skipped = [];

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const iso = toISODate(date);
    const label = `[${String(i + 1).padStart(2)}/${dates.length}] ${iso}`;
    try {
      const { curve, station } = await fetchTideCurve(date);
      const wx = await fetchArchiveWeather(date);

      const points = computeRawPoints(curve, wx);
      const bestRaw = Math.max(...points.map((p) => p.raw));

      const heights = curve.map((p) => p.v);
      const tideRangeFt = Math.max(...heights) - Math.min(...heights);
      // Noon of the sampled day is representative enough for a label that
      // only distinguishes spring from neap.
      const { phase } = moonPhase(date + 12 * 3600000);
      const moonDist = Math.min(phase, Math.abs(phase - 0.5), 1 - phase);

      samples.push({
        date: iso,
        bestRaw: +bestRaw.toFixed(4),
        tideRangeFt: +tideRangeFt.toFixed(2),
        moonPhase: +phase.toFixed(3),
        moonDistToSyzygy: +moonDist.toFixed(3),
        tideState: moonDist < 0.125 ? "spring" : "neap",
        season: seasonOf(date),
        station: station.name,
        curvePoints: curve.length,
      });
      console.log(`${label}  bestRaw ${bestRaw.toFixed(4)}  range ${tideRangeFt.toFixed(1)}ft  ${moonDist < 0.125 ? "spring" : "neap"}  ${station.name}`);
    } catch (e) {
      skipped.push({ date: iso, reason: e.message });
      console.log(`${label}  SKIPPED — ${e.message}`);
    }
    if (i < dates.length - 1) await sleep(REQUEST_DELAY_MS);
  }

  if (!samples.length) {
    console.error("\nNo days were sampled successfully. Nothing written.");
    process.exit(1);
  }

  const values = samples.map((s) => s.bestRaw).sort((a, b) => a - b);
  const pct = {
    p10: +percentile(values, 10).toFixed(4),
    p25: +percentile(values, 25).toFixed(4),
    p40: +percentile(values, 40).toFixed(4),
    p50: +percentile(values, 50).toFixed(4),
    p75: +percentile(values, 75).toFixed(4),
  };
  const bins = histogram(values);
  const byDate = [...samples].sort((a, b) => a.bestRaw - b.bestRaw);

  const meta = {
    generatedAt: new Date().toISOString(),
    site: SITE.name,
    stations: STATIONS,
    windowHours: 42,
    requested: dates.length,
    sampled: samples.length,
    skipped: skipped.length,
    stepDays: STEP_DAYS,
    archiveLagDays: ARCHIVE_LAG_DAYS,
    decentRawAtSampleTime: DECENT_RAW,
    weatherSource: "Open-Meteo ERA5 archive (archive-api.open-meteo.com), not the live forecast endpoint",
    tideSource: "NOAA CO-OPS datagetter predictions, same endpoint and params as the app",
  };

  writeFileSync(
    join(HERE, "best-raw-sample.json"),
    JSON.stringify({ meta, percentiles: pct, samples, skipped }, null, 2) + "\n"
  );

  /* ---- report ---- */
  const maxCount = Math.max(...bins.map((b) => b.count));
  const barFor = (c) => "#".repeat(Math.round((c / maxCount) * 40));
  const belowDecent = values.filter((v) => v < DECENT_RAW).length;

  const seasons = ["winter", "spring", "summer", "fall"];
  const seasonRows = seasons.map((s) => {
    const vs = samples.filter((x) => x.season === s).map((x) => x.bestRaw).sort((a, b) => a - b);
    return { s, n: vs.length, median: vs.length ? +percentile(vs, 50).toFixed(4) : null };
  });
  const tideRows = ["spring", "neap"].map((s) => {
    const vs = samples.filter((x) => x.tideState === s).map((x) => x.bestRaw).sort((a, b) => a - b);
    return { s, n: vs.length, median: vs.length ? +percentile(vs, 50).toFixed(4) : null };
  });

  const md = `# bestRaw historical sample

Generated ${meta.generatedAt} by \`scripts/sample-best-raw.mjs\`.
Regenerate with \`npm run sample:best-raw\`.

${samples.length} of ${dates.length} sampled days succeeded${skipped.length ? `, ${skipped.length} skipped` : ""}. Each day is a 42-hour
window from local midnight, scored with \`computeRawPoints\` from \`src/scoring.js\`,
which is the same function the app runs. Tides come from NOAA predictions on the
endpoint the app uses. Weather comes from the Open-Meteo ERA5 archive rather than
the live forecast endpoint, because past forecasts are not retained. Archive values
are reanalysis, so a given day will not reproduce exactly what the app showed at
the time. The distribution is what matters here.

## Recommendation

**25th percentile bestRaw = ${pct.p25}, current DECENT_RAW = ${DECENT_RAW}**

${pct.p25 > DECENT_RAW
  ? `The floor sits below the 25th percentile, so it engages on fewer than a quarter of days. ${belowDecent} of ${values.length} sampled days (${Math.round((belowDecent / values.length) * 100)}%) fell under it.`
  : `The floor sits above the 25th percentile, so it engages on more than a quarter of days. ${belowDecent} of ${values.length} sampled days (${Math.round((belowDecent / values.length) * 100)}%) fell under it.`}

Not applied automatically. Change \`DECENT_RAW\` in \`src/scoring.js\` deliberately.

## Percentiles

| percentile | bestRaw |
| --- | --- |
| 10th | ${pct.p10} |
| 25th | ${pct.p25} |
| 40th | ${pct.p40} |
| 50th (median) | ${pct.p50} |
| 75th | ${pct.p75} |

Min ${values[0]}, max ${values[values.length - 1]}, mean ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(4)}.

## Distribution

\`\`\`
${bins.map((b) => `${b.lo.toFixed(3)} - ${b.hi.toFixed(3)}  ${String(b.count).padStart(3)}  ${barFor(b.count)}`).join("\n")}
\`\`\`

## Coverage

Confirms the sample is not concentrated in one season or one part of the lunar cycle.

| season | days | median bestRaw |
| --- | --- | --- |
${seasonRows.map((r) => `| ${r.s} | ${r.n} | ${r.median ?? "n/a"} |`).join("\n")}

| tide state | days | median bestRaw |
| --- | --- | --- |
${tideRows.map((r) => `| ${r.s} | ${r.n} | ${r.median ?? "n/a"} |`).join("\n")}

## All days, ascending by bestRaw

| date | bestRaw | tide range (ft) | tide state | season | station |
| --- | --- | --- | --- | --- | --- |
${byDate.map((s) => `| ${s.date} | ${s.bestRaw} | ${s.tideRangeFt} | ${s.tideState} | ${s.season} | ${s.station} |`).join("\n")}

## Skipped days

${skipped.length
  ? `${skipped.length} day(s) had missing or erroring source data and were dropped rather than filled in.\n\n| date | reason |\n| --- | --- |\n${skipped.map((s) => `| ${s.date} | ${s.reason} |`).join("\n")}`
  : "None. Every sampled day returned complete tide and weather data."}
`;

  writeFileSync(join(HERE, "best-raw-report.md"), md);

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Sampled ${samples.length}/${dates.length} days${skipped.length ? `, skipped ${skipped.length}` : ""}`);
  console.log(`p10 ${pct.p10}  p25 ${pct.p25}  p40 ${pct.p40}  median ${pct.p50}  p75 ${pct.p75}`);
  console.log(`min ${values[0]}  max ${values[values.length - 1]}`);
  console.log("");
  console.log(`RECOMMENDATION: 25th percentile bestRaw = ${pct.p25}, current DECENT_RAW = ${DECENT_RAW}`);
  console.log(`${belowDecent}/${values.length} sampled days fall below the current floor.`);
  console.log("Not applied. Update DECENT_RAW in src/scoring.js as a separate deliberate edit.");
  console.log(`${"=".repeat(64)}`);
  console.log("\nWrote scripts/best-raw-sample.json and scripts/best-raw-report.md");
}

main().catch((e) => {
  console.error("\nFailed:", e.message);
  process.exit(1);
});
