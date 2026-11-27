// The 1-11 m time from the video, the stretch Freelap times (Stanley, 2026-11-27: "ako urobiť presnosť
// ako Freelap"; "posledné metre sú z boku").
//
// Each stance before the board gives a speed: the centre of mass over the planted toe (camera motion
// cancels), pixels to metres through the body at that moment (torso + hip-knee-ankle = 0.779 of height,
// Drillis & Contini 1966). The phone stands beside the board, so the board is seen side-on and a step
// x m before it at an angle: its forward motion shrinks by cos = d / sqrt(d^2 + x^2) while the body's
// height does not. d, the phone's distance from the runway, is fitted per clip to how short the foot
// (heel to toe, a length along the run) looks against the torso step by step. Each speed is divided by
// that cos, smoothed over three steps, and the steps are added back from the board until the chip's
// trigger points: 1.0 and 11.0 m before the take-off line (cones at 0.2 and 10.2 m, the chip 0.8 m
// ahead of the cone). The toe at the board touchdown is taken at the line.
//
// Against Freelap on the five jumps that have both (2026-11-27): Miška 24 Nov 1.317/1.25, 1.201/1.20,
// 1.248/1.24; Stanley 23 Nov 1.097/1.10, 24 Nov 1.099/1.09: +5.3, +0.1, +0.6, −0.3, +0.8 %. Without the
// angle the same sum read +21 to +35 % slow; a yaw from hip width still +9 to +17 %. The phone came out
// 7-10 m from the runway on all five.
import { P, has, dist, centreOfMass, torsoLength } from './kinematics.js';

const BODY_OF_HEIGHT = 0.288 + 0.245 + 0.246;
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
function slope(t, y) {
  const n = t.length, mt = t.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (t[i] - mt) * (y[i] - my); den += (t[i] - mt) ** 2; }
  return num / den;
}
const torso = k => (k && has(k, 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(k) : NaN);
const legLen = (k, s) => (has(k, s + 'hip', s + 'knee', s + 'ank') ? dist(P(k, s + 'hip'), P(k, s + 'knee')) + dist(P(k, s + 'knee'), P(k, s + 'ank')) : NaN);
const bodyPx = k => (k ? torso(k) + median([legLen(k, 'l'), legLen(k, 'r')]) : NaN);

// contacts: every stance up to the board, { foot, td, to }; takeoff: the board contact.
export function videoSplit(track, ts, contacts, takeoff, { sex = 'male', dir = 1, height = null } = {}) {
  if (!(height > 100) || !takeoff) return { why: 'height' };
  const H = height / 100;
  const cs = (contacts ?? []).filter(c => c.td < takeoff.td).sort((a, b) => a.td - b.td);
  if (cs.length < 4) return { why: 'steps' };
  const st = [];
  for (let n = cs.length - 1; n >= 0; n--) {
    const c = cs[n], next = n + 1 < cs.length ? cs[n + 1].td : takeoff.td;
    const over = anchor => {
      const t = [], x = [];
      for (let i = c.td + 2; i <= c.to - 2; i++) {
        const k = track[i], nm = c.foot + anchor; if (!k || !has(k, nm)) continue;
        const m = centreOfMass(k, sex); if (!m) continue;
        t.push(ts[i]); x.push((m[0] - P(k, nm)[0]) * dir);
      }
      return t.length >= 4 ? slope(t, x) : NaN;
    };
    const sizes = [], torsos = [], feet = [];
    for (let i = c.td - 3; i <= c.to + 3; i++) { sizes.push(bodyPx(track[i])); torsos.push(torso(track[i])); }
    for (let i = c.td + 1; i <= c.to - 1; i++) {
      const k = track[i], t = torso(k);
      if (t > 0 && has(k, c.foot + 'heel', c.foot + 'bigtoe')) feet.push(Math.abs(P(k, c.foot + 'heel')[0] - P(k, c.foot + 'bigtoe')[0]) / t);
    }
    if (n === cs.length - 1 && !(median(torsos) >= 55)) return { why: 'small' };
    const pxPerM = median(sizes) / (BODY_OF_HEIGHT * H);
    const toe = over('bigtoe'), heel = over('heel');
    const px = Number.isFinite(toe) && Number.isFinite(heel) && heel > 0 && toe / heel < 0.95 ? heel * 1.12 : toe;
    const v = px / pxPerM;
    if (!(v > 3 && v < 12)) break;
    st.push({ v, foot: median(feet), dt: ts[next] - ts[c.td], td: c.td });
  }
  if (st.length < 4) return { why: 'steps' };
  // the centre of mass behind the toe at the board touchdown
  const k0 = track[takeoff.td], f0 = takeoff.foot;
  const s0 = median([-1, 0, 1].map(q => bodyPx(track[takeoff.td + q]))) / (BODY_OF_HEIGHT * H);
  const m0 = k0 && centreOfMass(k0, sex);
  const behind0 = m0 && has(k0, f0 + 'bigtoe') && s0 > 0 ? ((P(k0, f0 + 'bigtoe')[0] - m0[0]) * dir) / s0 : NaN;
  const behind = behind0 > 0 && behind0 < 1.2 ? behind0 : 0.5;
  const walk = d => {
    let pos = behind; const xs = [];
    for (const s of st) { xs.push(pos); s.vc = s.v * (Number.isFinite(d) ? Math.sqrt(d * d + pos * pos) / d : 1); pos += s.vc * s.dt; }
    return xs;
  };
  const ref = median(st.slice(0, 2).map(s => s.foot));
  if (!(ref > 0)) return { why: 'feet' };
  let d = NaN, xs = walk(d);
  for (let it = 0; it < 4; it++) {
    let best = null;
    for (let dd = 2; dd <= 40; dd += 0.25) {
      const c0 = dd / Math.sqrt(dd * dd + xs[0] ** 2);
      let e = 0;
      st.forEach((s, i) => { if (Number.isFinite(s.foot)) e += (s.foot / ref * c0 - dd / Math.sqrt(dd * dd + xs[i] ** 2)) ** 2; });
      if (!best || e < best.e) best = { dd, e };
    }
    d = best.dd; xs = walk(d);
  }
  const raw = st.map(s => s.vc);
  st.forEach((s, i) => { s.vs = median(raw.slice(Math.max(0, i - 1), i + 2)); });
  let pos = behind, tPrev = ts[takeoff.td], t1 = NaN, t11 = NaN;
  for (const s of st) {
    const p1 = pos + s.vs * s.dt;
    if (pos <= 1 && p1 > 1) t1 = tPrev - (1 - pos) / s.vs;
    if (pos <= 11 && p1 > 11) { t11 = tPrev - (11 - pos) / s.vs; break; }
    pos = p1; tPrev -= s.dt;
  }
  const s1to11 = t1 - t11;
  if (!(d >= 3 && d <= 30)) return { why: 'camera', d };
  if (!(s1to11 >= 0.8 && s1to11 <= 2)) return { why: Number.isFinite(t11) ? 'range' : 'short', reached: pos, d };
  return { s1to11, v: 10 / s1to11, d, steps: st.map(s => +s.vs.toFixed(2)), why: null };
}
