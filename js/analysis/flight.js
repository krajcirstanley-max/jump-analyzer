// Speeds, takeoff angle and distances in metres, from a handheld panning camera.
// Two tricks remove the camera's motion without tracking the background:
//  1. During the takeoff contact the planted toe is fixed to the ground, so the
//     centre of mass measured relative to it moves exactly as it does in the world.
//  2. In flight the centre of mass falls at exactly g = 9.81 m/s², so fitting a
//     parabola to its height gives the scale (pixels per metre) and a quality check.
import { P, has, mid, dist, centreOfMass, torsoLength } from './kinematics.js';

const G = 9.81;
const range = (a, b) => { const out = []; for (let i = a; i <= b; i++) out.push(i); return out; };

// Least-squares fit of y = a t² + b t + c; returns coefficients and RMS residual.
export function fitParabola(t, y) {
  const n = t.length;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0;
  for (let i = 0; i < n; i++) {
    const x = t[i], x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    r0 += y[i]; r1 += x * y[i]; r2 += x2 * y[i];
  }
  // Solve [[s4 s3 s2][s3 s2 s1][s2 s1 s0]] [a b c] = [r2 r1 r0] (Cramer's rule).
  const det3 = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const A = [[s4, s3, s2], [s3, s2, s1], [s2, s1, s0]];
  const D = det3(A);
  const col = (k, v) => A.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)));
  const rhs = [r2, r1, r0];
  const a = det3(col(0, rhs)) / D, b = det3(col(1, rhs)) / D, c = det3(col(2, rhs)) / D;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (y[i] - (a * t[i] * t[i] + b * t[i] + c)) ** 2;
  return { a, b, c, rms: Math.sqrt(ss / n) };
}

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// Linear slope of y over t (least squares).
function slope(t, y) {
  const n = t.length, mt = t.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (t[i] - mt) * (y[i] - my); den += (t[i] - mt) ** 2; }
  return num / den;
}

// track: smoothed keypoints; ev: keyFrames() output; ts: frame timestamps (s).
// height: the athlete's height in cm, for the centre-of-mass lowering; a typical one by sex if absent.
export function flightAnalysis(track, ev, ts, sex = 'male', dir = 1, height = null) {
  const { takeoff: T, takeoffFoot: s, landing } = ev;
  const com = i => (track[i] ? centreOfMass(track[i], sex) : null);

  // 1. Gravity fit on the flight, away from the contacts (smoothing bleeds into them).
  // With the landing hidden (e.g. behind a pillar) the visible part of the flight is used.
  const lastSeen = () => { let i = T.to; while (i + 1 < track.length && i < T.to + 130 && com(i + 1)) i++; return i; };
  const from = T.to + 3, to = landing != null ? landing - 3 : lastSeen() - 3;
  const t = [], y = [];
  for (let i = from; i <= to; i++) { const c = com(i); if (c) { t.push(ts[i] - ts[T.to]); y.push(c[1]); } }
  if (t.length < 20) return { error: 'Flight too short to fit.' };
  const fit = fitParabola(t, y);
  const pxPerM = (2 * fit.a) / G; // image y points down, so a > 0 in flight

  // The gravity scale holds for the flight only. The athlete changes distance to the phone
  // (IMG_2674: the whole body is 1.4x bigger in the image on the board than at the 3rd-last
  // step), so anything measured elsewhere is rescaled by the body's size at that moment:
  // the median ratio over torso, thighs and shanks. A limb only counts if its flight length
  // is stable; a limb that varies by more than a quarter is mistracked, not perspective.
  const SEGS = [['lsho', 'rsho', 'lhip', 'rhip'], ['lhip', 'lknee'], ['rhip', 'rknee'], ['lknee', 'lank'], ['rknee', 'rank']];
  const segLen = (k, s) => {
    if (!k || !has(k, ...s)) return NaN;
    return s.length === 4 ? torsoLength(k) : dist(P(k, s[0]), P(k, s[1]));
  };
  const flightIdx = []; for (let i = from; i <= to; i++) flightIdx.push(i);
  const refs = SEGS.map(s => {
    const v = flightIdx.map(i => segLen(track[i], s)).filter(Number.isFinite);
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    const cv = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) / m;
    return v.length >= 10 && cv < 0.25 ? median(v) : NaN;
  });
  const zoom = i => {
    const r = SEGS.map((s, j) => median([-3, -2, -1, 0, 1, 2, 3].map(d => segLen(track[i + d], s))) / refs[j]);
    const z = median(r);
    return z > 0 ? z : 1;
  };

  // 2. Centre of mass relative to the planted toe during the takeoff contact.
  const rel = [], rt = [];
  for (let i = T.td; i <= T.to; i++) {
    const kp = track[i], c = com(i);
    if (!c || !has(kp, s + 'bigtoe')) continue;
    const toe = P(kp, s + 'bigtoe');
    rel.push([(c[0] - toe[0]) * dir, toe[1] - c[1]]); rt.push(ts[i]);
  }
  if (rel.length < 6) return { error: 'Takeoff contact too short to measure speeds.' };
  const k = Math.min(4, Math.floor(rel.length / 3));
  const win = (a, b) => ({ t: rt.slice(a, b), x: rel.slice(a, b).map(r => r[0]), y: rel.slice(a, b).map(r => r[1]) });
  const head = win(1, 1 + k), tail = win(rel.length - k, rel.length);
  const vxTD = slope(head.t, head.x) / (pxPerM * zoom(T.td));
  const vxTO = slope(tail.t, tail.x) / (pxPerM * zoom(T.to));
  const vyTOcontact = slope(tail.t, tail.y) / pxPerM;
  // Vertical speed at toe-off from the flight parabola (independent of the toe anchor).
  // Same local scale as vxTO, so the takeoff angle stays a pure ratio of image speeds.
  const vyTOflight = -fit.b / (pxPerM * zoom(T.to));
  const vyTO = Number.isFinite(vyTOflight) ? vyTOflight : vyTOcontact;

  // 3. Landing reach: heel ahead of the centre of mass at first sand contact (same frame,
  //    so camera motion doesn't matter).
  let reach = NaN;
  const lk = landing != null ? track[landing] : null, lc = landing != null ? com(landing) : null;
  if (lk && lc) {
    const heels = ['lheel', 'rheel'].filter(n => has(lk, n)).map(n => P(lk, n)[0] * dir);
    if (heels.length) reach = (Math.max(...heels) - lc[0] * dir) / (pxPerM * zoom(landing));
  }

  // Sanity: torso length implied by the scale must be human (0.40-0.62 m).
  const torsoPx = track[T.to] && has(track[T.to], 'lsho', 'rsho', 'lhip', 'rhip')
    ? Math.hypot((P(track[T.to], 'lsho')[0] + P(track[T.to], 'rsho')[0] - P(track[T.to], 'lhip')[0] - P(track[T.to], 'rhip')[0]) / 2,
      (P(track[T.to], 'lsho')[1] + P(track[T.to], 'rsho')[1] - P(track[T.to], 'lhip')[1] - P(track[T.to], 'rhip')[1]) / 2) : NaN;
  const torsoM = torsoPx / pxPerM;
  // A short visible arc (landing hidden) can't pin the curvature, so no metres from it.
  // The takeoff angle is a ratio of two speeds, so it doesn't depend on the scale.
  const fitSeconds = t.at(-1) - t[0];
  const angleOk = pxPerM > 0 && fit.rms < 0.03 * pxPerM;
  const scaleOk = angleOk && torsoM > 0.4 && torsoM < 0.62 && fitSeconds >= 0.35;
  // Rise to the apex and vertical speed are g·t²/2 and g·t from the time to the apex alone:
  // the scale cancels out. They need the apex well inside the arc that was seen: with only
  // the rising branch (IMG_4390: 0.04 s past the apex) the fitted apex time drifted 9%.
  const tUp = -fit.b / (2 * fit.a);
  // Why the scale failed, for the athlete: a body that shrinks or grows in the image during
  // the flight is moving away from or towards the phone, so one pixels-per-metre can't hold
  // (IMG_4596: torso 136 -> 92 px, fit off by 3.2 cm).
  const tor = flightIdx.map(i => segLen(track[i], SEGS[0])).filter(Number.isFinite);
  const depth = tor.length >= 12 ? median(tor.slice(-6)) / median(tor.slice(0, 6)) : NaN;
  const scaleWhy = scaleOk ? null : fitSeconds < 0.35 ? 'short' : !angleOk && Math.abs(depth - 1) > 0.15 ? 'depth' : !angleOk ? 'fit' : 'torso';
  const apexOk = angleOk && tUp > t[0] + 0.03 && tUp < t.at(-1) - 0.08;
  const flightTime = landing != null ? ts[landing] - ts[T.to] : NaN;
  // Takeoff distance: centre of mass ahead of the toe at toe-off (Hay's partition).
  const takeoffDist = rel.at(-1)[0] / (pxPerM * zoom(T.to));
  const flightDistance = vxTO * flightTime;

  // Speed through the penultimate stance, the same toe anchor as the takeoff contact but over
  // the whole stance, which is what World Athletics' last-step velocity averages. The ends are
  // dropped because the foot is still settling or already peeling off there.
  let speedLast = NaN;
  if (ev.pen) {
    const foot = ev.pen.foot, ct = [], cx = [];
    for (let i = ev.pen.td + 2; i <= ev.pen.to - 2; i++) {
      const c = com(i);
      if (c && has(track[i], foot + 'bigtoe')) { cx.push((c[0] - P(track[i], foot + 'bigtoe')[0]) * dir); ct.push(ts[i]); }
    }
    if (ct.length >= 5) speedLast = slope(ct, cx) / (pxPerM * zoom(Math.round((ev.pen.td + ev.pen.to) / 2)));
  }

  // Centre-of-mass lowering. Pixels can't be compared across frames with a moving phone, so each
  // height is the centre of mass above the foot on the ground in that same frame, turned into cm
  // with that stance leg's own image length and the athlete's real leg length (thigh + shank
  // = 0.491 x height, Winter). No flight scale needed: it works when metres are withheld.
  const legM = (0.491 * (height ?? (sex === 'female' ? 168 : 180))) / 100;
  const legPx = c => median(range(c.td + 2, c.to - 2).map(i => {
    const k = track[i];
    return k && has(k, c.foot + 'hip', c.foot + 'knee', c.foot + 'ank') ? dist(P(k, c.foot + 'hip'), P(k, c.foot + 'knee')) + dist(P(k, c.foot + 'knee'), P(k, c.foot + 'ank')) : NaN;
  }).filter(Number.isFinite));
  const above = (i, c, leg) => {
    const k = track[i], m = com(i);
    if (!m || !(leg > 0) || !has(k, c.foot + 'bigtoe', c.foot + 'heel')) return NaN;
    return ((Math.max(P(k, c.foot + 'bigtoe')[1], P(k, c.foot + 'heel')[1]) - m[1]) / leg) * legM * 100;
  };
  // A few frames around i, inside the contact only: before touchdown the foot is not the ground.
  const steady = (c, i, leg) => median([i - 1, i, i + 1, i + 2].filter(j => j >= c.td && j <= c.to).map(j => above(j, c, leg)).filter(Number.isFinite));
  // Into the penultimate: 3rd-last touchdown minus penultimate touchdown, Shimizu & Ae's interval
  // and instants. No published source reads mid-stance (research 2026-11-10), so neither do we.
  let hipDrop = NaN, hipDropFrame = null;
  if (ev.pen && ev.third) {
    hipDrop = steady(ev.third, ev.third.td, legPx(ev.third)) - steady(ev.pen, ev.pen.td, legPx(ev.pen));
    hipDropFrame = ev.pen.td;
  }
  // Into the board, World Athletics' interval: penultimate toe-off to the lowest point on the board.
  let comDropBoard = NaN, comDropBoardFrame = null;
  if (ev.pen) {
    const start = above(ev.pen.to, ev.pen, legPx(ev.pen)), legT = legPx(T);
    let low = Infinity;
    for (let i = T.td; i <= T.to; i++) { const h = above(i, T, legT); if (h < low) { low = h; comDropBoardFrame = i; } }
    if (Number.isFinite(start) && Number.isFinite(low)) comDropBoard = start - low;
  }

  // Speed lost on the board, as a percentage: stance speeds in image units over the body's local
  // size, so the metre scale cancels and it holds when metres are withheld. Not done for the
  // penultimate vs the 3rd-last: across a whole stride the body-size correction is off by 5-10%
  // (camera distance and limb angles change), more than the ~6% being measured; on our clips it
  // read +17% to -47%. The board loss compares stances 0.2 s apart and stays physical.
  const fps = (ts.length - 1) / (ts[ts.length - 1] - ts[0]);
  const trim = Math.max(1, Math.round(fps / 60));
  const stanceV = c => {
    const ct = [], cx = [];
    for (let i = c.td + trim; i <= c.to - trim; i++) {
      const m = com(i);
      if (m && has(track[i], c.foot + 'bigtoe')) { cx.push((m[0] - P(track[i], c.foot + 'bigtoe')[0]) * dir); ct.push(ts[i]); }
    }
    return ct.length >= 4 ? slope(ct, cx) / zoom(Math.round((c.td + c.to) / 2)) : NaN;
  };
  const vP = ev.pen ? stanceV(ev.pen) : NaN;
  const vT = slope(tail.t, tail.x) / zoom(T.to);
  const lossTO = vP > 0 && vT > 0 ? ((vT - vP) / vP) * 100 : NaN;
  // The board can't add speed, and elite losses stay under ~20%: outside -40..+2% it is a bad read.
  const speedLossTO = lossTO >= -40 && lossTO <= 2 ? lossTO : NaN;

  return {
    pxPerM, fitRmsM: fit.rms / pxPerM, fitSeconds, torsoM, scaleOk, angleOk, apexOk, tUp, depth, scaleWhy, scaleSource: 'gravity',
    vxTD, vxTO, velocityLoss: vxTO - vxTD, vyTO, vyTOcontact, vyTOflight,
    takeoffAngle: (Math.atan2(vyTO, vxTO) * 180) / Math.PI,
    takeoffSpeed: Math.hypot(vxTO, vyTO),
    apexRise: (fit.b * fit.b) / (4 * fit.a * pxPerM), // height of the fitted arc itself
    takeoffDist, flightDistance,
    speedLast, speedLoss: vxTO - speedLast,
    hipDrop, hipDropFrame, comDropBoard, comDropBoardFrame, speedLossTO,
    peakHeight: ((fit.b * fit.b) / (4 * fit.a * pxPerM)) * 100,
    zoomTD: zoom(T.td), zoomPen: ev.pen ? zoom(ev.pen.td) : NaN,
    landingReach: reach,
    // Hay (1986): takeoff distance + flight distance + landing distance, measured from
    // the toe at takeoff (add toe-to-board to get the official mark's reference).
    estDistance: Number.isFinite(reach) ? takeoffDist + flightDistance + reach : NaN,
  };
}
