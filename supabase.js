import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import {
  ResponsiveContainer, LineChart, Line, AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell,
} from "recharts";
import { supabase } from "./supabase";

/* StrideLab — reads your runs from Supabase, behind a login. */

const KM = 1000, MI = 1609.34;
function fmtDist(m, units) {
  if (m == null) return "—";
  const v = m / (units === "mi" ? MI : KM);
  return v.toFixed(2);
}
const distUnit = (u) => (u === "mi" ? "mi" : "km");
function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}
function fmtPace(secPerKm, units) {
  if (secPerKm == null || !isFinite(secPerKm) || secPerKm <= 0) return "—";
  const per = secPerKm * (units === "mi" ? MI / KM : 1);
  const m = Math.floor(per / 60), s = Math.round(per % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
const paceUnit = (u) => (u === "mi" ? "/mi" : "/km");
function fmtDate(iso, opts) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, opts || { month: "short", day: "numeric", year: "numeric" });
}
function fmtShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function weekKey(iso) {
  const d = new Date(iso);
  const day = (d.getDay() + 6) % 7; // Monday start
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

function zonesFor(maxHr) {
  return [
    { name: "Z1", lo: 0.0, hi: 0.6, color: "#3a4452" },
    { name: "Z2", lo: 0.6, hi: 0.7, color: "#4cc9f0" },
    { name: "Z3", lo: 0.7, hi: 0.8, color: "#5fd068" },
    { name: "Z4", lo: 0.8, hi: 0.9, color: "#ffb020" },
    { name: "Z5", lo: 0.9, hi: 2.0, color: "#ff5a4d" },
  ].map((z) => ({ ...z, loBpm: Math.round(z.lo * maxHr), hiBpm: Math.round(z.hi * maxHr) }));
}
function zoneDist(points, maxHr) {
  const z = zonesFor(maxHr);
  const counts = z.map(() => 0);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const hr = points[i].hr;
    if (hr == null) continue;
    const dt = points[i].e - points[i - 1].e;
    if (dt <= 0) continue;
    const ratio = hr / maxHr;
    const idx = z.findIndex((zz) => ratio >= zz.lo && ratio < zz.hi);
    if (idx >= 0) { counts[idx] += dt; total += dt; }
  }
  return z.map((zz, i) => ({ ...zz, sec: counts[i], pct: total ? (counts[i] / total) * 100 : 0 }));
}



const COACH_SYSTEM =
  "You are an expert running coach and exercise physiologist analyzing a runner's own Garmin data. " +
  "Be specific, reference the actual numbers given, and stay concise. Use plain language, avoid hedging and filler. " +
  "Prioritize: pacing execution, aerobic efficiency / cardiac drift, training load balance, and 1-2 concrete next actions. " +
  "Never invent data not provided. Format with short paragraphs and the occasional bullet, no headers.";

async function askAI(prompt, system) {
  const messages = Array.isArray(prompt) ? prompt : [{ role: "user", content: prompt }];
  const res = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages }),
  });
  if (res.status === 501) throw new Error("AI not enabled");
  if (!res.ok) throw new Error("AI request failed");
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
}

const SUMMARY_COLS = "id,garmin_activity_id,source,name,type,start_time,distance_m,duration_s,elapsed_s,avg_hr,max_hr,avg_cadence,avg_pace_s_per_km,elev_gain_m,calories,efficiency,decoupling,splits";
const mapRow = (r) => ({
  id: r.id, name: r.name, type: r.type, startTime: r.start_time,
  distance: r.distance_m, duration: r.duration_s, elapsed: r.elapsed_s,
  avgHr: r.avg_hr, maxHr: r.max_hr, avgCad: r.avg_cadence,
  avgPace: r.avg_pace_s_per_km, elevGain: r.elev_gain_m, calories: r.calories,
  efficiency: r.efficiency, decoupling: r.decoupling, splits: r.splits || [],
});
async function fetchRuns() {
  const { data, error } = await supabase.from("runs").select(SUMMARY_COLS).order("start_time", { ascending: false });
  if (error) throw error;
  return (data || []).map(mapRow);
}


function workoutPrompt(a, units) {
  const splits = a.splits.slice(0, 30).map((s, i) =>
    `  km ${s.km}: ${fmtPace(s.sec / (s.km - (a.splits[i - 1]?.km || 0)), units)}${paceUnit(units)}${s.avgHr ? `, ${s.avgHr}bpm` : ""}`).join("\n");
  return `Analyze this single run.
Name: ${a.name}
Date: ${fmtDate(a.startTime, { weekday: "long", month: "short", day: "numeric" })}
Distance: ${fmtDist(a.distance, units)} ${distUnit(units)}
Moving time: ${fmtDur(a.duration)}
Avg pace: ${fmtPace(a.avgPace, units)}${paceUnit(units)}
Avg HR: ${a.avgHr ?? "n/a"}  Max HR: ${a.maxHr ?? "n/a"}
Avg cadence: ${a.avgCad ?? "n/a"} spm
Elevation gain: ${a.elevGain} m
Cardiac drift (decoupling): ${a.decoupling != null ? a.decoupling.toFixed(1) + "%" : "n/a"}
Splits:
${splits}

Give: (1) what kind of session this was and how well it was executed, (2) what the pacing and HR pattern reveal, (3) one actionable takeaway. Keep it under 180 words.`;
}
function trendPrompt(list, units) {
  const rows = list.map((a) =>
    `${fmtDate(a.startTime, { month: "short", day: "numeric" })} | ${a.name} | ${fmtDist(a.distance, units)}${distUnit(units)} | ${fmtPace(a.avgPace, units)}${paceUnit(units)} | HR ${a.avgHr ?? "-"} | eff ${a.efficiency ?? "-"} | drift ${a.decoupling != null ? a.decoupling.toFixed(0) + "%" : "-"}`
  ).join("\n");
  return `Here are ${list.length} of my recent runs (oldest to newest). "eff" = aerobic efficiency (higher is better), "drift" = cardiac drift.
${rows}

Analyze the trend over this period: pace progression, aerobic efficiency, HR at given paces, weekly volume, and training balance (easy vs hard). Call out specific improvements or regressions with the numbers. End with 2-3 concrete suggestions. Under 220 words.`;
}

/* ============================================================
   UI

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@500;600;700&family=Saira:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap');
.sl-root *{box-sizing:border-box;margin:0;padding:0}
.sl-root{
  --bg:#090b0e; --panel:#13171c; --panel2:#1a1f26; --line:#262d36;
  --text:#e8edf2; --dim:#7f8b98; --dim2:#566270;
  --accent:#c6f24e; --hr:#ff5a4d; --pace:#4cc9f0; --cad:#b794f6; --elev:#6b7785;
  --font-d:'Saira Condensed',sans-serif; --font-b:'Saira',sans-serif; --font-m:'IBM Plex Mono',monospace;
  font-family:var(--font-b); background:var(--bg); color:var(--text);
  min-height:100vh; width:100%; -webkit-font-smoothing:antialiased;
}
.sl-bg{position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(1200px 500px at 80% -10%, rgba(198,242,78,.06), transparent 60%),
    radial-gradient(900px 500px at -10% 20%, rgba(76,201,240,.05), transparent 60%);
}
.sl-wrap{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 16px 80px}
.sl-top{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 0 12px;flex-wrap:wrap}
.sl-logo{font-family:var(--font-d);font-weight:700;font-size:26px;letter-spacing:.02em;text-transform:uppercase;display:flex;align-items:center;gap:9px}
.sl-logo b{color:var(--accent)}
.sl-logo .tk{display:inline-block;width:10px;height:22px;background:var(--accent);transform:skewX(-12deg);box-shadow:14px 0 0 var(--hr),28px 0 0 var(--pace)}
.sl-sub{font-family:var(--font-m);font-size:11px;color:var(--dim2);letter-spacing:.18em;text-transform:uppercase}
.sl-tabs{display:flex;gap:4px;background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:4px;flex-wrap:wrap}
.sl-tab{font-family:var(--font-d);text-transform:uppercase;letter-spacing:.06em;font-size:14px;font-weight:600;color:var(--dim);
  background:none;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;transition:.15s}
.sl-tab:hover{color:var(--text)}
.sl-tab.on{background:var(--accent);color:#0a0d06}
.sl-btn{font-family:var(--font-d);text-transform:uppercase;letter-spacing:.05em;font-weight:600;font-size:13px;
  background:var(--panel2);color:var(--text);border:1px solid var(--line);padding:9px 14px;border-radius:9px;cursor:pointer;transition:.15s}
.sl-btn:hover{border-color:var(--accent);color:var(--accent)}
.sl-btn.primary{background:var(--accent);color:#0a0d06;border-color:var(--accent)}
.sl-btn.primary:hover{filter:brightness(1.08);color:#0a0d06}
.sl-btn:disabled{opacity:.45;cursor:not-allowed}
.sl-grid{display:grid;gap:14px}
.sl-panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:16px}
.sl-h{font-family:var(--font-d);text-transform:uppercase;letter-spacing:.05em;font-weight:600;font-size:15px;color:var(--dim);margin-bottom:12px;display:flex;align-items:center;gap:8px}
.sl-h .dot{width:7px;height:7px;border-radius:2px;background:var(--accent)}
.stat-label{font-family:var(--font-m);font-size:10.5px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim2)}
.stat-val{font-family:var(--font-d);font-weight:700;line-height:1;letter-spacing:.01em}
.stat-unit{font-family:var(--font-b);font-size:13px;color:var(--dim);font-weight:500}
.kpi{background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:14px 15px;position:relative;overflow:hidden}
.kpi::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent)}
.kpi.hr::after{background:var(--hr)} .kpi.pace::after{background:var(--pace)} .kpi.cad::after{background:var(--cad)}
.row{display:flex;align-items:center;gap:10px}
.muted{color:var(--dim)} .mono{font-family:var(--font-m)}
.act-row{display:flex;align-items:center;gap:14px;padding:12px 6px;border-bottom:1px solid var(--line);cursor:pointer;transition:.12s;border-radius:8px}
.act-row:hover{background:var(--panel2)}
.act-badge{width:42px;height:42px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;
  font-family:var(--font-d);font-weight:700;font-size:18px;background:var(--panel2);border:1px solid var(--line)}
.chip{font-family:var(--font-m);font-size:11px;padding:3px 8px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim)}
.ai-box{background:linear-gradient(180deg,rgba(198,242,78,.05),transparent);border:1px solid var(--line);border-radius:12px;padding:15px;white-space:pre-wrap;line-height:1.55;font-size:14.5px}
.ai-box .ai-tag{font-family:var(--font-m);font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);display:block;margin-bottom:9px}
.split-bar{height:9px;border-radius:5px;background:var(--pace);opacity:.9}
.zone-seg{height:26px;display:flex;align-items:center;justify-content:center;font-family:var(--font-m);font-size:11px;color:#0a0d06;font-weight:500}
.empty{text-align:center;padding:46px 20px;color:var(--dim)}
.empty h2{font-family:var(--font-d);text-transform:uppercase;letter-spacing:.04em;font-size:26px;color:var(--text);margin-bottom:10px}
input.sl-in,textarea.sl-in{background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--text);font-family:var(--font-b);font-size:14px;padding:9px 12px;width:100%}
input.sl-in:focus,textarea.sl-in:focus{outline:none;border-color:var(--accent)}
.coach-msg{padding:11px 14px;border-radius:12px;margin-bottom:10px;line-height:1.5;font-size:14.5px;white-space:pre-wrap}
.coach-msg.u{background:var(--panel2);border:1px solid var(--line);margin-left:36px}
.coach-msg.a{background:linear-gradient(180deg,rgba(198,242,78,.05),transparent);border:1px solid var(--line);margin-right:18px}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--dim2);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}
.fade{animation:fade .35s ease both}
@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.back{font-family:var(--font-d);text-transform:uppercase;letter-spacing:.05em;font-size:13px;color:var(--dim);background:none;border:none;cursor:pointer;padding:0}
.back:hover{color:var(--accent)}
a.sl-link{color:var(--accent);text-decoration:none}
`;

function KPI({ label, value, unit, tone }) {
  return (
    <div className={`kpi ${tone || ""}`}>
      <div className="stat-label">{label}</div>
      <div className="row" style={{ alignItems: "baseline", marginTop: 6, gap: 5 }}>
        <span className="stat-val" style={{ fontSize: 30 }}>{value}</span>
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
    </div>
  );
}

const chartAxis = { stroke: "#3a444f", fontSize: 11, fontFamily: "'IBM Plex Mono',monospace", tick: { fill: "#7f8b98" } };
const tipStyle = { background: "#1a1f26", border: "1px solid #262d36", borderRadius: 10, fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "#e8edf2" };

function Dashboard({ acts, units, onOpen }) {
  const stats = useMemo(() => {
    if (!acts.length) return null;
    const sorted = [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    const now = Date.now();
    const wk = sorted.filter((a) => now - new Date(a.startTime) < 7 * 86400000);
    const mo = sorted.filter((a) => now - new Date(a.startTime) < 30 * 86400000);
    const sum = (arr, f) => arr.reduce((s, a) => s + (f(a) || 0), 0);
    return {
      sorted,
      weekDist: sum(wk, (a) => a.distance), weekRuns: wk.length,
      moDist: sum(mo, (a) => a.distance), moRuns: mo.length,
      moTime: sum(mo, (a) => a.duration),
    };
  }, [acts]);

  const weekly = useMemo(() => {
    const m = {};
    acts.forEach((a) => {
      const k = weekKey(a.startTime);
      m[k] = (m[k] || 0) + a.distance / (units === "mi" ? MI : KM);
    });
    return Object.entries(m).sort().slice(-12).map(([k, v]) => ({ week: fmtShortDate(k), dist: +v.toFixed(1) }));
  }, [acts, units]);

  const paceTrend = useMemo(() =>
    [...acts].sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      .filter((a) => a.avgPace).slice(-30)
      .map((a) => ({ d: fmtShortDate(a.startTime), pace: +(a.avgPace / 60).toFixed(2), hr: a.avgHr })),
    [acts]);

  if (!stats) return null;
  return (
    <div className="sl-grid fade" style={{ gridTemplateColumns: "1fr" }}>
      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))" }}>
        <KPI label="This week" value={fmtDist(stats.weekDist, units)} unit={distUnit(units)} />
        <KPI label="Runs / 7d" value={stats.weekRuns} tone="pace" />
        <KPI label="Last 30 days" value={fmtDist(stats.moDist, units)} unit={distUnit(units)} />
        <KPI label="Time / 30d" value={fmtDur(stats.moTime)} tone="hr" />
        <KPI label="Total runs" value={acts.length} tone="cad" />
      </div>

      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" />Weekly volume — {distUnit(units)}</div>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={weekly} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="week" {...chartAxis} interval="preserveStartEnd" />
              <YAxis {...chartAxis} />
              <Tooltip contentStyle={tipStyle} cursor={{ fill: "rgba(198,242,78,.06)" }} />
              <Bar dataKey="dist" radius={[4, 4, 0, 0]} fill="#c6f24e" />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" style={{ background: "var(--pace)" }} />Avg pace trend — min{paceUnit(units)}</div>
          <ResponsiveContainer width="100%" height={210}>
            <LineChart data={paceTrend} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="d" {...chartAxis} interval="preserveStartEnd" />
              <YAxis {...chartAxis} domain={["auto", "auto"]} reversed tickFormatter={(v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`} />
              <Tooltip contentStyle={tipStyle} formatter={(v, n) => n === "pace" ? [`${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`, "pace"] : [v, n]} />
              <Line dataKey="pace" stroke="#4cc9f0" strokeWidth={2} dot={{ r: 2, fill: "#4cc9f0" }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="sl-panel">
        <div className="sl-h"><span className="dot" style={{ background: "var(--hr)" }} />Recent activity</div>
        {stats.sorted.slice(0, 6).map((a) => <ActRow key={a.id} a={a} units={units} onOpen={onOpen} />)}
      </div>
    </div>
  );
}

function ActRow({ a, units, onOpen }) {
  const hard = a.avgHr && a.maxHr && a.avgHr > 158;
  return (
    <div className="act-row" onClick={() => onOpen(a.id)}>
      <div className="act-badge" style={{ color: hard ? "var(--hr)" : "var(--accent)" }}>{fmtDist(a.distance, units).split(".")[0]}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 15, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}</div>
        <div className="mono muted" style={{ fontSize: 12 }}>{fmtDate(a.startTime, { weekday: "short", month: "short", day: "numeric" })}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div className="stat-val" style={{ fontSize: 18 }}>{fmtDist(a.distance, units)}<span className="stat-unit"> {distUnit(units)}</span></div>
      </div>
      <div style={{ textAlign: "right", minWidth: 64 }}>
        <div className="stat-val mono" style={{ fontSize: 16, color: "var(--pace)" }}>{fmtPace(a.avgPace, units)}</div>
        <div className="stat-label">{paceUnit(units).replace("/", "per ")}</div>
      </div>
      <div style={{ textAlign: "right", minWidth: 50 }} className="hideSm">
        <div className="stat-val mono" style={{ fontSize: 16, color: "var(--hr)" }}>{a.avgHr ?? "—"}</div>
        <div className="stat-label">bpm</div>
      </div>
    </div>
  );
}

/* ---------- Activity list ---------- */
function ActivityList({ acts, units, onOpen }) {
  const [q, setQ] = useState("");
  const sorted = useMemo(() =>
    [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime))
      .filter((a) => a.name.toLowerCase().includes(q.toLowerCase())),
    [acts, q]);
  return (
    <div className="sl-panel fade">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 10 }}>
        <div className="sl-h" style={{ margin: 0 }}><span className="dot" />All runs · {acts.length}</div>
        <input className="sl-in" style={{ maxWidth: 240 }} placeholder="Filter by name…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {sorted.map((a) => <ActRow key={a.id} a={a} units={units} onOpen={onOpen} />)}
    </div>
  );
}

/* ---------- Route shape (SVG, tile-free) ---------- */
function Route({ points }) {
  const pts = points.filter((p) => p.lat != null && p.lon != null);
  if (pts.length < 3) return null;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
  const w = 100, h = 100, pad = 8;
  const sx = (lo) => pad + ((lo - minLo) / (maxLo - minLo || 1)) * (w - 2 * pad);
  const sy = (la) => pad + (1 - (la - minLa) / (maxLa - minLa || 1)) * (h - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${sx(p.lon).toFixed(1)} ${sy(p.lat).toFixed(1)}`).join(" ");
  const a = pts[0], b = pts[pts.length - 1];
  return (
    <svg viewBox="0 0 100 100" style={{ width: "100%", height: 200 }}>
      <path d={d} fill="none" stroke="#c6f24e" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round" opacity="0.95" />
      <circle cx={sx(a.lon)} cy={sy(a.lat)} r="2.4" fill="#4cc9f0" />
      <circle cx={sx(b.lon)} cy={sy(b.lat)} r="2.4" fill="#ff5a4d" />
    </svg>
  );
}

/* ---------- Activity detail ---------- */

function ActivityDetail({ summary, units, maxHr, onBack }) {
  const [a, setA] = useState(null);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await supabase.from("runs").select("points,splits").eq("id", summary.id).single();
      if (live) setA({ ...summary, points: (data && data.points) || [], splits: (data && data.splits) || summary.splits || [] });
    })();
    return () => { live = false; };
  }, [summary]);
  if (!a) return <div className="sl-panel"><span className="spin" /> loading…</div>;

  const zones = a.points.some((p) => p.hr != null) ? zoneDist(a.points, maxHr) : null;
  const series = a.points.map((p) => ({
    km: +(p.d / 1000).toFixed(2), elapsed: p.e,
    pace: p.pace ? +(p.pace / 60).toFixed(2) : null, hr: p.hr, ele: p.ele, cad: p.cad,
  }));
  const splitMax = Math.max(...a.splits.map((s, i) => s.sec / (s.km - (a.splits[i - 1]?.km || 0))));

  const runAI = async () => {
    setBusy(true); setErr(null);
    try { setAi(await askAI(workoutPrompt(a, units), COACH_SYSTEM)); }
    catch (e) { setErr("Couldn't reach the AI service. Try again."); }
    setBusy(false);
  };

  return (
    <div className="sl-grid fade" style={{ gridTemplateColumns: "1fr" }}>
      <button className="back" onClick={onBack}>← all runs</button>
      <div className="sl-panel">
        <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontFamily: "var(--font-d)", fontSize: 26, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".02em" }}>{a.name}</div>
            <div className="mono muted" style={{ fontSize: 13 }}>{fmtDate(a.startTime, { weekday: "long", month: "long", day: "numeric", year: "numeric" })} · {new Date(a.startTime).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</div>
          </div>
        </div>
        <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(110px,1fr))", marginTop: 14 }}>
          <KPI label="Distance" value={fmtDist(a.distance, units)} unit={distUnit(units)} />
          <KPI label="Moving time" value={fmtDur(a.duration)} />
          <KPI label="Avg pace" value={fmtPace(a.avgPace, units)} unit={paceUnit(units)} tone="pace" />
          <KPI label="Avg / Max HR" value={a.avgHr ? `${a.avgHr}/${a.maxHr}` : "—"} tone="hr" />
          <KPI label="Cadence" value={a.avgCad ?? "—"} unit="spm" tone="cad" />
          <KPI label="Elev gain" value={a.elevGain} unit="m" />
          <KPI label="Cardiac drift" value={a.decoupling != null ? a.decoupling.toFixed(1) : "—"} unit="%" tone="hr" />
          <KPI label="Calories" value={a.calories ?? "—"} />
        </div>
      </div>

      {/* AI */}
      <div className="sl-panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div className="sl-h" style={{ margin: 0 }}><span className="dot" />AI workout analysis</div>
          <button className="sl-btn primary" onClick={runAI} disabled={busy}>{busy ? <><span className="spin" /> analyzing</> : ai ? "Re-run" : "Analyze this run"}</button>
        </div>
        {err && <div className="muted" style={{ color: "var(--hr)" }}>{err}</div>}
        {ai ? <div className="ai-box"><span className="ai-tag">Coach · Claude</span>{ai}</div>
          : !busy && <div className="muted" style={{ fontSize: 14 }}>Get specific feedback on pacing execution, HR response, and one thing to work on.</div>}
      </div>

      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        {/* pace + hr */}
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" style={{ background: "var(--pace)" }} />Pace & heart rate over distance</div>
          <ResponsiveContainer width="100%" height={230}>
            <LineChart data={series} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="km" {...chartAxis} tickFormatter={(v) => v.toFixed(0)} />
              <YAxis yAxisId="p" {...chartAxis} reversed domain={["auto", "auto"]} tickFormatter={(v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, "0")}`} width={42} />
              <YAxis yAxisId="h" orientation="right" {...chartAxis} domain={["auto", "auto"]} />
              <Tooltip contentStyle={tipStyle} />
              <Line yAxisId="p" dataKey="pace" stroke="#4cc9f0" strokeWidth={1.8} dot={false} name="pace" />
              <Line yAxisId="h" dataKey="hr" stroke="#ff5a4d" strokeWidth={1.8} dot={false} name="hr" />
            </LineChart>
          </ResponsiveContainer>
        </div>
        {/* elevation */}
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" style={{ background: "var(--elev)" }} />Elevation</div>
          <ResponsiveContainer width="100%" height={230}>
            <AreaChart data={series} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
              <defs><linearGradient id="ele" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6b7785" stopOpacity={0.5} /><stop offset="100%" stopColor="#6b7785" stopOpacity={0.04} /></linearGradient></defs>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="km" {...chartAxis} tickFormatter={(v) => v.toFixed(0)} />
              <YAxis {...chartAxis} domain={["auto", "auto"]} width={42} />
              <Tooltip contentStyle={tipStyle} />
              <Area dataKey="ele" stroke="#8a96a3" strokeWidth={1.5} fill="url(#ele)" name="m" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        {/* splits */}
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" />Splits</div>
          <div className="sl-grid" style={{ gap: 7 }}>
            {a.splits.map((s, i) => {
              const len = s.km - (a.splits[i - 1]?.km || 0);
              const pace = s.sec / len;
              return (
                <div key={i} className="row" style={{ gap: 10 }}>
                  <span className="mono muted" style={{ width: 28, fontSize: 12 }}>{s.partial ? "·" : Math.round(s.km)}</span>
                  <div style={{ flex: 1 }}><div className="split-bar" style={{ width: `${(pace / splitMax) * 100}%`, opacity: 0.45 + 0.55 * (pace / splitMax) }} /></div>
                  <span className="mono" style={{ width: 52, textAlign: "right", color: "var(--pace)" }}>{fmtPace(pace, units)}</span>
                  <span className="mono muted" style={{ width: 42, textAlign: "right", color: s.avgHr ? "var(--hr)" : "var(--dim2)" }}>{s.avgHr ?? "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
        {/* zones + route */}
        <div className="sl-grid" style={{ gap: 14 }}>
          {zones && <div className="sl-panel">
            <div className="sl-h"><span className="dot" style={{ background: "var(--hr)" }} />HR zones <span className="muted" style={{ fontSize: 12, fontFamily: "var(--font-m)", textTransform: "none", letterSpacing: 0 }}>(max {maxHr})</span></div>
            <div style={{ display: "flex", borderRadius: 7, overflow: "hidden", marginBottom: 8 }}>
              {zones.map((z) => z.pct > 0 && <div key={z.name} className="zone-seg" style={{ width: `${z.pct}%`, background: z.color }} title={`${z.name} ${z.pct.toFixed(0)}%`}>{z.pct > 8 ? z.name : ""}</div>)}
            </div>
            <div className="sl-grid" style={{ gridTemplateColumns: "1fr 1fr", gap: 4 }}>
              {zones.map((z) => <div key={z.name} className="row" style={{ gap: 7, fontSize: 12 }}>
                <span style={{ width: 9, height: 9, borderRadius: 2, background: z.color }} />
                <span className="mono">{z.name}</span><span className="muted mono">{z.loBpm}–{z.hiBpm}</span>
                <span style={{ marginLeft: "auto" }} className="mono">{z.pct.toFixed(0)}% · {fmtDur(z.sec)}</span>
              </div>)}
            </div>
          </div>}
          <div className="sl-panel">
            <div className="sl-h"><span className="dot" style={{ background: "var(--pace)" }} />Route</div>
            <Route points={a.points} />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Trends ---------- */

function Trends({ acts, units }) {
  const [range, setRange] = useState(60);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const list = useMemo(() => {
    const cut = Date.now() - range * 86400000;
    return [...acts].filter((a) => new Date(a.startTime) >= cut).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  }, [acts, range]);

  const effSeries = list.filter((a) => a.efficiency).map((a) => ({ d: fmtShortDate(a.startTime), eff: a.efficiency, hr: a.avgHr }));
  const driftSeries = list.filter((a) => a.decoupling != null).map((a) => ({ d: fmtShortDate(a.startTime), drift: +a.decoupling.toFixed(1) }));
  const paceHr = list.filter((a) => a.avgPace && a.avgHr).map((a) => ({ x: +(a.avgPace / 60).toFixed(2), y: a.avgHr }));

  const runAI = async () => {
    setBusy(true); setErr(null);
    try { setAi(await askAI(trendPrompt(list, units), COACH_SYSTEM)); }
    catch (e) { setErr("Couldn't reach the AI service. Try again."); }
    setBusy(false);
  };

  return (
    <div className="sl-grid fade" style={{ gridTemplateColumns: "1fr" }}>
      <div className="row" style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
        <div className="sl-tabs">
          {[30, 60, 90, 180].map((r) => <button key={r} className={`sl-tab ${range === r ? "on" : ""}`} onClick={() => setRange(r)}>{r}d</button>)}
        </div>
        <span className="mono muted" style={{ fontSize: 12 }}>{list.length} runs in window</span>
      </div>

      <div className="sl-panel">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
          <div className="sl-h" style={{ margin: 0 }}><span className="dot" />AI trend analysis · last {range} days</div>
          <button className="sl-btn primary" onClick={runAI} disabled={busy || !list.length}>{busy ? <><span className="spin" /> analyzing</> : ai ? "Re-run" : "Analyze trends"}</button>
        </div>
        {err && <div style={{ color: "var(--hr)" }}>{err}</div>}
        {ai ? <div className="ai-box"><span className="ai-tag">Coach · Claude</span>{ai}</div>
          : !busy && <div className="muted" style={{ fontSize: 14 }}>See how pace, efficiency, and HR are tracking — and what to adjust.</div>}
      </div>

      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))" }}>
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" />Aerobic efficiency <span className="muted" style={{ fontSize: 12, fontFamily: "var(--font-m)", textTransform: "none", letterSpacing: 0 }}>(higher = better)</span></div>
          <ResponsiveContainer width="100%" height={210}>
            <LineChart data={effSeries} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="d" {...chartAxis} interval="preserveStartEnd" />
              <YAxis {...chartAxis} domain={["auto", "auto"]} />
              <Tooltip contentStyle={tipStyle} />
              <Line dataKey="eff" stroke="#c6f24e" strokeWidth={2} dot={{ r: 2 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="sl-panel">
          <div className="sl-h"><span className="dot" style={{ background: "var(--hr)" }} />Cardiac drift per run — %</div>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={driftSeries} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}>
              <CartesianGrid stroke="#1d242c" vertical={false} />
              <XAxis dataKey="d" {...chartAxis} interval="preserveStartEnd" />
              <YAxis {...chartAxis} />
              <Tooltip contentStyle={tipStyle} cursor={{ fill: "rgba(255,90,77,.07)" }} />
              <ReferenceLine y={5} stroke="#5fd068" strokeDasharray="4 4" />
              <Bar dataKey="drift" radius={[3, 3, 0, 0]}>
                {driftSeries.map((e, i) => <Cell key={i} fill={e.drift > 8 ? "#ff5a4d" : e.drift > 5 ? "#ffb020" : "#5fd068"} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

/* ---------- Coach (free chat) ---------- */

function Coach({ acts, units }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, busy]);

  const context = useMemo(() => {
    const recent = [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)).slice(0, 40);
    return recent.map((a) => `${fmtDate(a.startTime, { month: "short", day: "numeric" })} ${a.name}: ${fmtDist(a.distance, units)}${distUnit(units)}, ${fmtPace(a.avgPace, units)}${paceUnit(units)}, HR ${a.avgHr ?? "-"}, eff ${a.efficiency ?? "-"}, drift ${a.decoupling != null ? a.decoupling.toFixed(0) + "%" : "-"}`).join("\n");
  }, [acts, units]);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    const next = [...msgs, { role: "user", content: q }];
    setMsgs(next); setInput(""); setBusy(true);
    try {
      const apiMsgs = next.map((m, i) => i === 0 ? { role: "user", content: `My recent runs:\n${context}\n\nQuestion: ${m.content}` } : m);
      const reply = await askAI(apiMsgs, COACH_SYSTEM);
      setMsgs([...next, { role: "assistant", content: reply }]);
    } catch (e) {
      setMsgs([...next, { role: "assistant", content: "Couldn't reach the AI service — try again in a moment." }]);
    }
    setBusy(false);
  };

  const suggestions = ["What should my next workout be?", "Is my easy pace too fast?", "How is my fitness trending?", "Am I doing too much hard running?"];

  return (
    <div className="sl-panel fade" style={{ display: "flex", flexDirection: "column", minHeight: 460 }}>
      <div className="sl-h"><span className="dot" />Ask your coach</div>
      <div style={{ flex: 1, overflowY: "auto", paddingRight: 4 }}>
        {msgs.length === 0 && (
          <div>
            <div className="muted" style={{ fontSize: 14, marginBottom: 14 }}>I can see your last {Math.min(acts.length, 40)} runs. Ask me anything about your training.</div>
            <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 8 }}>
              {suggestions.map((s) => <button key={s} className="sl-btn" style={{ textAlign: "left", textTransform: "none", letterSpacing: 0, fontFamily: "var(--font-b)", fontWeight: 500 }} onClick={() => setInput(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => <div key={i} className={`coach-msg ${m.role === "user" ? "u" : "a"}`}>{m.content}</div>)}
        {busy && <div className="coach-msg a"><span className="spin" /> thinking…</div>}
        <div ref={endRef} />
      </div>
      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <input className="sl-in" placeholder="Ask about your running…" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="sl-btn primary" onClick={send} disabled={busy || !input.trim()}>Send</button>
      </div>
    </div>
  );
}

/* ---------- Import / Settings ---------- */

function Login() {
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw });
    if (error) setErr(error.message);
    setBusy(false);
  };
  return (
    <div className="sl-panel" style={{ maxWidth: 380, margin: "60px auto" }}>
      <div className="sl-logo" style={{ marginBottom: 4 }}><span className="tk" /> STRIDE<b>LAB</b></div>
      <div className="sl-sub" style={{ marginBottom: 18 }}>sign in</div>
      <input className="sl-in" style={{ marginBottom: 10 }} placeholder="email" type="email"
        value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      <input className="sl-in" style={{ marginBottom: 14 }} placeholder="password" type="password"
        value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
      {err && <div style={{ color: "var(--hr)", fontSize: 13, marginBottom: 10 }}>{err}</div>}
      <button className="sl-btn primary" style={{ width: "100%" }} onClick={submit} disabled={busy}>
        {busy ? <><span className="spin" /> signing in</> : "Sign in"}
      </button>
    </div>
  );
}

function Settings({ units, setUnits, maxHr, setMaxHr }) {
  return (
    <div className="sl-panel fade">
      <div className="sl-h"><span className="dot" />Settings</div>
      <div className="sl-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 16 }}>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>Units</div>
          <div className="sl-tabs" style={{ display: "inline-flex" }}>
            <button className={`sl-tab ${units === "km" ? "on" : ""}`} onClick={() => setUnits("km")}>km</button>
            <button className={`sl-tab ${units === "mi" ? "on" : ""}`} onClick={() => setUnits("mi")}>mi</button>
          </div>
        </div>
        <div>
          <div className="stat-label" style={{ marginBottom: 6 }}>Max heart rate (for zones)</div>
          <input className="sl-in" type="number" style={{ maxWidth: 120 }} value={maxHr}
            onChange={(e) => setMaxHr(Math.max(120, Math.min(220, +e.target.value || 185)))} />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined); // undefined = still checking
  const [acts, setActs] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState("dash");
  const [openId, setOpenId] = useState(null);
  const [units, setUnits] = useState(() => localStorage.getItem("sl_units") || "km");
  const [maxHr, setMaxHr] = useState(() => Number(localStorage.getItem("sl_maxhr")) || 185);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);
  useEffect(() => { localStorage.setItem("sl_units", units); }, [units]);
  useEffect(() => { localStorage.setItem("sl_maxhr", String(maxHr)); }, [maxHr]);

  useEffect(() => {
    if (!session) return;
    setLoadingRuns(true); setErr(null);
    fetchRuns()
      .then((r) => setActs(r))
      .catch((e) => setErr(e.message || "Couldn't load runs"))
      .finally(() => setLoadingRuns(false));
  }, [session]);

  const openSummary = useMemo(() => acts.find((a) => a.id === openId) || null, [acts, openId]);
  const open = (id) => { setOpenId(id); setTab("acts"); };

  if (session === undefined)
    return (<div className="sl-root"><style>{CSS}</style><div className="sl-wrap"><div className="sl-panel" style={{ marginTop: 60 }}><span className="spin" /> loading…</div></div></div>);

  if (!session)
    return (<div className="sl-root"><style>{CSS}</style><div className="sl-bg" /><div className="sl-wrap"><Login /></div></div>);

  const TABS = [["dash", "Dashboard"], ["acts", "Activities"], ["trends", "Trends"], ["coach", "Coach"], ["settings", "Settings"]];

  return (
    <div className="sl-root">
      <style>{CSS}</style>
      <div className="sl-bg" />
      <div className="sl-wrap">
        <div className="sl-top">
          <div>
            <div className="sl-logo"><span className="tk" /> STRIDE<b>LAB</b></div>
            <div className="sl-sub">running telemetry · {acts.length} runs</div>
          </div>
          <div className="sl-tabs">
            {TABS.map(([k, label]) => (
              <button key={k} className={`sl-tab ${tab === k ? "on" : ""}`}
                onClick={() => { setTab(k); if (k !== "acts") setOpenId(null); }}>{label}</button>
            ))}
          </div>
        </div>

        {loadingRuns ? <div className="sl-panel"><span className="spin" /> loading your runs…</div>
          : err ? <div className="sl-panel" style={{ color: "var(--hr)" }}>{err}</div>
            : acts.length === 0 ? <div className="sl-panel empty"><h2>No runs found</h2><p className="muted">Your runs table returned no rows.</p></div>
              : <>
                {tab === "dash" && <Dashboard acts={acts} units={units} onOpen={open} />}
                {tab === "acts" && (openSummary
                  ? <ActivityDetail summary={openSummary} units={units} maxHr={maxHr} onBack={() => setOpenId(null)} />
                  : <ActivityList acts={acts} units={units} onOpen={open} />)}
                {tab === "trends" && <Trends acts={acts} units={units} />}
                {tab === "coach" && <Coach acts={acts} units={units} />}
                {tab === "settings" && <Settings units={units} setUnits={setUnits} maxHr={maxHr} setMaxHr={setMaxHr} />}
              </>}

        <div style={{ textAlign: "center", marginTop: 30, fontSize: 11 }} className="mono muted">
          StrideLab · {session.user?.email} · <span style={{ cursor: "pointer", color: "var(--accent)" }} onClick={() => supabase.auth.signOut()}>sign out</span>
        </div>
      </div>
    </div>
  );
}
