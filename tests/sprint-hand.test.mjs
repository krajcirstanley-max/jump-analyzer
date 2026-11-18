// Sprint contacts against hand frames (2026-11-18). Four clips filmed hand-held: today's run cut to
// the Freelap stretch and three runs of 15.11 (13:06, 13:11, 13:15). Hand frames read on crops that
// follow the toe (a fixed crop moves with the phone's tilt and makes a standing shoe look lifted):
// touchdown = first frame the shoe is on the track, toe-off = last one; [a, b] = either.
// The server's pose and toe motion are in tests/real/sprint18 (gitignored); skipped without them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sprintFromMotion } from '../js/analysis/sprint.js';

const DIR = new URL('./real/sprint18/', import.meta.url);
const HAND = {
  cut18: { 21: [[21, 22], [35, 36]], 46: [[45, 46], [60, 61]], 76: [76, 89], 102: [102, [114, 115]], 131: [131, 143], 156: [156, 168], 184: [[183, 184], 196], 209: [208, [220, 221]], 236: [[235, 236], 247],
    266: [[259, 260], 272],   // the pose lost the toe 262-265: the touchdown read 266 before the toe was filled in
    287: [287, 297], 312: [[311, 312], [322, 323]] },
  sp1794744974224: { 651: [651, [662, 663]], 702: [[702, 703], [713, 714]], 730: [[730, 731], [741, 742]], 782: [782, 793], 833: [[833, 834], [843, 844]], 942: [942, [951, 952]], 971: [[971, 972], 981] },
  // 647: the shoe sweeps back low over the track at 645-646; by eye down at 647-648, the toe reads 645
  sp1794744749028: { 587: [[587, 588], [598, 599]], 647: [[645, 648], [657, 658]], 730: [[729, 730], [742, 743]], 843: [[842, 843], [852, 853]] },
  sp1794744449246: { 948: [948, 958], 1077: [[1077, 1078], 1088] },   // 1077: the toe lost at 1079-1083
};
const off = (v, h) => (Array.isArray(h) ? (v < h[0] ? v - h[0] : v > h[1] ? v - h[1] : 0) : v - h);
const have = Object.keys(HAND).every(c => existsSync(new URL(`${c}.json`, DIR)));

test('sprint: every hand-checked contact edge within one frame', { skip: !have }, () => {
  const bad = [];
  for (const [clip, hand] of Object.entries(HAND)) {
    const d = JSON.parse(readFileSync(new URL(`${clip}.json`, DIR))).dump;
    const { steps } = sprintFromMotion({ motion: d.motion, ts: d.ts, fps: d.meta.fps });
    for (const [key, [td, to]] of Object.entries(hand)) {
      const ref = Array.isArray(td) ? td[0] : td;
      const s = steps.find(x => Math.abs(x.frames[0] - ref) < 10);
      if (!s) { bad.push(`${clip}@${key}: no step`); continue; }
      const e = [off(s.frames[0], td), off(s.frames[1], to)];
      if (e.some(x => Math.abs(x) > 1)) bad.push(`${clip}@${key}: ${s.frames.join('-')} (${e})`);
    }
  }
  assert.deepEqual(bad, []);
});
