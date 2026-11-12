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
// Checked against Stanley's own counts (2026-11-12): IMG_4677 14, IMG_4594 8, IMG_4596 10,
// IMG_2674 10, IMG_4676 18.
//  - The run-in onto the mark is often in the same rhythm (IMG_4596, IMG_2674: 4-5 jog steps), so
//    the mark is found by the feet lifting: low in the run-in, high from the mark (runInSplit).
//  - A slow contact (walking in, IMG_4594) or a quick one on the take-off foot is the mark.
//  - No mark contact in view (the far start of IMG_4677 is unreadable: four steps where the feet
//    never come apart in the picture), the first tracked frame, or a hole that breaks the
//    rhythm: start not seen, and the card gives the range the whole run-up can be.
import { has, torsoLength, footLow } from './kinematics.js';

export const STEP = {
  lowGap: 0.2,     // torso lengths one foot must sit below the other
  merge: 0.12,     // s: same-foot phases closer than this are one contact
  minStep: 0.17,   // s: faster than this is a skip or a hop, not a run-up step
  maxStep: 0.45,   // s: slower than this is walking in
  hole: 0.15,      // s: missing track longer than this breaks the count
  max: 18,         // steps: "nikdy nechodíme viac ako 18 krokov" (Stanley, 2026-11-12), both athletes
  blip: 0.08,      // s: a lower-foot phase shorter than this is pose noise, not a contact
  runInPeak: 0.65, // torso lengths: mean foot gap of a run-in stays under this
  runInGap: 0.4,   // torso lengths: the run-up from the mark lifts the feet at least this much more
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
    if (cur && !hole && cur.foot === foot && i - cur.b <= o.merge * fps) { cur.b = i; cur.peak = Math.max(cur.peak, Math.abs(g)); }
    else { cur = { foot, a: i, b: i, peak: Math.abs(g), holeBefore: hole, cutBefore: gap > 1 }; out.push(cur); }
  }
  return out;
}

// The mark contact splits a run-in from the run-up when both are in the chain: the run-in is a
// relaxed jog with the feet low (IMG_4596, IMG_2674: mean foot gap 0.5 torso), the run-up from the
// mark drives them high (1.2-1.4). On our clips the first high phase is the mark contact itself
// (the free leg drives up for the first step while the take-off foot is on the mark); when it is
// the first step instead, the mark is the contact before it. Returns the chain index of the mark
// contact, or null.
function runInSplit(chain, foot, o) {
  const pk = chain.map(p => p.peak), end = chain.length - 3;   // the last steps lean in and lift less
  const mean = (a, b) => { let t = 0; for (let i = a; i < b; i++) t += pk[i]; return t / (b - a); };
  const sse = (a, b, m) => { let t = 0; for (let i = a; i < b; i++) t += (pk[i] - m) ** 2; return t; };
  let best = null;
  for (let k = 2; k <= end - 4; k++) {
    const lo = mean(0, k), hi = mean(k, end), cost = sse(0, k, lo) + sse(k, end, hi);
    if (lo <= o.runInPeak && hi - lo >= o.runInGap && (!best || cost < best.cost)) best = { k, cost };
  }
  if (!best) return null;
  return chain[best.k].foot === foot ? best.k : best.k - 1;
}

// track: cleaned keypoints. td: board touchdown frame, foot: take-off foot.
// Counting starts at the mark (Stanley, 2026-11-12: "vždy začíname ako je značka, pred ňou nerátaj
// kroky"). They run or skip onto it and land on the take-off foot, so the mark contact is a
// take-off-foot phase and the steps after it are even. A seen start needs that contact in view.
// Returns { count, seen, first, contacts: [{ foot, frame }], why, range } or null when the board
// phase isn't the take-off foot or the count is more than the longest run-up (a miscount).
// range: [lo, hi] for the whole run-up when the start isn't seen. It is even, at least what the
// video shows and at most o.max; when that pins it (IMG_4676: 18 visible) the start counts as seen.
export function countSteps(track, { td, foot, fps, first = 0 }, o = STEP) {
  if (td == null || !(fps > 0)) return null;
  let start = first;
  while (start < td && !(track[start] && has(track[start], 'lsho', 'rsho', 'lhip', 'rhip'))) start++;
  const all = lowFootPhases(track, start, td + 2, fps, o);
  if (!all.length) return null;
  // Flickers where the feet only just come apart (IMG_4677 at 399 and 409, as the far athlete
  // becomes readable) are not contacts. A phase cut by missing frames (IMG_4676 at 85-92, before
  // a hole) or by the touchdown (the board) is short for that reason, so it stays.
  const ph = all.filter((p, i) => i === all.length - 1 || p.cutBefore || p.cutAfter || (p.b - p.a + 1) / fps >= o.blip);
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
    if (p.foot === q.foot || step < o.minStep || step > o.maxStep) {
      if (q.holeBefore) why = 'hole';
      // A slow or quick contact on the take-off foot right before the first step is the landing on
      // the mark (walking in, a skip).
      else if (p.foot === foot && q.foot !== foot) k--;
      break;
    }
    k--;
  }
  if (k === 0 && ph[0].a <= start + 2) why = 'clip';
  let chain = ph.slice(k);
  if (why === 'clip' && chain[0].a <= start + 2) chain = chain.slice(1);
  let seen = false;
  if (why === 'start' && chain[0].foot === foot) {
    // The chain starts on the mark, or on the run-in before it.
    const m = runInSplit(chain, foot, o);
    chain = chain.slice((m ?? 0) + 1);
    seen = true;
  } else if (why === 'start') why = 'blind';             // first step in view, no mark contact before it
  const contacts = chain.map(p => ({ foot: p.foot, frame: p.a }));
  if (contacts.length > o.max) return null;
  const out = { count: contacts.length, seen, first: contacts[0]?.frame ?? null, contacts, why, range: null };
  if (!seen) {
    const lo = contacts.length + (contacts.length % 2);
    if (lo >= o.max) Object.assign(out, { count: o.max, seen: true, why: 'max' });
    else out.range = [lo, o.max];
  }
  return out;
}
