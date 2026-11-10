// Metres from the runway: the server finds the take-off line, the near edge of the sand and the
// two runway lines in every frame (server/ground.mjs). Those four crossing points are a
// rectangle of known size on the ground, so each frame gets a ground-plane homography and any
// point on the ground can be read in metres from the sand. The centre of mass is above the
// ground, so it is dropped to the line the athlete runs on.
//
// Measured on three handheld clips (2026-11-10): leg length from this scale was within 1 % of
// 0.491 x height for Stanley (0.99-1.01) and 1.01-1.08 for Miška. The gravity fit on the same
// clips was 6-28 % off, which is why this replaces it whenever the runway is found.
import { P, has, dist, centreOfMass } from './kinematics.js';
import { homography, applyH, invertH } from './homography.js';

export const RUNWAY_W = 1.22;
const BOARDS = [1, 2, 3]; // take-off line to sand, the usual training and competition boards

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
function slope(t, y) {
  const n = t.length, mt = t.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (t[i] - mt) * (y[i] - my); den += (t[i] - mt) ** 2; }
  return num / den;
}

// ground: { frames: { [i]: [sandFar, sandNear, lineFar, lineNear] } } in image pixels.
// Works in a unit where the take-off line is 1 from the sand, then picks the board distance
// (1, 2 or 3 m) from the athlete's leg length and scales everything by it.
export function groundAnalysis(ground, track, ev, ts, sex = 'male', height = null) {
  const frames = ground?.frames;
  if (!frames) return { error: 'no ground' };
  const T = ev.takeoff, s = ev.takeoffFoot;
  const H = {}, Hi = {};
  const WORLD = [[0, 0], [0, RUNWAY_W], [1, 0], [1, RUNWAY_W]];
  for (const [k, pts] of Object.entries(frames)) {
    const h = pts?.length === 4 && homography(pts, WORLD);
    if (h) { H[k] = h; Hi[k] = invertH(h); }
  }
  if (!H[T.td] || !H[T.to]) return { error: 'board not seen at the takeoff' };
  const toW = (i, p) => applyH(H[i], p);
  const ok = i => H[i] && track[i];

  // The line the athlete runs on: the planted toe across the takeoff contact.
  const yAth = median([...Array(T.to - T.td + 1)].map((_, k) => { const i = T.td + k; return ok(i) && has(track[i], s + 'bigtoe') ? toW(i, P(track[i], s + 'bigtoe'))[1] : NaN; }));
  if (!(yAth > -0.3 && yAth < RUNWAY_W + 0.3)) return { error: 'athlete not on the runway' };

  // Local metres per pixel along the run at a ground point, and the CoM dropped to the
  // athlete's line along the image vertical.
  const pxPerUnit = (i, x) => { const a = applyH(Hi[i], [x - 0.05, yAth]), b = applyH(Hi[i], [x + 0.05, yAth]); return Math.hypot(a[0] - b[0], a[1] - b[1]) / 0.1; };
  const comX = i => {
    const c = ok(i) && centreOfMass(track[i], sex); if (!c) return NaN;
    const p1 = applyH(Hi[i], [-6, yAth]), p2 = applyH(Hi[i], [3, yAth]);
    const t = (c[0] - p1[0]) / (p2[0] - p1[0]);
    return toW(i, [c[0], p1[1] + t * (p2[1] - p1[1])])[0];
  };
  const footX = (i, names) => names.filter(n => ok(i) && has(track[i], n)).map(n => toW(i, P(track[i], n))[0]);

  // Board distance from body size: the stance leg (hip-knee-ankle) against 0.491 x height.
  const legM = (0.491 * (height ?? (sex === 'female' ? 168 : 180))) / 100;
  const legs = [];
  for (const c of [ev.pen, { ...T, foot: s }].filter(Boolean)) {
    for (let i = c.td + 2; i <= c.to - 2; i++) {
      if (!ok(i) || !has(track[i], c.foot + 'hip', c.foot + 'knee', c.foot + 'ank')) continue;
      const k = track[i], px = dist(P(k, c.foot + 'hip'), P(k, c.foot + 'knee')) + dist(P(k, c.foot + 'knee'), P(k, c.foot + 'ank'));
      legs.push(px / pxPerUnit(i, comX(i)));
    }
  }
  const legUnits = median(legs);
  if (!(legUnits > 0)) return { error: 'no leg length' };
  const implied = legM / legUnits; // metres per unit = the board distance the body implies
  const boardM = ground.boardM ?? BOARDS.reduce((b, d) => (Math.abs(d - implied) < Math.abs(b - implied) ? d : b));
  const legRatio = (legUnits * boardM) / legM;
  const X = i => comX(i) * boardM;

  // Speed through the last step: penultimate touchdown to board touchdown, the centre of mass
  // averaged over three frames at each end (World Athletics' "last step" interval).
  const avgX = i => median([i - 1, i, i + 1].map(X));
  let speedLast = NaN;
  if (ev.pen && ok(ev.pen.td)) speedLast = (avgX(ev.pen.td) - avgX(T.td)) / (ts[T.td] - ts[ev.pen.td]);

  // Horizontal speed in the air is constant: one straight line through the first 0.3 s of the
  // flight. Later the board is far out of the picture and the camera tracking extrapolates: on
  // IMG_4596 two runs of the same clip put the landing frame's rectangle 60-90 px apart.
  const early = T.to + Math.round(0.3 / ((ts[T.to] - ts[T.td]) / (T.to - T.td) || 1 / 120));
  const end = Math.min(ev.landing != null ? ev.landing - 3 : Infinity, early, Math.max(...Object.keys(H).map(Number)));
  const ft = [], fx = [];
  for (let i = T.to + 3; i <= end; i++) { const x = X(i); if (Number.isFinite(x)) { ft.push(ts[i]); fx.push(x); } }
  const vxTO = ft.length >= 12 ? -slope(ft, fx) : NaN;

  // Where the foot left the ground and where the body first touched the sand.
  const toeTO = median([T.to - 2, T.to - 1, T.to].flatMap(i => footX(i, [s + 'bigtoe']))) * boardM;
  // Landing reach on the body's own scale: by the landing the board is metres out of the picture,
  // but thigh + shank (a sum of segment lengths, so knee bend does not change it) was measured
  // in metres at the board. Only the feet on the sand count: an airborne heel is no mark.
  let landX = NaN, reach = NaN;
  // The frame of first contact, or the nearest one to it with the whole body tracked (a leg
  // hidden in the sand leaves no centre of mass; the reach barely changes over a few frames).
  const L = ev.landing == null ? null : [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, -6].map(d => ev.landing + d).find(i => track[i] && centreOfMass(track[i], sex));
  if (L != null) {
    const k = track[L];
    const legPx = median([L - 2, L - 1, L, L + 1, L + 2].flatMap(i => ['l', 'r'].map(f => {
      const q = track[i]; return q && has(q, f + 'hip', f + 'knee', f + 'ank') ? dist(P(q, f + 'hip'), P(q, f + 'knee')) + dist(P(q, f + 'knee'), P(q, f + 'ank')) : NaN;
    })));
    const pxM = legPx / (legUnits * boardM);
    const c = centreOfMass(k, sex);
    const feet = ['lheel', 'rheel', 'lank', 'rank'].filter(n => has(k, n)).map(n => P(k, n));
    if (c && feet.length && pxM > 0) {
      const low = Math.max(...feet.map(p => p[1]));
      const onSand = feet.filter(p => p[1] >= low - 15);
      // image direction of the run, from the takeoff frame's homography
      const a = applyH(Hi[T.to], [1, yAth]), b = applyH(Hi[T.to], [0, yAth]), run = Math.sign(b[0] - a[0]);
      reach = Math.min(...onSand.map(p => (p[0] - c[0]) * run)) / pxM;
      if (ok(L)) landX = Math.max(...footX(L, ['lheel', 'rheel']).map(x => x * boardM));
    }
  }
  const takeoffDist = Number.isFinite(toeTO) ? toeTO - X(T.to) : NaN;
  const flightTime = ev.landing != null ? ts[ev.landing] - ts[T.to] : NaN;
  // The jump is Hay's partition: each part is read where it happens, at a local scale (toe to
  // centre of mass at toe-off, flight speed x flight time, centre of mass to heel at landing).
  // Toe-to-heel straight through the homography would need the board-to-landing extrapolation.
  const jump = takeoffDist + vxTO * flightTime + reach;
  const direct = toeTO - landX;
  const agree = Number.isFinite(jump) && Number.isFinite(direct) ? Math.abs(direct - jump) : NaN;

  const pxPerM = pxPerUnit(T.td, comX(T.td)) / boardM;
  return {
    boardM, implied, legRatio, yAth, pxPerM,
    speedLast, vxTO, speedLoss: vxTO - speedLast, speedLossPct: ((vxTO - speedLast) / speedLast) * 100,
    // + behind the take-off line (legal, distance given away), - past it towards the sand.
    toeToLine: toeTO - boardM, takeoffDist, landingReach: reach, jump, jumpDirect: direct, flightTime, partsGap: agree,
    // Trust: the body agrees with the board scale.
    sure: Math.abs(legRatio - 1) <= 0.1 ? 'vysoká' : Math.abs(legRatio - 1) <= 0.18 ? 'stredná' : 'nízka',
  };
}
