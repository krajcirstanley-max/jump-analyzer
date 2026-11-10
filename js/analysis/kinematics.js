// Body geometry from 2D keypoints: joint angles, segment-based centre of mass.
// Image coordinates: x right, y down. Angles in degrees.
import { JI } from '../pose/models.js';

export const P = (kp, name) => [kp[JI[name] * 3], kp[JI[name] * 3 + 1]];
export const has = (kp, ...names) => names.every(n => kp && kp[JI[n] * 3 + 2] >= 0.5 && !Number.isNaN(kp[JI[n] * 3]));
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Interior angle at b (a-b-c), 180 = straight.
export function angle3(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
  return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
}

// Angle of the line from -> to above the horizontal, measured on the side of travel
// (dir = +1 running right, -1 running left). 90 = vertical.
export function angleToHorizontal(from, to, dir) {
  return (Math.atan2(from[1] - to[1], (to[0] - from[0]) * dir) * 180) / Math.PI;
}

export function torsoLength(kp) {
  return dist(mid(P(kp, 'lsho'), P(kp, 'rsho')), mid(P(kp, 'lhip'), P(kp, 'rhip')));
}

// Key-frame angles come from a short quadratic fit over ~33 ms of the unfiltered track. The 12 Hz
// display filter takes up to 5° off the fastest moments (IMG_2674 toe-off: 176° → 170°; the
// photo of that frame agrees with 176°).
export function sharpen(track, fps) {
  const m = Math.max(1, Math.round(fps / 60));
  const weight = i => (3 * (3 * m * m + 3 * m - 1 - 5 * i * i)) / ((2 * m + 3) * (2 * m + 1) * (2 * m - 1));
  return track.map((kp, f) => {
    if (!kp) return kp;
    const out = Array.from(kp);
    for (let j = 0; j < kp.length; j += 3) for (const c of [0, 1]) {
      let sum = 0, ok = true;
      for (let i = -m; i <= m && ok; i++) {
        const v = track[f + i]?.[j + c];
        ok = Number.isFinite(v) && track[f + i][j + 2] >= 0.5;
        if (ok) sum += weight(i) * v;
      }
      if (ok) out[j + c] = sum;
    }
    return out;
  });
}

// de Leva (1996) segment parameters: mass fraction and CoM position from the proximal end.
const DE_LEVA = {
  male: { head: 0.0694, trunk: [0.4346, 0.4310], upperarm: [0.0271, 0.5772], forearm: [0.0162, 0.4574], hand: 0.0061, thigh: [0.1416, 0.4095], shank: [0.0433, 0.4395], foot: [0.0137, 0.4415] },
  female: { head: 0.0668, trunk: [0.4257, 0.3782], upperarm: [0.0255, 0.5754], forearm: [0.0138, 0.4559], hand: 0.0056, thigh: [0.1478, 0.3612], shank: [0.0481, 0.4352], foot: [0.0129, 0.4014] },
};

// Whole-body centre of mass, or null if a major segment is missing.
export function centreOfMass(kp, sex = 'male') {
  const d = DE_LEVA[sex];
  if (!has(kp, 'lsho', 'rsho', 'lhip', 'rhip')) return null;
  const sho = mid(P(kp, 'lsho'), P(kp, 'rsho')), hip = mid(P(kp, 'lhip'), P(kp, 'rhip'));
  const parts = [];
  const seg = (a, b, [m, f]) => parts.push([m, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]]);
  seg(sho, hip, d.trunk);
  const head = has(kp, 'lear', 'rear') ? mid(P(kp, 'lear'), P(kp, 'rear')) : has(kp, 'nose') ? P(kp, 'nose') : sho;
  parts.push([d.head, head]);
  for (const s of ['l', 'r']) {
    if (!has(kp, s + 'knee', s + 'ank')) return null;
    seg(P(kp, s + 'hip'), P(kp, s + 'knee'), d.thigh);
    seg(P(kp, s + 'knee'), P(kp, s + 'ank'), d.shank);
    if (has(kp, s + 'heel', s + 'bigtoe')) seg(P(kp, s + 'heel'), P(kp, s + 'bigtoe'), d.foot);
    else parts.push([d.foot[0], P(kp, s + 'ank')]);
    if (has(kp, s + 'elb', s + 'wri')) {
      seg(P(kp, s + 'sho'), P(kp, s + 'elb'), d.upperarm);
      seg(P(kp, s + 'elb'), P(kp, s + 'wri'), d.forearm);
      parts.push([d.hand, P(kp, s + 'wri')]);
    } else parts.push([d.upperarm[0] + d.forearm[0] + d.hand, P(kp, s + 'sho')]);
  }
  const m = parts.reduce((a, [w]) => a + w, 0);
  return [parts.reduce((a, [w, p]) => a + w * p[0], 0) / m, parts.reduce((a, [w, p]) => a + w * p[1], 0) / m];
}

// The foot's lowest point in the image (heel or toe, whichever is lower).
export function footLow(kp, s) {
  const pts = [s + 'heel', s + 'bigtoe', s + 'ank'].filter(n => has(kp, n)).map(n => P(kp, n));
  if (!pts.length) return null;
  return pts.reduce((a, b) => (b[1] > a[1] ? b : a));
}

// Parabolic sub-frame refinement of an extremum at index i of series y.
export function subFrame(y, i) {
  const a = y[i - 1], b = y[i], c = y[i + 1];
  if ([a, b, c].some(v => v == null || Number.isNaN(v))) return i;
  const den = a - 2 * b + c;
  return den === 0 ? i : i + Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
}
