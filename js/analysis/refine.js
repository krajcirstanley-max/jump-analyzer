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
export function refineTouchdowns(result, events, { height = null, tolM = 0.015, noLateTD = false } = {}) {
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
    // Without the runway the phone's motion is unknown and taken as none; a phone that follows the jumper
    // and tilts down keeps the planted foot "falling" in the picture, and the touchdown moved late
    // (2026-11-24, Ostrava hall, runway not found on any clip: Stanley's board 681 named, 684 refined, heel
    // down at 680 by eye; leg angle 73° for 60°, inclination −12° for −26°). Then it only moves earlier.
    // The board touchdown is never moved later than named. On 2026-11-24 (Ostrava hall, a phone following
    // the jumper) the move was +3 on every jump, with and without the runway: Stanley 681 -> 684 (heel down
    // at 680 by eye), Miška 800 -> 803 (798-800): leg angle 73° for 60°, inclination −12° for −26°, the
    // whole plant phase graded down. The bench got better without it (292 -> 293 of 308 within a frame).
    // The penultimate's late moves stay: they were right (4676 520 -> 521, 5161). So do the run-ups' board
    // contacts filmed across the hall (Rozbeh, rozbeh-cones.test: +1/+2 and right); only jumps ask for this.
    if (noLateTD && key === 'TD' && best != null && best > td) best = td;
    if (best != null && best !== td) { out[key] = best; moved[key] = best - td; }
  }
  return { events: out, moved };
}

// Contact edges Claude read off the frames, where no pose-track contact overlapped (locate's
// edges say 'claude'), are 3-8 frames off. IMG_4933 (2026-11-16, box under the penultimate):
// the board contact came as 492/505, the raw track puts the foot down at 497 and the toe still
// on the board at 513, and by eye it is ~495-496 / 512; the toe-off 7 frames early made a
// straight take-off knee read 140°. Here the raw stance foot decides both edges, searched wider
// than refineTouchdowns does: the touchdown is the frame the foot's lowest point stops falling
// at its contact level, the toe-off the last frame the big toe is still at its contact level.
// sources: locate's edges { take, pen } ('claude' | 'pose'). Pose edges are left alone.
export function refineClaudeEdges(result, events, sources, { height = null, tolM = 0.015 } = {}) {
  const raw = i => result.accurate?.[i] ?? result.fast?.[i] ?? null;
  const fps = result.fps ?? 120, N = result.N ?? (result.fast?.length ?? 0);
  const legM = (0.491 * (height ?? 180)) / 100;
  const out = { ...events }, moved = {}, done = [];
  const med3 = (y, i) => median([y(i - 1), y(i), y(i + 1)]);
  // search reach in time, so a 240 fps clip gets the same 0,05 s back / 0,1 s forward
  const back = Math.max(6, Math.round(0.05 * fps)), fwd = Math.max(12, Math.round(0.1 * fps));
  for (const [src, kTD, kTO] of [['take', 'TD', 'TO'], ['pen', 'penTD', 'penTO']]) {
    const td = events[kTD], to = events[kTO];
    if (sources?.[src] !== 'claude' || td == null || to == null || to - td < 4) continue;
    const inner = []; for (let i = td + 2; i <= to - 2; i++) inner.push(i);
    const lowOf = f => median(inner.map(i => lowPoint(raw(i), f)?.[1]));
    const f = (lowOf('l') || -1) > (lowOf('r') || -1) ? 'l' : 'r';
    const legPx = median(inner.map(i => { const k = raw(i), h = at(k, f + 'hip'), n = at(k, f + 'knee'), a = at(k, f + 'ank'); return h && n && a ? Math.hypot(h[0] - n[0], h[1] - n[1]) + Math.hypot(n[0] - a[0], n[1] - a[1]) : NaN; }));
    if (!(legPx > 0)) continue;
    const tol = (tolM * legPx) / legM;
    const low = i => (i >= 0 && i < N ? lowPoint(raw(i), f)?.[1] ?? NaN : NaN);
    const toe = i => { if (i < 0 || i >= N) return NaN; const k = raw(i), p = at(k, f + 'bigtoe') ?? at(k, f + 'smalltoe'); return p ? p[1] : NaN; };
    const level = median(inner.map(i => med3(low, i)));
    if (!Number.isFinite(level)) continue;
    // touchdown: first frame at the level whose next frame is no lower, then back up while the
    // frame before is within the tolerance (heel down before the forefoot settles)
    let nTD = null;
    for (let i = td - back; i <= Math.min(td + fwd, to - 3); i++) {
      const a = low(i), b = low(i + 1);
      if (Number.isFinite(a) && Number.isFinite(b) && a >= level - 2 * tol && b - a <= 0.2 * tol) { nTD = i; break; }
    }
    while (nTD != null && nTD > td - back && Number.isFinite(low(nTD - 1)) && (low(nTD) - low(nTD - 1) <= tol || low(nTD - 1) >= level - 1.5 * tol)) nTD--;
    // toe-off: the toe's level over the back half of the contact (the heel is already up), then
    // the last frame still at it before two frames clearly above (median of three: single-frame
    // leg swaps, IMG_4933 505/507, would end the contact early)
    const startTD = nTD ?? td, mid = Math.round((startTD + to) / 2);
    const late = []; for (let i = mid; i <= to - 1; i++) late.push(med3(toe, i));
    const tLevel = median(late);
    let nTO = null;
    if (Number.isFinite(tLevel)) {
      for (let i = mid; i <= to + fwd; i++) {
        const up = j => Number.isFinite(med3(toe, j)) && med3(toe, j) < tLevel - 2 * tol;
        if (Number.isFinite(med3(toe, i)) && med3(toe, i) >= tLevel - 2 * tol && up(i + 1) && up(i + 2)) { nTO = i; break; }
      }
    }
    const newTD = nTD ?? td, newTO = nTO ?? to, dur = (newTO - newTD + 1) / fps;
    if (dur < 0.06 || dur > 0.26 || newTO <= newTD) continue;   // implausible: keep Claude's
    if (newTD !== td) { out[kTD] = newTD; moved[kTD] = newTD - td; }
    if (newTO !== to) { out[kTO] = newTO; moved[kTO] = newTO - to; }
    done.push(kTD, kTO);
  }
  return { events: out, moved, done };
}
