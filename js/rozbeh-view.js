// Rozbeh: a full run-up with its take-off and never a landing (Stanley 2026-11-19: "nikdy inak
// nedopadneme, z celého je tam odraz ale nikdy nie s dopadom"), filmed from the side like an
// acceleration. Its own tab, storage and history, so Skok is never touched: it sends the clip as a
// jump job and reads the answer with the same analyzeJump, as a run-through. Freelap gives the
// splits (cones 1 · 6 · 11 · 21 m from the board), the video the steps and the take-off.
import { analyzeJump } from './analysis/jump.js';
import { detectContacts, approachToeOffs } from './analysis/events.js';
import { NORMS } from './analysis/metrics.js';
import { APPROVED_CUES } from './analysis/coach.js';
import { pairRun } from './analysis/sprint.js';
import { coneTimes } from './analysis/conetimes.js';
import { analyzeInCloud, resumeCloudJob, cloudReady, pendingCloudJob, askAboutJump } from './cloud.js';

const KEY = 'jump.rozbeh';
// Bumped when the reading changes: saved run-ups are read again from their stored answer on start.
const RB_ALGO = 9;   // 9 (2026-11-21): sprint-pass step edges, cone passings at the hips; 8: cone marks read in the picture, the run-through take-off rule; 7: 5 m splits from the cones, steps back 3.4 s; 6: run-up toe-offs at the toe peak
export const RUNUP_STEPS = 18;   // Stanley 2026-11-19: "rozbehy sú vždy 18 krokov"
const MAX = 120;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, dp) => (Number.isFinite(x) ? Number(x).toFixed(dp).replace('.', ',') : '–');
const n3 = x => num(x, 3).replace(/^0/, '');
const FOOT = { l: 'Ľ', r: 'P' };

// The Freelap splits of a run-up, nearest the board last: [21→11, 11→6, 6→1] with a cone at 6 m,
// [21→11, 11→1] without. Times in s, speeds in m/s; null where a split is missing.
export function splitsOf(legs) {
  const L = (legs ?? []).filter(Number.isFinite);
  if (!L.length) return null;
  if (L.length >= 3) {
    const [a, b, c] = L.slice(-3);
    return { s21_11: a, s11_6: b, s6_1: c, s1_11: b + c, v21_11: 10 / a, v11_6: 5 / b, v6_1: 5 / c, v1_11: 10 / (b + c), keep: (5 / c) / (5 / b) - 1 };
  }
  if (L.length === 2) { const [a, b] = L; return { s21_11: a, s1_11: b, v21_11: 10 / a, v1_11: 10 / b, keep: (10 / b) / (10 / a) - 1 }; }
  return { s1_11: L[0], v1_11: 10 / L[0] };
}

// What a run-up keeps from the jump analysis: the steps it saw, the last two contacts and the
// take-off. A rozbeh never lands, so the answer is read as a run-through whatever the server said.
// The steps of the run-up's end, walked back from the take-off by the running rhythm: a contact one
// step period before the next is the step before; two periods means a step the pose missed (kept as
// "nezachytený" so the numbers from the board stay right). Stops where the rhythm breaks or past
// `backS` seconds before the take-off (the Freelap zone). A single short miss had cut every step
// before it from the jump timeline (2026-11-19, IMG_4656: 3 of about 9 steps shown).
export function stepsBack(clean, first, last, fps, takeoff, pen, { backS = 2.6 } = {}) {
  // the run-up's own toe-offs as in Skok (approachToeOffs: the toe's peak, not the frame before)
  const raw = approachToeOffs(detectContacts(clean, first, last, fps), [pen, takeoff], fps).filter(c => c.to >= c.td && c.td < takeoff.td - 2).sort((a, b) => a.td - b.td);
  const cs = [];
  for (const c of raw) { const p = cs.at(-1); if (p && c.td <= p.to + 1) { if (c.to - c.td > p.to - p.td) cs[cs.length - 1] = c; continue; } cs.push(c); }
  // the running rhythm from the contacts of the last 2.5 s (one pair can be wrong: IMG_4658's pen and
  // take-off were named 18 frames apart for a 28-frame step, and the walk stopped after one step)
  const near = cs.filter(c => (takeoff.td - c.td) / fps < 2.5);
  const gaps = near.slice(1).map((c, i) => c.td - near[i].td).filter(g => g / fps > 0.17 && g / fps < 0.36).sort((a, b) => a - b);
  let period = gaps.length >= 3 ? gaps[gaps.length >> 1] : pen ? takeoff.td - pen.td : Math.round(0.26 * fps);
  const out = [{ td: takeoff.td, to: takeoff.to, foot: takeoff.foot }];
  // the last step is short (IMG_4658: 0.15 s against 0.24 s for the steps before), so the pen counts from half a period
  if (pen && takeoff.td - pen.td > 0.45 * period) out.unshift({ td: pen.td, to: pen.to, foot: pen.foot });
  for (let k = cs.length - 1; k >= 0; k--) {
    const c = cs[k], next = out[0];
    if (c.td >= next.td - 2) continue;
    const gap = next.td - c.td, n = Math.round(gap / period);
    if ((takeoff.td - c.td) / fps > backS) break;
    if (n < 1 || Math.abs(gap - n * period) > 0.35 * period || n > 3) { if (gap < 0.6 * period) continue; break; }
    for (let m = n - 1; m >= 1; m--) out.unshift({ td: Math.round(next.td - m * gap / n), to: null, foot: null, missing: true });
    out.unshift({ td: c.td, to: c.to, foot: c.foot });
    if (n === 1) period = 0.7 * period + 0.3 * gap;
  }
  return out.map((s, i) => ({ ...s, contact: s.to != null ? (s.to - s.td + 1) / fps : null, air: i < out.length - 1 && s.to != null ? (out[i + 1].td - s.to - 1) / fps : null }));
}

// The server's sprint-pass contacts (toe against track, result.motionSteps, 2026-11-21) replace the
// pose's edges of the step they match (touchdown within 3 frames). Filmed across the hall, against two
// blind readers on 108 steps: toe-offs within a frame 75 % from the pose, 85 % with these; touchdowns
// 86 → 87 %, the pose's −0.4 frame toe-off bias gone.
export function withMotion(steps, motion, fps) {
  if (!motion?.length) return steps;
  const out = steps.map(s => {
    if (s.missing || s.to == null) return { ...s };
    const m = motion.filter(q => Math.abs(q[0] - s.td) <= 3).sort((a, b) => Math.abs(a[0] - s.td) - Math.abs(b[0] - s.td))[0];
    return m && m[1] > m[0] ? { ...s, td: m[0], to: m[1], motion: true } : { ...s };
  });
  return out.map((s, i) => ({ ...s, contact: s.to != null ? (s.to - s.td + 1) / fps : null, air: i < out.length - 1 && s.to != null ? (out[i + 1].td - s.to - 1) / fps : null }));
}

// Per Freelap split: the steps in it, their rate from the video, the step length from the split's
// speed. The cones are passed by the chip on the hip; the 1 m cone about 1 m before the take-off
// touchdown at the 6-1 m speed. Steps at a boundary can fall either side, so the counts are shown "≈".
export function splitSteps(steps, ts, splits) {
  if (!splits || !steps?.length) return null;
  const take = steps.at(-1), tTD = ts[take.td], v1 = splits.v6_1 ?? splits.v1_11;
  if (!Number.isFinite(tTD) || !Number.isFinite(v1)) return null;
  const t1 = tTD - 1 / v1;
  const segs = splits.s11_6 != null
    ? [['21–11 m', t1 - splits.s6_1 - splits.s11_6 - splits.s21_11, t1 - splits.s6_1 - splits.s11_6, splits.v21_11], ['11–6 m', t1 - splits.s6_1 - splits.s11_6, t1 - splits.s6_1, splits.v11_6], ['6–1 m', t1 - splits.s6_1, t1, splits.v6_1]]
    : [['21–11 m', t1 - splits.s1_11 - (splits.s21_11 ?? NaN), t1 - splits.s1_11, splits.v21_11], ['11–1 m', t1 - splits.s1_11, t1, splits.v1_11]];
  return segs.filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([label, a, b, v]) => {
    const inside = steps.filter(s => ts[s.td] >= a && ts[s.td] < b);
    const periods = [];
    for (let i = 0; i < steps.length - 1; i++) if (ts[steps[i].td] >= a && ts[steps[i].td] < b) periods.push(ts[steps[i + 1].td] - ts[steps[i].td]);
    const rate = periods.length ? periods.length / periods.reduce((x, y) => x + y, 0) : null;
    const seen = ts[steps[0].td] <= a + 0.05;   // the steps go back to the split's start
    return { label, steps: inside.length, rate, length: rate && v ? v / rate : null, seen, contact: inside.filter(s => s.contact != null).reduce((x, s, _, l) => x + s.contact / l.length, 0) || null };
  });
}

// The run-up in 5 m pieces (2026-11-21, Stanley: "či každým krokom zrýchľujem alebo nie, či sa niekde
// nedrží rýchlosť"): the video's cone crossings, put on Freelap's clock where Freelap timed the 10 m
// they split (21-11 and 11-1: the video only says how the 10 m divides). 21-26 m and any piece
// without a Freelap leg keep the video's own time (about 1-2 % on the 1-11 m checked against Freelap).
export function fiveMeters(legs, fiveM) {
  const L = (legs ?? []).filter(Number.isFinite), f = splitsOf(L);
  const out = (fiveM ?? []).filter(x => x.to - x.from === 5 && x.s > 0).map(x => ({ ...x, v: 5 / x.s, src: 'video' }));
  for (const [lo, hi, F] of [[1, 11, f?.s1_11], [11, 21, f?.s21_11]]) {
    const h = out.filter(x => x.from >= lo && x.to <= hi);
    if (h.length !== 2 || !(F > 0)) continue;
    const sum = h[0].s + h[1].s;
    for (const x of h) { x.s = F * x.s / sum; x.v = 5 / x.s; x.src = 'freelap'; }
  }
  return out.sort((a, b) => b.from - a.from);   // far to near, the order he runs it
}

// Checked blind on IMG_5151-5158 (2026-11-21, filmed across the hall, 113 steps): touchdowns 89 %
// within a frame, toe-offs 72 % (92 % within two); which foot's step is longer agreed with the hand
// reads on 7 of 8, the per-foot contact and flight were 10-20 ms off on some.
// Left against right foot over the run-up the video saw, the last three steps left out (they are
// shaped for the take-off). Steps are named from the take-off foot back. In 13 of Stanley's 16
// stored run-ups the step off the right foot was longer: 292 against 271 ms, the flight after it
// 152 against 122 ms (2026-11-21).
export function rhythmOf(steps, ts, who) {
  const L = steps?.length ?? 0;
  if (L < 6 || !ts?.length) return null;
  const rows = steps.map((st, i) => ({ i, foot: footOf(i, L, who), step: i < L - 1 && !st.missing && !steps[i + 1].missing ? ts[i + 1] - ts[i] : null,
    contact: st.missing ? null : st.contact, air: st.missing || i === L - 1 ? null : st.air, fromBoard: L - 1 - i }));
  const side = f => { const r = rows.filter(x => x.foot === f && x.fromBoard > 3 && x.step != null); const av = k => { const v = r.map(x => x[k]).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }; return { n: r.length, step: av('step'), contact: av('contact'), air: av('air') }; };
  const R = side('r'), Lf = side('l');
  return { rows, r: R, l: Lf, enough: R.n >= 2 && Lf.n >= 2 };
}

// The 5 m pieces from the cone marks read in the picture (analysis/conetimes.js), on Freelap's clock:
// the picture's times are stretched evenly by the phone's view (8 % on IMG_5155), so they only split
// what Freelap timed. k = Freelap time over picture time between the two Freelap marks seen furthest
// apart; a mark inside a Freelap leg splits it at k times its picture time from the leg's end.
// Without Freelap there is no clock to put them on, so no pieces.
export function fiveFromMarks(legs, marks) {
  const L = (legs ?? []).filter(Number.isFinite);
  if (L.length < 2 || !marks) return [];
  const F = { 1: 0, 11: L.at(-1), 21: L.at(-1) + L.at(-2) };   // true time before the 1 m mark
  const t = m => (Number.isFinite(marks[m]) ? marks[m] : NaN);
  const have = [1, 11, 21].filter(m => Number.isFinite(t(m)));
  if (have.length < 2) return [];
  const a = have[0], b = have.at(-1), k = (F[b] - F[a]) / (t(a) - t(b));
  if (!(k > 0.8 && k < 1.15)) return [];
  const before1 = m => (Number.isFinite(t(m)) ? F[a] + k * (t(a) - t(m)) : NaN);   // true time of mark m before 1 m
  const out = [];
  for (const [lo, mid, hi] of [[1, 6, 11], [11, 16, 21]]) {
    const leg = F[hi] - F[lo], tm = before1(mid);
    if (Number.isFinite(tm) && tm - F[lo] > 0.3 * leg && tm - F[lo] < 0.7 * leg) {
      out.push({ from: lo, to: mid, s: tm - F[lo], src: 'freelap' }, { from: mid, to: hi, s: F[hi] - tm, src: 'freelap' });
    } else out.push({ from: lo, to: hi, s: leg, src: 'freelap' });
  }
  return out.map(x => ({ ...x, s: +x.s.toFixed(3), v: (x.to - x.from) / x.s })).sort((p, q) => q.from - p.from);
}

const rbCard = (title, body) => `<section class="card sp-card"><h2>${title}</h2>${body}</section>`;
// Speed in 5 m pieces, far to near, with the change from one piece to the next.
export function fiveCard(legs, fiveM, marks = null) {
  const parts = marks ? fiveFromMarks(legs, marks) : fiveMeters(legs, fiveM);
  if (marks && !parts.length) return rbCard('Rýchlosť po 5 m', `<p class="note">${(legs ?? []).filter(Number.isFinite).length >= 2 ? 'Vo videu appka nevidela dosť kužeľov (treba pri doske a na 11 alebo 21 m).' : 'Úseky po 5 m appka rozdelí, keď k rozbehu priradí časy z Freelapu: kužele vo videu dávajú len podiel z ich času.'}</p>`);
  if (!parts.length) return rbCard('Rýchlosť po 5 m', '<p class="note">Appka potrebuje vo videu kužele každých 5 m: k 1, 11 a 21 m (Freelap) obyčajné kužele na 6, 16 a 26 m. Rýchlosť medzi dvoma kužeľmi zmeria z videa.</p>');
  const top = Math.max(...parts.map(p => p.v)), low = Math.min(...parts.map(p => p.v));
  const rows = parts.map((p, n) => {
    const prev = parts[n - 1], d = prev ? (p.v / prev.v - 1) * 100 : null;
    return `<div class="sp-row rb-row${p.v === top ? ' hl' : ''}"><span style="width:76px">${p.to}–${p.from} m</span>
      <span class="sp-bar"><span class="c" style="width:${(14 + (top > low ? (p.v - low) / (top - low) : 1) * 66).toFixed(0)}px"></span></span>
      <span class="sp-n" style="width:72px"><b>${num(p.v, 2)}</b> m/s</span><span class="sp-n" style="width:56px">${num(p.s, 2)} s</span>
      <span class="sp-n" style="width:64px">${d == null ? '' : `<span class="chg ${d >= 0.5 ? 'up' : d <= -0.5 ? 'down' : ''}">${d >= 0 ? '+' : '−'}${num(Math.abs(d), 1)} %</span>`}</span></div>`;
  }).join('');
  const peak = parts.findIndex(p => p.v === top), after = parts.slice(peak + 1);
  // a change under 1 % between pieces is holding the speed, not gaining or losing it (IMG_5155: 9.55
  // then 9.50 m/s); the 5 m shares are good to about 0.5-1 % (far/near ratio 0-3 % off Freelap's)
  const held = (() => { let k = parts.length - 1; while (k > 0 && Math.abs(parts[k].v / parts[k - 1].v - 1) < 0.01) k--; return k; })();
  const say = after.length && after.at(-1).v < top * 0.99
    ? `Najrýchlejší úsek ${parts[peak].to}–${parts[peak].from} m, potom ${num((1 - after.at(-1).v / top) * 100, 1)} % pomalšie do dosky.`
    : held < parts.length - 1 ? `Od ${parts[held].to} m rýchlosť drží až do dosky (zmena pod 1 %).`
    : peak === parts.length - 1 ? 'Zrýchľuješ až do posledného úseku pred doskou.' : 'Rýchlosť drží až do dosky.';
  const src = marks ? 'Čas z Freelapu, rozdelený na 5 m podľa toho, kedy ťa video vidí prejsť okolo klobúčika.' : parts.some(p => p.src === 'freelap') ? 'Úseky v 10 m Freelapu: čas z Freelapu, rozdelený podľa prechodu okolo kužeľa vo videu. Ostatné z videa (±1–2 %).' : 'Čas z prechodu okolo kužeľov vo videu (±1–2 %).';
  return rbCard('Rýchlosť po 5 m', `${rows}<p class="note s">${say}</p><p class="note s">${src}</p>`);
}
// "Ako má vyzerať rýchlejší rozbeh" (Stanley 2026-11-21: "keď chcem bežať rýchlejšie ako to má
// vyzerať… vidieť na krivke"). Research: vault 51 Coaching Library/51 (2026-11-21).
// - Shape: better jumpers run the same curve, higher (Koyama, Muraki & Ae 2011, laser, 965 jumps):
//   21-11 m about 3 % slower than 11-1 m. So the target keeps the athlete's own 21-11 / 11-6 / 6-1
//   shape scaled to the chosen 11-1 time; a dip into the board is not kept (finalists hold the last
//   10 m flat, Berlin 2009 Vloss ≈ 0).
// - Steps: near top speed the extra speed comes mostly from step rate (Kivi 2001; Hunter 2004: same
//   length, higher rate within a person), contact about 13 ms shorter per m/s. The card splits the
//   21-11 m gain 70 % rate / 30 % length and says it is an estimate.
// Options: the athlete's 11-1 m less 2, 4.5 and 7 %.
export const TARGET_SHARE_RATE = 0.7;
export function targetOptions(near) { return [...new Set([0.98, 0.955, 0.93].map(f => Math.round(near * f * 100) / 100))]; }
// Shapes of the target (Stanley 2026-11-21: "môže byť aj iná tá krivka… lepšie zrýchlenie, agresívnejšie
// budovanie rýchlosti"), as the 21-11 m speed over the 11-1 m speed:
//  own   - his own ratio (better jumpers run the same curve higher, Koyama 2011)
//  elite - 0.97, the 8.00-8.10 m group's laser curve (Koyama 2011), last 10 m flat (Berlin 2009)
//  fast  - 0.99, the speed built by 21 m: longer above 95 % of the peak, which goes with distance
//          (r = 0.70 men, Zhou & Kang 2000), at the cost the same authors name: too fast too early
//          spoils the take-off
export const TARGET_SHAPES = { own: null, elite: 0.97, fast: 0.99 };
export function targetPlan(legs, marks, steps, ts, target, shape = 'own') {
  const pieces = fiveFromMarks(legs, marks);
  if (pieces.length !== 3 || !(target > 0.5)) return null;
  const L = legs.filter(Number.isFinite), far = L.at(-2), near = L.at(-1);
  const now = [21, 11, 6].map(a => pieces.find(p => p.to === a)).map(p => ({ a: p.to, b: p.from, v: p.v }));
  const k = near / target, tgt = now.map(p => ({ ...p, v: p.v * k }));
  const dip = now[2].v / now[1].v - 1;
  // under 1 % is inside what the 5 m shares can tell (the far/near ratio sat 0-3 % off Freelap's)
  if (dip < -0.01) tgt[1].v = tgt[2].v = 10 / target;
  const ratioNow = (10 / far) / (10 / near), ratio = TARGET_SHAPES[shape] ?? ratioNow;
  if (shape !== 'own' && TARGET_SHAPES[shape]) { tgt[0].v = ratio * 10 / target; tgt[1].v = tgt[2].v = 10 / target; }
  // the steps that fall in 21-11 m by the cone marks (video clock, as the steps)
  let rate = null, contact = null;
  if (steps?.length && ts?.length && Number.isFinite(marks?.[21]) && Number.isFinite(marks?.[11])) {
    const dts = [], cts = [];
    for (let i = 0; i < steps.length - 1; i++) {
      if (steps[i].missing || steps[i + 1].missing) continue;
      const mid = (ts[i] + ts[i + 1]) / 2;
      if (mid > marks[21] && mid < marks[11]) { dts.push(ts[i + 1] - ts[i]); if (Number.isFinite(steps[i].contact)) cts.push(steps[i].contact); }
    }
    if (dts.length >= 3) rate = dts.length / dts.reduce((a, b) => a + b, 0);
    if (cts.length >= 3) contact = cts.reduce((a, b) => a + b, 0) / cts.length;
  }
  const v0 = now[0].v, v1 = tgt[0].v, r = v1 / v0;
  return { now, tgt, far, near, target, t21: 10 / tgt[0].v, dip, v0, v1, shape, ratio, ratioNow,
    rate0: rate, rate1: rate ? rate * r ** TARGET_SHARE_RATE : null, len0: rate ? v0 / rate : null, len1: rate ? v1 / (rate * r ** TARGET_SHARE_RATE) : null,
    ct0: contact, ct1: contact != null ? contact - 0.013 * (v1 - v0) : null };
}
export function targetCard(legs, marks, steps, ts, target, recId = '', shape = 'own') {
  const L = (legs ?? []).filter(Number.isFinite);
  if (L.length < 2) return rbCard('Cieľová rýchlosť', '<p class="note">Cieľ appka ukáže, keď má rozbeh časy z Freelapu (21–11 a 11–1 m).</p>');
  const opts = targetOptions(L.at(-1)), sel = opts.includes(target) ? target : opts[1];
  const shp = shape in TARGET_SHAPES ? shape : 'own';
  const P = targetPlan(L, marks, steps, ts, sel, shp);
  if (!P) return rbCard('Cieľová rýchlosť', '<p class="note">Na krivku treba vo videu kužeľ pri doske, klobúčik na 5,2 m a kužeľ na 10,2 alebo 20,2 m.</p>');
  const W = 340, H = 190, x = m => 24 + (21 - m) / 20 * (W - 40);
  const lo = Math.floor(Math.min(...P.now.map(p => p.v)) - 0.4), hi = Math.ceil(Math.max(...P.tgt.map(p => p.v)) + 0.2);
  const y = v => 12 + (hi - v) / (hi - lo) * (H - 40);
  const pts = arr => arr.map(p => [x((p.a + p.b) / 2), y(p.v)]);
  const path = (arr, style) => { const q = pts(arr), s0 = [[x(21), y(arr[0].v * 0.985)], ...q, [x(1), y(arr[2].v)]]; let d = `M${s0[0]}`; for (let i = 1; i < s0.length; i++) { const [a, b] = [s0[i - 1], s0[i]], cx = (a[0] + b[0]) / 2; d += ` C${cx},${a[1]} ${cx},${b[1]} ${b[0]},${b[1]}`; } return `<path d="${d}" fill="none" ${style}/>`; };
  const grid = []; for (let v = lo; v <= hi + 1e-9; v += 0.5) grid.push(`<line x1="24" x2="${W - 16}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="2" y="${y(v) + 4}" font-size="10" fill="var(--muted)">${num(v, 1)}</text>`);
  const marksSvg = [21, 11, 6, 1].map(m => `<line x1="${x(m)}" x2="${x(m)}" y1="${y(hi)}" y2="${H - 26}" stroke="var(--line)" stroke-dasharray="2 3"/><text x="${x(m)}" y="${H - 12}" font-size="11" text-anchor="middle" fill="var(--muted)">${m} m</text>`).join('');
  const dots = (arr, c) => pts(arr).map(([a, b], i) => `<circle cx="${a}" cy="${b}" r="3.5" fill="${c}"/><text x="${a}" y="${b - 8}" font-size="10.5" text-anchor="middle" fill="${c}" font-weight="700">${num(arr[i].v, 2)}</text>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Rýchlosť teraz a cieľ">${grid.join('')}${marksSvg}${path(P.now, 'stroke="var(--accent)" stroke-width="2.5"')}${path(P.tgt, 'stroke="var(--warn)" stroke-width="2.5" stroke-dasharray="6 4"')}${dots(P.now, 'var(--accent)')}${dots(P.tgt, 'var(--warn)')}</svg>`;
  const row = (a, b, c, hl) => `<div class="sp-row rb-row${hl ? ' hl' : ''}"><span style="flex:1">${a}</span><span class="sp-n" style="width:70px">${b}</span><span class="sp-n" style="width:22px;color:var(--muted)">→</span><span class="sp-n" style="width:70px"><b>${c}</b></span></div>`;
  const chips = opts.map(t => `<button class="rb-chip${t === sel ? ' on' : ''}" data-rb-target="${num(t, 2)}" data-rb-target-rec="${esc(recId)}">${num(t, 2)} s · ${num(10 / t, 1)} m/s</button>`).join('');
  const shapeChips = [['own', 'Tvoj tvar'], ['elite', 'Ako 8 m skokani'], ['fast', 'Rýchlejší nábeh']].map(([k, lb]) => `<button class="rb-chip${k === shp ? ' on' : ''}" data-rb-shape="${k}" data-rb-target-rec="${esc(recId)}">${lb}</button>`).join('');
  const d = P.dip * 100;
  const pct = x => num(Math.abs(1 - x) * 100, 0);
  const shapeTxt = shp === 'elite' ? `Tvar 8 m skokanov (Koyama 2011, laser): 21–11 m o ${pct(0.97)} % pomalšie ako 11–1 m, posledných 10 m rovno (teraz o ${pct(P.ratioNow)} % pomalšie).`
    : shp === 'fast' ? `Rýchlejší nábeh: rýchlosť postavená už do 21 m, 21–11 m len o ${pct(0.99)} % pomalšie ako 11–1 m (teraz ${pct(P.ratioNow)} %). Za: dlhšie bežíš pri vyše 95 % maxima, a to u mužov súvisí s dĺžkou skoku (r = 0,70, Zhou a Kang 2000). Proti: tí istí autori píšu, že priskoro rýchlo sťažuje odraz a trafenie dosky; viac práce je na prvých krokoch, nie pri doske.`
    : '';
  const hold = shp !== 'own' ? shapeTxt : Math.abs(d) < 1 ? 'Tvar nechaj: od 21 m pridávaš a posledných 10 m držíš, presne ako finalisti.'
    : d < 0 ? `Od 21 do 11 m pridávaš správne. Posledných 5 m o ${num(-d, 1)} % pomalšie, finalisti tam držia: cieľová krivka drží až do dosky.`
    : 'Tvar nechaj: zrýchľuješ až do dosky.';
  const stepRows = P.rate0 ? row('Krokov za sekundu (21–11 m)', num(P.rate0, 2), num(P.rate1, 2), 0) + row('Dĺžka kroku', `${num(P.len0, 2)} m`, `${num(P.len1, 2)} m`, 0) + (P.ct0 != null ? row('Na zemi', `${Math.round(P.ct0 * 1000)} ms`, `${Math.round(P.ct1 * 1000)} ms`, 0) : '') : '';
  return rbCard('Cieľová rýchlosť', `<p class="note" style="margin-bottom:8px">Čas 11–1 m, ktorý chceš bežať:</p><div class="rb-chips">${chips}</div><p class="note" style="margin-bottom:6px">Tvar krivky:</p><div class="rb-chips">${shapeChips}</div>
    ${svg}
    <p class="note s"><span style="color:var(--accent);font-weight:700">━ teraz</span> (${num(P.far, 2)} / ${num(P.near, 2)} s) &nbsp; <span style="color:var(--warn);font-weight:700">╍ cieľ</span> (${num(P.t21, 2)} / ${num(P.target, 2)} s). Rýchlosť v m/s v úsekoch 21–11, 11–6 a 6–1 m.</p>
    <div style="margin-top:10px">${row('21–11 m', `${num(P.far, 2)} s`, `${num(P.t21, 2)} s`, 0)}${row('11–1 m', `${num(P.near, 2)} s`, `${num(P.target, 2)} s`, 1)}${stepRows}</div>
    <p class="note s" style="margin-top:10px"><b>Ako to má vyzerať.</b> ${hold} Medzi 21 a 11 m o ${num(P.v1 - P.v0, 1)} m/s vyššie (${num(P.v1, 2)} m/s): rýchlosť musí byť postavená tam, nie dobehnutá pri doske. Navyše príde hlavne z rýchlejšieho kroku: kratšie na zemi, krok skoro rovnako dlhý.</p>
    <p class="note s"><b>Povel:</b> „stlač zem pod seba“</p>
    <p class="note s">Tvar krivky: Koyama 2011 (965 skokov, laser), 21–11 m asi o 3 % pomalšie ako 11–1 m u teba aj u 8 m skokanov. Krok: odhad z výskumu (Kivi 2001, Hunter 2004: pri vyššej rýchlosti hlavne frekvencia). Tvoj vlastný pomer appka zistí, keď zabehneš rýchlejšie.</p>`);
}

// Every step the video saw: which foot, the step time, the contact and the flight; then right
// against left over the run-up before the last three steps.
export function rhythmCard(steps, ts, who, total = RUNUP_STEPS) {
  const R = rhythmOf(steps, ts, who);
  if (!R) return '';
  const ms = x => (Number.isFinite(x) ? Math.round(x * 1000) : '–');
  const rows = R.rows.map(r => `<div class="sp-row rb-row${r.fromBoard <= 3 ? ' dim' : ''}"><span class="sp-i">${total - r.fromBoard}</span><span class="sp-f">${FOOT[r.foot]}</span>
    <span class="sp-n">${ms(r.step)}</span><span class="sp-n">${ms(r.contact)}</span><span class="sp-n">${r.fromBoard === 0 ? 'odraz' : ms(r.air)}</span></div>`).join('');
  const sideTxt = (lb, x) => `${lb}: krok <b>${ms(x.step)}</b> ms`;
  const diff = R.enough ? R.r.step - R.l.step : null;
  const verdict = diff == null ? 'Na porovnanie treba aspoň 2 kroky z každej nohy pred poslednými tromi.'
    : Math.abs(diff) < 0.008 ? 'Rytmus je vyrovnaný (rozdiel pod 1 snímku).'
    // only the step time (touchdown to touchdown): its side agreed with two blind readers on 7 of 8
    // run-ups, the per-side flight did not (IMG_5158: the app's longer flight was on the other foot)
    : `Krok z ${diff > 0 ? 'pravej' : 'ľavej'} je dlhší o ${Math.round(Math.abs(diff) * 1000)} ms (${num(Math.abs(diff) / ((R.r.step + R.l.step) / 2) * 100, 0)} %).`;
  return rbCard('Rytmus ľavá / pravá', `<div class="sp-row rb-row sp-head"><span class="sp-i">#</span><span class="sp-f"></span><span class="sp-n">krok</span><span class="sp-n">zem</span><span class="sp-n">let</span></div>${rows}
    ${R.enough ? `<p class="note s">${sideTxt('Pravá', R.r)}<br>${sideTxt('Ľavá', R.l)}</p>` : ''}<p class="note s">${verdict}</p>
    <p class="note s">Kroky od odrazu z pravej dozadu; posledné 3 (sivé) sa do porovnania nerátajú. Časy v ms, každý dotyk a odlepenie ±1 snímka (±8 ms) pri 85–87 % krokov; zem a let jedného kroku preto ±10–20 ms, krok z dotyku na dotyk je presnejší a len z neho sa porovnávajú nohy.</p>`);
}


// Both athletes take off from the right foot (Stanley 2026-11-19: "odraz je z pravej"); the pose
// swaps left and right in a side view, so the feet are named from the take-off back, alternating.
export const TAKEOFF_FOOT = { stanley: 'r', miska: 'r' };
export const footOf = (i, len, who) => { const t = TAKEOFF_FOOT[who] ?? 'r'; return (len - 1 - i) % 2 === 0 ? t : (t === 'r' ? 'l' : 'r'); };

export function rozbehNumbers(result, sex, height) {
  const res = { ...result, events: result?.events ? { ...result.events, kind: 'runthrough' } : result?.events };
  let j = analyzeJump(res, sex, res.ts ?? null, { height, trustTakeoff: true });
  // The board cone (0.2 m) is passed within about 0.1 s of the take-off touchdown. When the server's
  // named take-off has no cone passing there but the pose's own run-up pick does, the pose's stands
  // (2026-11-21, IMG_5157 with Claude: named 1178, a step in the sand; the pose and the cone: 1100).
  const boardCone = jj => { if (jj.error || !result.ground?.cones) return null; const c = coneTimes(result.ground.cones, res.smooth, res.ts ?? [], { td: jj.takeoff?.td, sex }); return !c.error && c.crossings.some(x => x.cone === 0.2); };
  if (!j.error && result.events?.TD != null && boardCone(j) === false) {
    const j2 = analyzeJump({ ...res, events: { kind: 'runthrough' } }, sex, res.ts ?? null, { height, trustTakeoff: true });
    if (boardCone(j2)) j = j2;
  }
  if (j.error) return { error: j.error };
  const m = Object.fromEntries((j.metrics ?? []).map(x => [x.key, x.status === 'hidden' ? null : x.value]));
  const g = j.flight?.ground && !j.flight.ground.error ? j.flight.ground : null;
  const sp = id => g?.steps?.find(s => s.id === id)?.speed ?? null;
  const back = withMotion(stepsBack(res.clean, res.first ?? 0, res.last ?? res.clean.length - 1, j.fps, { ...j.takeoff, foot: j.takeoffFoot }, j.pen, { backS: 3.4 }), result.motionSteps, j.fps);
  return {
    steps: back.map(r => ({ foot: r.foot, contact: r.contact, air: r.air, td: r.td, missing: !!r.missing })),
    ts: back.map(r => res.ts?.[r.td] ?? r.td / j.fps),
    stepCount: j.stepCount?.count ?? null, stepSeen: !!j.stepCount?.seen,
    pen: { contact: m.contactPen != null ? m.contactPen / 1000 : null, knee: m.penKnee },
    take: { contact: m.contactTO != null ? m.contactTO / 1000 : null, kneeTD: m.kneeTD, kneeTO: m.kneeTO, angle: m.takeoffAngle },
    speeds: g ? { third: sp('third'), pen: sp('pen'), take: sp('take') } : null,
    // 1-6 and 6-11 m only from a cone seen at the 6 m mark (ground.js): without one the mark came
    // out 1.8 m off on IMG_4677 (2026-11-14), too loose to split anything
    videoSplits: g?.splits?.s1to6 != null && g?.splits?.s6to11 != null ? { s1to6: g.splits.s1to6, s6to11: g.splits.s6to11 } : null,
    // 5 m (and 10 m) times between neighbouring cones as the video saw the hip pass them
    fiveM: g?.splits?.fiveM?.length ? g.splits.fiveM : null,
    // the cone marks read in the picture (2026-11-21: filmed across the hall the runway's metres
    // can't place the cones), the 5 m card's source whenever any were passed
    marks: (() => { const c = coneTimes(result.ground?.cones, res.smooth, res.ts ?? [], { td: j.takeoff?.td, sex }); return c.error ? null : c.marks; })(),
    frames: { penTD: j.pen?.td ?? null, TD: j.takeoff?.td ?? null, TO: j.takeoff?.to ?? null },
  };
}

// The splits shown for a run-up: Freelap's (21-11 and 11-1; Stanley 2026-11-19: Freelap measures
// only those two), with 11-1 divided at 6 m in the proportion the video's cone crossings give.
export function splitsWithVideo(legs, video) {
  const L = (legs ?? []).filter(Number.isFinite);
  if (L.length === 2 && video?.s1to6 > 0 && video?.s6to11 > 0) {
    const r = video.s1to6 / (video.s1to6 + video.s6to11), F = L[1];
    return { ...splitsOf([L[0], F * (1 - r), F * r]), from6: 'video' };
  }
  return splitsOf(L);
}

export function initRozbeh({ root, athletes, freelap, getAthlete, roster, inspect, onProgress = () => {}, onChange = () => {}, onDeleted = () => {}, saveClip, loadClip, loadOriginal, dropClip, storePose, loadPose, makePlayer }) {
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const store = l => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch { /* storage full or blocked */ } };
  const patch = (id, f) => { const l = load(), x = l.find(r => r.id === id); if (x) { f(x); store(l); } onChange(); return x; };
  const inFlight = new Set();
  const queue = [];
  let running = 0, current = null, player = null;

  const runOf = rec => {
    if (rec.typed?.length) return { legs: rec.typed, typed: true };
    if (rec.noFreelap) return null;
    const all = freelap?.runs?.() ?? [];
    const byKey = rec.runKey ? all.find(r => r.key === rec.runKey) : null;
    if (byKey) return byKey;
    const ups = all.filter(r => r.type === 'rozbeh');
    return pairRun(ups.length ? ups : all, { recordedAt: rec.recordedAt, duration: rec.duration ?? 0 }, rec.who) ?? null;
  };

  // ---------- upload ----------
  async function upload(file, { quiet = false } = {}) {
    if (!cloudReady()) { onProgress('Najprv ulož prístupový kľúč v nastaveniach.'); return; }
    let info = null;
    try { info = await inspect(file); } catch { onProgress(`Video ${file.name} sa nedá prečítať.`); return; }
    if (info.fps < 100) { onProgress(`${file.name}: video má len ${num(info.fps, 0)} fps, rozbeh potrebuje spomalené (120 fps).`); return; }
    const me = getAthlete();
    const id = `rb${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const rec = { id, at: Date.now(), recordedAt: info.recordedAt ?? file.lastModified ?? Date.now(), duration: info.duration ?? null, file: file.name, size: file.size, who: me?.id ?? null, pending: true, stage: 'čaká v rade', jobId: null };
    const l = load(); l.unshift(rec);
    for (const old of l.slice(MAX)) if (old.hasClip) dropClip?.(old.id);
    store(l); onChange();
    try { await saveClip(id, file); patch(id, x => { x.hasClip = true; }); } catch { /* the upload still goes */ }
    queue.push({ id, file, quiet });
    pump();
    return id;
  }
  // Every clip goes to the server at once and waits in its queue there (2026-11-19: sent two at a
  // time, three run-ups waited half an hour on a locked phone while the server sat idle).
  function pump() {
    while (running < 8 && queue.length) {
      const job = queue.shift();
      running++;
      run(job).finally(() => { running--; pump(); });
    }
  }
  async function run({ id, file, jobId = null }) {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const rec0 = load().find(r => r.id === id);
    const me = athletes[rec0?.who] ? { id: rec0.who, ...athletes[rec0.who] } : getAthlete();
    let saved = false;
    const take = result => {
      if (saved || !result) return;
      saved = true;
      const who = result.who?.id in athletes ? result.who.id : me.id, a = athletes[who];
      const nums = rozbehNumbers(result, a.sex, a.height);
      storePose?.(id, result).catch(() => {});
      patch(id, x => Object.assign(x, nums.error
        ? { who, pending: false, error: 'Odraz sa vo videu nenašiel. Ťukni a skús znova.', stage: null, hasPose: true, algo: RB_ALGO }
        : { who, pending: false, error: null, stage: null, ...nums, hasPose: true, algo: RB_ALGO }));
      if (!nums.error) comment(load().find(x => x.id === id));
    };
    try {
      patch(id, x => { x.stage = jobId ? 'server počíta' : 'posiela sa'; x.error = null; });
      const opts = {
        onJob: j => patch(id, x => { x.jobId = j; x.stage = 'čaká na server'; }),
        onProgress: q => { if (!saved) patch(id, x => { x.stage = q?.stage === 'queued' ? 'čaká na server' : 'server počíta'; }); },
        onResult: ({ result }) => take(result),
      };
      let out;
      if (jobId) out = await resumeCloudJob(jobId, opts);
      else {
        const all = await roster();
        out = await analyzeInCloud(file, { sex: me.sex, name: me.name, height: me.height, history: [], athletes: all, mode: 'rozbeh', ...opts });
      }
      take(out?.result);
      patch(id, x => { x.jobId = null; });
    } catch (e) {
      console.warn('Rozbeh failed', e);
      if (!saved) patch(id, x => { x.pending = false; x.stage = null; x.error = 'Analýza sa nepodarila. Ťukni a skús znova.'; x.jobId = null; });
    } finally { inFlight.delete(id); }
  }
  // After iOS closed the app: jobs on the server are followed again, clips that never left go now.
  async function resume() {
    // read again with today's code from the stored answer (no new upload)
    for (const r of load().filter(x => !x.pending && (x.hasPose || x.error) && (x.algo ?? 1) < RB_ALGO)) {
      const pose = await loadPose?.(r.id).catch(() => null);
      if (!pose) continue;
      const a = athletes[r.who] ?? getAthlete();
      const nums = rozbehNumbers(pose, a.sex, a.height);
      patch(r.id, x => Object.assign(x, nums.error ? { error: 'Odraz sa vo videu nenašiel. Ťukni a skús znova.', algo: RB_ALGO } : { ...nums, error: null, hasPose: true, algo: RB_ALGO }));
    }
    for (const r of load().filter(x => x.pending)) {
      if (inFlight.has(r.id)) continue;
      // a job already on the server is followed first: it is the nearest to done
      if (r.jobId && pendingCloudJob(r.jobId)) { queue.unshift({ id: r.id, file: null, jobId: r.jobId }); continue; }
      const file = r.hasClip ? await loadOriginal(r.id) : null;
      if (file) queue.push({ id: r.id, file });
      else patch(r.id, x => { x.pending = false; x.stage = null; x.error = 'Video sa v telefóne nenašlo. Nahraj ho znova.'; });
    }
    pump();
  }
  async function retry(id) {
    const r = load().find(x => x.id === id);
    if (!r || inFlight.has(id) || r.pending) return;
    const file = r.hasClip ? await loadOriginal(id) : null;
    if (!file) { patch(id, x => { x.error = 'Video sa v telefóne nenašlo. Nahraj ho znova.'; }); return; }
    patch(id, x => { x.pending = true; x.error = null; x.stage = 'čaká v rade'; });
    queue.push({ id, file }); pump();
    if (current === id) draw();
  }

  // ---------- list line ----------
  function summary(rec) {
    const name = athletes[rec.who]?.name ?? '';
    const at = rec.pending || rec.error ? rec.at : rec.recordedAt ?? rec.at;
    if (rec.pending || rec.error) return { kind: 'rozbeh', id: rec.id, who: rec.who, at, title: `Rozbeh · ${rec.file ?? ''}`, sub: rec.error ? 'nepodarilo sa · ťukni a skús znova' : rec.stage ?? 'analýza beží…', value: rec.error ? '!' : '…', valueSub: '' };
    const s = splitsWithVideo(runOf(rec)?.legs, rec.videoSplits);
    const n = runOf(rec)?.steps, steps = n ? ` ${n} kr.` : '';
    const sub = [s?.s21_11 != null ? `11–21 ${num(s.s21_11, 2)}` : null, rec.take?.contact != null ? `odraz ${num(rec.take.contact, 3)} s` : null].filter(Boolean).join(' · ');
    return { kind: 'rozbeh', id: rec.id, who: rec.who, at, title: `${name}${name ? ' · ' : ''}rozbeh${steps}`, sub, value: s?.s1_11 != null ? num(s.s1_11, 2) : '–', valueSub: s?.s1_11 != null ? '1–11 m' : 'bez Freelapu' };
  }

  // ---------- detail ----------
  const card = (title, body) => `<section class="card sp-card"><h2>${title}</h2>${body}</section>`;
  const cell = (lb, big, small = '') => `<div class="sp-cd"><p class="sp-lb">${lb}</p><p class="sp-mid">${big}</p>${small ? `<p class="sp-lb">${small}</p>` : ''}</div>`;
  function freelapHtml(rec) {
    const run = runOf(rec), s = splitsWithVideo(run?.legs, rec.videoSplits);
    const form = `<details class="rb-type"${s ? '' : ' open'}><summary>${s ? 'Upraviť časy' : 'Zadať časy z Freelapu'}</summary>
      <div class="sp-g2">${[['21–11 m', 's21_11'], ['11–1 m', 's1_11']].map(([lb, k]) => `<label class="sp-cd"><span class="sp-lb">${lb}</span><input class="rb-in" inputmode="decimal" data-rb-leg="${k}" value="${s?.[k] != null ? num(s[k], 2) : ''}" placeholder="0,00"></label>`).join('')}</div>
      <p class="note s">11–6 a 6–1 rozdelí appka z videa podľa klobúčika 5,2 m od dosky.</p>
      <button class="btn" data-rb-save="${esc(rec.id)}">Uložiť časy</button></details>`;
    if (!s) return card('Freelap · posledných 21 m', `<p class="note">K tomuto rozbehu sa nenašiel beh z Freelapu.</p>${form}`);
    const cells = s.s11_6 != null
      ? cell('21–11 m', `${num(s.s21_11, 2)} s`, `${num(s.v21_11, 2)} m/s`) + cell('11–6 m', `${num(s.s11_6, 2)} s`, `${num(s.v11_6, 2)} m/s`) + cell('6–1 m', `${num(s.s6_1, 2)} s`, `${num(s.v6_1, 2)} m/s`)
      : (s.s21_11 != null ? cell('21–11 m', `${num(s.s21_11, 2)} s`, `${num(s.v21_11, 2)} m/s`) : '') + cell('11–1 m', `${num(s.s1_11, 2)} s`, `${num(s.v1_11, 2)} m/s`);
    const keep = Number.isFinite(s.keep) ? `<span class="chg ${s.keep >= 0 ? 'up' : 'down'}">${s.keep >= 0 ? '+' : '−'}${num(Math.abs(s.keep) * 100, 1)} % ${s.s11_6 != null ? 'na posledných 5 m' : 'na posledných 10 m'}</span>` : '';
    const what = Number.isFinite(s.keep) ? (s.keep >= 0
      ? `Do dosky si zrýchlil o ${num(Math.abs(s.s11_6 != null ? s.v6_1 - s.v11_6 : s.v1_11 - s.v21_11), 2)} m/s.`
      : `Na konci si spomalil o ${num(Math.abs(s.s11_6 != null ? s.v6_1 - s.v11_6 : s.v1_11 - s.v21_11), 2)} m/s. Cieľ: rýchlosť udržať až do dosky.`) : '';
    const per = rec.ts?.length ? splitSteps(rec.steps.map((x, i) => ({ ...x, td: i })), rec.ts, s) : null;
    const perHtml = per?.length ? `<div class="rb-per">${per.map(p => `<div class="sp-row rb-row"><span style="width:64px">${p.label}</span><span class="sp-n" style="width:auto;flex:1;text-align:left">${p.seen ? `≈ ${p.steps} ${p.steps === 1 ? 'krok' : p.steps < 5 ? 'kroky' : 'krokov'}` : 'začiatok mimo videa'}</span><span class="sp-n" style="width:64px">${p.rate ? `${num(p.rate, 2)} kr/s` : '–'}</span><span class="sp-n" style="width:64px">${p.length ? `${num(p.length, 2)} m` : '–'}</span></div>`).join('')}<p class="note s">Frekvencia z videa, dĺžka kroku z rýchlosti Freelapu a frekvencie.</p></div>` : '';
    return card(`Freelap · posledných 21 m${run.typed ? ' (zadané ručne)' : ''}`, `<div class="${s.s11_6 != null ? 'sp-g3' : 'sp-g2'}">${cells}</div>
      ${s.s11_6 != null ? `<div class="rb-sum"><span><span class="sp-lb">1–11 m</span> <b>${num(s.s1_11, 2)} s</b> <span class="sp-lb">· ${num(s.v1_11, 2)} m/s</span></span>${keep}</div>` : `<div class="rb-sum"><span></span>${keep}</div>`}
      ${s.from6 ? '<p class="note s">11–6 a 6–1: čas 11–1 z Freelapu rozdelený podľa prechodu cez kužeľ na 6 m vo videu.</p>' : ''}${what ? `<p class="note s">${what}</p>` : ''}${perHtml}${form}`);
  }
  function takeoffHtml(rec) {
    const t = rec.take ?? {};
    return card('Odraz', `<div class="sp-g3">${cell('Na doske', t.contact != null ? `${num(t.contact, 3)} s` : '–', rec.pen?.contact != null ? `predposl. ${num(rec.pen.contact, 3)} s` : '')}
      ${cell('Koleno pri odraze', t.kneeTO != null ? `${num(t.kneeTO, 0)}°` : '–', t.kneeTD != null ? `dopad ${num(t.kneeTD, 0)}°` : '')}
      ${cell('Uhol odrazu', t.angle != null ? `${num(t.angle, 0)}°` : '–', t.angle != null ? '' : 'let je príliš krátky')}</div>
      ${rec.speeds?.pen != null ? `<p class="note s">Rýchlosť z dráhy: predposledný ${num(rec.speeds.pen, 2)} m/s, odraz ${num(rec.speeds.take, 2)} m/s.</p>` : '<p class="note s">Rýchlosť posledných krokov len keď appka nájde dosku a čiary dráhy.</p>'}`);
  }
  // The last steps, 11-1 m from the board (Stanley 2026-11-19: "posledné kroky 11-1 potrebujem každý
  // let a kontakt a frekvencia a dĺžka"): contact and flight from the video (±1-2 frames by eye on
  // IMG_4654), the step rate from touchdown to touchdown, the step length from the Freelap speed of
  // the split the step is in. The 11 m cone from the splits, else the last 1.25 s.
  function lastSteps(rec) {
    const steps = rec.steps ?? [], ts = rec.ts ?? [];
    if (!steps.length) return null;
    const total = runOf(rec)?.steps ?? RUNUP_STEPS, sp = splitsWithVideo(runOf(rec)?.legs, rec.videoSplits);
    const tTake = ts.at(-1);
    const t1 = sp && Number.isFinite(tTake) ? tTake - 1 / (sp.v6_1 ?? sp.v1_11) : null;
    const t6 = t1 != null && sp.s6_1 != null ? t1 - sp.s6_1 : null;
    const t11 = t1 != null ? t1 - (sp.s1_11 ?? NaN) : null;
    const inZone = i => (Number.isFinite(t11) ? ts[i] >= t11 - 0.02 : tTake - ts[i] <= 1.25);
    const speedAt = i => (!sp ? rec.speeds?.pen ?? null : t6 != null && ts[i] < t6 ? sp.v11_6 : sp.v6_1 ?? sp.v1_11);
    const first = Math.max(0, steps.findIndex((_, i) => inZone(i)));
    const rows = steps.slice(first).map((st, k) => {
      const i = first + k, last = i === steps.length - 1;
      const period = !last && Number.isFinite(ts[i + 1]) ? ts[i + 1] - ts[i] : null;
      const v = speedAt(i), ok = st.contact != null && st.contact >= 0.07 && !st.missing;
      return { n: total - (steps.length - 1 - i), foot: footOf(i, steps.length, rec.who), contact: ok ? st.contact : null, air: !last && ok ? st.air : null,
        rate: period ? 1 / period : null, length: period && v ? v * period : null, takeoff: last, pen: i === steps.length - 2 };
    });
    return { total, rows, sp };
  }
  // The last steps, 11-1 m from the board (Stanley 2026-11-19: "posledné kroky 11-1 potrebujem každý
  // let a kontakt a frekvencia a dĺžka"): contact and flight from the video (±1-2 frames by eye on
  // IMG_4654), the step rate from touchdown to touchdown, the step length from the Freelap speed of
  // the split the step is in. The 11 m cone from the splits, else the last 1.25 s.
  function stepsHtml(rec) {
    const L = lastSteps(rec);
    if (!L) return '';
    const scale = 420;
    const rows = L.rows.map(r => `<div class="sp-row rb-row${r.takeoff || r.pen ? ' hl' : ''}"><span class="sp-i">${r.n}</span><span class="sp-f">${FOOT[r.foot]}</span>
        <span class="sp-bar">${r.contact != null ? `<span class="c" style="width:${(r.contact * scale).toFixed(0)}px"></span>` : ''}${r.air != null ? `<span class="fl" style="width:${(r.air * scale).toFixed(0)}px"></span>` : ''}</span>
        <span class="sp-n">${r.contact != null ? n3(r.contact) : '–'}</span><span class="sp-n">${r.takeoff ? 'odraz' : r.air != null ? n3(r.air) : '–'}</span>
        <span class="sp-n">${r.rate ? num(r.rate, 2) : '–'}</span><span class="sp-n">${r.length ? num(r.length, 2) : '–'}</span></div>`).join('');
    return card(`Posledné kroky · 11–1 m (kroky ${L.rows[0].n}–${L.total})`, `<p class="sp-legend"><i class="c"></i>na zemi <i class="fl"></i>let · kr/s frekvencia · m dĺžka kroku</p>
      <div class="sp-row rb-row sp-head"><span class="sp-i">#</span><span class="sp-f"></span><span class="sp-bar"></span><span class="sp-n">zem</span><span class="sp-n">let</span><span class="sp-n">kr/s</span><span class="sp-n">m</span></div>${rows}
      <p class="note s">Rozbeh ${L.total} krokov${runOf(rec)?.steps ? ' (Freelap)' : ''}: ${L.total} odraz, ${L.total - 1} predposledný. Zem a let ±0,01 s. Dĺžka kroku z rýchlosti Freelapu v úseku${L.sp ? '' : ' (bez Freelapu len z rýchlosti dráhy, ak ju appka zmerala)'}.</p>`);
  }

  const fiveHtml = rec => fiveCard(runOf(rec)?.legs, rec.fiveM, rec.marks ?? null);
  const TARGET_KEY = who => `jump.rbTarget.${who}`;
  const targetOf = rec => { try { return parseFloat(localStorage.getItem(TARGET_KEY(rec.who))) || null; } catch { return null; } };
  const shapeOf = rec => { try { return localStorage.getItem(`${TARGET_KEY(rec.who)}.shape`) || 'own'; } catch { return 'own'; } };
  const targetHtml = rec => `<div data-rb-target-box>${targetCard(runOf(rec)?.legs, rec.marks ?? null, rec.steps, rec.ts, targetOf(rec), rec.id, shapeOf(rec))}</div>`;
  const rhythmHtml = rec => rhythmCard(rec.steps, rec.ts, rec.who, runOf(rec)?.steps ?? RUNUP_STEPS);

  // ---------- comment ----------
  // Claude's comment on the run-up (2026-11-19, Stanley: "koment od Clauda že čo je problém"): the
  // numbers go to the server's chat with the run-up rules (server/chat.py RUNUP_SYSTEM), the text is
  // kept on the record and written again when its numbers change (Freelap times added or typed).
  const r2 = x => (Number.isFinite(x) ? +x.toFixed(3) : null);
  function contextOf(rec) {
    const run = runOf(rec), s = splitsWithVideo(run?.legs, rec.videoSplits), L = lastSteps(rec);
    const earlier = load().filter(x => x.who === rec.who && x.id !== rec.id && !x.pending && !x.error).slice(0, 4).map(x => {
      const t = splitsWithVideo(runOf(x)?.legs, x.videoSplits);
      return { den: new Date(x.recordedAt ?? x.at).toLocaleDateString('sk-SK'), s1_11: r2(t?.s1_11), strataNaKonciPct: t?.keep != null ? r2(t.keep * 100) : null, kontaktNaDoske: r2(x.take?.contact) };
    });
    return {
      atlet: athletes[rec.who]?.name ?? null, krokovRozbehu: L?.total ?? RUNUP_STEPS,
      freelap: s ? { s21_11: r2(s.s21_11), s11_6: r2(s.s11_6), s6_1: r2(s.s6_1), s1_11: r2(s.s1_11), v21_11: r2(s.v21_11), v11_6: r2(s.v11_6), v6_1: r2(s.v6_1), v1_11: r2(s.v1_11), zmenaRychlostiNaKonciPct: s.keep != null ? r2(s.keep * 100) : null } : null,
      // values no runner produces are a frame-edge error, not a fault, and never reach the comment
      // (IMG_4658: a 0.025 s flight and 7.5 steps/s on the step into the board from a contact 2-4
      // frames off; the comment built its whole point on them)
      posledneKroky: (L?.rows ?? []).map(r => {
        const okRate = r.rate != null && r.rate >= 3 && r.rate <= 6;
        return { krok: r.n, noha: r.foot === 'r' ? 'pravá' : 'ľavá', zem: r.contact != null && r.contact <= 0.2 ? r2(r.contact) : null,
          let: r.air != null && r.air >= 0.05 && r.air <= 0.25 ? r2(r.air) : null, frekvencia: okRate ? r2(r.rate) : null, dlzka: okRate ? r2(r.length) : null,
          ...(r.takeoff ? { odraz: true } : {}), ...(r.pen ? { predposledny: true } : {}) };
      }),
      povoleneCue: APPROVED_CUES,
      odraz: { kontaktNaDoske: r2(rec.take?.contact), kontaktPredposledny: r2(rec.pen?.contact), kolenoPriDopade: r2(rec.take?.kneeTD), kolenoPriOdraze: r2(rec.take?.kneeTO) },
      predosleRozbehy: earlier,
      // the app's own norms (elite ranges in analysis/metrics.js): the only targets the comment may name
      normy: (() => { const g = athletes[rec.who]?.sex === 'female' ? 'f' : 'm', nr = k => NORMS[k]?.[g] ? { od: NORMS[k][g][0], do: NORMS[k][g][1], jednotka: NORMS[k].unit } : null;
        return { kontaktNaDoskeMs: nr('contactTO'), kontaktPredposlednyMs: nr('contactPen'), kolenoPriOdraze: nr('kneeTO'), kolenoPriDopade: nr('kneeTD') }; })(),
    };
  }
  const commentSig = rec => JSON.stringify([runOf(rec)?.legs ?? null, rec.steps?.length ?? 0, rec.algo ?? 0]);
  const commenting = new Set();
  async function comment(rec) {
    if (!rec || rec.pending || rec.error || commenting.has(rec.id) || !cloudReady()) return;
    const sig = commentSig(rec);
    if (rec.comment?.sig === sig) return;
    commenting.add(rec.id);
    patch(rec.id, x => { x.commentError = null; });
    try {
      const text = await askAboutJump(contextOf(rec), [{ role: 'user', text: 'Napíš krátky komentár k tomuto rozbehu: čo v ňom najviac rozhoduje, ako to vyzerá, ako by to malo byť, a jeden povel.' }], { kind: 'rozbeh' });
      patch(rec.id, x => { x.comment = { text, sig, at: Date.now() }; });
    } catch (e) {
      patch(rec.id, x => { x.commentError = e?.message || 'Komentár sa nepodarilo napísať.'; });
    } finally { commenting.delete(rec.id); onChange(); }
  }
  function commentHtml(rec) {
    const c = rec.comment, fresh = c && c.sig === commentSig(rec);
    const body = c?.text ? `${c.text.split(/\n+/).map(p => `<p class="rb-coach">${esc(p)}</p>`).join('')}${fresh ? '' : '<p class="note s">Časy sa zmenili, píšem nový komentár…</p>'}`
      : commenting.has(rec.id) || !rec.commentError ? '<p class="note">◌ Píšem komentár…</p>'
      : `<p class="note">${esc(rec.commentError)}</p><button class="btn" data-rb-comment="${esc(rec.id)}">Skúsiť znova</button>`;
    return `<div data-rb-cm>${card('Komentár', body)}</div>`;
  }
  let shownSig = '';
  function draw() {
    const rec = load().find(r => r.id === current);
    if (rec) shownSig = `${!!rec.pending}|${rec.error ?? ''}|${(rec.typed ?? []).join(',')}`;
    if (!rec) { root.innerHTML = '<div class="card"><p class="note">Rozbeh sa nenašiel.</p></div>'; return; }
    const name = athletes[rec.who]?.name ?? '';
    const video = rec.hasClip ? `<section class="card sp-card sp-video"><div class="sp-vbox player" data-rb-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div></section>` : '';
    const state = rec.pending ? `<section class="card"><p class="note" data-rb-state>◌ ${esc(rec.stage ?? 'analýza beží')}… Video si môžeš pozrieť hneď, čísla sa doplnia samé.</p></section>`
      : rec.error ? `<section class="card"><p class="banner bad">${esc(rec.error)}</p><button class="btn" data-rb-retry="${esc(rec.id)}">Skúsiť znova</button></section>` : '';
    const n = runOf(rec)?.steps ?? RUNUP_STEPS;
    root.innerHTML = `<h2 class="ath-name">${esc(name)}${name ? ' · ' : ''}rozbeh${n ? ` ${n} kr.` : ''}</h2>${video}${state}
      ${rec.pending || rec.error ? '' : commentHtml(rec) + freelapHtml(rec) + fiveHtml(rec) + targetHtml(rec) + rhythmHtml(rec) + takeoffHtml(rec) + stepsHtml(rec)}
      <section class="card"><button class="btn danger" data-rb-del="${esc(rec.id)}">Zmazať rozbeh</button></section>`;
    mountVideo(rec);
    if (!rec.pending && !rec.error && rec.comment?.sig !== commentSig(rec) && !commenting.has(rec.id)) comment(rec);
  }
  async function mountVideo(rec) {
    const box = root.querySelector('[data-rb-clip]');
    if (!box) return;
    if (player?.id === rec.id && player.el?.isConnected) return;
    const blob = await loadClip(rec.id).catch(() => null);
    if (!blob || current !== rec.id) { if (!blob) box.innerHTML = '<p class="note">Video sa v telefóne nenašlo.</p>'; return; }
    box.innerHTML = '';
    try {
      const p = await makePlayer(box, blob);
      player = { id: rec.id, el: box, p };
      // opens at the last steps: the start of the clip is the far, empty run-up
      const at = rec.frames?.penTD ?? rec.frames?.TD;
      if (Number.isFinite(at)) await p.player?.show?.(Math.max(0, at - 90));
    } catch { box.innerHTML = '<p class="note">Video sa nedá prehrať.</p>'; }
  }
  const parse = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) && v > 0.3 && v < 3 ? v : null; };
  root.addEventListener('click', e => {
    // the target time: remembered per athlete, only the target card redrawn (the video keeps playing)
    const sp = e.target.closest('[data-rb-shape]');
    if (sp) {
      const rec = load().find(x => x.id === sp.dataset.rbTargetRec);
      if (rec) { try { localStorage.setItem(`${TARGET_KEY(rec.who)}.shape`, sp.dataset.rbShape); } catch {} const box = root.querySelector('[data-rb-target-box]'); if (box) box.outerHTML = targetHtml(rec); }
      return;
    }
    const tp = e.target.closest('[data-rb-target]');
    if (tp) {
      const rec = load().find(x => x.id === tp.dataset.rbTargetRec), t = parseFloat(tp.dataset.rbTarget.replace(',', '.'));
      if (rec && t > 0) { try { localStorage.setItem(TARGET_KEY(rec.who), String(t)); } catch {} const box = root.querySelector('[data-rb-target-box]'); if (box) box.outerHTML = targetHtml(rec); }
      return;
    }
    const save = e.target.closest('[data-rb-save]');
    if (save) {
      const v = k => parse(root.querySelector(`[data-rb-leg="${k}"]`)?.value);
      const a = v('s21_11'), c = v('s1_11');
      const legs = c != null ? (a != null ? [a, c] : [c]) : (a != null ? [a] : []);
      patch(save.dataset.rbSave, x => { x.typed = legs.length ? legs : null; });
      draw(); return;
    }
    const cm = e.target.closest('[data-rb-comment]');
    if (cm) { const r = load().find(x => x.id === cm.dataset.rbComment); if (r) { comment(r); onChange(); } return; }
    const rt = e.target.closest('[data-rb-retry]');
    if (rt) return void retry(rt.dataset.rbRetry);
    const del = e.target.closest('[data-rb-del]');
    if (del) {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Naozaj?'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Zmazať rozbeh'; }, 3000); return; }
      const id = del.dataset.rbDel;
      store(load().filter(r => r.id !== id)); dropClip?.(id); current = null; onChange(); onDeleted();
    }
  });

  return {
    upload, resume, retry, summary,
    records: () => load(),
    open(id) { current = id; player = null; draw(); },
    // while it is on its way only the state line changes, so the video keeps playing
    refresh() {
      if (!current || !root.isConnected) return;
      const r = load().find(x => x.id === current);
      if (!r) return;
      const sig = `${!!r.pending}|${r.error ?? ''}|${(r.typed ?? []).join(',')}`;
      const cm = root.querySelector('[data-rb-cm]');
      if (sig === shownSig && cm && !r.pending && !r.error) { cm.outerHTML = commentHtml(r); return; }
      const line = root.querySelector('[data-rb-state]');
      if (sig === shownSig && r.pending && line) { line.textContent = `◌ ${r.stage ?? 'analýza beží'}… Video si môžeš pozrieť hneď, čísla sa doplnia samé.`; return; }
      if (sig !== shownSig) draw();
    },
    busy: () => running > 0 || queue.length > 0,
  };
}
