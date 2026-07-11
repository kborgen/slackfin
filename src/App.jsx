import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  Fish, Wind, Moon, Waves, Gauge, Sunrise, Sunset, Thermometer, Info, Loader2,
  Send, ChevronDown, ChevronUp, Plus, Trash2, X, MapPin, RefreshCw
} from "lucide-react";
import { supabase } from "./supabaseClient";

/* ---------------------------------------------------------------
   slackfin
   A tide + weather + AI reasoning tool for Fox Island Pier,
   Marine Area 13, South Puget Sound.

   Data sources:
   - NOAA CO-OPS (tide predictions)
   - Open-Meteo (weather + marine)
   - Claude (plain-language read of conditions)

   Everything lives in the browser. Catch log is saved with the
   artifact's personal storage, so it is private to you and
   sticks around between visits.
------------------------------------------------------------------ */

const STATIONS = {
  gigHarbor: { id: "9446369", name: "Gig Harbor" },
  tacoma: { id: "9446484", name: "Tacoma" },
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
  let stationUsed = STATIONS.gigHarbor;
  let curveData, hiloData;
  try {
    curveData = await fetchNOAA(STATIONS.gigHarbor.id, "predictions", "", beginDateStr);
    hiloData = await fetchNOAA(STATIONS.gigHarbor.id, "predictions", "&interval=hilo", beginDateStr);
  } catch (e) {
    stationUsed = STATIONS.tacoma;
    curveData = await fetchNOAA(STATIONS.tacoma.id, "predictions", "", beginDateStr);
    hiloData = await fetchNOAA(STATIONS.tacoma.id, "predictions", "&interval=hilo", beginDateStr);
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

async function fetchMarine() {
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${SITE.lat}&longitude=${SITE.lon}&hourly=sea_surface_temperature&timezone=America%2FLos_Angeles&forecast_days=2&temperature_unit=fahrenheit`;
  const res = await fetch(url);
  const data = await res.json();
  return data;
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
      <div className="flex items-center gap-1" style={{ color: THEME.slack }}>
        {Icon ? <Icon size={12} strokeWidth={2} /> : null}
        <span className="uppercase tracking-wide" style={{ fontSize: 10 }}>{label}</span>
      </div>
      <div className="mono leading-none" style={{ fontSize: 16, color: THEME.ink }}>{value}</div>
      <div style={{ fontSize: 10, color: THEME.slack, minHeight: 12 }}>{sub || "\u00A0"}</div>
    </div>
  );
}

function ScoreStamp({ score }) {
  const color = score >= 70 ? THEME.bite : score >= 45 ? THEME.kelp : THEME.slack;
  const label = score >= 70 ? "GOOD" : score >= 45 ? "FAIR" : "SLOW";
  return (
    <div
      className="flex flex-col items-center justify-center rounded-full shrink-0"
      style={{
        width: 84, height: 84, border: `3px solid ${color}`, color,
        transform: "rotate(-6deg)",
      }}
    >
      <div className="mono text-2xl font-semibold leading-none">
        {score}<span style={{ fontSize: 12, fontWeight: 400, color: THEME.slack }}>/100</span>
      </div>
      <div className="tracking-widest mt-1" style={{ fontSize: 10 }}>{label}</div>
    </div>
  );
}

/* ---------------- tide chart ---------------- */

function TideChart({ series, nowMs, windows, sunEvents, currentPoint }) {
  const width = 800, height = 260, padL = 42, padR = 10, padT = 16, padB = 26;
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
          <text x={6} y={y(v) + 3} fontSize="12" fill={THEME.slack} className="mono">{v.toFixed(1)}</text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={x(t)} x2={x(t)} y1={padT} y2={height - padB} stroke={THEME.line} strokeWidth="1" opacity="0.35" />
          <text x={x(t)} y={height - 6} fontSize="12" fill={THEME.slack} textAnchor="middle" className="mono">
            {formatTime(t).replace(":00", "").replace(" ", "")}
          </text>
        </g>
      ))}
      {windows.map((w, i) => (
        <rect key={i} x={x(w.start)} y={padT} width={Math.max(1, x(w.end) - x(w.start))} height={height - padT - padB}
          fill={THEME.bite} opacity="0.14" />
      ))}
      {sunEvents.map((s, i) => (
        <line key={i} x1={x(s)} x2={x(s)} y1={padT} y2={height - padB} stroke={THEME.kelp} strokeWidth="1" strokeDasharray="2,3" opacity="0.5" />
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

  const [aiVerdict, setAiVerdict] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const aiRequested = useRef(false);

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  const [catches, setCatches] = useState([]);
  const [showLogForm, setShowLogForm] = useState(false);
  const [form, setForm] = useState({ species: "", length: "", bait: "", notes: "", photoFile: null, photoPreview: null });

  const [showAbout, setShowAbout] = useState(false);
  const [showHow, setShowHow] = useState(false);

  const [expandedPhoto, setExpandedPhoto] = useState(null);

  useEffect(() => {
    const id = setInterval(() => setNow(pacificNowPseudo()), 60000);
    return () => clearInterval(id);
  }, []);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const nextErrors = {};
    const beginStr = toNOAADateStr(pacificNowPseudo());

    const [tideRes, wxRes, marineRes] = await Promise.allSettled([
      fetchTide(beginStr),
      fetchWeather(),
      fetchMarine(),
    ]);

    if (tideRes.status === "fulfilled") setTide(tideRes.value);
    else nextErrors.tide = "Couldn't reach NOAA tide data. Try refreshing.";

    if (wxRes.status === "fulfilled") setWx(wxRes.value);
    else nextErrors.wx = "Couldn't reach weather data.";

    if (marineRes.status === "fulfilled") setMarine(marineRes.value);
    else nextErrors.marine = "Water temperature unavailable right now.";

    setErrors(nextErrors);
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

  const windows = useMemo(() => {
    if (!series.length) return [];
    return findWindows(series, 62, now, 30 * 3600000);
  }, [series, now]);

  const sunEvents = useMemo(() => {
    if (!wx) return [];
    const evts = [];
    (wx.daily?.sunrise || []).forEach((s) => evts.push(parseWallClock(s)));
    (wx.daily?.sunset || []).forEach((s) => evts.push(parseWallClock(s)));
    return evts;
  }, [wx]);

  const sst = useMemo(() => {
    if (!marine?.hourly?.time) return null;
    const times = marine.hourly.time.map(parseWallClock);
    let bestI = 0, bestDiff = Infinity;
    times.forEach((t, i) => { const d = Math.abs(t - now); if (d < bestDiff) { bestDiff = d; bestI = i; } });
    return marine.hourly.sea_surface_temperature?.[bestI] ?? null;
  }, [marine, now]);

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
    const prompt = `You are a local angler giving a quick, plain-spoken read on fishing conditions at Fox Island Pier, Marine Area 13, South Puget Sound, Washington. Use only the facts below. Do not invent regulations, limits, or facts not given. Do not use em dashes or semicolons. Keep it to 3 short sentences, casual and direct, no bullet points.

Facts:
- Tide direction right now: ${currentPoint.rate < 0 ? "outgoing (falling)" : "incoming (rising)"}, moving ${Math.abs(currentPoint.rate).toFixed(2)} ft/hr
- Current tide height: ${currentPoint.v.toFixed(1)} ft
- Barometric pressure trend: ${currentPoint.pressureDelta <= -1 ? "falling" : currentPoint.pressureDelta >= 2 ? "rising fast" : "steady"}
- Wind speed: ${Math.round(currentPoint.windSpeed)} mph
- Moon: ${moon.name}
- Best predicted window in next 24 to 30 hours: ${w ? `${formatTime(w.start)} to ${formatTime(w.end)} (score ${w.avg}/100)` : "no strong window found"}
- Local note: the south end of Fox Island is known to fish best on the outgoing tide

Give your honest read of whether now, or the upcoming window, looks worth fishing, and why, in your own words.`;
    askClaude(prompt)
      .then((text) => setAiVerdict(text || localVerdict()))
      .catch(() => setAiVerdict(localVerdict()))
      .finally(() => setAiLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPoint, windows]);

  async function sendChat() {
    const question = chatInput.trim();
    if (!question || chatLoading) return;
    setChatInput("");
    const nextMessages = [...chatMessages, { role: "user", text: question }];
    setChatMessages(nextMessages);
    setChatLoading(true);
    const w = windows[0];
    const context = `Conditions right now at Fox Island Pier, Marine Area 13: tide ${currentPoint?.rate < 0 ? "outgoing" : "incoming"} at ${currentPoint ? Math.abs(currentPoint.rate).toFixed(2) : "?"} ft/hr, height ${currentPoint?.v?.toFixed(1)} ft, pressure ${currentPoint?.pressureDelta <= -1 ? "falling" : currentPoint?.pressureDelta >= 2 ? "rising fast" : "steady"}, wind ${Math.round(currentPoint?.windSpeed || 0)} mph, moon ${moon.name}, water temp ${sst ? sst.toFixed(1) + "F" : "unknown"}. Best predicted window: ${w ? `${formatTime(w.start)} to ${formatTime(w.end)}` : "none strong"}.`;
    const prompt = `You are a local angler chatting with a friend about fishing Fox Island Pier in Marine Area 13, South Puget Sound. Use only the facts given below and general, well known angling knowledge. Never state specific catch limits, season dates, or legal rules. If asked about rules or limits, say to check the WDFW site. Do not use em dashes or semicolons. Keep answers short, 2 to 4 sentences, plain spoken.

Facts: ${context}

Question: ${question}`;
    try {
      const answer = await askClaude(prompt);
      setChatMessages((cur) => [...cur, { role: "assistant", text: answer || "Couldn't get a read on that just now." }]);
    } catch (e) {
      setChatMessages((cur) => [...cur, { role: "assistant", text: "Couldn't reach the almanac just now. Try again in a bit." }]);
    } finally {
      setChatLoading(false);
    }
  }

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
        length: form.length.trim(),
        bait: form.bait.trim(),
        notes: form.notes.trim(),
        conditions,
        photo_url: photoUrl,
      }])
      .select();

    if (!error && data) {
      setCatches([data[0], ...catches]);
      setForm({ species: "", length: "", bait: "", notes: "", photoFile: null, photoPreview: null });
      setShowLogForm(false);
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
              <h1 className="serif leading-tight" style={{ fontSize: 26, color: "#042A2B" }}>
                slackfin
              </h1>
            </div>
            <div className="flex items-center gap-1.5 mt-2" style={{ color: THEME.ink }}>
              <MapPin size={13} />
              <span className="uppercase tracking-wide" style={{ fontSize: 13 }}>Fox Island Pier · Marine Area 13</span>
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

        {/* live conditions strip */}
        <div className="grid grid-cols-4 gap-2 mb-4">
          <Chip icon={Waves} label="Tide" value={currentPoint ? `${currentPoint.v.toFixed(1)} ft` : "…"}
            sub={currentPoint ? (currentPoint.rate < 0 ? "outgoing" : "incoming") : ""} />
          <Chip icon={Thermometer} label="Water" value={sst ? `${sst.toFixed(0)}°F` : "n/a"} sub="approx, SST model" />
          <Chip icon={Wind} label="Wind" value={currentPoint ? `${Math.round(currentPoint.windSpeed)} mph` : "…"} />
          <Chip icon={Gauge} label="Pressure" value={currentPoint ? `${Math.round(currentPoint.pressureNow)} hPa` : "…"}
            sub={currentPoint ? (currentPoint.pressureDelta <= -1 ? "falling" : currentPoint.pressureDelta >= 2 ? "rising" : "steady") : ""} />
          <Chip icon={Moon} label="Moon" value={moon.emoji} sub={moon.name} />
          {todaySun ? (
            <>
              <Chip icon={Sunrise} label="Sunrise" value={formatTime(todaySun.sunrise)} />
              <Chip icon={Sunset} label="Sunset" value={formatTime(todaySun.sunset)} />
            </>
          ) : null}
          {nextHigh ? (
            <Chip icon={Waves} label={nextHigh.type === "H" ? "Next high" : "Next low"} value={formatTime(nextHigh.t)} sub={`${nextHigh.v.toFixed(1)} ft`} />
          ) : null}
        </div>

        {Object.keys(errors).length > 0 && (
          <div className="mb-3 px-3 py-2 rounded-lg" style={{ fontSize: 12, background: "#FBE4DC", color: THEME.ink }}>
            {Object.values(errors).join(" ")}
          </div>
        )}

        {/* verdict card */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-2" style={{ fontSize: 11, color: THEME.ink }}>Conditions Score</div>
          <div className="flex gap-3 items-center">
            {currentPoint ? <ScoreStamp score={currentPoint.score} /> : <Loader2 className="animate-spin" size={28} />}
            <div className="flex-1 min-w-0">
              {aiLoading && !aiVerdict ? (
                <div className="flex items-center gap-2 " style={{ fontSize: 13, color: THEME.slack }}>
                  <Loader2 className="animate-spin" size={13} /> Reading the conditions…
                </div>
              ) : (
                <p className="serif italic leading-snug" style={{ fontSize: 15, color: THEME.ink }}>
                  {aiVerdict || localVerdict()}
                </p>
              )}
            </div>
          </div>
          <button
            onClick={() => setShowHow((s) => !s)}
            className="flex items-center gap-1 mt-3"
            style={{ fontSize: 11, color: THEME.kelp }}
          >
            <Info size={12} /> How this score works {showHow ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
          {showHow && (
            <p className="mt-2 leading-relaxed" style={{ fontSize: 12, color: THEME.slack }}>
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
            <span className="uppercase tracking-wide" style={{ fontSize: 11, color: THEME.ink }}>
              Tide, next 42 hours
            </span>
            {currentPoint ? (
              <span className="mono" style={{ fontSize: 10, color: THEME.slack }}>Current: {currentPoint.v.toFixed(1)} ft</span>
            ) : null}
            {tide?.station ? (
              <span className="mono" style={{ fontSize: 10, color: THEME.slack }}>NOAA {tide.station.name}</span>
            ) : null}
          </div>
          {series.length ? (
            <TideChart series={series} nowMs={now} windows={windows} sunEvents={sunEvents} currentPoint={currentPoint} />
          ) : (
            <div className="h-40 flex items-center justify-center" style={{ color: THEME.slack }}>
              <Loader2 className="animate-spin mr-2" size={16} /> Loading tide curve…
            </div>
          )}
          <div className="flex items-center gap-3 mt-2 " style={{ fontSize: 10, color: THEME.slack }}>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: THEME.bite, opacity: 0.4 }} /> good window</span>
            <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-0.5" style={{ background: THEME.kelp }} /> sunrise / sunset</span>
          </div>
        </div>

        {/* best windows */}
        {windows.length > 0 && (
          <div className="mb-4">
            <div className="uppercase tracking-wide mb-2" style={{ fontSize: 11, color: THEME.slack }}>Best windows ahead</div>
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

        {/* ask panel */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-2" style={{ fontSize: 11, color: THEME.ink }}>Ask about conditions</div>
          {chatMessages.length > 0 && (
            <div className="flex flex-col gap-2 mb-3 max-h-64 overflow-y-auto">
              {chatMessages.map((m, i) => (
                <div key={i} className={`rounded-lg px-3 py-2 ${m.role === "user" ? "self-end" : "self-start"}`}
                  style={{
                    background: m.role === "user" ? THEME.ink : THEME.paperDeep,
                    color: m.role === "user" ? THEME.white : THEME.ink,
                    fontSize: 13,
                    maxWidth: "85%",
                  }}>
                  {m.text}
                </div>
              ))}
              {chatLoading && (
                <div className="flex items-center gap-2" style={{ fontSize: 13, color: THEME.slack }}>
                  <Loader2 className="animate-spin" size={12} /> thinking…
                </div>
              )}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
              placeholder="Worth fishing the evening tide?"
              className="flex-1 rounded-lg px-3 py-2 "
              style={{ fontSize: 13, border: `1px solid ${THEME.line}`, background: THEME.paper, color: THEME.ink }}
            />
            <button
              onClick={sendChat}
              disabled={chatLoading || !chatInput.trim()}
              className="rounded-lg px-3 flex items-center justify-center motion-safe:transition-opacity disabled:opacity-40"
              style={{ background: THEME.kelp, color: THEME.white }}
              aria-label="Send question"
            >
              <Send size={15} />
            </button>
          </div>
          <div className="flex flex-wrap gap-2 mt-2">
            {["Is the morning tide better than evening?", "Does wind affect the bite today?"].map((q) => (
              <button
                key={q}
                onClick={() => setChatInput(q)}
                className="rounded-full px-3 py-1"
                style={{ fontSize: 11, background: THEME.paperDeep, color: THEME.ink, border: `1px solid ${THEME.line}` }}
              >
                {q}
              </button>
            ))}
          </div>
        </div>

        {/* catch log */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.white, border: `1px solid ${THEME.line}` }}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5" style={{ color: THEME.ink }}>
              <span className="uppercase tracking-wide" style={{ fontSize: 11 }}>Your catch log</span>
            </div>
            <button
              onClick={() => setShowLogForm((s) => !s)}
              className="flex items-center gap-1 rounded-full px-2.5 py-1"
              style={{ fontSize: 12, background: THEME.kelp, color: THEME.white }}
            >
              {showLogForm ? <X size={12} /> : <Plus size={12} />} {showLogForm ? "Cancel" : "Log a catch"}
            </button>
          </div>

          {showLogForm && (
            <div className="flex flex-col gap-2 mb-3 p-3 rounded-xl" style={{ background: THEME.paper }}>
              <input
                value={form.species}
                onChange={(e) => setForm({ ...form, species: e.target.value })}
                placeholder="Species (coho, blackmouth, cutthroat…)"
                className="rounded-lg px-3 py-2 "
                style={{ fontSize: 13, border: `1px solid ${THEME.line}`, background: THEME.white }}
              />
              <div className="flex gap-2">
                <input
                  value={form.length}
                  onChange={(e) => setForm({ ...form, length: e.target.value })}
                  placeholder="Length (in)"
                  className="w-24 rounded-lg px-3 py-2 "
                  style={{ fontSize: 13, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
                <input
                  value={form.bait}
                  onChange={(e) => setForm({ ...form, bait: e.target.value })}
                  placeholder="Bait or lure"
                  className="flex-1 rounded-lg px-3 py-2 "
                  style={{ fontSize: 13, border: `1px solid ${THEME.line}`, background: THEME.white }}
                />
              </div>
              <textarea
                value={form.notes}
                onChange={(e) => setForm({ ...form, notes: e.target.value })}
                placeholder="Notes"
                rows={2}
                className="rounded-lg px-3 py-2 resize-none"
                style={{ fontSize: 13, border: `1px solid ${THEME.line}`, background: THEME.white }}
              />
              <div className="flex flex-col gap-2">
                <label className="rounded-lg px-3 py-2 text-center cursor-pointer" style={{ fontSize: 13, border: `1px dashed ${THEME.line}`, background: THEME.paper, color: THEME.slack }}>
                  {form.photoPreview ? "Change photo" : "Add a photo"}
                  <input
                    type="file"
                    accept="image/*"
                    capture="environment"
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
              <div style={{ fontSize: 11, color: THEME.slack }}>
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
            <p style={{ fontSize: 13, color: THEME.slack }}>
              No catches logged yet. Every entry saves the conditions at the time, so patterns show up over a season.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {catches.map((c) => (
                <div key={c.id} className="rounded-xl p-3" style={{ background: THEME.paper }}>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium" style={{ fontSize: 14, color: THEME.ink }}>
                        {c.species}{c.length ? ` · ${c.length}"` : ""}
                      </div>
                      <div style={{ fontSize: 11, color: THEME.slack }}>
                        {formatDayLabel(toPacificPseudo(c.created_at), now)} {formatTime(toPacificPseudo(c.created_at))}{c.bait ? ` · ${c.bait}` : ""}
                      </div>
                      {c.notes && <div className="mt-1" style={{ fontSize: 12, color: THEME.ink }}>{c.notes}</div>}
                      {c.conditions && (
                        <div className="mono mt-1" style={{ fontSize: 10, color: THEME.slack }}>
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
                    <button onClick={() => deleteCatch(c.id, c.photo_url)} aria-label="Delete catch" className="shrink-0">
                      <Trash2 size={14} style={{ color: THEME.slack }} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* regs reminder */}
        <div className="rounded-2xl p-4 mb-4" style={{ background: THEME.paperDeep, border: `1px solid ${THEME.line}` }}>
          <div className="uppercase tracking-wide mb-2" style={{ fontSize: 11, color: THEME.ink }}>Know before you go</div>
          <ul className="leading-relaxed list-disc pl-4" style={{ fontSize: 12, color: THEME.ink }}>
            <li>Marine Area 13 is the only Washington marine area open to salmon fishing year round, and it allows the two-pole endorsement.</li>
            <li>Single-point barbless hooks are required for salmon here.</li>
            <li>Daily limits, size limits, and species-specific rules change through the season and can shift with emergency orders.</li>
          </ul>
          <a
            href="https://wdfw.wa.gov/fishing/locations/marine-areas/south-puget-sound"
            target="_blank"
            rel="noopener noreferrer"
            className="underline inline-block mt-2"
            style={{ fontSize: 12, color: THEME.slackDeep }}
          >
            Check current WDFW rules for Marine Area 13
          </a>
        </div>

        {/* about / portfolio footer */}
        <button
          onClick={() => setShowAbout((s) => !s)}
          className="w-full text-left uppercase tracking-wide flex items-center justify-between py-2"
          style={{ fontSize: 11, color: THEME.ink }}
        >
          About this tool {showAbout ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        {showAbout && (
          <p className="leading-relaxed pb-4" style={{ fontSize: 12, color: THEME.slack }}>
            Built for the Fox Island Fishing Pier on Fox Island, WA. Tide data comes from NOAA, the government's
            tide agency. Weather and water temperature come from Open-Meteo, a weather data service. The written
            summary at the top is generated by Claude, an AI assistant, based on the same numbers shown above. The
            score is a starting point based on general fishing guidance for this spot, not a guarantee you'll catch
            anything. Your catch log is private and saved so you can look back on past trips.
          </p>
        )}
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
