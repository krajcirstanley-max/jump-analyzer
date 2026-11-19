// The board contact among the sprint pass's foot contacts (2026-11-20). Claude used to read every
// frame around the board to say which contact is the take-off (11-15 s a clip, a wrong answer about
// one run-up in five); the toe-against-track contacts already hold the take-off within a frame on
// every jump checked, so the take-off is picked from them by rule:
//  - near the camera: the athlete's torso at least 0.7 of its largest size in the clip (the far
//    steps are small and their centre of mass jitters, IMG_4954's first step rose "2.8")
//  - the body thrown up right after the toe-off: the centre of mass rises at least 1.3 torso
//    lengths a second over the next 6 frames. Checked on 21 jumps (bench, outdoor 19 Nov, box
//    take-offs): every take-off 2.0-6.9, every other near step under 1.3 (most under 0.6)
//  - not crouched: hips over the ankles at least 0.75 of the run's median (getting up in the sand)
//  - the first such step: after a run-through the athlete runs out of the pit and those steps rise
//    too (run-up IMG_4653: 1580 at 9.0 after the board's 3.3)
// The contacts then go through locate's nameEvents in place of Claude's ground frames, so the
// pose track's edges stand where it found the contact, exactly as before.
import { centreOfMass, has, torsoLength, P } from '../js/analysis/kinematics.js';
import { fromWire } from '../js/cloud.js';
import { stepsOf } from './sprint.mjs';

export const RISE_MIN = 1.3, NEAR_MIN = 0.7, CROUCH = 0.75;

// steps: [{ td, to }] in seconds (sprintFromMotion). Returns { S, i }: every step with its frames
// and measures, and the take-off's index (-1 if none).
export function pickTakeoff(steps, track, ts, sex) {
  const fr = t => { let lo = 0, hi = ts.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (ts[m] < t) lo = m + 1; else hi = m; } return lo; };
  const dt = (ts.at(-1) - ts[0]) / (ts.length - 1);
  const comY = i => (track[i] ? centreOfMass(track[i], sex)?.[1] ?? NaN : NaN);
  const torso = i => (track[i] && has(track[i], 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(track[i]) : NaN);
  const tall = i => {
    const k = track[i]; if (!k || !has(k, 'lhip', 'rhip')) return NaN;
    const a = ['lank', 'rank'].filter(n => has(k, n)); if (!a.length) return NaN;
    return (Math.max(...a.map(n => P(k, n)[1])) - (P(k, 'lhip')[1] + P(k, 'rhip')[1]) / 2) / torso(i);
  };
  const S = steps.map(s => {
    const f0 = fr(s.td), f1 = fr(s.to);
    return { f0, f1, rise: (comY(f1) - comY(f1 + 6)) / torso(f1) / (6 * dt), tall: tall(f0), torso: torso(f0) };
  });
  const tl = S.map(s => s.tall).filter(Number.isFinite).sort((a, b) => a - b), med = tl[tl.length >> 1];
  const big = Math.max(...S.map(s => s.torso).filter(Number.isFinite));
  const i = S.findIndex(s => s.torso >= NEAR_MIN * big && s.rise >= RISE_MIN && !(s.tall < CROUCH * med));
  return { S, i };
}

// The pass on the server: the contacts, the pick, and what nameEvents takes as Claude's reading
// (the last five contacts up to the board as ground frames, T the board touchdown).
export async function stepTakeoff({ frames, meta, res, wire, sex, onProgress }) {
  onProgress?.({ stage: 'contacts', done: 0, total: 1 });
  const timing = {};
  const sp = await stepsOf({ frames, meta, res, wire, timing });
  if (sp.error || !sp.steps?.length) return { error: sp.error ?? 'no steps', timing };
  const pose = fromWire(wire);
  const { S, i } = pickTakeoff(sp.steps, pose.clean ?? pose.smooth, meta.ts, sex);
  const steps = S.map(s => ({ td: s.f0, to: s.f1, rise: Number.isFinite(s.rise) ? +s.rise.toFixed(2) : null }));
  if (i < 0) return { error: 'no take-off among the contacts', steps, timing };
  const span = s => Array.from({ length: s.f1 - s.f0 + 1 }, (_, k) => s.f0 + k);
  return { seen: { ground: S.slice(Math.max(0, i - 4), i + 1).flatMap(span), T: S[i].f0 }, steps, pick: i, timing };
}
