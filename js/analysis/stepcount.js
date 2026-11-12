// Run-up step count: every foot contact from the first step after the start up to and including
// the board, the way Stanley counts it (2026-11-12): the run-in or skip onto the mark is not
// counted, and the count is always even.
//
// Signal: which foot is lower in the picture. While one foot is on the ground the other is up,
// and the lower one changes once per step. That holds side-on and also head-on, far down the
// runway, where the side-on contact detector sees nothing. Measured in torso lengths, so it
// doesn't care how big the athlete is.
//
// Walking back from the board, phases count as long as they alternate feet at a running rhythm.
// What ends the chain decides whether the start was seen:
//  - a contact much quicker than a running step (the skip onto the mark: IMG_4677, 83 and 117 ms
//    against 210-290 ms running) or much slower (walking in), or standing: start seen.
//  - the chain reaching the first tracked frame, or a hole in the track: start not seen, and
//    the count is only what the video shows (IMG_4676 and IMG_4658 begin mid run-up).
import { has, torsoLength, footLow } from './kinematics.js';

export const STEP = {
  lowGap: 0.2,     // torso lengths one foot must sit below the other
  merge: 0.12,     // s: same-foot phases closer than this are one contact
  minStep: 0.17,   // s: faster than this is a skip or a hop, not a run-up step
  maxStep: 0.45,   // s: slower than this is walking in
  hole: 0.15,      // s: missing track longer than this breaks the count
};

// Phases of one foot being clearly lower, up to the board touchdown.
export function lowFootPhases(track, from, to, fps, o = STEP) {
  const out = [];
  let cur = null, lastSeen = null;
  for (let i = from; i <= to; i++) {
    const kp = track[i];
    if (!kp || !has(kp, 'lsho', 'rsho', 'lhip', 'rhip')) continue;
    const l = footLow(kp, 'l'), r = footLow(kp, 'r');
    if (!l || !r) continue;
    // Missing frames make the phase edges next to them unreliable (cut), and a long run of them
    // could hide a step.
    const gap = lastSeen != null ? i - lastSeen - 1 : 0, hole = gap > o.hole * fps;
    if (gap > 1 && cur) cur.cutAfter = true;
    lastSeen = i;
    const g = (l[1] - r[1]) / torsoLength(kp);
    if (!(Math.abs(g) >= o.lowGap)) continue;
    const foot = g > 0 ? 'l' : 'r';
    if (cur && !hole && cur.foot === foot && i - cur.b <= o.merge * fps) cur.b = i;
    else { cur = { foot, a: i, b: i, holeBefore: hole, cutBefore: gap > 1 }; out.push(cur); }
  }
  return out;
}

// track: cleaned keypoints. td: board touchdown frame, foot: take-off foot.
// Returns { count, seen, first, contacts: [{ foot, frame }], why } or null when the board phase
// isn't the take-off foot (signal not usable on this clip).
export function countSteps(track, { td, foot, fps, first = 0 }, o = STEP) {
  if (td == null || !(fps > 0)) return null;
  let start = first;
  while (start < td && !(track[start] && has(track[start], 'lsho', 'rsho', 'lhip', 'rhip'))) start++;
  const ph = lowFootPhases(track, start, td + 2, fps, o);
  if (!ph.length) return null;
  const board = ph.at(-1);
  if (board.foot !== foot || board.b < td - Math.round(0.1 * fps)) return null;
  let k = ph.length - 1, why = 'start';
  while (k > 0) {
    const p = ph[k - 1], q = ph[k];
    if (p.a <= start + 2) { why = 'clip'; break; }       // phase cut by the start of the track
    // Step time from the phase starts, or from the ends when a start was cut by missing frames.
    const step = (!p.cutBefore && !q.cutBefore ? q.a - p.a : !p.cutAfter && !q.cutAfter ? q.b - p.b : (q.a + q.b - p.a - p.b) / 2) / fps;
    // A short hole in the track is fine while the rhythm carries across it (IMG_4676 loses the
    // far athlete for 0.18 s at 92-114): a whole hidden step would break the rhythm. When the
    // rhythm does break at a hole, the start can't be told from a lost step.
    if (p.foot === q.foot || step < o.minStep || step > o.maxStep) { if (q.holeBefore) why = 'hole'; break; }
    k--;
  }
  // The chain may reach back to the very first phase: cut by the clip start, or a clean start.
  if (k === 0 && ph[0].a <= start + 2) why = 'clip';
  let chain = ph.slice(k);
  if (why === 'clip' && chain[0].a <= start + 2) chain = chain.slice(1);
  const seen = why === 'start';
  // Seen start, odd count: the first phase is the take-off foot landing on the mark at the end of
  // the skip (an even count starts with the other foot), which Stanley doesn't count.
  if (seen && chain.length % 2 === 1 && chain[0].foot === foot) chain = chain.slice(1);
  const contacts = chain.map(p => ({ foot: p.foot, frame: p.a }));
  return { count: contacts.length, seen, first: contacts[0]?.frame ?? null, contacts, why };
}
