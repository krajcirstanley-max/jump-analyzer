// When the athlete passes each cone of a run-up, read in the picture itself (2026-11-21).
//
// Filmed from across the hall (IMG_5151-5158: the phone on the far side of the track, the athlete
// 120-300 px tall) the board's 2 m ruler can't carry the runway's metres 20 m up: the homography
// put the 10.2 and 20.2 m cones at 14 and 28 m, and the track's yellow tapes passed for cones. In the
// picture the passing is plain: a cone is passed in the frame where the centre of mass and the cone
// base stand at the same x. So each cone sighting (server ground.mjs detectCones: tall Freelap cones
// and flat marker discs, "klobúčik") is followed from frame to frame, kept if it lies on the
// athlete's ground line, and the centre of mass's crossing of it is timed (a line through the frames
// around the change of side, sub-frame).
//
// That crossing is the athlete's bearing from the phone, not the cone's square across the runway:
// a cone standing beside the line is passed a little early or late as the phone looks back or
// ahead. Seen from one place that error grows evenly with the distance up the runway, so it
// stretches every piece by the same factor (IMG_5155: 1-11 and 11-21 m both 8 % long against
// Freelap) and leaves the share of each piece in a longer one alone. The times are therefore only
// used as shares of what Freelap timed (fiveFromMarks in rozbeh-view.js), never on their own.
import { centreOfMass, has, P, torsoLength } from './kinematics.js';

// metres from the board where the cones stand; the chip fires 0.8 m before a Freelap cone, and the
// marks are named by that point (1, 6, 11, 16, 21, 26 m), the disc at 5.2 m giving the 6 m mark
const CONES = [0.2, 5.2, 10.2, 15.2, 20.2, 25.2];
const CHIP = 0.8;

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// cones: { [frame]: [[x, base, h, w?], ...] } in image pixels; track: keypoints per frame;
// ts: frame times; td: the take-off touchdown frame; legs: Freelap [21-11, 11-1] if paired.
// Returns { crossings: [{ cone, mark, frame, t }], marks: { [m]: t } } or { error }.
export function coneTimes(cones, track, ts, { td, sex = 'male', legs = null } = {}) {
  if (!cones || !Number.isInteger(td) || !ts?.length) return { error: 'no cones' };
  const tor = i => (track[i] && has(track[i], 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(track[i]) : NaN);
  // the hips, not the centre of mass: the Freelap chip sits on the belt, and with the forward lean far
  // up the run the centre of mass leads the hips (2026-11-21, 32 crossings read blind at the hips: the
  // board cone and the disc matched to the frame, the 10.2 and 20.2 m cones came 1-3 frames early off
  // the centre of mass)
  const comX = i => { const q = track[i]; if (!q) return NaN; return has(q, 'lhip', 'rhip') ? (P(q, 'lhip')[0] + P(q, 'rhip')[0]) / 2 : centreOfMass(q, sex)?.[0] ?? NaN; };
  // the athlete's ground: the lowest foot point over the frames around (a stride's worth)
  const footY = i => median([-6, -3, 0, 3, 6].map(d => { const q = track[i + d]; if (!q) return NaN; const y = ['lbigtoe', 'rbigtoe', 'lheel', 'rheel'].filter(n => has(q, n)).map(n => P(q, n)[1]); return y.length ? Math.max(...y) : NaN; }));

  // sightings into tracks: the same cone in the next frames, a few px further as the phone pans
  const tracks = [];
  for (const i of Object.keys(cones).map(Number).sort((a, b) => a - b)) for (const c of cones[i] ?? []) {
    let best = null, bd = Infinity;
    for (const t of tracks) {
      // the phone pans up to 10 px a frame (IMG_5152's disc: 9.5), almost all of it sideways
      const l = t.at(-1), gap = i - l.i, ax = Math.abs(l.x - c[0]), ay = Math.abs(l.y - c[1]), dd = Math.hypot(ax, ay);
      if (gap > 0 && gap <= 4 && ax < 14 + 8 * gap && ay < 4 + 2 * gap && dd < bd) { best = t; bd = dd; }
    }
    (best ?? (tracks.push([]), tracks.at(-1))).push({ i, x: c[0], y: c[1] });
  }

  const crossings = [];
  for (const t of tracks) {
    if (t.length < 6) continue;
    const rows = t.map(o => ({ ...o, dx: comX(o.i) - o.x }));
    const n = rows.findIndex((o, k) => k > 0 && Number.isFinite(o.dx) && Number.isFinite(rows[k - 1].dx) && Math.sign(o.dx) !== Math.sign(rows[k - 1].dx) && o.i - rows[k - 1].i <= 4);
    if (n < 0) continue;
    const at = rows[n].i, T = tor(at);
    // on the athlete's line: the base within about a torso of the feet (5151-5158: 0.2-0.8 torso
    // below them, the cones and the disc standing at the runway's near edge); the track's tapes lie
    // several torsos lower, nearer the phone
    const dy = (rows[n].y - footY(at)) / T;
    if (!(T > 0) || !(dy > -0.6 && dy < 1.3)) continue;
    const win = rows.filter(o => Math.abs(o.i - at) <= 8 && Number.isFinite(o.dx));
    if (win.length < 5 || !(win[0].dx * win.at(-1).dx < 0)) continue;
    const tt = win.map(o => ts[o.i]), vv = win.map(o => o.dx);
    const mt = tt.reduce((a, b) => a + b, 0) / tt.length, mv = vv.reduce((a, b) => a + b, 0) / vv.length;
    let num = 0, den = 0; for (let k = 0; k < tt.length; k++) { num += (tt[k] - mt) * (vv[k] - mv); den += (tt[k] - mt) ** 2; }
    const sl = num / den; if (!(Math.abs(sl) > 0)) continue;
    crossings.push({ frame: at, t: mt - mv / sl, dy: +dy.toFixed(2), n: t.length, at: rows.filter(o => Math.abs(o.i - at) <= 10).map(o => [o.i, o.x, o.y]) });
  }
  if (!crossings.length) return { error: 'no cone passed' };

  // which cone: the board cone is passed around the take-off touchdown (the foot lands on the board
  // ahead of the centre of mass: 5151-5158, -0.06 to +0.09 s); the others by how long before it, at
  // the run-up's speed (Freelap's when paired, else 9 m/s for him, 8.3 for her)
  const tTD = ts[td];
  const board = crossings.filter(c => Math.abs(c.t - tTD) <= 0.2).sort((a, b) => Math.abs(a.t - tTD) - Math.abs(b.t - tTD))[0];
  const t0 = board ? board.t : tTD + 0.02;
  const L = (legs ?? []).filter(Number.isFinite);
  const vNear = L.length >= 2 ? 10 / L.at(-1) : sex === 'female' ? 8.3 : 9;
  const vFar = L.length >= 2 ? 10 / L.at(-2) : vNear * 0.97;
  // the time before the board cone at which cone D is expected (the run slows a little further up)
  const expect = D => (D <= 10 ? D / vNear : 10 / vNear + (D - 10) / vFar);
  const out = board ? [{ cone: 0.2, ...board }] : [];
  for (const D of CONES.slice(1)) {
    const e = expect(D - 0.2), tol = Math.max(0.12, 0.12 * e);
    const c = crossings.filter(x => x !== board && Math.abs((t0 - x.t) - e) <= tol).sort((a, b) => Math.abs((t0 - a.t) - e) - Math.abs((t0 - b.t) - e))[0];
    if (c) out.push({ cone: D, ...c });
  }
  // the chip's point: 0.8 m before the cone, at the speed there
  const marks = {};
  for (const c of out) { const v = c.cone <= 10.2 ? vNear : vFar; c.mark = Math.round(c.cone + CHIP); c.tMark = c.t - CHIP / v; marks[c.mark] = +c.tMark.toFixed(4); }
  return { crossings: out.sort((a, b) => a.cone - b.cone), marks };
}
