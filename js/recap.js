// "Video z tréningu" (Stanley, 2026-11-15, prototype approved in four rounds): one portrait video per
// athlete and day, cut from the day's jumps. This module writes the whole cut as a list of output
// frames (30 fps); the server only draws them (server/recap_render.py), so every decision lives here
// and is tested here. His rules from the rounds:
// - the first shot is a whole jump, run-up to the sand;
// - no scores on the phases, one measured value each ("na doske 0,125 s");
// - "čo sa zlepšilo" compares the SAME measure on two jumps; never two different numbers;
// - "spolu" is one model run (whatIf's speed-angle curve), shown only from a full run-up;
// - "nabudúce" is the measured miss, the target, then the cue big;
// - holds long enough to read; few words; no brands; the ghost is only his own better rep.
import { whatIf, idealTakeoff, bestAngle, COEF } from './analysis/whatif.js';
import { JI } from './pose/models.js';

export const OUT = { W: 1080, H: 1920, fps: 30 };
const G = 9.81;
const WEEKDAY = ['NEDEĽA', 'PONDELOK', 'UTOROK', 'STREDA', 'ŠTVRTOK', 'PIATOK', 'SOBOTA'];
const ease = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const n = (x, d) => Number(x).toFixed(d).replace('.', ',');
// A full run-up, the only one "spolu" speaks for: confirmed steps from this many on.
export const FULL_RUNUP = 14;

// One value per phase, the first measured one in the list; ms shown in seconds.
const PHASE_VALUE = {
  pen: [['contactPen', 'kontakt']],
  plant: [['legTD', 'uhol nohy'], ['inclTD', 'náklon pri dotyku']],
  toeoff: [['contactTO', 'na doske'], ['kneeDrive', 'švih kolena']],
  flight: [['flight', 'vo vzduchu']],
  landing: [['kneeLand', 'koleno']],
};
const PHASE_NAME = { run: 'ROZBEH', pen: 'PREDPOSLEDNÝ', plant: 'DOTYK', toeoff: 'ODRAZ', flight: 'LET', landing: 'DOPAD' };
// Words for a measure in the "zlepšilo" / "nabudúce" shots.
const SHORT = {
  contactTO: 'NA DOSKE', contactPen: 'KONTAKT', legTD: 'UHOL NOHY', inclTD: 'NÁKLON PRI DOTYKU', hipDrop: 'BOKY DOLE',
  kneeTO: 'KOLENO PRI ODRAZE', flight: 'LET', kneeLand: 'KOLENO PRI DOPADE', takeoffAngle: 'UHOL ODRAZU', speedLast: 'RÝCHLOSŤ DO DOSKY',
  touchdownDist: 'DOŠĽAP PRED ŤAŽISKOM', penKnee: 'KOLENO V PREDPOSLEDNOM', kneeDrive: 'ŠVIH KOLENA', trunkTO: 'TRUP PRI ODRAZE', vyTO: 'RÝCHLOSŤ HORE',
};
const PHASE_OF = { contactPen: 'pen', hipDrop: 'pen', penKnee: 'pen', legTD: 'plant', inclTD: 'plant', touchdownDist: 'plant', speedLast: 'pen',
  contactTO: 'toeoff', kneeTO: 'toeoff', kneeDrive: 'toeoff', trunkTO: 'toeoff', takeoffAngle: 'toeoff', vyTO: 'toeoff', flight: 'flight', kneeLand: 'landing' };
// The measures the "zlepšilo" shot may compare (scale-free or frame-exact ones first).
const IMPROVE = ['contactTO', 'legTD', 'inclTD', 'contactPen', 'hipDrop', 'kneeTO', 'takeoffAngle', 'touchdownDist', 'kneeDrive', 'speedLast'];

// "0,125 s", "63°", "10 cm", "8,9 m/s"; inclTD and other signed angles shown as their size.
export function fmt(key, v) {
  if (!Number.isFinite(v)) return '';
  const m = METRIC_UNIT[key] ?? '';
  if (m === 'ms') return `${n(v / 1000, 3)} s`;
  if (m === '°') return `${Math.round(Math.abs(v))}°`;
  if (m === 'cm') return `${Math.round(v)} cm`;
  if (m === 'm/s') return `${n(v, 1)} m/s`;
  if (m === 'm') return `${n(v, 2)} m`;
  return n(v, 1);
}
const METRIC_UNIT = { contactTO: 'ms', contactPen: 'ms', flight: 'ms', legTD: '°', inclTD: '°', kneeTO: '°', kneeLand: '°', takeoffAngle: '°', penKnee: '°', kneeDrive: '°', trunkTO: '°',
  hipDrop: 'cm', peakHeight: 'cm', speedLast: 'm/s', vyTO: 'm/s', touchdownDist: 'm' };
const fmtRange = (key, lo, hi) => {
  const u = METRIC_UNIT[key];
  if (u === 'ms') return `${n(lo / 1000, 3)}–${n(hi / 1000, 3)} s`;
  if (u === '°') { const [a, b] = [Math.abs(lo), Math.abs(hi)].sort((x, y) => x - y); return `${Math.round(a)}–${Math.round(b)}°`; }
  if (u === 'cm') return `${Math.round(lo)}–${Math.round(hi)} cm`;
  if (u === 'm/s') return `${n(lo, 1)}–${n(hi, 1)} m/s`;
  if (u === 'm') return `${n(lo, 2)}–${n(hi, 2)} m`;
  return `${lo}–${hi}`;
};

const metric = (j, key) => (j.metrics ?? []).find(m => m.key === key && Number.isFinite(m.value) && m.status !== 'hidden') ?? null;
const kf = (j, id) => j.keyFrames?.find(k => k.id === id)?.frame ?? null;
const phaseScore = (j, id) => j.phases?.find(p => p.id === id)?.score ?? null;
// Where a value sits against its norm, lower is better: for "less is better" measures (contact) the
// share of the band from its low edge, for "more is better" from its high edge, else the distance from
// the band's middle in half-widths (1 at an edge, more outside).
const place = m => {
  const [lo, hi] = [...m.norm].sort((a, b) => a - b), w = Math.max(1e-9, hi - lo);
  if (m.good === 'low') return (m.value - lo) / w;
  if (m.good === 'high') return (hi - m.value) / w;
  return Math.abs(m.value - (lo + hi) / 2) / (w / 2);
};

// ---------------- the decisions ----------------
// jumps: [{ jump, at }] of one athlete and day, in the order filmed.
export function plan(jumps, { sex = 'male', height = null } = {}) {
  const J = jumps.filter(x => x.jump && !x.jump.error);
  if (!J.length) return null;
  const score = x => x.jump.score?.score ?? -1;
  const best = J.reduce((b, x) => (score(x) > score(b) ? x : b), J[0]);
  const last = J[J.length - 1];
  const out = { count: J.length, intro: last, best, phases: phaseValues(best.jump), split: splitOf(best.jump) };
  if (J.length >= 2) {
    out.improved = improvement(J);
    out.bestOf = ['pen', 'plant', 'toeoff'].map(id => {
      const x = J.reduce((b, y) => ((phaseScore(y.jump, id) ?? -1) > (phaseScore(b.jump, id) ?? -1) ? y : b), J[0]);
      const v = phaseValues(x.jump).find(p => p.id === id);
      return { id, x, nth: J.indexOf(x) + 1, value: v ? `${v.label} ${v.text}` : '' };
    });
    out.together = together(J, { sex, height });
  }
  out.next = nextThing(last.jump, { sex, height }) ?? nextThing(best.jump, { sex, height });
  out.nth = x => J.indexOf(x) + 1;
  return out;
}
export function phaseValues(j) {
  return ['pen', 'plant', 'toeoff', 'flight', 'landing'].map(id => {
    for (const [key, label] of PHASE_VALUE[id]) {
      const m = metric(j, key);
      if (m) return { id, key, label, text: fmt(key, m.value), ok: m.status === 'ok' };
    }
    return { id, key: null, label: '', text: '' };
  });
}
// The Freelap 1-11 m time: typed, else the video's own time between the cones.
const splitOf = j => (j.split > 0.8 && j.split < 2.5 ? j.split : j.speed?.split1to11 > 0.8 && j.speed.split1to11 < 2.5 ? j.speed.split1to11 : null);
// The biggest move toward the norm from an earlier jump to a later one on the same measure.
export function improvement(J) {
  let bestHit = null;
  for (let a = 0; a < J.length; a++) for (let b = a + 1; b < J.length; b++) {
    for (const key of IMPROVE) {
      const ma = metric(J[a].jump, key), mb = metric(J[b].jump, key);
      if (!ma || !mb || !ma.norm || !mb.norm) continue;
      const gain = place(ma) - place(mb);
      const step = Math.abs(mb.value - ma.value);
      if (gain < 0.15 || fmt(key, ma.value) === fmt(key, mb.value)) continue;
      if (!bestHit || gain > bestHit.gain) bestHit = { key, a: J[a], b: J[b], from: ma.value, to: mb.value, gain, step, inNorm: mb.status === 'ok' };
    }
  }
  return bestHit;
}
// "Spolu": the fastest take-off with the best-scored take-off's angle and the longest landing reach,
// through whatIf's speed-angle curve: one model run, never a sum (whatif.js rule). Only from full run-ups.
export function together(J, { height = null } = {}) {
  if (!J.every(x => (x.jump.runupJudged ?? x.jump.runup ?? 0) >= FULL_RUNUP)) return null;
  const ok = J.filter(x => Number.isFinite(x.jump.flight?.vxTO) && Number.isFinite(x.jump.flight?.vyTO) && Number.isFinite(x.jump.flight?.takeoffDist) && Number.isFinite(x.jump.flight?.landingReach));
  if (ok.length < 2) return null;
  const speed = ok.reduce((b, x) => (Math.hypot(x.jump.flight.vxTO, x.jump.flight.vyTO) > Math.hypot(b.jump.flight.vxTO, b.jump.flight.vyTO) ? x : b), ok[0]);
  const land = ok.reduce((b, x) => (x.jump.flight.landingReach > b.jump.flight.landingReach ? x : b), ok[0]);
  const f = speed.jump.flight, T0 = ((speed.jump.metrics ?? []).find(m => m.key === 'flight')?.value ?? NaN) / 1000;
  const est = (speed.jump.metrics ?? []).find(m => m.key === 'estDistance' && m.status !== 'hidden')?.value;
  if (!(T0 > 0) || !(est > 0)) return null;
  const drop = ((G * T0 - f.vyTO) ** 2 - f.vyTO ** 2) / (2 * G);
  // the take-off angle nearest the one that gives this athlete the most distance (whatIf's bestAngle)
  const ideal = bestAngle(f.vxTO, f.vyTO, drop, (height ?? 180) / 100)?.angle;
  const angleJ = Number.isFinite(ideal) ? ok.reduce((b, x) => (Math.abs(x.jump.flight.takeoffAngle - ideal) < Math.abs(b.jump.flight.takeoffAngle - ideal) ? x : b), ok[0]) : speed;
  const th0 = (Math.atan2(f.vyTO, f.vxTO) * 180) / Math.PI, target = angleJ.jump.flight.takeoffAngle;
  const it = Number.isFinite(target) ? idealTakeoff(f.vxTO, f.vyTO, target) : { vx: f.vxTO, vy: f.vyTO };
  const T1 = (it.vy + Math.sqrt(Math.max(0, it.vy * it.vy + 2 * G * drop))) / G;
  const h = (height ?? 180) / 100;
  const base = f.takeoffDist + f.vxTO * T0 + f.landingReach;
  const comb = f.takeoffDist - h * COEF.linDist * ((target ?? th0) - th0) + it.vx * T1 + land.jump.flight.landingReach;
  const gain = comb - base;
  if (!Number.isFinite(gain) || gain < 0.03) return null;   // the best parts are one jump: nothing to add
  return { speed, angle: angleJ, land, angleDeg: target, value: est + gain, gain };
}
// The one thing for next time: the what-if pick (else the first coaching fix) and its cue.
export function nextThing(j, { sex = 'male', height = null } = {}) {
  const wi = whatIf(j, sex, { height });
  const it = wi?.items?.[0];
  const fix = j.coach?.fixes?.[0];
  const key = it?.metricKey ?? fix?.metricKey ?? null;
  const m = key ? (j.metrics ?? []).find(x => x.key === key && Number.isFinite(x.value)) : null;
  const cue = it?.cue ?? fix?.cue ?? null;
  if (!m || !cue) return null;
  if (key === 'speedApproach' || key === 'speedKeep') {
    // run-up speed is told as the Freelap 1-11 m time (Stanley: "rýchlosť ako čas"); the target from the norm
    const sp = (j.metrics ?? []).find(x => x.key === 'speedApproach' && Number.isFinite(x.value));
    if (!sp) return null;
    return { key: 'speedApproach', phase: 'pen', value: `${n(10 / sp.value, 2)} s`, target: sp.norm ? `${n(10 / sp.norm[1], 2)}–${n(10 / sp.norm[0], 2)} s` : '', cue: cue.toUpperCase(), word: 'ROZBEH 1–11 m' };
  }
  const phase = PHASE_OF[key] ?? fix?.phase ?? 'plant';
  return { key, phase, value: fmt(key, m.value), target: m.norm ? fmtRange(key, ...m.norm) : '', cue: cue.toUpperCase(), word: SHORT[key] ?? m.label.toUpperCase() };
}

// ---------------- the cut ----------------
// Camera: the hips, smoothed over ±30 frames (Gaussian, sigma 10).
function cameraOf(smooth) {
  const N = smooth.length, cx = new Float64Array(N).fill(NaN), cy = new Float64Array(N).fill(NaN);
  const at = (k, n) => (k && Number.isFinite(k[JI[n] * 3]) && (k[JI[n] * 3 + 2] ?? 1) > 0.3 ? [k[JI[n] * 3], k[JI[n] * 3 + 1]] : null);
  for (let i = 0; i < N; i++) { const l = at(smooth[i], 'lhip'), r = at(smooth[i], 'rhip'); if (l && r) { cx[i] = (l[0] + r[0]) / 2; cy[i] = (l[1] + r[1]) / 2; } }
  const fill = a => { let last = NaN; const idx = []; for (let i = 0; i < N; i++) if (Number.isFinite(a[i])) idx.push(i);
    if (!idx.length) return a.fill(0);
    for (let i = 0; i < N; i++) { if (Number.isFinite(a[i])) { last = i; continue; } const nx = idx.find(k => k > i); const pv = last;
      a[i] = pv == null || !Number.isFinite(pv) ? a[nx] : nx == null ? a[pv] : a[pv] + ((a[nx] - a[pv]) * (i - pv)) / (nx - pv); } return a; };
  fill(cx); fill(cy);
  const g = Array.from({ length: 61 }, (_, k) => Math.exp(-0.5 * ((k - 30) / 10) ** 2)), gs = g.reduce((a, b) => a + b, 0);
  const sm = a => Float64Array.from(a, (_, i) => { let s = 0; for (let k = 0; k < 61; k++) s += g[k] * a[Math.max(0, Math.min(N - 1, i + k - 30))]; return s / gs; });
  return { cx: sm(cx), cy: sm(cy) };
}

const INK = 'ink', ACC = 'acc', WARN = 'warn';
// a word with its fade/slide at local frame t (8 frames, after `delay`)
const W = (t, text, x, y, f, s, col, delay = 0, al = 'l') => { const e = ease((t - delay) / 8); return e > 0 && text ? { t: text, x, y: Math.round(y + (1 - e) * 40), f, s, c: col, a: +e.toFixed(3), al } : null; };

// story(): jumps [{ jump, pose, clip }] → { out, clips: [{ frames:{f: kp} }], frames: [...] }
export function story(jumps, { athlete = {}, date = new Date(), sex = 'male', height = null } = {}) {
  const J = jumps.filter(x => x.jump && !x.jump.error && x.pose?.smooth);
  const P = plan(J, { sex, height });
  if (!P) return null;
  const idx = x => J.findIndex(y => y.jump === x.jump);
  const cams = J.map(x => cameraOf(x.pose.smooth));
  const used = J.map(() => new Set());
  const frames = [];
  const fit = (c, f) => Math.max(0, Math.min(J[c].pose.smooth.length - 1, Math.round(f)));
  const shot = (c, f, z, extra = {}) => { const fi = fit(c, f); used[c].add(fi); return { c, f: fi, cx: +cams[c].cx[fi].toFixed(1), cy: +cams[c].cy[fi].toFixed(1), z: +z.toFixed(3), ...extra }; };
  const push = (list, fx) => { list.forEach((v, i) => frames.push(fx(v, i))); };
  const dip = () => { for (let k = 0; k < 3 && frames.length; k++) { const fr = frames[frames.length - 1 - k]; if (fr) fr.fade = 0; } };
  const seg = () => frames.length;
  const marks = [];   // segment starts, for the dips
  const start = () => marks.push(frames.length);
  const name = (athlete.name ?? '').toUpperCase();
  const fps = x => x.pose.fps ?? x.jump.fps ?? 120, k = (x, id) => kf(x.jump, id);

  // 1. intro: the whole last jump, run-up to the sand
  {
    start();
    const x = P.intro, c = idx(x), r = fps(x) / 120;
    const td = k(x, 'TD'), to = k(x, 'TO'), land = k(x, 'land') ?? to + Math.round(0.75 * fps(x)), pen = k(x, 'penTD') ?? td - 25;
    const list = [];
    for (let f = Math.max(0, pen - Math.round(160 * r)); f < pen - 2 * r; f += 2.5 * r) list.push(f);
    for (let f = pen - 2 * r; f < to + 6 * r; f += 0.7 * r) list.push(f);
    for (let f = to + 6 * r; f <= land + 18 * r; f += 2 * r) list.push(f);
    const d = new Date(date);
    push(list, (f, i) => shot(c, f, 1.5 + 0.7 * ease(i / 70), { yb: 0.55, dark: 0.15,
      w: [W(i, `${WEEKDAY[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`, 72, 250, 'S', 46, ACC, 6), W(i, 'TRÉNING', 62, 320, 'B', 230, INK, 10), W(i, name, 66, 560, 'B', 110, ACC, 16)].filter(Boolean) }));
  }

  // 2. the best jump, phase by phase, a hold on each with one measured value
  {
    start();
    const x = P.best, c = idx(x), r = fps(x) / 120;
    const pen = k(x, 'penTD'), td = k(x, 'TD'), to = k(x, 'TO'), land = k(x, 'land');
    const vals = Object.fromEntries(P.phases.map(p => [p.id, p]));
    const foot = x.jump.takeoffFoot ?? x.jump.takeoff?.foot ?? 'r';
    const kneeOk = metric(x.jump, 'kneeTO')?.status === 'ok';
    const list = [];
    if (pen != null) for (let q = 0; q < 40; q++) list.push([pen - 90 * r + q * 2.2 * r, 0, 'run']);
    if (pen != null) { for (let q = 0; q < 25; q++) list.push([pen - 10 * r + q * 0.4 * r, Math.min(1, q / 12), null]); for (let q = 0; q < 44; q++) list.push([pen, 1, 'pen']); }
    for (let f = (pen ?? td - 25 * r); f < td; f += 0.4 * r) list.push([f, 1, null]);
    for (let q = 0; q < 48; q++) list.push([td, 1, 'plant']);
    for (let f = td; f < to; f += 0.25 * r) list.push([f, 1, null]);
    for (let q = 0; q < 56; q++) list.push([to, 1, 'toeoff']);
    const end = land ?? to + 90 * r;
    for (let f = to; f < end; f += 0.9 * r) list.push([f, f < to + 32 * r ? 1 : 0.8, 'flight']);
    if (land != null && vals.landing?.text) for (let q = 0; q < 34; q++) list.push([land, 0.8, 'landing']);
    const first = {};
    list.forEach(([, , h], i) => { if (h && first[h] == null) first[h] = i; });
    push(list, ([f, sk, hold], i) => {
      const j = i - (first[hold] ?? i), out = shot(c, f, 2.3, { sk });
      const w = [];
      if (hold === 'run') {
        w.push(W(j, `${P.nth(x)}. SKOK`, 70, 200, 'B', 170, INK, 2));
        if (P.split) { w.push(W(j, 'ROZBEH 1–11 m', 76, 1500, 'S', 52, ACC, 10)); w.push(W(j, `${n(P.split, 2)} s`, 70, 1570, 'B', 150, INK, 14)); }
      } else if (hold && vals[hold]?.text) {
        w.push(W(j, PHASE_NAME[hold], 70, 200, 'B', 170, INK, 0));
        w.push(W(j, vals[hold].text, 1010, 390, 'B', 170, ACC, 4, 'r'));
        w.push(W(j, vals[hold].label, 1006, 580, 'S', 46, INK, 6, 'r'));
        if (hold === 'toeoff' && kneeOk && j > 12) out.arc = { a: foot + 'hip', b: foot + 'knee', c: foot + 'ank', t: fmt('kneeTO', metric(x.jump, 'kneeTO').value) };
      } else if (hold) w.push(W(j, PHASE_NAME[hold], 70, 200, 'B', 170, INK, 0));
      out.w = w.filter(Boolean);
      return out;
    });
  }

  // 3. what got better: the same measure on two jumps, top earlier, bottom later, a counter
  if (P.improved) {
    const I = P.improved, A = I.a, B = I.b, ca = idx(A), cb = idx(B);
    start();
    for (let i = 0; i < 14; i++) frames.push({ bg: 1, w: [W(i, 'ČO SA', 'c', 700, 'B', 190, INK, 0), W(i, 'ZLEPŠILO', 'c', 880, 'B', 190, ACC, 3)].filter(Boolean) });
    start();
    const ka = ['penTD', 'penTO', 'TD', 'maxFlex', 'TO', 'apex'].map(id => [k(A, id), k(B, id)]).filter(([p, q]) => p != null && q != null);
    const sync = f => { if (ka.length < 2) return f - ka[0][0] + ka[0][1]; for (let q = 1; q < ka.length; q++) if (f <= ka[q][0] || q === ka.length - 1) { const [p0, q0] = ka[q - 1], [p1, q1] = ka[q]; return q0 + ((f - p0) * (q1 - q0)) / Math.max(1, p1 - p0); } return f; };
    const anchor = { contactTO: 'TD', legTD: 'TD', inclTD: 'TD', touchdownDist: 'TD', contactPen: 'penTD', hipDrop: 'penTD', kneeTO: 'TO', takeoffAngle: 'TO', kneeDrive: 'TO', speedLast: 'penTD' }[I.key] ?? 'TD';
    const fa = k(A, anchor), ra = fps(A) / 120;
    const list = [];
    for (let f = fa - 31 * ra; f < fa; f += 0.6 * ra) list.push([f, null]);
    for (let q = 0; q < 56; q++) list.push([fa, 'hold']);
    for (let f = fa; f < fa + 15 * ra; f += 0.6 * ra) list.push([f, null]);
    const h0 = list.findIndex(([, h]) => h);
    const label = SHORT[I.key] ?? I.key;
    push(list, ([f, hold], i) => {
      const j = i - h0, e = ease(j / 6), num = I.from + (I.to - I.from) * ease((j - 8) / 18);
      const w = [{ t: `${P.nth(A)}. SKOK${splitOf(A.jump) ? ` – ${n(splitOf(A.jump), 2)} s` : ''}`, x: 60, y: 120, f: 'S', s: 44, c: WARN, a: 1, al: 'l' },
        { t: `${P.nth(B)}. SKOK${splitOf(B.jump) ? ` – ${n(splitOf(B.jump), 2)} s` : ''}`, x: 60, y: 1000, f: 'S', s: 44, c: ACC, a: 1, al: 'l' },
        { t: label, x: 60, y: 170, f: 'B', s: label.length > 14 ? 96 : 110, c: INK, a: 1, al: 'l' }];
      if (j >= 0 && e > 0) {
        w.push({ t: fmt(I.key, I.from), x: 1020, y: 310, f: 'B', s: 200, c: WARN, a: +e.toFixed(3), al: 'r' });
        w.push({ t: fmt(I.key, num), x: 1020, y: 1080, f: 'B', s: 200, c: ACC, a: +e.toFixed(3), al: 'r' });
        if (j > 26 && I.inNorm) w.push(W(j, 'V NORME', 1020, 1320, 'B', 100, ACC, 26, 'r'));
      }
      return { panes: [{ ...shot(ca, f, 1.75, { yb: 0.55, sk: 1, skc: WARN }), at: [0, 0], wh: [1080, 960] }, { ...shot(cb, sync(f), 1.75, { yb: 0.55, sk: 1 }), at: [0, 960], wh: [1080, 960] }], line: 1, w: w.filter(Boolean) };
    });
  }

  // 4. the best phase from each attempt, then "spolu"
  if (P.bestOf) {
    start();
    for (let i = 0; i < 16; i++) frames.push({ bg: 1, w: [W(i, 'NAJLEPŠIE', 'c', 760, 'B', 190, INK, 0), W(i, 'Z KAŽDÉHO POKUSU', 'c', 960, 'S', 56, ACC, 3)].filter(Boolean) });
    for (const b of P.bestOf) {
      start();
      const c = idx(b.x), r = fps(b.x) / 120;
      const at = b.id === 'pen' ? k(b.x, 'penTD') - 10 * r : b.id === 'plant' ? k(b.x, 'TD') - 14 * r : k(b.x, 'TD') + 4 * r;
      const step = b.id === 'toeoff' ? 0.3 : b.id === 'plant' ? 0.4 : 0.5;
      const list = Array.from({ length: 56 }, (_, q) => at + q * step * r);
      push(list, (f, i) => shot(c, f, 2.3, { sk: 1, w: [W(i, PHASE_NAME[b.id], 'c', 1420, 'B', 170, INK, 0), W(i, `${b.nth}. SKOK`, 'c', 1600, 'S', 48, ACC, 4), W(i, b.value, 'c', 230, 'B', 140, ACC, 6)].filter(Boolean) }));
    }
    if (P.together) {
      start();
      const T = P.together, c = idx(T.land), lf = k(T.land, 'land') ?? k(T.land, 'TO') + 80, r = fps(T.land) / 120;
      for (let i = 0; i < 165; i++) frames.push(shot(c, lf - 44 * r + i * 0.4 * r, 2.0, { dark: 0.66, w: [W(i, 'SPOLU', 'c', 330, 'B', 170, INK, 0),
        W(i, `rýchlosť  –  ${P.nth(T.speed)}. skok`, 'c', 600, 'S', 50, INK, 8), W(i, `uhol odrazu ${Math.round(T.angleDeg)}°  –  ${P.nth(T.angle)}. skok`, 'c', 680, 'S', 50, INK, 14),
        W(i, `dopad  –  ${P.nth(T.land)}. skok`, 'c', 760, 'S', 50, INK, 20), W(i, `≈ ${n(T.value, 1)} m`, 'c', 900, 'B', 300, ACC, 30)].filter(Boolean) }));
    }
  }

  // 5. next time: the measured miss on its frame, the target, then the cue big
  if (P.next) {
    const N = P.next, x = P.intro, c = idx(x), r = fps(x) / 120;
    const at = N.phase === 'pen' ? k(x, 'penTD') : N.phase === 'toeoff' ? k(x, 'TO') : N.phase === 'flight' ? k(x, 'apex') ?? k(x, 'TO') + 30 : N.phase === 'landing' ? k(x, 'land') ?? k(x, 'TO') + 80 : k(x, 'TD');
    start();
    const list = [...Array.from({ length: 25 }, (_, q) => [at - 10 * r + q * 0.4 * r, null]), ...Array.from({ length: 80 }, () => [at, 'hold'])];
    push(list, ([f, h], i) => {
      const j = i - 25;
      return shot(c, f, 2.3, { dark: 0.1, sk: 1, skw: 6, w: [W(i, PHASE_NAME[N.phase] ?? '', 70, 230, 'B', 150, INK, 0), W(i, `${P.nth(x)}. SKOK`, 76, 380, 'S', 44, WARN, 0),
        W(j, `${N.word} ${N.value}`, 70, 1420, 'B', N.word.length + N.value.length > 16 ? 110 : 140, WARN, 4), N.target ? W(j, `CIEĽ  ${N.target}`, 76, 1590, 'S', 52, INK, 12) : null].filter(Boolean) });
    });
    start();
    // the cue in lines of up to 13 letters, all one size (the longest line fills the width)
    const lines = [];
    for (const word of N.cue.split(' ')) { const l = lines.at(-1); if (l && (l + ' ' + word).length <= 13) lines[lines.length - 1] = l + ' ' + word; else lines.push(word); }
    const size = Math.min(250, Math.floor(950 / (0.5 * Math.max(...lines.map(l => l.length)))));
    const top = 960 - (lines.length * size * 1.05) / 2;
    for (let i = 0; i < 70; i++) frames.push(shot(c, at + i * 0.3 * r, 2.3, { dark: 0.62, w: [W(i, 'NABUDÚCE', 'c', top - 90, 'S', 56, ACC, 0),
      ...lines.map((l, q) => W(i, l, 'c', top + q * size * 1.05, 'B', size, INK, 4 + 4 * q))].filter(Boolean) }));
  }

  // 6. the end: today's better thing and next time's cue, over the best jump's flight
  {
    start();
    const x = P.best, c = idx(x), to = k(x, 'TO'), land = k(x, 'land') ?? to + 90, r = fps(x) / 120;
    const good = P.improved ? `${SHORT[P.improved.key] ?? ''} ${fmt(P.improved.key, P.improved.to)}`.trim() : P.phases.find(p => p.id === 'toeoff' && p.text) ? `NA DOSKE ${P.phases.find(p => p.id === 'toeoff').text}` : '';
    const goodSub = P.improved ? `z ${fmt(P.improved.key, P.improved.from)} v ${P.nth(P.improved.a)}. skoku` : '';
    for (let i = 0; i < 84; i++) frames.push(shot(c, Math.min(land, to + 4 * r + i * 1.4 * r), 2.0, { dark: Math.min(0.82, i / 40), w: [
      good ? W(i, P.improved ? 'DNES LEPŠIE' : 'DNES', 'c', 600, 'S', 52, ACC, 14) : null, good ? W(i, good, 'c', 670, 'B', good.length > 14 ? 130 : 190, INK, 18) : null, goodSub ? W(i, goodSub, 'c', 880, 'S', 44, INK, 22) : null,
      P.next ? W(i, 'NABUDÚCE', 'c', 1040, 'S', 52, ACC, 26) : null, P.next ? W(i, P.next.cue, 'c', 1110, 'B', P.next.cue.length > 12 ? 150 : 190, INK, 30) : null].filter(Boolean) }));
  }

  // a 3-frame dip from black at every cut
  for (const m of marks.slice(1)) for (let q = 0; q < 3 && m + q < frames.length; q++) frames[m + q].fade = +((q + 1) / 4).toFixed(2);
  void dip; void seg;

  // keypoints only for the frames used, as plain numbers (NaN → null)
  const clips = J.map((x, c) => {
    const kp = {};
    for (const f of [...used[c]].sort((a, b) => a - b)) { const k = x.pose.smooth[f]; if (k) kp[f] = Array.from(k, v => (Number.isFinite(v) ? +v.toFixed(1) : null)); }
    return { frames: [...used[c]].sort((a, b) => a - b), kp, W: x.pose.W ?? null, H: x.pose.H ?? null };
  });
  return { out: OUT, clips, frames, seconds: +(frames.length / OUT.fps).toFixed(1), plan: summary(P) };
}
// what the cut says, for the app and the tests
function summary(P) {
  return { count: P.count, best: P.nth(P.best), intro: P.nth(P.intro), split: P.split, phases: P.phases.filter(p => p.text).map(p => `${p.id}:${p.text}`),
    improved: P.improved ? { key: P.improved.key, from: fmt(P.improved.key, P.improved.from), to: fmt(P.improved.key, P.improved.to), a: P.nth(P.improved.a), b: P.nth(P.improved.b) } : null,
    bestOf: P.bestOf?.map(b => `${b.id}:${b.nth}`) ?? null, together: P.together ? +P.together.value.toFixed(2) : null, next: P.next ? { cue: P.next.cue, value: P.next.value, target: P.next.target } : null };
}
