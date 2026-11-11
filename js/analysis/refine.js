// Touchdowns to the frame. The contact detector reads the impact from the smoothed track, and the
// smoothing that suits angles pulls the impact a frame or two early: on IMG_4677 the penultimate
// touchdown came out at 673 while the foot met the ground at 674-675 (checked at high zoom;
// Stanley: "este som bol vo vzduchu"). Here the raw track decides: the foot's lowest point (toes
// or heel) has to sit within 1.5 cm of where it stands during the contact.
//
// With the runway's homographies the comparison is against the image of the stance point on the
// ground in each frame, so a panning or tilting phone does not move the level.
import { JI } from '../pose/models.js';
import { homography, applyH, invertH } from './homography.js';

const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const at = (kp, n) => (kp && Number.isFinite(kp[JI[n] * 3]) && kp[JI[n] * 3 + 2] > 0.3 ? [kp[JI[n] * 3], kp[JI[n] * 3 + 1]] : null);
const WORLD = [[0, 0], [0, 1.22], [1, 0], [1, 1.22]];

// The lowest of the foot's sole points in the image (largest y).
function lowPoint(kp, f) {
  const pts = ['bigtoe', 'smalltoe', 'heel'].map(n => at(kp, f + n)).filter(Boolean);
  return pts.length ? pts.reduce((b, p) => (p[1] > b[1] ? p : b)) : null;
}

// events: { td3, penTD, penTO, TD, TO } frame numbers (Claude's names with the pose's edges).
// Returns a copy with td3 / penTD / TD moved to the first frame the foot is really down, and
// what moved. Never moves a touchdown by more than 2 frames earlier or 4 later.
export function refineTouchdowns(result, events, { height = null, tolM = 0.015 } = {}) {
  const raw = i => result.accurate?.[i] ?? result.fast?.[i] ?? null;
  const frames = result.ground?.frames ?? {};
  const Hcache = {};
  const Hw = i => { if (!(i in Hcache)) { const p = frames[i]; const h = p?.length === 4 && homography(p, WORLD); Hcache[i] = h ? { h, inv: invertH(h) } : null; } return Hcache[i]; };
  const legM = (0.491 * (height ?? 180)) / 100;
  const out = { ...events }, moved = {};
  const plan = [['TD', events.TO], ['penTD', events.penTO], ['td3', null]];
  for (const [key, end] of plan) {
    const td = events[key]; if (td == null) continue;
    const te = end ?? td + 8;
    const mid = []; for (let i = td + 2; i <= te - 1; i++) mid.push(i);
    if (mid.length < 2) continue;
    // the stance foot: the lower one through the middle of the contact
    const lowOf = f => median(mid.map(i => lowPoint(raw(i), f)?.[1]));
    const f = (lowOf('l') || -1) > (lowOf('r') || -1) ? 'l' : 'r';
    // pixels per metre at the athlete from the stance leg
    const legPx = median(mid.map(i => { const k = raw(i), h = at(k, f + 'hip'), n = at(k, f + 'knee'), a = at(k, f + 'ank'); return h && n && a ? Math.hypot(h[0] - n[0], h[1] - n[1]) + Math.hypot(n[0] - a[0], n[1] - a[1]) : NaN; }));
    if (!(legPx > 0)) continue;
    const tol = (tolM * legPx) / legM;
    // Camera motion: how far the image of the stance point on the ground moved since the middle
    // of the contact. Without the runway the phone is taken as still over these few frames.
    const m = mid[mid.length >> 1];
    const gw = (() => { const p = lowPoint(raw(m), f), H = Hw(m); return p && H ? applyH(H.h, p) : null; })();
    const rawShift = i => { const H = Hw(i), H0 = Hw(m); return gw && H && H0 ? applyH(H.inv, gw)[1] - applyH(H0.inv, gw)[1] : NaN; };
    // The per-frame homographies jitter by a few pixels (3.6 px between two frames on IMG_4677),
    // as much as the touchdown itself; the phone's tilt is smooth, so a parabola through the
    // window carries it.
    const shift = (() => {
      const xs = [], ys = []; for (let i = td - 4; i <= te + 2; i++) { const v = rawShift(i); if (Number.isFinite(v)) { xs.push(i - m); ys.push(v); } }
      if (xs.length < 6) return () => 0;
      const S = k => xs.reduce((a, x) => a + x ** k, 0), T = k => xs.reduce((a, x, n) => a + x ** k * ys[n], 0);
      const A = [[S(0), S(1), S(2)], [S(1), S(2), S(3)], [S(2), S(3), S(4)]], B = [T(0), T(1), T(2)];
      const det = M => M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) - M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) + M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0]);
      const D = det(A); if (!D) return () => 0;
      const c = [0, 1, 2].map(k => det(A.map((r, n) => r.map((v, j) => (j === k ? B[n] : v)))) / D);
      return i => c[0] + c[1] * (i - m) + c[2] * (i - m) ** 2;
    })();
    // The touchdown is the frame the foot's lowest point stops falling: the next frame is no
    // lower (within a fifth of the tolerance) and the point is already near its contact level.
    // A level test alone was fragile: the heel lands first, the forefoot follows and the heel
    // sinks a little further under load, so "within 1.5 cm of the lowest" moved with each clip.
    const y = i => { const p = lowPoint(raw(i), f); return p ? p[1] - shift(i) : NaN; };
    const span = []; for (let i = td; i <= te; i++) span.push(y(i));
    const level = median(span);
    let best = null;
    for (let i = td - 2; i <= Math.min(td + 4, te - 2); i++) {
      const a = y(i), b = y(i + 1);
      if (Number.isFinite(a) && Number.isFinite(b) && b - a <= 0.2 * tol && a >= level - 2 * tol) { best = i; break; }
    }
    // the heel can be down a frame before the foot stops sinking: back up while the frame before
    // is within the tolerance of the stopped level
    while (best != null && best > td - 2 && Number.isFinite(y(best - 1)) && y(best) - y(best - 1) <= tol) best--;
    if (best != null && best !== td) { out[key] = best; moved[key] = best - td; }
  }
  return { events: out, moved };
}
