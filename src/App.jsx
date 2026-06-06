import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell,
} from 'recharts';
import { supabase } from './supabase';

const KM = 1000;
const MI = 1609.34;
const DAY = 86400000;
const nl = String.fromCharCode(10);

const distUnit = (u) => (u === 'mi' ? 'mi' : 'km');
const paceUnit = (u) => (u === 'mi' ? '/mi' : '/km');
const sum = (arr, f = (x) => x) => arr.reduce((t, x) => t + (f(x) || 0), 0);
const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);
const pct = (v) => (v == null || !isFinite(v) ? '-' : `${Math.round(v)}%`);

function fmtDist(m, units) {
  if (m == null) return '-';
  return (m / (units === 'mi' ? MI : KM)).toFixed(2);
}
function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return '-';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtPace(secPerKm, units) {
  if (secPerKm == null || !isFinite(secPerKm) || secPerKm <= 0) return '-';
  const per = secPerKm * (units === 'mi' ? MI / KM : 1);
  return `${Math.floor(per / 60)}:${String(Math.round(per % 60)).padStart(2, '0')}`;
}
function fmtDate(iso, opts) {
  return new Date(iso).toLocaleDateString(undefined, opts || { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtShortDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function weekKey(iso) {
  const d = new Date(iso);
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
function anchorTime(acts) {
  return Math.max(Date.now(), ...acts.map((a) => new Date(a.startTime).getTime()).filter(Boolean));
}
function splitPaces(a) {
  return (a.splits || []).map((s, i) => {
    const len = s.km - (a.splits[i - 1]?.km || 0);
    return len > 0 ? s.sec / len : null;
  }).filter((v) => v && isFinite(v));
}
function progressionScore(a) {
  const paces = splitPaces(a);
  if (paces.length < 4) return null;
  const n = Math.max(1, Math.floor(paces.length / 3));
  const first = mean(paces.slice(0, n));
  const last = mean(paces.slice(-n));
  return first && last ? ((first - last) / first) * 100 : null;
}
function classifyRun(a, maxHr = 185) {
  const name = (a.name || '').toLowerCase();
  const ratio = a.avgHr && maxHr ? a.avgHr / maxHr : null;
  const prog = progressionScore(a);
  const km = (a.distance || 0) / KM;
  const min = (a.duration || 0) / 60;
  let label = 'Easy';
  let intensity = 'easy';
  let reason = ratio ? `avg HR ${Math.round(ratio * 100)}% max` : 'name and distance';
  const has = (...terms) => terms.some((t) => name.includes(t));

  if (has('race', 'marathon', 'half', '5k', '10k', 'time trial')) {
    label = 'Race'; intensity = 'hard'; reason = 'race marker';
  } else if (has('interval', 'repeat', 'workout', 'fartlek', 'vo2', 'speed', '400', '800', '1k')) {
    label = 'Intervals'; intensity = 'hard'; reason = 'repeat or speed marker';
  } else if (has('hill', 'climb', 'vert')) {
    label = 'Hills'; intensity = ratio && ratio < 0.78 ? 'moderate' : 'hard'; reason = 'hill marker';
  } else if (has('tempo', 'threshold', 'steady', 'progression')) {
    label = has('progression') ? 'Progression' : 'Tempo'; intensity = 'hard'; reason = 'quality marker';
  } else if (prog != null && prog >= 6) {
    label = 'Progression'; intensity = ratio && ratio < 0.82 ? 'moderate' : 'hard'; reason = `${prog.toFixed(0)}% faster late`;
  } else if (km >= 18 || min >= 90) {
    label = 'Long'; intensity = ratio && ratio >= 0.82 ? 'hard' : 'moderate'; reason = km >= 18 ? `${km.toFixed(1)} km` : `${Math.round(min)} min`;
  } else if (has('recovery', 'shakeout')) {
    label = 'Recovery'; intensity = 'easy'; reason = 'recovery marker';
  } else if (ratio != null && ratio >= 0.84) {
    label = 'Hard'; intensity = 'hard';
  } else if (ratio != null && ratio >= 0.76) {
    label = 'Steady'; intensity = 'moderate';
  }
  return { label, intensity, reason, hard: intensity === 'hard', ratio, progression: prog };
}
function sessionLoad(a, maxHr = 185) {
  const min = (a.duration || 0) / 60;
  if (!min) return 0;
  const cls = classifyRun(a, maxHr);
  const ratio = cls.ratio;
  const hrFactor = ratio == null ? null : ratio < 0.72 ? 0.8 : ratio < 0.8 ? 1 : ratio < 0.88 ? 1.25 : 1.55;
  const fallback = cls.hard ? 1.35 : cls.intensity === 'moderate' ? 1.05 : 0.8;
  return Math.round(min * (hrFactor || fallback));
}
function trainingProfile(acts, units, maxHr = 185) {
  const sorted = [...acts].sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const anchor = anchorTime(sorted);
  const within = (days) => sorted.filter((a) => anchor - new Date(a.startTime).getTime() < days * DAY);
  const d7 = within(7);
  const d28 = within(28);
  const load7 = sum(d7, (a) => sessionLoad(a, maxHr));
  const load28 = sum(d28, (a) => sessionLoad(a, maxHr));
  const chronic = load28 / 4;
  const acwr = chronic ? load7 / chronic : null;
  const totalMin28 = sum(d28, (a) => a.duration) / 60;
  const hardMin28 = sum(d28.filter((a) => classifyRun(a, maxHr).hard), (a) => a.duration) / 60;
  const hardShare = totalMin28 ? (hardMin28 / totalMin28) * 100 : null;
  const weekDist = sum(d7, (a) => a.distance);
  const longest7 = Math.max(0, ...d7.map((a) => a.distance || 0));
  const longShare = weekDist ? (longest7 / weekDist) * 100 : null;
  const driftFlags = within(14).filter((a) => a.decoupling != null && a.decoupling > 8).length;
  const daily = Array.from({ length: 7 }, (_, i) => {
    const start = anchor - (6 - i) * DAY;
    const end = start + DAY;
    return sum(sorted.filter((a) => {
      const t = new Date(a.startTime).getTime();
      return t >= start && t < end;
    }), (a) => sessionLoad(a, maxHr));
  });
  const avgDay = mean(daily);
  const variance = mean(daily.map((v) => Math.pow(v - avgDay, 2)));
  const sd = Math.sqrt(variance);
  const monotony = sd ? avgDay / sd : load7 ? 3 : 0;
  const strain = Math.round(load7 * monotony);
  const flags = [];
  if (acwr != null && acwr > 1.35) flags.push({ level: 'red', text: `Load spike: 7d is ${(acwr * 100).toFixed(0)}% of 28d baseline` });
  else if (acwr != null && acwr > 1.2) flags.push({ level: 'yellow', text: `Load rising: 7d is ${(acwr * 100).toFixed(0)}% of 28d baseline` });
  if (hardShare != null && hardShare > 35) flags.push({ level: 'red', text: `Hard running is ${pct(hardShare)} of recent time` });
  else if (hardShare != null && hardShare > 25) flags.push({ level: 'yellow', text: `Hard running is ${pct(hardShare)} of recent time` });
  if (longShare != null && longShare > 38) flags.push({ level: 'yellow', text: `Long run is ${pct(longShare)} of weekly volume` });
  if (monotony > 2.1) flags.push({ level: 'yellow', text: `High monotony: ${monotony.toFixed(1)} daily load consistency` });
  if (driftFlags >= 2) flags.push({ level: 'yellow', text: `${driftFlags} runs with >8% cardiac drift in 14d` });
  const status = flags.some((f) => f.level === 'red') ? 'Red' : flags.length ? 'Yellow' : 'Green';
  const recommendation = status === 'Red'
    ? 'Back off intensity until load and drift settle.'
    : status === 'Yellow'
      ? 'Keep the next session controlled and protect recovery.'
      : 'Load looks stable; a quality session is reasonable if you feel good.';
  const weeks = {};
  sorted.forEach((a) => {
    const k = weekKey(a.startTime);
    if (!weeks[k]) weeks[k] = { week: fmtShortDate(k), dist: 0, load: 0, hard: 0 };
    weeks[k].dist += a.distance / (units === 'mi' ? MI : KM);
    weeks[k].load += sessionLoad(a, maxHr);
    if (classifyRun(a, maxHr).hard) weeks[k].hard += 1;
  });
  const mixMap = {};
  d28.forEach((a) => {
    const c = classifyRun(a, maxHr);
    mixMap[c.label] = (mixMap[c.label] || 0) + 1;
  });
  return {
    d7, d28, load7, load28, acwr, hardShare, longShare, monotony, strain,
    flags, status, recommendation,
    weeklyLoad: Object.entries(weeks).sort().slice(-8).map(([, v]) => ({ ...v, dist: +v.dist.toFixed(1), load: Math.round(v.load) })),
    typeMix: Object.entries(mixMap).sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count })),
  };
}
function trainingSummary(profile) {
  const flagText = profile.flags.length ? profile.flags.map((f) => f.text).join('; ') : 'no major load flags';
  const mix = profile.typeMix.slice(0, 5).map((t) => `${t.label} ${t.count}`).join(', ') || 'n/a';
  return `Training load: 7d ${profile.load7}, 28d ${profile.load28}, acute:chronic ${profile.acwr ? profile.acwr.toFixed(2) : 'n/a'}, hard share ${pct(profile.hardShare)}, long-run share ${pct(profile.longShare)}, monotony ${profile.monotony.toFixed(1)}, status ${profile.status}. Workout mix: ${mix}. Flags: ${flagText}.`;
}

function zonesFor(maxHr) {
  return [
    { name: 'Z1', lo: 0, hi: 0.6, color: '#3a4452' },
    { name: 'Z2', lo: 0.6, hi: 0.7, color: '#4cc9f0' },
    { name: 'Z3', lo: 0.7, hi: 0.8, color: '#5fd068' },
    { name: 'Z4', lo: 0.8, hi: 0.9, color: '#ffb020' },
    { name: 'Z5', lo: 0.9, hi: 2, color: '#ff5a4d' },
  ].map((z) => ({ ...z, loBpm: Math.round(z.lo * maxHr), hiBpm: Math.round(z.hi * maxHr) }));
}
function zoneDist(points, maxHr) {
  const zones = zonesFor(maxHr);
  const counts = zones.map(() => 0);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const hr = points[i].hr;
    const dt = points[i].e - points[i - 1].e;
    if (hr == null || dt <= 0) continue;
    const idx = zones.findIndex((z) => hr / maxHr >= z.lo && hr / maxHr < z.hi);
    if (idx >= 0) { counts[idx] += dt; total += dt; }
  }
  return zones.map((z, i) => ({ ...z, sec: counts[i], pct: total ? (counts[i] / total) * 100 : 0 }));
}

const COACH_SYSTEM = 'You are an expert running coach and exercise physiologist analyzing a runner Garmin data. Be specific, reference the actual numbers given, stay concise, and never invent data. Prioritize pacing execution, aerobic efficiency, cardiac drift, training load balance, and 1-2 concrete next actions.';
async function askAI(prompt, system) {
  const messages = Array.isArray(prompt) ? prompt : [{ role: 'user', content: prompt }];
  const res = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system, messages }) });
  if (res.status === 501) throw new Error('AI not enabled');
  if (!res.ok) throw new Error('AI request failed');
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(nl).trim();
}

const SUMMARY_COLS = 'id,garmin_activity_id,source,name,type,start_time,distance_m,duration_s,elapsed_s,avg_hr,max_hr,avg_cadence,avg_pace_s_per_km,elev_gain_m,calories,efficiency,decoupling,splits';
const mapRow = (r) => ({
  id: r.id, name: r.name, type: r.type, startTime: r.start_time,
  distance: r.distance_m, duration: r.duration_s, elapsed: r.elapsed_s,
  avgHr: r.avg_hr, maxHr: r.max_hr, avgCad: r.avg_cadence,
  avgPace: r.avg_pace_s_per_km, elevGain: r.elev_gain_m, calories: r.calories,
  efficiency: r.efficiency, decoupling: r.decoupling, splits: r.splits || [],
});
async function fetchRuns() {
  const { data, error } = await supabase.from('runs').select(SUMMARY_COLS).order('start_time', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapRow);
}
function workoutPrompt(a, units, maxHr) {
  const cls = classifyRun(a, maxHr);
  const splits = (a.splits || []).slice(0, 30).map((s, i) => {
    const len = s.km - (a.splits[i - 1]?.km || 0);
    return `km ${s.km}: ${fmtPace(s.sec / len, units)}${paceUnit(units)}${s.avgHr ? `, ${s.avgHr}bpm` : ''}`;
  }).join(nl);
  return `Analyze this single run.
Name: ${a.name}
Date: ${fmtDate(a.startTime)}
Workout type: ${cls.label} (${cls.intensity}; ${cls.reason})
Estimated session load: ${sessionLoad(a, maxHr)}
Distance: ${fmtDist(a.distance, units)} ${distUnit(units)}
Moving time: ${fmtDur(a.duration)}
Avg pace: ${fmtPace(a.avgPace, units)}${paceUnit(units)}
Avg HR: ${a.avgHr ?? 'n/a'}  Max HR: ${a.maxHr ?? 'n/a'}
Avg cadence: ${a.avgCad ?? 'n/a'} spm
Elevation gain: ${a.elevGain} m
Cardiac drift: ${a.decoupling != null ? a.decoupling.toFixed(1) + '%' : 'n/a'}
Splits:
${splits}

Give what kind of session it was, how well it was executed, what pacing and HR reveal, and one actionable takeaway. Keep it under 180 words.`;
}
function trendPrompt(list, units, maxHr) {
  const profile = trainingProfile(list, units, maxHr);
  const rows = list.map((a) => {
    const cls = classifyRun(a, maxHr);
    return `${fmtDate(a.startTime, { month: 'short', day: 'numeric' })} | ${a.name} | ${cls.label} | load ${sessionLoad(a, maxHr)} | ${fmtDist(a.distance, units)}${distUnit(units)} | ${fmtPace(a.avgPace, units)}${paceUnit(units)} | HR ${a.avgHr ?? '-'} | eff ${a.efficiency ?? '-'} | drift ${a.decoupling != null ? a.decoupling.toFixed(0) + '%' : '-'}`;
  }).join(nl);
  return `Here are ${list.length} recent runs. ${trainingSummary(profile)}
${rows}

Analyze pace progression, aerobic efficiency, HR at given paces, weekly volume, and training balance. Call out specific improvements or regressions with numbers. End with 2-3 concrete suggestions. Under 220 words.`;
}

function KPI({ label, value, unit, tone }) {
  return <div className={`kpi ${tone || ''}`}><div className='stat-label'>{label}</div><div className='row' style={{ alignItems: 'baseline', marginTop: 6, gap: 5 }}><span className='stat-val' style={{ fontSize: 30 }}>{value}</span>{unit && <span className='stat-unit'>{unit}</span>}</div></div>;
}
const chartAxis = { stroke: '#3a444f', fontSize: 11, fontFamily: 'IBM Plex Mono,monospace', tick: { fill: '#7f8b98' } };
const tipStyle = { background: '#1a1f26', border: '1px solid #262d36', borderRadius: 10, fontFamily: 'IBM Plex Mono,monospace', fontSize: 12, color: '#e8edf2' };

function Dashboard({ acts, units, maxHr, onOpen }) {
  const profile = useMemo(() => trainingProfile(acts, units, maxHr), [acts, units, maxHr]);
  const stats = useMemo(() => {
    const anchor = anchorTime(acts);
    const wk = acts.filter((a) => anchor - new Date(a.startTime).getTime() < 7 * DAY);
    const mo = acts.filter((a) => anchor - new Date(a.startTime).getTime() < 30 * DAY);
    return { weekDist: sum(wk, (a) => a.distance), weekRuns: wk.length, moDist: sum(mo, (a) => a.distance), moTime: sum(mo, (a) => a.duration) };
  }, [acts]);
  const paceTrend = useMemo(() => [...acts].sort((a, b) => new Date(a.startTime) - new Date(b.startTime)).filter((a) => a.avgPace).slice(-30).map((a) => ({ d: fmtShortDate(a.startTime), pace: +(a.avgPace / 60).toFixed(2), hr: a.avgHr })), [acts]);
  const sorted = useMemo(() => [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)), [acts]);
  return <div className='sl-grid fade' style={{ gridTemplateColumns: '1fr' }}>
    <div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}>
      <KPI label='This week' value={fmtDist(stats.weekDist, units)} unit={distUnit(units)} />
      <KPI label='Runs / 7d' value={stats.weekRuns} tone='pace' />
      <KPI label='Load / 7d' value={profile.load7} tone={profile.status === 'Red' ? 'hr' : profile.status === 'Yellow' ? 'cad' : ''} />
      <KPI label='Acute:Chronic' value={profile.acwr ? profile.acwr.toFixed(2) : '-'} tone={profile.acwr > 1.25 ? 'hr' : 'pace'} />
      <KPI label='Last 30 days' value={fmtDist(stats.moDist, units)} unit={distUnit(units)} />
      <KPI label='Time / 30d' value={fmtDur(stats.moTime)} tone='hr' />
    </div>
    <div className={`sl-panel readiness ${profile.status.toLowerCase()}`}>
      <div className='row' style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
        <div><div className='sl-h' style={{ marginBottom: 8 }}><span className='dot' />Coach check-in</div><div className='readiness-main'>{profile.status}</div><div className='muted' style={{ fontSize: 14 }}>{profile.recommendation}</div></div>
        <div className='load-grid'><div><span className='stat-label'>Hard share</span><b>{pct(profile.hardShare)}</b></div><div><span className='stat-label'>Long share</span><b>{pct(profile.longShare)}</b></div><div><span className='stat-label'>Monotony</span><b>{profile.monotony.toFixed(1)}</b></div><div><span className='stat-label'>Strain</span><b>{profile.strain}</b></div></div>
      </div>
      <div className='flag-row'>{profile.flags.length ? profile.flags.map((f) => <span key={f.text} className={`flag ${f.level}`}>{f.text}</span>) : <span className='flag green'>No major load flags</span>}</div>
    </div>
    <div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
      <ChartPanel title={`Weekly volume - ${distUnit(units)}`} color='#c6f24e'><BarChart data={profile.weeklyLoad} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='week' {...chartAxis} interval='preserveStartEnd' /><YAxis {...chartAxis} /><Tooltip contentStyle={tipStyle} /><Bar dataKey='dist' radius={[4, 4, 0, 0]} fill='#c6f24e' /></BarChart></ChartPanel>
      <ChartPanel title='Estimated training load' color='#b794f6'><BarChart data={profile.weeklyLoad} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='week' {...chartAxis} interval='preserveStartEnd' /><YAxis {...chartAxis} /><Tooltip contentStyle={tipStyle} /><Bar dataKey='load' radius={[4, 4, 0, 0]} fill='#b794f6' /></BarChart></ChartPanel>
      <ChartPanel title={`Avg pace trend - min${paceUnit(units)}`} color='#4cc9f0'><LineChart data={paceTrend} margin={{ top: 4, right: 6, left: -18, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='d' {...chartAxis} interval='preserveStartEnd' /><YAxis {...chartAxis} domain={['auto', 'auto']} reversed tickFormatter={(v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`} /><Tooltip contentStyle={tipStyle} /><Line dataKey='pace' stroke='#4cc9f0' strokeWidth={2} dot={{ r: 2 }} /></LineChart></ChartPanel>
    </div>
    <div className='sl-panel'><div className='sl-h'><span className='dot' style={{ background: 'var(--cad)' }} />Workout mix - last 28 days</div><div className='mix-row'>{profile.typeMix.map((t) => <span key={t.label} className='mix-chip'><b>{t.count}</b>{t.label}</span>)}</div></div>
    <div className='sl-panel'><div className='sl-h'><span className='dot' style={{ background: 'var(--hr)' }} />Recent activity</div>{sorted.slice(0, 6).map((a) => <ActRow key={a.id} a={a} units={units} maxHr={maxHr} onOpen={onOpen} />)}</div>
  </div>;
}
function ChartPanel({ title, color, children }) {
  return <div className='sl-panel'><div className='sl-h'><span className='dot' style={{ background: color }} />{title}</div><ResponsiveContainer width='100%' height={210}>{children}</ResponsiveContainer></div>;
}
function ActRow({ a, units, maxHr = 185, onOpen }) {
  const cls = classifyRun(a, maxHr);
  return <div className='act-row' onClick={() => onOpen(a.id)}>
    <div className='act-badge' style={{ color: cls.hard ? 'var(--hr)' : cls.intensity === 'moderate' ? 'var(--cad)' : 'var(--accent)' }}>{fmtDist(a.distance, units).split('.')[0]}</div>
    <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600, fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</div><div className='mono muted' style={{ fontSize: 12 }}>{fmtDate(a.startTime, { weekday: 'short', month: 'short', day: 'numeric' })} - {cls.label} - load {sessionLoad(a, maxHr)}</div></div>
    <div style={{ textAlign: 'right' }}><div className='stat-val' style={{ fontSize: 18 }}>{fmtDist(a.distance, units)}<span className='stat-unit'> {distUnit(units)}</span></div></div>
    <div style={{ textAlign: 'right', minWidth: 64 }}><div className='stat-val mono' style={{ fontSize: 16, color: 'var(--pace)' }}>{fmtPace(a.avgPace, units)}</div><div className='stat-label'>{paceUnit(units).replace('/', 'per ')}</div></div>
    <div style={{ textAlign: 'right', minWidth: 50 }} className='hideSm'><div className='stat-val mono' style={{ fontSize: 16, color: 'var(--hr)' }}>{a.avgHr ?? '-'}</div><div className='stat-label'>bpm</div></div>
  </div>;
}
function ActivityList({ acts, units, maxHr, onOpen }) {
  const [q, setQ] = useState('');
  const sorted = useMemo(() => [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)).filter((a) => a.name.toLowerCase().includes(q.toLowerCase())), [acts, q]);
  return <div className='sl-panel fade'><div className='row' style={{ justifyContent: 'space-between', marginBottom: 10, flexWrap: 'wrap', gap: 10 }}><div className='sl-h' style={{ margin: 0 }}><span className='dot' />All runs - {acts.length}</div><input className='sl-in' style={{ maxWidth: 240 }} placeholder='Filter by name...' value={q} onChange={(e) => setQ(e.target.value)} /></div>{sorted.map((a) => <ActRow key={a.id} a={a} units={units} maxHr={maxHr} onOpen={onOpen} />)}</div>;
}
function Route({ points }) {
  const pts = (points || []).filter((p) => p.lat != null && p.lon != null);
  if (pts.length < 3) return null;
  const lats = pts.map((p) => p.lat), lons = pts.map((p) => p.lon);
  const minLa = Math.min(...lats), maxLa = Math.max(...lats), minLo = Math.min(...lons), maxLo = Math.max(...lons);
  const sx = (lo) => 8 + ((lo - minLo) / (maxLo - minLo || 1)) * 84;
  const sy = (la) => 8 + (1 - (la - minLa) / (maxLa - minLa || 1)) * 84;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.lon).toFixed(1)} ${sy(p.lat).toFixed(1)}`).join(' ');
  return <svg viewBox='0 0 100 100' style={{ width: '100%', height: 200 }}><path d={d} fill='none' stroke='#c6f24e' strokeWidth='1.4' strokeLinejoin='round' strokeLinecap='round' opacity='0.95' /><circle cx={sx(pts[0].lon)} cy={sy(pts[0].lat)} r='2.4' fill='#4cc9f0' /><circle cx={sx(pts[pts.length - 1].lon)} cy={sy(pts[pts.length - 1].lat)} r='2.4' fill='#ff5a4d' /></svg>;
}
function ActivityDetail({ summary, units, maxHr, onBack }) {
  const [a, setA] = useState(null);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    supabase.from('runs').select('points,splits').eq('id', summary.id).single().then(({ data }) => {
      if (live) setA({ ...summary, points: data?.points || [], splits: data?.splits || summary.splits || [] });
    });
    return () => { live = false; };
  }, [summary]);
  if (!a) return <div className='sl-panel'><span className='spin' /> loading...</div>;
  const cls = classifyRun(a, maxHr);
  const zones = a.points.some((p) => p.hr != null) ? zoneDist(a.points, maxHr) : null;
  const series = a.points.map((p) => ({ km: +(p.d / 1000).toFixed(2), pace: p.pace ? +(p.pace / 60).toFixed(2) : null, hr: p.hr, ele: p.ele }));
  const splitMax = Math.max(1, ...a.splits.map((s, i) => s.sec / (s.km - (a.splits[i - 1]?.km || 0))));
  const runAI = async () => { setBusy(true); setErr(null); try { setAi(await askAI(workoutPrompt(a, units, maxHr), COACH_SYSTEM)); } catch { setErr('Could not reach the AI service. Try again.'); } setBusy(false); };
  return <div className='sl-grid fade' style={{ gridTemplateColumns: '1fr' }}>
    <button className='back' onClick={onBack}>back to all runs</button>
    <div className='sl-panel'><div style={{ fontFamily: 'var(--font-d)', fontSize: 26, fontWeight: 700, textTransform: 'uppercase' }}>{a.name}</div><div className='mono muted' style={{ fontSize: 13 }}>{fmtDate(a.startTime, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div><div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(110px,1fr))', marginTop: 14 }}><KPI label='Distance' value={fmtDist(a.distance, units)} unit={distUnit(units)} /><KPI label='Type' value={cls.label} unit={cls.intensity} tone={cls.hard ? 'hr' : 'cad'} /><KPI label='Load' value={sessionLoad(a, maxHr)} tone={cls.hard ? 'hr' : 'pace'} /><KPI label='Moving time' value={fmtDur(a.duration)} /><KPI label='Avg pace' value={fmtPace(a.avgPace, units)} unit={paceUnit(units)} tone='pace' /><KPI label='Avg / Max HR' value={a.avgHr ? `${a.avgHr}/${a.maxHr}` : '-'} tone='hr' /><KPI label='Cadence' value={a.avgCad ?? '-'} unit='spm' tone='cad' /><KPI label='Cardiac drift' value={a.decoupling != null ? a.decoupling.toFixed(1) : '-'} unit='%' tone='hr' /></div></div>
    <div className='sl-panel'><div className='row' style={{ justifyContent: 'space-between', marginBottom: 12 }}><div className='sl-h' style={{ margin: 0 }}><span className='dot' />AI workout analysis</div><button className='sl-btn primary' onClick={runAI} disabled={busy}>{busy ? 'analyzing...' : ai ? 'Re-run' : 'Analyze this run'}</button></div>{err && <div className='muted' style={{ color: 'var(--hr)' }}>{err}</div>}{ai ? <div className='ai-box'><span className='ai-tag'>Coach - Claude</span>{ai}</div> : !busy && <div className='muted' style={{ fontSize: 14 }}>Get specific feedback on pacing execution, HR response, and one thing to work on.</div>}</div>
    <div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}><ChartPanel title='Pace and heart rate over distance' color='#4cc9f0'><LineChart data={series} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='km' {...chartAxis} tickFormatter={(v) => v.toFixed(0)} /><YAxis yAxisId='p' {...chartAxis} reversed domain={['auto', 'auto']} tickFormatter={(v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`} width={42} /><YAxis yAxisId='h' orientation='right' {...chartAxis} domain={['auto', 'auto']} /><Tooltip contentStyle={tipStyle} /><Line yAxisId='p' dataKey='pace' stroke='#4cc9f0' strokeWidth={1.8} dot={false} /><Line yAxisId='h' dataKey='hr' stroke='#ff5a4d' strokeWidth={1.8} dot={false} /></LineChart></ChartPanel><ChartPanel title='Elevation' color='#6b7785'><LineChart data={series} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='km' {...chartAxis} tickFormatter={(v) => v.toFixed(0)} /><YAxis {...chartAxis} domain={['auto', 'auto']} width={42} /><Tooltip contentStyle={tipStyle} /><Line dataKey='ele' stroke='#8a96a3' strokeWidth={1.5} dot={false} /></LineChart></ChartPanel></div>
    <div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}><div className='sl-panel'><div className='sl-h'><span className='dot' />Splits</div><div className='sl-grid' style={{ gap: 7 }}>{a.splits.map((s, i) => { const len = s.km - (a.splits[i - 1]?.km || 0); const pace = s.sec / len; return <div key={i} className='row' style={{ gap: 10 }}><span className='mono muted' style={{ width: 28, fontSize: 12 }}>{s.partial ? '.' : Math.round(s.km)}</span><div style={{ flex: 1 }}><div className='split-bar' style={{ width: `${(pace / splitMax) * 100}%`, opacity: 0.45 + 0.55 * (pace / splitMax) }} /></div><span className='mono' style={{ width: 52, textAlign: 'right', color: 'var(--pace)' }}>{fmtPace(pace, units)}</span><span className='mono muted' style={{ width: 42, textAlign: 'right', color: s.avgHr ? 'var(--hr)' : 'var(--dim2)' }}>{s.avgHr ?? '-'}</span></div>; })}</div></div><div className='sl-grid' style={{ gap: 14 }}>{zones && <div className='sl-panel'><div className='sl-h'><span className='dot' style={{ background: 'var(--hr)' }} />HR zones <span className='muted' style={{ fontSize: 12, fontFamily: 'var(--font-m)', textTransform: 'none', letterSpacing: 0 }}>(max {maxHr})</span></div><div style={{ display: 'flex', borderRadius: 7, overflow: 'hidden', marginBottom: 8 }}>{zones.map((z) => z.pct > 0 && <div key={z.name} className='zone-seg' style={{ width: `${z.pct}%`, background: z.color }} title={`${z.name} ${z.pct.toFixed(0)}%`}>{z.pct > 8 ? z.name : ''}</div>)}</div><div className='sl-grid' style={{ gridTemplateColumns: '1fr 1fr', gap: 4 }}>{zones.map((z) => <div key={z.name} className='row' style={{ gap: 7, fontSize: 12 }}><span style={{ width: 9, height: 9, borderRadius: 2, background: z.color }} /><span className='mono'>{z.name}</span><span className='muted mono'>{z.loBpm}-{z.hiBpm}</span><span style={{ marginLeft: 'auto' }} className='mono'>{z.pct.toFixed(0)}% - {fmtDur(z.sec)}</span></div>)}</div></div>}<div className='sl-panel'><div className='sl-h'><span className='dot' style={{ background: 'var(--pace)' }} />Route</div><Route points={a.points} /></div></div></div>
  </div>;
}
function Trends({ acts, units, maxHr }) {
  const [range, setRange] = useState(60);
  const [ai, setAi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const list = useMemo(() => { const anchor = anchorTime(acts); return [...acts].filter((a) => anchor - new Date(a.startTime).getTime() < range * DAY).sort((a, b) => new Date(a.startTime) - new Date(b.startTime)); }, [acts, range]);
  const profile = useMemo(() => trainingProfile(list, units, maxHr), [list, units, maxHr]);
  const effSeries = list.filter((a) => a.efficiency).map((a) => ({ d: fmtShortDate(a.startTime), eff: a.efficiency, hr: a.avgHr }));
  const driftSeries = list.filter((a) => a.decoupling != null).map((a) => ({ d: fmtShortDate(a.startTime), drift: +a.decoupling.toFixed(1) }));
  const runAI = async () => { setBusy(true); setErr(null); try { setAi(await askAI(trendPrompt(list, units, maxHr), COACH_SYSTEM)); } catch { setErr('Could not reach the AI service. Try again.'); } setBusy(false); };
  return <div className='sl-grid fade' style={{ gridTemplateColumns: '1fr' }}><div className='row' style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}><div className='sl-tabs'>{[30, 60, 90, 180].map((r) => <button key={r} className={`sl-tab ${range === r ? 'on' : ''}`} onClick={() => setRange(r)}>{r}d</button>)}</div><span className='mono muted' style={{ fontSize: 12 }}>{list.length} runs in window</span></div><div className='sl-panel'><div className='row' style={{ justifyContent: 'space-between', marginBottom: 12 }}><div className='sl-h' style={{ margin: 0 }}><span className='dot' />AI trend analysis - last {range} days</div><button className='sl-btn primary' onClick={runAI} disabled={busy || !list.length}>{busy ? 'analyzing...' : ai ? 'Re-run' : 'Analyze trends'}</button></div>{err && <div style={{ color: 'var(--hr)' }}>{err}</div>}{ai ? <div className='ai-box'><span className='ai-tag'>Coach - Claude</span>{ai}</div> : !busy && <div className='muted' style={{ fontSize: 14 }}>See how pace, efficiency, HR, and load are tracking.</div>}</div><div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))' }}><KPI label='Load / 7d' value={profile.load7} tone={profile.status === 'Red' ? 'hr' : ''} /><KPI label='Load / 28d' value={profile.load28} tone='cad' /><KPI label='Acute:Chronic' value={profile.acwr ? profile.acwr.toFixed(2) : '-'} tone={profile.acwr > 1.25 ? 'hr' : 'pace'} /><KPI label='Hard share' value={pct(profile.hardShare)} tone='hr' /></div><div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}><ChartPanel title='Aerobic efficiency (higher is better)' color='#c6f24e'><LineChart data={effSeries} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='d' {...chartAxis} interval='preserveStartEnd' /><YAxis {...chartAxis} domain={['auto', 'auto']} /><Tooltip contentStyle={tipStyle} /><Line dataKey='eff' stroke='#c6f24e' strokeWidth={2} dot={{ r: 2 }} /></LineChart></ChartPanel><ChartPanel title='Cardiac drift per run - %' color='#ff5a4d'><BarChart data={driftSeries} margin={{ top: 4, right: 6, left: -20, bottom: 0 }}><CartesianGrid stroke='#1d242c' vertical={false} /><XAxis dataKey='d' {...chartAxis} interval='preserveStartEnd' /><YAxis {...chartAxis} /><Tooltip contentStyle={tipStyle} /><ReferenceLine y={5} stroke='#5fd068' strokeDasharray='4 4' /><Bar dataKey='drift' radius={[3, 3, 0, 0]}>{driftSeries.map((e, i) => <Cell key={i} fill={e.drift > 8 ? '#ff5a4d' : e.drift > 5 ? '#ffb020' : '#5fd068'} />)}</Bar></BarChart></ChartPanel></div></div>;
}
function Coach({ acts, units, maxHr }) {
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);
  const context = useMemo(() => { const recent = [...acts].sort((a, b) => new Date(b.startTime) - new Date(a.startTime)).slice(0, 40); const profile = trainingProfile(acts, units, maxHr); const rows = recent.map((a) => { const cls = classifyRun(a, maxHr); return `${fmtDate(a.startTime, { month: 'short', day: 'numeric' })} ${a.name}: ${cls.label}, load ${sessionLoad(a, maxHr)}, ${fmtDist(a.distance, units)}${distUnit(units)}, ${fmtPace(a.avgPace, units)}${paceUnit(units)}, HR ${a.avgHr ?? '-'}, eff ${a.efficiency ?? '-'}, drift ${a.decoupling != null ? a.decoupling.toFixed(0) + '%' : '-'}`; }).join(nl); return `${trainingSummary(profile)}${nl}${rows}`; }, [acts, units, maxHr]);
  const send = async () => { const q = input.trim(); if (!q || busy) return; const next = [...msgs, { role: 'user', content: q }]; setMsgs(next); setInput(''); setBusy(true); try { const apiMsgs = next.map((m, i) => i === 0 ? { role: 'user', content: `My recent runs:${nl}${context}${nl}${nl}Question: ${m.content}` } : m); const reply = await askAI(apiMsgs, COACH_SYSTEM); setMsgs([...next, { role: 'assistant', content: reply }]); } catch { setMsgs([...next, { role: 'assistant', content: 'Could not reach the AI service. Try again in a moment.' }]); } setBusy(false); };
  const suggestions = ['What should my next workout be?', 'Is my easy pace too fast?', 'How is my load trending?', 'Am I doing too much hard running?'];
  return <div className='sl-panel fade' style={{ display: 'flex', flexDirection: 'column', minHeight: 460 }}><div className='sl-h'><span className='dot' />Ask your coach</div><div style={{ flex: 1, overflowY: 'auto', paddingRight: 4 }}>{msgs.length === 0 && <div><div className='muted' style={{ fontSize: 14, marginBottom: 14 }}>I can see your last {Math.min(acts.length, 40)} runs with training load context. Ask me anything about your training.</div><div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8 }}>{suggestions.map((s) => <button key={s} className='sl-btn' style={{ textAlign: 'left', textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-b)', fontWeight: 500 }} onClick={() => setInput(s)}>{s}</button>)}</div></div>}{msgs.map((m, i) => <div key={i} className={`coach-msg ${m.role === 'user' ? 'u' : 'a'}`}>{m.content}</div>)}{busy && <div className='coach-msg a'><span className='spin' /> thinking...</div>}<div ref={endRef} /></div><div className='row' style={{ marginTop: 12, gap: 8 }}><input className='sl-in' placeholder='Ask about your running...' value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} /><button className='sl-btn primary' onClick={send} disabled={busy || !input.trim()}>Send</button></div></div>;
}
function Login() {
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => { setBusy(true); setErr(null); const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password: pw }); if (error) setErr(error.message); setBusy(false); };
  return <div className='sl-panel' style={{ maxWidth: 380, margin: '60px auto' }}><div className='sl-logo' style={{ marginBottom: 4 }}><span className='tk' /> STRIDE<b>LAB</b></div><div className='sl-sub' style={{ marginBottom: 18 }}>sign in</div><input className='sl-in' style={{ marginBottom: 10 }} placeholder='email' type='email' value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} /><input className='sl-in' style={{ marginBottom: 14 }} placeholder='password' type='password' value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />{err && <div style={{ color: 'var(--hr)', fontSize: 13, marginBottom: 10 }}>{err}</div>}<button className='sl-btn primary' style={{ width: '100%' }} onClick={submit} disabled={busy}>{busy ? 'signing in...' : 'Sign in'}</button></div>;
}
function Settings({ units, setUnits, maxHr, setMaxHr }) {
  return <div className='sl-panel fade'><div className='sl-h'><span className='dot' />Settings</div><div className='sl-grid' style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 16 }}><div><div className='stat-label' style={{ marginBottom: 6 }}>Units</div><div className='sl-tabs' style={{ display: 'inline-flex' }}><button className={`sl-tab ${units === 'km' ? 'on' : ''}`} onClick={() => setUnits('km')}>km</button><button className={`sl-tab ${units === 'mi' ? 'on' : ''}`} onClick={() => setUnits('mi')}>mi</button></div></div><div><div className='stat-label' style={{ marginBottom: 6 }}>Max heart rate (for zones and load)</div><input className='sl-in' type='number' style={{ maxWidth: 120 }} value={maxHr} onChange={(e) => setMaxHr(Math.max(120, Math.min(220, +e.target.value || 185)))} /></div></div></div>;
}
export default function App() {
  const [session, setSession] = useState(undefined);
  const [acts, setActs] = useState([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState('dash');
  const [openId, setOpenId] = useState(null);
  const [units, setUnits] = useState(() => localStorage.getItem('sl_units') || 'km');
  const [maxHr, setMaxHr] = useState(() => Number(localStorage.getItem('sl_maxhr')) || 185);
  useEffect(() => { supabase.auth.getSession().then(({ data }) => setSession(data.session)); const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s)); return () => sub.subscription.unsubscribe(); }, []);
  useEffect(() => { localStorage.setItem('sl_units', units); }, [units]);
  useEffect(() => { localStorage.setItem('sl_maxhr', String(maxHr)); }, [maxHr]);
  useEffect(() => { if (!session) return; setLoadingRuns(true); setErr(null); fetchRuns().then((r) => setActs(r)).catch((e) => setErr(e.message || 'Could not load runs')).finally(() => setLoadingRuns(false)); }, [session]);
  const openSummary = useMemo(() => acts.find((a) => a.id === openId) || null, [acts, openId]);
  const open = (id) => { setOpenId(id); setTab('acts'); };
  if (session === undefined) return <div className='sl-root'><div className='sl-wrap'><div className='sl-panel' style={{ marginTop: 60 }}><span className='spin' /> loading...</div></div></div>;
  if (!session) return <div className='sl-root'><div className='sl-bg' /><div className='sl-wrap'><Login /></div></div>;
  const tabs = [['dash', 'Dashboard'], ['acts', 'Activities'], ['trends', 'Trends'], ['coach', 'Coach'], ['settings', 'Settings']];
  return <div className='sl-root'><div className='sl-bg' /><div className='sl-wrap'><div className='sl-top'><div><div className='sl-logo'><span className='tk' /> STRIDE<b>LAB</b></div><div className='sl-sub'>running telemetry - {acts.length} runs</div></div><div className='sl-tabs'>{tabs.map(([k, label]) => <button key={k} className={`sl-tab ${tab === k ? 'on' : ''}`} onClick={() => { setTab(k); if (k !== 'acts') setOpenId(null); }}>{label}</button>)}</div></div>{loadingRuns ? <div className='sl-panel'><span className='spin' /> loading your runs...</div> : err ? <div className='sl-panel' style={{ color: 'var(--hr)' }}>{err}</div> : acts.length === 0 ? <div className='sl-panel empty'><h2>No runs found</h2><p className='muted'>Your runs table returned no rows.</p></div> : <>{tab === 'dash' && <Dashboard acts={acts} units={units} maxHr={maxHr} onOpen={open} />}{tab === 'acts' && (openSummary ? <ActivityDetail summary={openSummary} units={units} maxHr={maxHr} onBack={() => setOpenId(null)} /> : <ActivityList acts={acts} units={units} maxHr={maxHr} onOpen={open} />)}{tab === 'trends' && <Trends acts={acts} units={units} maxHr={maxHr} />}{tab === 'coach' && <Coach acts={acts} units={units} maxHr={maxHr} />}{tab === 'settings' && <Settings units={units} setUnits={setUnits} maxHr={maxHr} setMaxHr={setMaxHr} />}</>}<div style={{ textAlign: 'center', marginTop: 30, fontSize: 11 }} className='mono muted'>StrideLab - {session.user?.email} - <span style={{ cursor: 'pointer', color: 'var(--accent)' }} onClick={() => supabase.auth.signOut()}>sign out</span></div></div></div>;
}
