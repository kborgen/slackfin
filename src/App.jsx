import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Fish, Wind, Moon, Waves, Gauge, Sunrise, Sunset, Thermometer, Info, Loader2,
  ChevronDown, ChevronUp, Plus, Trash2, X, MapPin, RefreshCw
} from "lucide-react";
import { supabase } from "./supabaseClient";

/* ---------------------------------------------------------------
   slackfin
   A tide + weather + AI reasoning tool for Fox Island Pier,
   Marine Area 13, South Puget Sound.

   Data sources:
   - NOAA CO-OPS (tide predictions + observed water temperature)
   - Open-Meteo (weather)
   - Claude (plain-language read of conditions)

   Everything lives in the browser. Catch log is saved with the
   artifact's personal storage, so it is private to you and
   sticks around between visits.
------------------------------------------------------------------ */

// Tide predictions need a NOAA Reference (harmonic) station to get the 6-minute
// curve the chart draws. Tacoma is the nearest one to Fox Island (~7 mi) and
// also serves observed water temperature; Seattle is the reliable backup. The
// nearer stations on Hale Passage are subordinate stations that only publish
// high/low offsets, not the continuous curve, so they can't be primaries here.
const STATIONS = {
  primary: { id: "9446484", name: "Tacoma" },
  fallback: { id: "9447130", name: "Seattle" },
};

const SITE = { name: "Fox Island Pier", lat: 47.2286, lon: -122.5898 };

const THEME = {
  ink: "#1F2B2E",
  paper: "#E4F5FB",
  paperDeep: "#CBE7F1",
  line: "#A7CBD1",
  tide: "#5EB1BF",
  bite: "#EF7B45",
  kelp: "#3D7A6E",
  slack: "#6C8A8C",
  slackDeep: "#3F5254",
  white: "#FAFEFF",
};

const FONT_IMPORT =
  "@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,wght@0,400;0,500;0,600;1,500&family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap');";

/* ---------------- time helpers ----------------
   NOAA and Open-Meteo are both requested in Pacific local time.
   We treat every timestamp as a "wall clock" value and store it
   as if it were UTC milliseconds, so comparisons stay simple no
   matter what timezone the viewer's browser is in. */

function parseWallClock(str) {
  const clean = str.replace("T", " ");
  const [datePart, timePart] = clean.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = (timePart || "00:00").split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm || 0);
}

function pacificNowPseudo() {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const hour = Number(map.hour) % 24;
  return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
}

function toPacificPseudo(isoString) {
  const d = new Date(isoString);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const map = {};
  parts.forEach((p) => (map[p.type] = p.value));
  const hour = Number(map.hour) % 24;
  return Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), hour, Number(map.minute), Number(map.second));
}

function toDatetimeLocalValue(pseudoMs) {
  const d = new Date(pseudoMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function toNOAADateStr(pseudoMs) {
  const d = new Date(pseudoMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function formatTime(pseudoMs) {
  const d = new Date(pseudoMs);
  let h = d.getUTCHours();
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

function formatDayLabel(pseudoMs, todayMs) {
  const oneDay = 86400000;
  const startOfDay = (ms) => {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  };
  const diff = Math.round((startOfDay(pseudoMs) - startOfDay(todayMs)) / oneDay);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const d = new Date(pseudoMs);
  return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function compressImage(file, maxWidth = 1200, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => {
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob);
            else reject(new Error("Compression failed"));
          },
          "image/jpeg",
          quality
        );
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ---------------- moon phase (no API needed) ---------------- */

function moonPhase(pseudoMs) {
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

/* ---------------- data fetchers ---------------- */

async function fetchNOAA(stationId, product, extraParams, beginDateStr) {
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${stationId}&product=${product}&datum=MLLW&time_zone=lst_ldt&units=english&format=json&begin_date=${beginDateStr}&range=42${extraParams || ""}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "NOAA error");
  return data;
}

async function fetchTide(beginDateStr) {
  let stationUsed = STATIONS.primary;
  let curveData, hiloData;
  try {
    curveData = await fetchNOAA(STATIONS.primary.id, "predictions", "", beginDateStr);
    hiloData = await fetchNOAA(STATIONS.primary.id, "predictions", "&interval=hilo", beginDateStr);
  } catch (e) {
    stationUsed = STATIONS.fallback;
    curveData = await fetchNOAA(STATIONS.fallback.id, "predictions", "", beginDateStr);
    hiloData = await fetchNOAA(STATIONS.fallback.id, "predictions", "&interval=hilo", beginDateStr);
  }
  const curve = curveData.predictions.map((p) => ({ t: parseWallClock(p.t), v: parseFloat(p.v) }));
  const hilo = hiloData.predictions.map((p) => ({ t: parseWallClock(p.t), v: parseFloat(p.v), type: p.type }));
  return { curve, hilo, station: stationUsed };
}

async function fetchWeather() {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${SITE.lat}&longitude=${SITE.lon}&hourly=temperature_2m,pressure_msl,wind_speed_10m,wind_direction_10m,cloud_cover,precipitation&daily=sunrise,sunset&timezone=America%2FLos_Angeles&forecast_days=3&wind_speed_unit=mph&temperature_unit=fahrenheit`;
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

async function fetchWaterTemp() {
  // Open-Meteo's marine model has no coverage inside Puget Sound, so we use
  // the nearest NOAA station that reports observed water temperature. Tacoma
  // (9446484) is ~10 mi away in the Sound; Gig Harbor does not offer the product.
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${STATIONS.primary.id}&product=water_temperature&time_zone=lst_ldt&units=english&format=json&date=latest`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "NOAA water temp error");
  const latest = data?.data?.[data.data.length - 1];
  const temp = latest ? parseFloat(latest.v) : NaN;
  if (!Number.isFinite(temp)) throw new Error("No water temperature reading");
  return { temp, station: STATIONS.primary, observedAt: latest.t };
}

async function askClaude(prompt) {
  const res = await fetch(
    "https://psobrejvsfnepxgkceqx.supabase.co/functions/v1/ask-slackfin",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    }
  );
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text;
}

/* ---------------- scoring model ----------------
   Movement matters more than direction, but local guidance for
   Fox Island specifically (Salmon University) says the south
   end fishes best on the outgoing tide, so outgoing movement is
   weighted a bit higher than incoming. Dawn and dusk get a
   bonus. Falling or steady barometric pressure gets a bonus,
   a sharp rise gets a penalty. Strong wind gets a penalty.
   This is a starting heuristic, not a guarantee. See "How this
   works" in the app, and your own catch log, for the real word. */

function buildSeries(curve, wx, nowMs) {
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
    const movement = normRate * (rate < 0 ? 1 : 0.45);

    let minDist = Infinity;
    for (const ev of sunEvents) {
      const d = Math.abs(p.t - ev) / 60000;
      if (d < minDist) minDist = d;
    }
    const lightBonus = minDist <= 90 ? 1 - minDist / 90 : 0;

    const idx = findWxIdx(p.t);
    const pressureNow = wx.hourly?.pressure_msl?.[idx] ?? null;
    const idxPrev = Math.max(0, idx - 3);
    const pressureDelta = pressureNow != null ? pressureNow - wx.hourly.pressure_msl[idxPrev] : 0;
    const pressureFactor = pressureDelta <= -1 ? 1 : pressureDelta >= 2 ? -1 : 0.4;
    const windSpeed = wx.hourly?.wind_speed_10m?.[idx] ?? 0;
    const windFactor = windSpeed > 18 ? Math.min((windSpeed - 18) / 12, 1) : 0;

    const moon = moonPhase(p.t);
    const moonBonus = moon.phase < 0.06 || moon.phase > 0.94 || Math.abs(moon.phase - 0.5) < 0.06 ? 1 : 0;

    const raw =
      0.4 * movement +
      0.2 * lightBonus +
      0.15 * Math.max(pressureFactor, 0) +
      (pressureFactor < 0 ? pressureFactor * 0.15 : 0) +
      0.05 * moonBonus -
      0.15 * windFactor;

    const score = Math.max(0, Math.min(100, Math.round(raw * 100)));
    return { ...p, rate, score, windSpeed, pressureNow, pressureDelta };
  });
}

function findWindows(series, thresholdScore, nowMs, horizonMs) {
  const windows = [];
  let cur = null;
  for (const p of series) {
    if (p.t < nowMs - 15 * 60000 || p.t > nowMs + horizonMs) continue;
    if (p.score >= thresholdScore) {
      if (!cur) cur = { start: p.t, end: p.t, scores: [p.score] };
      else { cur.end = p.t; cur.scores.push(p.score); }
    } else if (cur) {
      windows.push(cur);
      cur = null;
    }
  }
  if (cur) windows.push(cur);
  return windows
    .filter((w) => w.end - w.start >= 18 * 60000)
    .map((w) => ({ ...w, avg: Math.round(w.scores.reduce((a, b) => a + b, 0) / w.scores.length) }))
    .sort((a, b) => b.avg - a.avg);
}

/* ---------------- small UI atoms ---------------- */

function Chip({ icon: Icon, label, value, sub }) {
  return (
    <div
      className="flex flex-col items-start justify-start gap-1 rounded-xl px-3 py-2.5"
      style={{ background: THEME.white, border: `1px solid ${THEME.line}`, minHeight: 84 }}
    >
      <div className="flex items-center gap-1" style={{ color: THEME.slackDeep }}>
        {Icon ? <Icon size={12} strokeWidth={2} /> : null}
        <span className="uppercase tracking-wide" style={{ fontSize: 12 }}>{label}</span>
      </div>
      <div className="mono leading-none" style={{ fontSize: 18, color: value === "…" ? THEME.bite : THEME.ink }}>{value}</div>
      <div style={{ fontSize: 12, color: THEME.slackDeep, minHeight: 12 }}>{sub || "\u00A0"}</div>
    </div>
  );
}

function FishRating({ score }) {
  // Same 3-tier bands used elsewhere in the app (GOOD/FAIR/SLOW at 70/45),
  // so the fish count never implies more precision than the heuristic has.
  const color = score >= 70 ? THEME.bite : score >= 45 ? THEME.kelp : THEME.slack;
  const label = score >= 70 ? "GOOD" : score >= 45 ? "FAIR" : "SLOW";
  const filled = Math.max(1, Math.min(5, Math.round(score / 20)));

  return (
    <div className="flex flex-col items-center gap-1 shrink-0" style={{ width: 84 }}>
      <div
        role="img"
        aria-label={`${filled} of 5 fish, ${label.toLowerCase()} conditions, score ${score} of 100`}
        className="flex items-center gap-0.5"
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <Fish
            key={i}
            size={16}
            strokeWidth={2}
            aria-hidden="true"
            style={{ color: i < filled ? color : THEME.line }}
            fill={i < filled ? color : "none"}
          />
        ))}
      </div>
      <div className="mono leading-none" style={{ fontSize: 15, color }}>{score}</div>
      <div className="tracking-widest" style={{ fontSize: 10, color }}>{label}</div>
    </div>
  );
}

/* ---------------- tide chart ---------------- */

function TideChart({ series, nowMs, windows, sunriseEvents, sunsetEvents, currentPoint }) {
  const width = 800, height = 320, padL = 48, padR = 12, padT = 20, padB = 32;
  if (!series.length) return null;
  const tMin = series[0].t, tMax = series[series.length - 1].t;
  const vMin = Math.min(...series.map((p) => p.v));
  const vMax = Math.max(...series.map((p) => p.v));
  const vSpan = vMax - vMin || 1;

  const x = (t) => padL + ((t - tMin) / (tMax - tMin)) * (width - padL - padR);
  const y = (v) => padT + (1 - (v - vMin) / vSpan) * (height - padT - padB);

  const pathD = series.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");

  const yTicks = 4;
  const yGridLines = Array.from({ length: yTicks + 1 }, (_, i) => vMin + (vSpan * i) / yTicks);

  // 6-hour x ticks
  const xTicks = [];
  const startDay = new Date(tMin);
  let cursor = Date.UTC(startDay.getUTCFullYear(), startDay.getUTCMonth(), startDay.getUTCDate());
  while (cursor < tMax) {
    if (cursor >= tMin) xTicks.push(cursor);
    cursor += 6 * 3600000;
  }

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Tide chart with fishing windows">
      {yGridLines.map((v, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={y(v)} y2={y(v)} stroke={THEME.line} strokeWidth="1" opacity="0.6" />
          <text x={6} y={y(v) + 3} fontSize="13" fill={THEME.slackDeep} className="mono">{v.toFixed(1)}</text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} x2={x(t)} y1={padT} y2={height - padB} stroke={THEME.line} strokeWidth="1" opacity="0.35" />
          <text x={x(t)} y={height - 8} fontSize="13" fill={THEME.slackDeep} textAnchor="middle" className="mono">
            {formatTime(t).replace(":00", "").replace(" ", "")}
          </text>
        </g>
      ))}
      {windows.map((w, i) => (
        <rect key={i} x={x(w.start)} y={padT} width={Math.max(1, x(w.end) - x(w.start))} height={height - padT - padB}
          fill={THEME.bite} opacity="0.14" />
      ))}
      {sunriseEvents.map((s, i) => (
        <line key={`sr-${i}`} x1={x(s)} x2={x(s)} y1={padT} y2={height - padB} stroke="#D9A441" strokeWidth="1.5" opacity="0.8" />
      ))}
      {sunsetEvents.map((s, i) => (
        <line key={`ss-${i}`} x1={x(s)} x2={x(s)} y1={padT} y2={height - padB} stroke="#C1652E" strokeWidth="1.5" opacity="0.8" />
      ))}
      <path d={pathD} fill="none" stroke={THEME.tide} strokeWidth="2.5" strokeLinejoin="round" />
      {nowMs >= tMin && nowMs <= tMax && currentPoint ? (
        <>
          <line x1={x(nowMs)} x2={x(nowMs)} y1={padT} y2={height - padB} stroke={THEME.ink} strokeWidth="1.5" />
          <circle cx={x(nowMs)} cy={y(currentPoint.v)} r="4" fill={THEME.ink} />
        </>
      ) : null}
    </svg>
  );
}

/* ---------------- main component ---------------- */

export default function Slackfin() {
  const [now, setNow] = useState(pacificNowPseudo());
  const [tide, setTide] = useState(null);
  const [wx, setWx] = useState(null);
  const [marine, setMarine] = useState(null);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [lastAttempt, setLastAttempt] = useState(null);

  const [aiVerdict, setAiVerdict] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiRequested = useRef(false);


  const [catches, setCatches] = useState([]);
  const [showLogForm, setShowLogForm] = useState(false);
  const [form, setForm] = useState({ species: "", length: "", bait: "", notes: "", photoFile: null, photoPreview: null, angler: "", caughtAt: pacificNowPseudo() });

  const [showAbout, setShowAbout] = useState(false);
  const [showHow, setShowHow] = useState(false);

  const [expandedPhoto, setExpandedPhoto] = useState(null);

  const [userId, setUserId] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [wordmarkTaps, setWordmarkTaps] = useState(0);

  const [locationRequest, setLocationRequest] = useState({ name: "", note: "" });
  const [locationRequestSent, setLocationRequestSent] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setNow(pacificNowPseudo()), 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const hasVisited = localStorage.getItem("slackfin_visited");
    if (!hasVisited) {
      setShowHow(true);
      setShowAbout(true);
      localStorage.setItem("slackfin_visited", "true");
    }
  }, []);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        await supabase.auth.signInAnonymously();
      }
    })();
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUserId(session?.user?.id ?? null);
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const nextErrors = {};
    const beginStr = toNOAADateStr(pacificNowPseudo());

    const [tideRes, wxRes, waterRes] = await Promise.allSettled([
      fetchTide(beginStr),
      fetchWeather(),
      fetchWaterTemp(),
    ]);

    if (tideRes.status === "fulfilled") setTide(tideRes.value);
    else nextErrors.tide = "NOAA's tide data is currently down. Please check back soon.";

    if (wxRes.status === "fulfilled") setWx(wxRes.value);
    else nextErrors.wx = "Couldn't reach weather data.";

    if (waterRes.status === "fulfilled") setMarine(waterRes.value);
    else nextErrors.marine = "Water temperature unavailable right now.";

    setErrors(nextErrors);
    setLastAttempt(pacificNowPseudo());
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("catches")
        .select("*")
        .order("created_at", { ascending: false });
      if (!error) setCatches(data);
    })();
  }, []);

  const series = useMemo(() => {
    if (!tide || !wx) return [];
    return buildSeries(tide.curve, wx, now);
  }, [tide, wx, now]);

  const currentPoint = useMemo(() => {
    if (!series.length) return null;
    return series.reduce((a, b) => (Math.abs(b.t - now) < Math.abs(a.t - now) ? b : a));
  }, [series, now]);

  // Wind and pressure come from Open-Meteo, not NOAA, so read them straight
  // from the weather response — a NOAA tide outage must not blank these chips.
  const wxNow = useMemo(() => {
    if (!wx?.hourly?.time?.length) return null;
    const times = wx.hourly.time.map(parseWallClock);
    let bestI = 0, bestDiff = Infinity;
    times.forEach((t, i) => {
      const d = Math.abs(t - now);
      if (d < bestDiff) { bestDiff = d; bestI = i; }
    });
    const pressureNow = wx.hourly.pressure_msl?.[bestI] ?? null;
    const idxPrev = Math.max(0, bestI - 3);
    const pressureDelta = pressureNow != null
      ? pressureNow - wx.hourly.pressure_msl[idxPrev]
      : 0;
    return { windSpeed: wx.hourly.wind_speed_10m?.[bestI] ?? null, pressureNow, pressureDelta };
  }, [wx, now]);

  const windows = useMemo(() => {
    if (!series.length) return [];
    return findWindows(series, 62, now, 30 * 3600000);
  }, [series, now]);

  const sunriseEvents = useMemo(() => {
    if (!wx) return [];
    return (wx.daily?.sunrise || []).map((s) => parseWallClock(s));
  }, [wx]);

  const sunsetEvents = useMemo(() => {
    if (!wx) return [];
    return (wx.daily?.sunset || []).map((s) => parseWallClock(s));
  }, [wx]);

  const sst = useMemo(() => {
    return Number.isFinite(marine?.temp) ? marine.temp : null;
  }, [marine]);

  const nextHigh = useMemo(() => {
    if (!tide?.hilo) return null;
    return tide.hilo.find((h) => h.t > now);
  }, [tide, now]);

  const moon = useMemo(() => moonPhase(now), [now]);

  const todaySun = useMemo(() => {
    if (!wx?.daily?.sunrise?.length) return null;
    return { sunrise: parseWallClock(wx.daily.sunrise[0]), sunset: parseWallClock(wx.daily.sunset[0]) };
  }, [wx]);

  function localVerdict() {
    if (!currentPoint) return "";
    const dir = currentPoint.rate < 0 ? "outgoing" : "incoming";
    const w = windows[0];
    let text = `Tide is ${dir}, moving about ${Math.abs(currentPoint.rate).toFixed(2)} ft/hr.`;
    if (w) text += ` Best window in the next day looks like ${formatTime(w.start)} to ${formatTime(w.end)}, average score ${w.avg}.`;
    return text;
  }

  useEffect(() => {
    if (aiRequested.current) return;
    if (!currentPoint || !windows) return;
    aiRequested.current = true;
    setAiLoading(true);
    const w = windows[0];

    // Pull extra weather signals at the current hour so the read can key off
    // whatever actually stands out today rather than reciting the same stats.
    const wxIdx = (() => {
      const times = (wx?.hourly?.time || []).map(parseWallClock);
      let bestI = -1, bestDiff = Infinity;
      times.forEach((t, i) => { const d = Math.abs(t - now); if (d < bestDiff) { bestDiff = d; bestI = i; } });
      return bestI;
    })();
    const airTemp = wxIdx >= 0 ? wx?.hourly?.temperature_2m?.[wxIdx] : null;
    const cloud = wxIdx >= 0 ? wx?.hourly?.cloud_cover?.[wxIdx] : null;
    const precip = wxIdx >= 0 ? wx?.hourly?.precipitation?.[wxIdx] : null;
    const sky = cloud == null ? "unknown"
      : cloud >= 80 ? "overcast" : cloud >= 40 ? "partly cloudy" : "mostly clear";

    // Where the sun is relative to now, since dawn and dusk drive the bite.
    const daylight = (() => {
      if (!todaySun) return "unknown";
      if (now < todaySun.sunrise) return `before sunrise (sunrise ${formatTime(todaySun.sunrise)})`;
      if (now > todaySun.sunset) return `after sunset (sunset was ${formatTime(todaySun.sunset)})`;
      const toSet = (todaySun.sunset - now) / 3600000;
      if (toSet < 2) return `approaching dusk (sunset ${formatTime(todaySun.sunset)})`;
      const sinceRise = (now - todaySun.sunrise) / 3600000;
      if (sinceRise < 2) return `early after sunrise (${formatTime(todaySun.sunrise)})`;
      return "midday, well past the dawn bite";
    })();

    // How the best window sits relative to right now, so it can say whether to
    // fish now or wait, instead of just listing a time range.
    const windowRelation = !w ? "no strong window found in the next 24 to 30 hours"
      : now >= w.start && now <= w.end ? `we are inside the best window right now (runs to ${formatTime(w.end)}, score ${w.avg}/100)`
      : now < w.start ? `the best window is still ahead, ${formatTime(w.start)} to ${formatTime(w.end)} (score ${w.avg}/100)`
      : `the best window already passed, next data-driven pick is ${formatTime(w.start)} to ${formatTime(w.end)}`;

    const prompt = `You are a local angler giving a quick, plain-spoken read on fishing conditions at Fox Island Pier, Marine Area 13, South Puget Sound, Washington. Use only the facts below. Do not invent regulations, limits, or facts not given. Do not use em dashes or semicolons.

Facts:
- Tide right now: ${currentPoint.rate < 0 ? "outgoing (falling)" : "incoming (rising)"}, moving ${Math.abs(currentPoint.rate).toFixed(2)} ft/hr, height ${currentPoint.v.toFixed(1)} ft
- Barometric pressure: ${currentPoint.pressureDelta <= -1 ? "falling" : currentPoint.pressureDelta >= 2 ? "rising fast" : "steady"}
- Wind: ${Math.round(currentPoint.windSpeed)} mph
- Sky: ${sky}${precip != null && precip > 0 ? `, ${precip.toFixed(2)} in precip` : ", no rain"}${airTemp != null ? `, air ${Math.round(airTemp)}F` : ""}
- Water temperature: ${sst != null ? `${sst.toFixed(0)}F` : "unavailable"}
- Time of day: ${daylight}
- Moon: ${moon.name}
- Best predicted window: ${windowRelation}
- Local knowledge: the south end of Fox Island fishes best on the outgoing tide

Instructions:
- Lead with whatever stands out most today. Do not recite every fact.
- Name only the one or two factors that actually drive your call. Pick different angles on different days depending on which conditions are notable.
- Be honest when it is a mediocre or slow read. Do not force optimism.

Respond in exactly this format with no other text:
VERDICT: [one short punchy sentence, max 12 words, giving your bottom-line take]
WHY: [2 to 3 sentences of supporting reasoning, casual and direct, focused on the factors that matter most right now, no em dashes or semicolons]`;
    askClaude(prompt)
      .then((text) => setAiVerdict(text || localVerdict()))
      .catch(() => setAiVerdict(localVerdict()))
      .finally(() => setAiLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPoint, windows]);

  async function saveCatch() {
    if (!form.species.trim()) return;

    let photoUrl = null;
    if (form.photoFile) {
      const fileName = `${Date.now()}.jpg`;
      const { error: uploadError } = await supabase.storage
        .from("catch-photos")
        .upload(fileName, form.photoFile);
      if (!uploadError) {
        const { data: urlData } = supabase.storage
          .from("catch-photos")
          .getPublicUrl(fileName);
        photoUrl = urlData.publicUrl;
      }
    }

    const conditions = currentPoint
      ? {
          tideDirection: currentPoint.rate < 0 ? "outgoing" : "incoming",
          tideHeight: Number(currentPoint.v.toFixed(1)),
          pressureTrend: currentPoint.pressureDelta <= -1 ? "falling" : currentPoint.pressureDelta >= 2 ? "rising" : "steady",
          windMph: Math.round(currentPoint.windSpeed || 0),
          moon: moon.name,
          score: currentPoint.score,
        }
      : null;

    const { data, error } = await supabase
      .from("catches")
      .insert([{
        species: form.species.trim(),
        angler: form.angler.trim(),
        length: form.length.trim(),
        bait: form.bait.trim(),
        notes: form.notes.trim(),
        conditions,
        photo_url: photoUrl,
        created_by: userId,
        caught_at: new Date(form.caughtAt).toISOString(),
      }])
      .select();

    if (!error && data) {
      setCatches([data[0], ...catches]);
      setForm({ species: "", length: "", bait: "", notes: "", photoFile: null, photoPreview: null, angler: "", caughtAt: pacificNowPseudo() });
      setShowLogForm(false);
    }
  }

  async function adminDeleteCatch(id, photoUrl) {
    const passphrase = window.prompt("Admin passphrase:");
    if (!passphrase) return;
    const res = await fetch(
      "https://psobrejvsfnepxgkceqx.supabase.co/functions/v1/admin-delete",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ catchId: id, photoUrl, passphrase }),
      }
    );
    const data = await res.json();
    if (data.success) {
      setCatches(catches.filter((c) => c.id !== id));
      setIsAdmin(true);
    } else {
      alert("Delete failed: " + (data.error || "unknown error"));
    }
  }

  async function deleteCatch(id, photoUrl) {
    if (photoUrl) {
      const fileName = photoUrl.split("/").pop();
      await supabase.storage.from("catch-photos").remove([fileName]);
    }
    const { error } = await supabase.from("catches").delete().eq("id", id);
    if (!error) {
      setCatches(catches.filter((c) => c.id !== id));
    }
  }

  async function submitLocationRequest() {
    if (!locationRequest.name.trim()) return;
    const { error } = await supabase.from("location_requests").insert([{
      location_name: locationRequest.name.trim(),
      note: locationRequest.note.trim(),
    }]);
    if (!error) {
      setLocationRequestSent(true);
      setLocationRequest({ name: "", note: "" });
    }
  }

  const cssVars = {
    "--serif": "'Newsreader', serif",
    "--mono": "'IBM Plex Mono', monospace",
    "--sans": "'IBM Plex Sans', sans-serif",
  };

  return (
    <div style={{ ...cssVars, background: THEME.paper, minHeight: "100vh", fontFamily: "var(--sans)" }}>
      <style>{`
        ${FONT_IMPORT}
        .serif { font-family: var(--serif); }
        .mono { font-family: var(--mono); }
        button:focus-visible, input:focus-visible, textarea:focus-visible {
          outline: 2px solid ${THEME.tide};
          outline-offset: 2px;
        }
      `}</style>

      <div className="max-w-lg mx-auto px-4 pt-6 pb-28">
        {/* header */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <div className="flex items-center gap-2 mt-0.5">
              <img
                src="/slackfin_logo.png"
                alt="slackfin logo"
                className="rounded-lg shrink-0"
                style={{ width: 34, height: 34 }}
              />
              <h1
                className="serif leading-tight cursor-pointer select-none"
                style={{ fontSize: 30, color: "#042A2B" }}
                onClick={() => {
                  const next = wordmarkTaps + 1;
                  setWordmarkTaps(next);
                  if (next >= 5) {
                    setIsAdmin((prev) => !prev);
                    setWordmarkTaps(0);
                  }
                }}
              >
                slackfin
              </h1>
            </div>
            <p style={{ fontSize: 14, color: THEME.slackDeep, marginTop: 4, marginBottom: 12, lineHeight: 1.45 }}>
              Know before you go: tide, weather, and a bite report, in tow.
            </p>
            <div className="flex items-center gap-1.5 mt-2">
              <MapPin size={15} style={{ color: THEME.kelp }} />
              <span style={{ fontSize: 15, fontWeight: 600 }}>
                <span className="uppercase tracking-wide" style={{ color: THEME.kelp }}>Fox Island Pier</span>
                <span style={{ color: THEME.slackDeep }}> · Marine Area 13</span>
              </span>
            </div>
          </div>
          <button
            onClick={loadAll}
            className="motion-safe:transition-transform active:scale-95 rounded-full p-2 mt-1 shrink-0"
            style={{ border: `1px solid ${THEME.line}`, background: THEME.white }}
            aria-label="Refresh conditions"
          >
            <RefreshCw size={15} style={{ color: THEME.ink }} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {Object.keys(errors).length > 0 && (
          <div
            className="mb-3 px-3 py-2 rounded-lg"
            style={{ fontSize: 14, background: "#FBF3D3", border: `1px solid #E7D79E`, color: THEME.ink, lineHeight: 1.45 }}
          >
            {Object.values(errors).join(" ")}
            {lastAttempt ? <span style={{ color: THEME.slack }}> Last checked at {formatTime(lastAttempt)}.</span> : null}
            {" "}
            <button
              onClick={loadAll}
              className="underline underline-offset-2"
              style={{ fontSize: 14, color: THEME.tide, fontWeight: 600 }}
            >
              Retry
            </button>
          </div>
        )}

        {/* live conditions strip */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          <Chip icon={Waves} label="Tide"
            value={currentPoint ? `${currentPoint.v.toFixed(1)} ft` : errors.tide ? "—" : "…"}
            sub={currentPoint ? (currentPoint.rate < 0 ? "outgoing" : "incoming") : ""} />
          <Chip icon={Thermometer} label="Water" value={sst != null ? `${sst.toFixed(0)}°F` : "n/a"} sub={sst != null ? "NOAA Tacoma" : "unavailable"} />
          <Chip icon={Wind} label="Wind"
            value={wxNow?.windSpeed != null ? `${Math.round(wxNow.windSpeed)} mph` : errors.wx ? "—" : "…"} />
          <Chip icon={Gauge} label="Pressure"
            value={wxNow?.pressureNow != null ? `${Math.round(wxNow.pressureNow)} hPa` : errors.wx ? "—" : "…"}
            sub={wxNow?.pressureNow != null ? (wxNow.pressureDelta <= -1 ? "falling" : wxNow.pressureDelta >= 2 ? "rising" : "steady") : ""} />
          <Chip icon={Moon} label="Moon" value={moon.emoji} sub={moon.name} />
          {todaySun ? (
            <>
              <Chip icon={Sunrise} label="Sunrise" value={formatTime(todaySun.sunrise)} />
              <Chip icon={Sunset} label="Sunset" value={formatTime(todaySun.sunset)} />
            </>
          ) : null}
          <Chip icon={Waves}
            label={nextHigh ? (nextHigh.type === "H" ? "Next high" : "Next low") : "Next tide"}
            value={nextHigh ? formatTime(nextHigh.t) : errors.tide ? "—" : "…"}
            sub={nextHigh ? `${nextHigh.v.toFixed(1)} ft` : ""} />

        </div>

        {/* verdict card */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-2" style={{ fontSize: 13, color: THEME.ink, fontWeight: 600 }}>Conditions Score</div>
          <div className="flex flex-col gap-3">
            <div className="flex justify-center">
              {currentPoint ? (
                <FishRating score={currentPoint.score} />
              ) : errors.tide ? (
                <p className="text-center" style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>
                  Can't score conditions without tide data. Wind, pressure, and water temp above are still current.
                </p>
              ) : (
                <Loader2 className="animate-spin" size={28} />
              )}
            </div>
            <div className="w-full min-w-0">
              {aiLoading && !aiVerdict ? (
                <div className="flex items-center gap-2 " style={{ fontSize: 14, color: THEME.slackDeep }}>
                  <Loader2 className="animate-spin" size={13} /> Reading the conditions…
                </div>
              ) : (() => {
                const raw = aiVerdict || localVerdict();
                const idx = raw.indexOf("WHY:");
                if (idx === -1) {
                  return (
                    <p className="serif italic leading-normal" style={{ fontSize: 15, color: THEME.ink }}>
                      {raw}
                    </p>
                  );
                }
                const verdict = raw.slice(0, idx).replace(/^\s*VERDICT:\s*/, "").trim();
                const why = raw.slice(idx + 4).trim();
                return (
                  <>
                    <p className="serif leading-normal" style={{ fontSize: 18, fontWeight: 600, color: THEME.ink }}>
                      {verdict}
                    </p>
                    <p className="serif italic leading-normal mt-1" style={{ fontSize: 15, color: THEME.ink }}>
                      {why}
                    </p>
                  </>
                );
              })()}
            </div>
          </div>
          <button
            onClick={() => setShowHow((s) => !s)}
            className="flex items-center gap-1 mt-3"
            style={{ fontSize: 12, color: THEME.kelp }}
          >
            <Info size={12} /> How this score works {showHow ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showHow && (
            <p className="mt-2 leading-relaxed" style={{ fontSize: 14, color: THEME.slackDeep }}>
              The score weighs tide movement, dawn and dusk light, barometric pressure, wind, and moon phase.
              Outgoing tide is weighted a bit higher here, since the south end of Fox Island is known locally
              to fish best on the outgoing. It is a starting heuristic, not a guarantee. Log your catches below
              and use them to check your own pattern against it.
            </p>
          )}
        </div>

        {/* tide chart */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="flex items-center justify-between mb-2">
            <span className="uppercase tracking-wide" style={{ fontSize: 13, color: THEME.ink, fontWeight: 600 }}>
              Tide, next 42 hours
            </span>
            {currentPoint ? (
              <span className="mono rounded-full px-2 py-0.5" style={{ fontSize: 12, background: THEME.paper, color: THEME.ink }}>Current: {currentPoint.v.toFixed(1)} ft</span>
            ) : null}
            {tide?.station ? (
              <span className="mono" style={{ fontSize: 12, color: THEME.slackDeep }}>NOAA {tide.station.name}</span>
            ) : null}
          </div>
          {series.length ? (
            <TideChart series={series} nowMs={now} windows={windows} sunriseEvents={sunriseEvents} sunsetEvents={sunsetEvents} currentPoint={currentPoint} />
          ) : errors.tide ? (
            <div className="py-2" style={{ fontSize: 13, color: THEME.slackDeep }}>
              Unavailable{lastAttempt ? ` · last checked ${formatTime(lastAttempt)}` : ""}
            </div>
          ) : (
            <div className="h-40 flex items-center justify-center" style={{ color: THEME.slackDeep }}>
              <Loader2 className="animate-spin mr-2" size={16} /> Loading tide curve…
            </div>
          )}
          {series.length ? (
            <div className="flex items-center gap-3 mt-2 " style={{ fontSize: 12, color: THEME.slackDeep }}>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: THEME.bite, opacity: 0.4 }} /> good window</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5" style={{ background: "#D9A441" }} /> sunrise</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5" style={{ background: "#C1652E" }} /> sunset</span>
            </div>
          ) : null}
        </div>

        {/* best windows */}
        {windows.length > 0 && (
          <div className="mb-4">
            <div className="uppercase tracking-wide mb-2" style={{ fontSize: 13, color: THEME.slackDeep, fontWeight: 600 }}>Best windows ahead</div>
            <div className="flex gap-2 flex-wrap">
              {windows.slice(0, 4).map((w, i) => (
                <div key={i} className="rounded-lg px-3 py-1.5 mono"
                  style={{ fontSize: 12, background: THEME.white, border: `1px solid ${THEME.line}`, color: THEME.ink }}>
                  {formatDayLabel(w.start, now)} {formatTime(w.start)}–{formatTime(w.end)}
                  <span style={{ color: THEME.bite }}> · {w.avg}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* catch log */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5" style={{ color: THEME.ink }}>
              <span className="uppercase tracking-wide" style={{ fontSize: 13, fontWeight: 600 }}>Community catch log</span>
            </div>
            <button
              onClick={() => setShowLogForm((s) => !s)}
              className="flex items-center gap-1 rounded-full px-2.5 py-1"
              style={{ fontSize: 12, background: THEME.kelp, color: THEME.white }}
            >
              {showLogForm ? <X size={12} /> : <Plus size={12} />} {showLogForm ? "Cancel" : "Log a catch"}
            </button>
          </div>
          <p className="mb-2" style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>
            See what others are catching at Fox Island Pier. Add your own below.
          </p>

          {showLogForm && (
            <div className="flex flex-col gap-2 mb-3 p-3 rounded-xl" style={{ background: THEME.paper }}>
              <p style={{ fontSize: 12, color: THEME.slackDeep, marginBottom: 4, lineHeight: 1.45 }}>
                Catches, including photos and first names, are visible to anyone who visits this site.
              </p>
              <div className="flex flex-col gap-1">
                <label style={{ fontSize: 12, color: THEME.ink }}>Your first name</label>
                <input
                  value={form.angler}
                  onChange={(e) => setForm({ ...form, angler: e.target.value })}
                  placeholder="Kate, Lefty, Spike..."
                  className="rounded-lg px-3 py-2"
                  style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label style={{ fontSize: 12, color: THEME.ink }}>When did you catch it? (estimate)</label>
                <input
                  type="datetime-local"
                  value={toDatetimeLocalValue(form.caughtAt)}
                  onChange={(e) => setForm({ ...form, caughtAt: parseWallClock(e.target.value) })}
                  className="rounded-lg px-3 py-2"
                  style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label style={{ fontSize: 12, color: THEME.ink }}>Species</label>
                <input
                  value={form.species}
                  onChange={(e) => setForm({ ...form, species: e.target.value })}
                  placeholder="coho, blackmouth, cutthroat…"
                  className="rounded-lg px-3 py-2 "
                  style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
              </div>
              <div className="flex gap-2">
                <div className="flex flex-col gap-1">
                  <label style={{ fontSize: 12, color: THEME.ink }}>Length (in)</label>
                  <input
                    value={form.length}
                    onChange={(e) => setForm({ ...form, length: e.target.value })}
                    placeholder="Length (in)"
                    className="w-24 rounded-lg px-3 py-2 "
                    style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                  />
                </div>
                <div className="flex flex-col gap-1 flex-1">
                  <label style={{ fontSize: 12, color: THEME.ink }}>Bait or lure</label>
                  <input
                    value={form.bait}
                    onChange={(e) => setForm({ ...form, bait: e.target.value })}
                    placeholder="Bait or lure"
                    className="flex-1 rounded-lg px-3 py-2 "
                    style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <label style={{ fontSize: 12, color: THEME.ink }}>Notes</label>
                <textarea
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="Notes"
                  rows={2}
                  className="rounded-lg px-3 py-2 resize-none"
                  style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
              </div>
              <div className="flex flex-col gap-2">
                <label className="rounded-lg px-3 py-2 text-center cursor-pointer" style={{ fontSize: 13, border: `1px dashed ${THEME.line}`, background: THEME.paper, color: THEME.slackDeep }}>
                  {form.photoPreview ? "Change photo" : "Add a photo"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files[0];
                      if (file) {
                        try {
                          const compressed = await compressImage(file);
                          setForm({ ...form, photoFile: compressed, photoPreview: URL.createObjectURL(compressed) });
                        } catch (err) {
                          setForm({ ...form, photoFile: file, photoPreview: URL.createObjectURL(file) });
                        }
                      }
                    }}
                  />
                </label>
                {form.photoPreview && (
                  <img src={form.photoPreview} alt="Catch preview" className="rounded-lg w-full object-contain" style={{ maxHeight: 160, background: THEME.paper }} />
                )}
              </div>
              <div style={{ fontSize: 12, color: THEME.slackDeep, lineHeight: 1.45 }}>
                Saves today's tide, pressure, wind, and moon alongside the catch.
              </div>
              <button
                onClick={saveCatch}
                disabled={!form.species.trim()}
                className="rounded-lg py-2 disabled:opacity-40"
                style={{ fontSize: 13, background: THEME.kelp, color: THEME.white }}
              >
                Save catch
              </button>
            </div>
          )}

          {catches.length === 0 ? (
            <p style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>
              No catches logged yet. Be the first to share what's biting.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {catches.map((c) => (
                <div key={c.id} className="rounded-xl p-3" style={{ background: THEME.paper }}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium" style={{ fontSize: 14, color: THEME.ink }}>
                        {c.species}{c.length ? ` · ${c.length}"` : ""}{c.angler ? ` · ${c.angler}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: THEME.slackDeep }}>
                        {formatDayLabel(c.caught_at ? new Date(c.caught_at).getTime() : toPacificPseudo(c.created_at), now)} {formatTime(c.caught_at ? new Date(c.caught_at).getTime() : toPacificPseudo(c.created_at))}{c.bait ? ` · ${c.bait}` : ""}
                      </div>
                      {c.notes && <div className="mt-1" style={{ fontSize: 14, color: THEME.ink, lineHeight: 1.45 }}>{c.notes}</div>}
                      {c.conditions && (
                        <div className="mono mt-1" style={{ fontSize: 12, color: THEME.slackDeep, lineHeight: 1.45 }}>
                          {c.conditions.tideDirection} tide, {c.conditions.tideHeight}ft · {c.conditions.pressureTrend} pressure · {c.conditions.windMph}mph · {c.conditions.moon} · score {c.conditions.score}
                        </div>
                      )}
                      {c.photo_url && (
                        <img
                          src={c.photo_url}
                          alt={c.species}
                          className="rounded-lg w-full object-contain mt-2 cursor-pointer"
                          style={{ maxHeight: 200, background: THEME.paper }}
                          onClick={() => setExpandedPhoto(c.photo_url)}
                        />
                      )}
                    </div>
                    {(userId && c.created_by === userId) ? (
                      <button onClick={() => deleteCatch(c.id, c.photo_url)} aria-label="Delete catch" className="shrink-0">
                        <Trash2 size={14} style={{ color: THEME.slack }} />
                      </button>
                    ) : isAdmin ? (
                      <button onClick={() => adminDeleteCatch(c.id, c.photo_url)} aria-label="Admin delete catch" className="shrink-0">
                        <Trash2 size={14} style={{ color: THEME.bite }} />
                      </button>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* regs reminder */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.paperDeep, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-2" style={{ fontSize: 13, color: THEME.ink, fontWeight: 600 }}>Know before you go</div>
          <ul className="leading-relaxed list-disc pl-4" style={{ fontSize: 14, color: THEME.ink }}>
            <li>Open 7 a.m. to dusk.</li>
            <li>Marine Area 13 is the only Washington marine area open to salmon fishing year round, and it allows the two-pole endorsement.</li>
            <li>Single-point barbless hooks are required for salmon here.</li>
            <li>Daily limits, size limits, and species-specific rules change through the season and can shift with emergency orders.</li>
            <li>Fox Island Pier sits near a salmon migration choke-point in the Tacoma Narrows, with coho typically peaking in September and October.</li>
          </ul>
          <a
            href="https://wdfw.wa.gov/fishing/locations/marine-areas/south-puget-sound"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-block mt-2"
            style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}
          >
            Check current WDFW rules for Marine Area 13
          </a>
        </div>

        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-1" style={{ fontSize: 13, color: THEME.ink, fontWeight: 600 }}>Want another location?</div>
          <p style={{ fontSize: 13, color: THEME.slackDeep, marginBottom: 8 }}>
            slackfin currently works best for saltwater piers in Washington State near a NOAA tide station. Let us know what spot you'd want to see next.
          </p>
          {locationRequestSent ? (
            <p style={{ fontSize: 13, color: THEME.kelp }}>Thanks! Your request has been noted.</p>
          ) : (
            <div className="flex flex-col gap-2">
              <input
                value={locationRequest.name}
                onChange={(e) => setLocationRequest({ ...locationRequest, name: e.target.value })}
                placeholder="Pier or location name"
                className="rounded-lg px-3 py-2"
                style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.paper }}
              />
              <input
                value={locationRequest.note}
                onChange={(e) => setLocationRequest({ ...locationRequest, note: e.target.value })}
                placeholder="Anything else? (optional)"
                className="rounded-lg px-3 py-2"
                style={{ fontSize: 16, border: `1px solid ${THEME.line}`, background: THEME.paper }}
              />
              <button
                onClick={submitLocationRequest}
                disabled={!locationRequest.name.trim()}
                className="rounded-lg py-2 disabled:opacity-40"
                style={{ fontSize: 13, background: THEME.kelp, color: THEME.white }}
              >
                Send request
              </button>
            </div>
          )}
        </div>

        {/* about / portfolio footer */}
        <button
          onClick={() => setShowAbout((s) => !s)}
          className="w-full text-left uppercase tracking-wide flex items-center justify-between py-2"
          style={{ fontSize: 13, color: THEME.ink, fontWeight: 600 }}
        >
          About this tool {showAbout ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {showAbout && (
          <div className="flex flex-col gap-2 pb-4">
            {[
              { label: "Data sources", desc: "Tide and water temperature from NOAA, weather from Open-Meteo." },
              { label: "AI summary", desc: "The written read is generated by Claude based on the same numbers shown above." },
              { label: "Scoring", desc: "A starting point from general fishing guidance for this spot, not a guarantee." },
              { label: "Your catch log", desc: "Private to this site, saved so you can look back on past trips." },
            ].map((row) => (
              <div key={row.label}>
                <div style={{ fontSize: 14, color: THEME.ink, fontWeight: 500 }}>{row.label}</div>
                <div style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>{row.desc}</div>
              </div>
            ))}
            <div>
              <div className="font-medium" style={{ fontSize: 14, color: THEME.ink }}>Visibility</div>
              <div style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>
                Catches, including photos and first names, are visible to anyone who visits this site.
              </div>
            </div>

            <div>
              <div className="font-medium" style={{ fontSize: 14, color: THEME.ink }}>Keep it fishing-related</div>
              <div style={{ fontSize: 14, color: THEME.slackDeep, lineHeight: 1.45 }}>
                Off-topic or inappropriate posts may be removed.
              </div>
            </div>
          </div>
        )}

        <div className="text-center pt-6 pb-6" style={{ fontSize: 14, color: THEME.slackDeep, borderTop: `1px solid ${THEME.line}` }}>
          © 2026 slackfin · Built by{" "}
          <a href="mailto:katherineborgen@gmail.com" style={{ color: THEME.kelp, textDecoration: "underline" }}>
            Kate Borgen
          </a>
        </div>
      </div>

      {expandedPhoto && (
        <div
          className="fixed inset-0 flex items-center justify-center p-4 z-50"
          style={{ background: "rgba(0,0,0,0.85)" }}
          onClick={() => setExpandedPhoto(null)}
        >
          <img
            src={expandedPhoto}
            alt="Enlarged catch photo"
            className="max-w-full max-h-full rounded-lg object-contain"
          />
          <button
            onClick={() => setExpandedPhoto(null)}
            className="absolute top-4 right-4 rounded-full p-2"
            style={{ background: THEME.white, color: THEME.ink }}
            aria-label="Close photo"
          >
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}
