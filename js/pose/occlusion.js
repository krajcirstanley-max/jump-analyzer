// Frames where something covers the athlete (a pillar, a passer-by), so the skeleton is
// a guess. Signal: the fast model's mean keypoint score, the same number the pipeline
// re-detects on. It runs on every tracked frame on one scale, unlike the accurate model.
// Tuned on IMG_4390's pillar: the score drops from ~0.77 to 0.2-0.5 and recovers as she
// emerges; box jumps coincide but only after the score has already gone.
import { meanScore } from './engine.js';

const CORE = 0.5;       // clearly covered
const EDGE = 1.2;       // × core: entering or leaving cover, counted only next to a core run
const RELATIVE = 0.65;  // × the clip's median, so a dim clip isn't flagged wholesale
const MIN_CORE = 3;     // frames below core: a one-off dip is motion blur, not a pillar

export function hiddenFrames(result) {
  const hidden = new Set();
  const scores = (result.fast ?? []).map(k => (k ? meanScore(k) : null));
  const known = scores.filter(s => s != null).sort((a, b) => a - b);
  if (!known.length) return hidden;
  const core = Math.min(CORE, known[known.length >> 1] * RELATIVE);
  const edge = core * EDGE;
  let start = -1, deep = 0;
  const close = end => {
    if (deep >= MIN_CORE) for (let i = start; i < end; i++) hidden.add(i);
    start = -1; deep = 0;
  };
  scores.forEach((s, i) => {
    if (s == null || s >= edge) { if (start >= 0) close(i); return; }
    if (start < 0) start = i;
    if (s < core) deep++;
  });
  if (start >= 0) close(scores.length);
  return hidden;
}
