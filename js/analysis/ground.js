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

// Cone sightings per frame -> one entry per cone: k (0 = 0.2 m, 1 = 10.2 m, 2 = 20.2 m from the
// line), its median x in metres from the sand, and every sighting { i, x }.
function coneClusters(conesByFrame, H, boardM) {
  const obs = [];
  for (const [k, list] of Object.entries(conesByFrame ?? {})) {
    if (!H[k]) continue;
    for (const c of list) {
      const p = applyH(H[k], c);
      if (p[1] > -1.2 && p[1] < RUNWAY_W + 1.2) obs.push({ i: +k, x: p[0] * boardM, img: [c[0], c[1]] });
    }
  }
  obs.sort((a, b) => a.x - b.x);
  const groups = [];
  for (const o of obs) { const g = groups.at(-1); if (g && o.x - g.at(-1).x < 1.5) g.push(o); else groups.push([o]); }
  const best = {};
  for (const g of groups) {
    if (g.length < 3) continue;
    const x = median(g.map(o => o.x)), k = Math.round((x - boardM - 0.2) / 10);
    if (k < 0 || k > 2 || Math.abs(x - (boardM + 0.2 + 10 * k)) > 0.8 + 1.2 * k) continue;
    if (!best[k] || g.length > best[k].obs.length) best[k] = { k, x, obs: g };
  }
  // From far away the board's 2 m ruler stretches with distance: on IMG_4658 (filmed across the
  // hall) the 10.2 m cone came out at 14.2 m and the 20.2 m cone at 32.8 m, outside the window
  // above. The cones still come in order up the runway, so a missing one is taken by order: the
  // first group 6-16 m up from the board cone, then one 1.5-3.5 times as far. These keep their
  // image positions for the splits but never set the scale (byOrder).
  const zero = boardM + 0.2;
  const ups = groups.filter(g => g.length >= 3).map(g => ({ x: median(g.map(o => o.x)), obs: g })).filter(g => g.x - zero > 4);
  if (!best[1]) {
    const c1 = ups.find(g => g.x - zero >= 6 && g.x - zero <= 16);
    if (c1) best[1] = { k: 1, x: c1.x, obs: c1.obs, byOrder: true };
  }
  if (best[1] && !best[2]) {
    const g1 = best[1].x - zero, c2 = ups.find(g => g.x > best[1].x + 4 && (g.x - zero) / g1 >= 1.5 && (g.x - zero) / g1 <= 3.5);
    if (c2) best[2] = { k: 2, x: c2.x, obs: c2.obs, byOrder: true };
  }
  return Object.values(best).sort((a, b) => a.k - b.k);
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
  const legLength = () => {
    const legs = [];
    for (const c of [ev.pen, { ...T, foot: s }].filter(Boolean)) {
      for (let i = c.td + 2; i <= c.to - 2; i++) {
        if (!ok(i) || !has(track[i], c.foot + 'hip', c.foot + 'knee', c.foot + 'ank')) continue;
        const k = track[i], px = dist(P(k, c.foot + 'hip'), P(k, c.foot + 'knee')) + dist(P(k, c.foot + 'knee'), P(k, c.foot + 'ank'));
        legs.push(px / pxPerUnit(i, comX(i)));
      }
    }
    return median(legs);
  };
  let legUnits = legLength();
  if (!(legUnits > 0)) return { error: 'no leg length' };
  const implied = legM / legUnits; // metres per unit = the board distance the body implies
  const boardM = ground.boardM ?? BOARDS.reduce((b, d) => (Math.abs(d - implied) < Math.abs(b - implied) ? d : b));

  // Freelap cones, when the clip shows them: 0.2, 10.2 and 20.2 m from the board, so a 10 m
  // baseline against the 2 m from the sand. On IMG_4677 (far, oblique phone) the board scale
  // put the two cones 9.53 m apart: every distance and speed 5 % short (6.44 m for a jump of
  // about 6.80, 8.7 m/s against Freelap's 9.09). The run direction is rescaled about the
  // take-off line, so the line and the board distance stay where they were found.
  const cones = coneClusters(ground.cones, H, boardM);
  let coneScale = null;
  const measured = cones.filter(c => !c.byOrder);
  if (measured.length >= 2) {
    const a = measured[0], b = measured.at(-1), sc = (10 * (b.k - a.k)) / (b.x - a.x);
    if (sc > 0.85 && sc < 1.15) {
      const u = 1 - sc, A = [sc, 0, u, 0, 1, 0, 0, 0, 1];
      const mul = (M, N) => [0, 1, 2].flatMap(r => [0, 1, 2].map(c => M[r * 3] * N[c] + M[r * 3 + 1] * N[3 + c] + M[r * 3 + 2] * N[6 + c]));
      const H0 = { ...H }, Hi0 = { ...Hi }, leg0 = legUnits;
      for (const k of Object.keys(H)) { H[k] = mul(A, H[k]); Hi[k] = invertH(H[k]); }
      legUnits = legLength();
      // The far cone is read through tracking that has drifted 10 m from the board, so the body
      // gets a veto: the rescale stays only if the leg then matches 0.491 x height at least as
      // well as before (IMG_4677: 7 % off before, 2 % after).
      if (Math.abs((legUnits * boardM) / legM - 1) <= Math.abs((leg0 * boardM) / legM - 1) + 0.01) {
        coneScale = sc;
        for (const c of cones) { c.x = boardM + sc * (c.x - boardM); c.obs = c.obs.map(o => ({ ...o, x: boardM + sc * (o.x - boardM) })); }
      } else { Object.assign(H, H0); Object.assign(Hi, Hi0); legUnits = leg0; }
    }
  }
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

  // The Freelap splits from the video: the centre of mass passing 80 cm before each cone (where
  // the chip fires), read against the cone in the same frame when it was seen there, so the
  // camera tracking's drift over 10 m cancels. IMG_4677: 1.07 s against Freelap's 1.10.
  // Where the cone is in the frame, the distance is read in the image, on the athlete's own
  // scale: CoM to cone along the run, after sliding the cone across the runway to the
  // athlete's line (the across direction is the only thing taken from the homography there).
  // Through the homography alone, 10 m from the board the tracking put the CoM about 1 m too
  // far ahead of the 10.2 m cone (IMG_4677), and the 1-11 m time came out 1.16 s for Freelap's
  // 1.10.
  const run = (() => { const a = applyH(Hi[T.to], [1, yAth]), b = applyH(Hi[T.to], [0, yAth]); return Math.sign(b[0] - a[0]) || 1; })();
  const footGround = i => median([-6, -4, -2, 0, 2, 4, 6].flatMap(d => { const q = track[i + d]; return q ? ['lbigtoe', 'rbigtoe', 'lheel', 'rheel'].filter(n => has(q, n)).map(n => P(q, n)[1]) : []; }).sort((a, b) => b - a).slice(0, 4));
  // The across direction is read once, at the take-off line in the board frame, where the
  // homography is good: 10 m away it claimed the runway's cross lines were nearly flat (dx/dy
  // -13 to -35 against -1.7 at the board), the tracking's drift, not the scene.
  const acrossRef = (() => { const a = applyH(Hi[T.td], [1, 0]), b = applyH(Hi[T.td], [1, RUNWAY_W]); return (b[0] - a[0]) / (b[1] - a[1] || 1); })();
  const imgDist = (i, cone) => {
    const c = ok(i) && centreOfMass(track[i], sex), m = legPxAt(i) / legMeasured; if (!c || !(m > 0)) return NaN;
    const gy = footGround(i), q = cone.img;
    const qx = q[0] + (Number.isFinite(gy) ? (gy - q[1]) * acrossRef : 0);
    return ((c[0] - qx) * -run) / m; // metres before (upstream of) the cone
  };
  const crossing = k => {
    // The board cone's trigger point is 1 m from the line, where the board's own homography is
    // at its best: when that cone wasn't picked up (IMG_4658: 2 sightings), the ground stands in.
    const cone = cones.find(c => c.k === k) ?? (k === 0 && cones.some(c => c.k === 1) ? { k: 0, x: boardM + 0.2, obs: [] } : null);
    const seen = cone ? new Map(cone.obs.map(o => [o.i, o])) : null;
    // distance past the trigger point: + before it, - after it
    // Without the cone there is no split: through the board's homography alone the 1-11 m time
    // came out 1.22 s for Freelap's 1.10 (IMG_4677), far too loose to show.
    if (!cone) return NaN;
    const left = i => {
      if (seen.has(i)) return imgDist(i, seen.get(i)) - 0.8;
      const x = X(i); return Number.isFinite(x) ? x - (cone.x + 0.8) : NaN;
    };
    const d = []; for (const i of Object.keys(H).map(Number).sort((a, b) => a - b)) { if (i > T.td) break; const v = left(i); if (Number.isFinite(v)) d.push([i, v]); }
    const n = d.findIndex(([, v], j) => j > 0 && d[j - 1][1] > 0 && v <= 0);
    if (n < 0) return NaN;
    const win = d.filter(([i]) => Math.abs(i - d[n][0]) <= 8);
    if (win.length < 6 || win[0][1] < 0 || win.at(-1)[1] > 0) return NaN;
    const tt = win.map(([i]) => ts[i]), vv = win.map(([, v]) => v), sl = slope(tt, vv);
    const mt = tt.reduce((a, b) => a + b, 0) / tt.length, mv = vv.reduce((a, b) => a + b, 0) / vv.length;
    return mt - mv / sl;
  };
  const t1 = crossing(0), t11 = crossing(1), t21 = crossing(2);
  // The 1-11 m time has to agree with the speed into the board: its average speed (10 m over the
  // time) may sit a little under the last step's, never far from it. On IMG_4658 (filmed from
  // 40 m) the cone crossings gave 1.17 s, 8.5 m/s, while the run read 9.4-10 m/s at both ends
  // and Freelap said 1.06 s: such a time is withheld, not shown.
  const fits = (sec) => Number.isFinite(sec) && !(Number.isFinite(speedLast) && Math.abs(10 / sec / speedLast - 1) > 0.12);
  const s1 = t1 - t11, s2 = t11 - t21;
  const splits = {
    s1to11: fits(s1) ? s1 : null, s11to21: Number.isFinite(s2) && fits(s1) ? s2 : null,
    withheld: Number.isFinite(s1) && !fits(s1) ? +s1.toFixed(3) : null,
    source: cones.length >= 2 && coneScale ? 'cones' : 'board',
    cones: cones.map(c => ({ k: c.k, x: +c.x.toFixed(2), n: c.obs.length })), coneScale,
  };

  const board = steps.find(st => st.id === 'take');
  if (board) board.speed = vxTO; // the board contact's speed is the take-off speed

  const pxPerM = pxPerUnit(T.td, comX(T.td)) / boardM;
  return {
    steps, legMeasured, series, comXTO: X(T.to), toeTO, landX: Number.isFinite(jump) ? toeTO - jump : NaN,
    boardM, implied, legRatio, yAth, pxPerM, splits,
    speedLast, vxTO, speedLoss: vxTO - speedLast, speedLossPct: ((vxTO - speedLast) / speedLast) * 100,
    // + behind the take-off line (legal, distance given away), - past it towards the sand.
    toeToLine: toeTO - boardM, takeoffDist, landingReach: reach, jump, jumpDirect: direct, flightTime, partsGap: agree,
    // Trust: the body agrees with the board scale.
    sure: Math.abs(legRatio - 1) <= 0.1 ? 'vysoká' : Math.abs(legRatio - 1) <= 0.18 ? 'stredná' : 'nízka',
  };
}
