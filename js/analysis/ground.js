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

  // The last three contacts on the ground: where the toe was planted, how long each contact and
  // step took, and how high the centre of mass rode. Heights are on the body's scale (the stance
  // leg, thigh + shank, as measured against the board above) from the foot's lowest point in the
  // same frame, so neither the camera's pan nor its tilt enters.
  const fps = (ts.length - 1) / (ts[ts.length - 1] - ts[0]);
  const legMeasured = legUnits * boardM;
  const heightAt = (i, c) => {
    const k = track[i], m = k && centreOfMass(k, sex);
    if (!m || !has(k, c.foot + 'hip', c.foot + 'knee', c.foot + 'ank', c.foot + 'bigtoe', c.foot + 'heel')) return NaN;
    const legPx = dist(P(k, c.foot + 'hip'), P(k, c.foot + 'knee')) + dist(P(k, c.foot + 'knee'), P(k, c.foot + 'ank'));
    return ((Math.max(P(k, c.foot + 'bigtoe')[1], P(k, c.foot + 'heel')[1]) - m[1]) / legPx) * legMeasured;
  };
  const steady = (c, i) => median([i - 1, i, i + 1].filter(j => j >= c.td && j <= c.to).map(j => heightAt(j, c)));
  const contacts = [['third', ev.third], ['pen', ev.pen], ['take', { ...T, foot: s }]].filter(([, c]) => c && c.foot);
  const steps = contacts.map(([id, c], n) => {
    const toes = []; for (let i = c.td + 1; i <= c.to - 1; i++) toes.push(...footX(i, [c.foot + 'bigtoe']));
    let mid = null; // the centre of mass passing over the toe
    for (let i = c.td; i < c.to && mid == null; i++) { const a = X(i), b = X(i + 1), t = median(toes) * boardM; if (a >= t && b < t) mid = i; }
    const hs = []; for (let i = c.td; i <= c.to; i++) hs.push([i, heightAt(i, c)]);
    const low = hs.filter(([, h]) => Number.isFinite(h)).reduce((b, x) => (!b || x[1] < b[1] ? x : b), null);
    const next = contacts[n + 1]?.[1];
    // heel ahead of the centre of mass at touchdown, centre of mass ahead of the toe at toe-off
    const heelTD = median([c.td, c.td + 1].flatMap(i => footX(i, [c.foot + 'heel']))) * boardM;
    const toeOff = median([c.to - 1, c.to].flatMap(i => footX(i, [c.foot + 'bigtoe']))) * boardM;
    const st = { id, foot: c.foot, td: c.td, to: c.to, contactMs: ((c.to - c.td + 1) / fps) * 1000, toeX: median(toes) * boardM,
      tdDist: X(c.td) - heelTD, toDist: toeOff - X(c.to),
      com: { td: steady(c, c.td), mid: mid != null ? steady(c, mid) : NaN, low: low?.[1] ?? NaN, lowFrame: low?.[0] ?? null, to: steady(c, c.to) } };
    if (next) {
      st.flightMs = ((next.td - c.to - 1) / fps) * 1000;
      st.stepMs = (ts[next.td] - ts[c.td]) * 1000;
      st.freqHz = 1000 / st.stepMs;
      st.toToMs = (ts[next.to] - ts[c.to]) * 1000;
      st.flightRatio = st.flightMs / st.contactMs;
    }
    return st;
  });
  // Step length is toe to toe. The speed is the centre of mass over the same touchdown-to-touchdown
  // interval, not length / time: the board foot lands far ahead of the body (0.7 m vs 0.3 m on
  // IMG_4596), which stretches the last step's toe-to-toe length without any extra speed.
  steps.forEach((st, n) => { const nx = steps[n + 1]; if (nx) { st.length = st.toeX - nx.toeX; st.speed = (avgX(st.td) - avgX(nx.td)) / (ts[nx.td] - ts[st.td]); } });

  // Centre of mass frame by frame from the 3rd-last touchdown to toe-off, for the charts: distance
  // from the sand and height. The ground under the CoM is the image of the athlete's line, pinned
  // in each contact to the stance foot (the same zero the contact heights use) and interpolated
  // across the flights; the scale is the leg's (thigh + shank, 7-frame median). Read through the
  // homography alone, flight heights drifted to 1.77 m once the board was far away (IMG_4596).
  const legPxAt = i => median([-3, -2, -1, 0, 1, 2, 3].flatMap(d => ['l', 'r'].map(f => {
    const q = track[i + d]; return q && has(q, f + 'hip', f + 'knee', f + 'ank') ? dist(P(q, f + 'hip'), P(q, f + 'knee')) + dist(P(q, f + 'knee'), P(q, f + 'ank')) : NaN;
  })));
  const groundAt = i => applyH(Hi[i], [comX(i), yAth])[1];
  const anchors = contacts.map(([, c]) => {
    const d = []; for (let i = c.td; i <= c.to; i++) { const k = track[i]; if (!ok(i) || !has(k, c.foot + 'bigtoe', c.foot + 'heel')) continue; d.push(Math.max(P(k, c.foot + 'bigtoe')[1], P(k, c.foot + 'heel')[1]) - groundAt(i)); }
    return { t: (ts[c.td] + ts[c.to]) / 2, d: median(d) };
  }).filter(a => Number.isFinite(a.d));
  const offset = t => {
    if (!anchors.length) return 0;
    if (t <= anchors[0].t) return anchors[0].d;
    for (let k = 1; k < anchors.length; k++) if (t <= anchors[k].t) { const a = anchors[k - 1], b = anchors[k]; return a.d + ((t - a.t) / (b.t - a.t)) * (b.d - a.d); }
    return anchors.at(-1).d;
  };
  const series = [];
  for (let i = (ev.third ?? ev.pen ?? T).td; i <= T.to; i++) {
    if (!ok(i)) continue;
    const c = centreOfMass(track[i], sex); if (!c) continue;
    const x = comX(i), h = ((groundAt(i) + offset(ts[i]) - c[1]) / legPxAt(i)) * legMeasured;
    if (Number.isFinite(x) && Number.isFinite(h)) series.push({ i, t: ts[i] - ts[T.td], x: x * boardM, h });
  }

  const board = steps.find(st => st.id === 'take');
  if (board) board.speed = vxTO; // the board contact's speed is the take-off speed

  const pxPerM = pxPerUnit(T.td, comX(T.td)) / boardM;
  return {
    steps, legMeasured, series, comXTO: X(T.to), toeTO, landX: Number.isFinite(jump) ? toeTO - jump : NaN,
    boardM, implied, legRatio, yAth, pxPerM,
    speedLast, vxTO, speedLoss: vxTO - speedLast, speedLossPct: ((vxTO - speedLast) / speedLast) * 100,
    // + behind the take-off line (legal, distance given away), - past it towards the sand.
    toeToLine: toeTO - boardM, takeoffDist, landingReach: reach, jump, jumpDirect: direct, flightTime, partsGap: agree,
    // Trust: the body agrees with the board scale.
    sure: Math.abs(legRatio - 1) <= 0.1 ? 'vysoká' : Math.abs(legRatio - 1) <= 0.18 ? 'stredná' : 'nízka',
  };
}
