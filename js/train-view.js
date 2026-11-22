// The three tabs since 2026-11-14 (Stanley approved the mockup: "prerob to"): Tréning (pick Skok /
// Šprint / RSI, film or upload, Freelap, today's analyses), História (every analysis, filtered),
// Progres (trends for the athlete chosen in the header, then PB and goal). Every row opens its
// detail screen. The capture and analysis code stays in each module; this file only lists and
// routes.
import { modeOfRun } from './analysis/sprint.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, dp) => (Number.isFinite(x) ? Number(x).toFixed(dp).replace('.', ',') : '–');
const dayKey = t => new Date(t).toLocaleDateString('sv-SE');
const hm = t => new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
const dayName = t => new Date(t).toLocaleDateString('sk-SK', { weekday: 'short', day: 'numeric', month: 'numeric' });
const LABEL = { sprint: 'ŠP', rsi: 'RSI', skok: 'SK', rozbeh: 'RB' };
const PHASE = { pen: 'predposl.', plant: 'plant', takeoff: 'odraz', flight: 'let', landing: 'dopad' };

// The jump attempts as list lines.
export function jumpSummary(r, athletes) {
  // a distance the analysis withheld (no runway measured: IMG_5166 read 2.74 m from the arc) is not shown
  const est = r.metrics?.estDistance?.s !== 'hidden' ? r.metrics?.estDistance?.v : undefined;
  const weak = (r.phases ?? []).filter(p => Number.isFinite(p.score)).sort((a, b) => a.score - b.score)[0];
  return {
    kind: 'skok', id: r.id, who: r.athlete, at: Date.parse(r.recordedAt || r.analysedAt),
    title: `${athletes[r.athlete]?.name ?? ''} · skok${r.runup ? ` z ${r.runup} krokov` : ''}`,
    sub: weak ? `najslabšie ${PHASE[weak.id] ?? weak.id} ${Math.round(weak.score)}` : '',
    value: Number.isFinite(r.score) ? String(Math.round(r.score)) : '–', valueSub: r.measured > 0 ? `${num(r.measured, 2)} m` : Number.isFinite(est) ? `≈ ${num(est, 2)} m` : 'skóre',   // the tape without ≈
  };
}

export function itemHtml(it, { showTime = true } = {}) {
  return `<button class="feed-item" data-item="${esc(it.kind)}" data-id="${esc(it.id)}" data-who="${esc(it.who ?? '')}">
    <span class="feed-ic k-${it.kind}">${LABEL[it.kind]}</span>
    <span class="feed-t"><b>${esc(it.title)}</b><small>${showTime ? `${hm(it.at)}${it.sub ? ' · ' : ''}` : ''}${esc(it.sub)}</small></span>
    <span class="feed-v">${esc(it.value)}<small>${esc(it.valueSub)}</small></span></button>`;
}

// All analyses, newest first; filter: 'all' | 'skok' | 'sprint' | 'rsi'.
export function listHtml(items, filter = 'all', dayExtra = null) {
  const list = items.filter(it => filter === 'all' || it.kind === filter).sort((a, b) => b.at - a.at);
  if (!list.length) return '<p class="note">Zatiaľ tu nič nie je.</p>';
  let day = '', out = '';
  for (const it of list) {
    const d = dayKey(it.at);
    if (d !== day) { day = d; out += `<p class="feed-day">${d === dayKey(Date.now()) ? 'Dnes' : esc(dayName(it.at))}</p>${dayExtra && (filter === 'all' || filter === 'skok') ? dayExtra(d) : ''}`; }
    out += itemHtml(it);
  }
  return out;
}

export function todayHtml(items, dayExtra = null) {
  const today = items.filter(it => dayKey(it.at) === dayKey(Date.now())).sort((a, b) => b.at - a.at);
  return `<p class="feed-day">Dnes · najnovšie hore</p>${dayExtra ? dayExtra(dayKey(Date.now())) : ''}${today.length ? today.map(it => itemHtml(it)).join('') : '<p class="note">Dnes ešte nič. Natoč alebo nahraj video.</p>'}`;
}

// ---------- Progres ----------
function spark(v, lowerBetter) {
  if (v.length < 2) return '';
  const a = Math.min(...v), b = Math.max(...v), W = 120, H = 34;
  const y = x => (lowerBetter ? 5 + ((x - a) / (b - a || 1)) * (H - 10) : H - 5 - ((x - a) / (b - a || 1)) * (H - 10));
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * W).toFixed(1)},${y(x).toFixed(1)}`);
  const [lx, ly] = pts.at(-1).split(',');
  return `<svg class="trend-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><polyline points="${pts.join(' ')}"/><circle cx="${lx}" cy="${ly}" r="3.5"/></svg>`;
}
// Per day: the day's best value.
function byDay(points, lowerBetter) {
  const m = new Map();
  for (const { at, v } of points) {
    if (!Number.isFinite(v)) continue;
    const d = dayKey(at), prev = m.get(d);
    if (prev == null || (lowerBetter ? v < prev.v : v > prev.v)) m.set(d, { at, v });
  }
  return [...m.values()].sort((x, y) => x.at - y.at);
}
function trendCard(label, series, { unit = '', dp = 2, lowerBetter = false, color = 'g' } = {}) {
  if (!series.length) return '';
  const v = series.map(p => p.v), best = lowerBetter ? Math.min(...v) : Math.max(...v);
  const bestAt = series.find(p => p.v === best)?.at;
  return `<div class="card trend-card t-${color}"><div><p class="trend-l">${esc(label)}</p>
    <p class="trend-v">${num(v.at(-1), dp)}<span>${unit ? ` ${unit}` : ''}</span></p>
    <p class="trend-l">najlepšie ${num(best, dp)}${unit ? ` ${unit}` : ''}${bestAt ? ` · ${esc(dayName(bestAt))}` : ''} · ${series.length} ${series.length === 1 ? 'deň' : series.length < 5 ? 'dni' : 'dní'}</p></div>${spark(v, lowerBetter)}</div>`;
}

export function trendsHtml({ who, name, runs, attempts, rsi, rozbeh = [] }) {
  const mine = runs.filter(r => r.who === who && r.legs?.length >= 2);
  const fly = byDay(mine.filter(r => modeOfRun(r) === 'fly').map(r => ({ at: r.at, v: Math.min(...r.legs) })), true);
  const acc = byDay(mine.filter(r => modeOfRun(r) === 'accel').map(r => ({ at: r.at, v: r.legs[0] })), true);
  const score = byDay(attempts.map(r => ({ at: Date.parse(r.recordedAt || r.analysedAt), v: r.score })), false);
  const rsiDays = byDay(rsi.filter(x => x.who === who).flatMap(({ rec }) => (rec.jumps ?? []).map(j => ({ at: Date.parse(rec.at), v: j.rsi }))), false);
  const vert = byDay(rsi.filter(x => x.who === who && !(x.rec.jumps ?? []).length).flatMap(({ rec }) => (rec.standing ?? []).map(j => ({ at: Date.parse(rec.at), v: j.heightCm }))), false);
  // Run-ups, one pair of cards per number of steps: 1-11 m and 11-21 m before the board. With a cone
  // at 6 m the last two splits make 1-11 (2026-11-19, cones 1 · 6 · 11 · 21 m); a 5 m split alone
  // was shown as "the last 10 m" before.
  const ups = runs.filter(r => r.who === who && modeOfRun(r) === 'rozbeh' && r.legs?.length);
  const s1 = r => (r.legs.length >= 3 ? r.legs.at(-1) + r.legs.at(-2) : r.legs.at(-1));
  const s2 = r => (r.legs.length >= 3 ? r.legs.at(-3) : r.legs.length === 2 ? r.legs[0] : null);
  const upCards = [...new Set(ups.map(r => r.steps ?? 0))].sort((a, b) => b - a).flatMap(n => {
    const mine = ups.filter(r => (r.steps ?? 0) === n), lb = `Rozbeh${n ? ` ${n} krokov` : ''}`;
    return [trendCard(`${lb} · 1–11 m`, byDay(mine.map(r => ({ at: r.at, v: s1(r) })), true), { unit: 's', lowerBetter: true }),
      trendCard(`${lb} · 11–21 m`, byDay(mine.filter(r => s2(r) != null).map(r => ({ at: r.at, v: s2(r) })), true), { unit: 's', lowerBetter: true })];
  });
  // the take-off of the run-ups analysed from video, the day's mean
  const rbDay = (key) => { const m = new Map(); for (const r of (rozbeh ?? []).filter(x => x.who === who && x[key.split('.')[0]]?.contact != null)) { const d = new Date(r.recordedAt ?? r.at).toLocaleDateString('sv-SE'); (m.get(d) ?? m.set(d, []).get(d)).push({ at: r.recordedAt ?? r.at, v: r[key.split('.')[0]].contact }); } return [...m.values()].map(l => ({ at: l[0].at, v: l.reduce((a, x) => a + x.v, 0) / l.length })).sort((a, b) => a.at - b.at); };
  upCards.push(trendCard('Rozbeh · kontakt na doske (priemer dňa)', rbDay('take.contact'), { unit: 's', dp: 3, lowerBetter: true }));
  const cards = [
    trendCard('Letmá desiatka (najlepšia z dňa)', fly, { unit: 's', lowerBetter: true }),
    trendCard('0–10 m z rúk', acc, { unit: 's', lowerBetter: true }),
    ...upCards,
    trendCard('Skóre techniky skoku', score, { dp: 0, color: 'p' }),
    trendCard('RSI (najlepšie z dňa)', rsiDays, { color: 'o' }),
    trendCard('Výskok z miesta', vert, { unit: 'cm', dp: 1, color: 'o' }),
  ].join('');
  return `<div class="card"><h2>Progres</h2><p class="note">${esc(name)} · prepni atléta hore.</p></div>${cards || '<div class="card"><p class="note">Zatiaľ žiadne merania. Pribudnú s Freelapom, skokmi a RSI.</p></div>'}`;
}
