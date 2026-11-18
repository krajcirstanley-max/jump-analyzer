// Stanley's sprints of 4 July 2026, filmed at 60 fps and uploaded on 18 Nov: the 120 fps thresholds
// found a stance every 2 s and the app showed almost no steps. The toe/track motion of each clip was
// dumped from the server (gitignored tests/real/sprint60/), so this replays the step finder without
// a GPU. Hand frames: touchdown = first frame the shoe is on the track, toe-off = the last, read on
// toe-following crops. Skipped when the files are not there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { footStances, sprintFromMotion, cleanSteps, STANCE_60 } from '../js/analysis/sprint.js';

const dir = new URL('./real/sprint60/', import.meta.url);
const load = id => JSON.parse(readFileSync(new URL(`${id}.dump.json`, dir)));
const IDS = ['sp1795032883157', 'sp1795032918554', 'sp1795032936596', 'sp1795032953783', 'sp1795032972783', 'sp1795032991001'];
const have = IDS.every(id => existsSync(new URL(`${id}.dump.json`, dir)));
const HAND = {
  sp1795032883157: [['r', 149, 156], ['l', 163, 169], ['r', 178, 184], ['l', 192, 198]],
  sp1795032972783: [['r', 254, 259], ['r', 283, 288], ['l', 269, 275], ['l', 297, 302]],
  sp1795032918554: [['l', 374, 380]], sp1795032936596: [['r', 236, 242]], sp1795032991001: [['r', 135, 141]],
  sp1795032953783: [['l', 322, 327], ['l', 348, 355]],
};

test('60 fps: every hand-read stance found, edges within a frame (24 of 26 at least)', { skip: !have }, () => {
  let ok = 0, n = 0;
  for (const [id, list] of Object.entries(HAND)) {
    const d = load(id);
    for (const [foot, a, b] of list) {
      const s = footStances(d.motion, foot, d.ts, d.fps, STANCE_60).find(x => x.a <= b && x.b - 1 >= a);
      assert.ok(s, `${id} ${foot}${a}-${b} not found`);
      ok += (Math.abs(s.a - a) <= 1) + (Math.abs(s.b - 1 - b) <= 1); n += 2;
      assert.ok(Math.abs(s.a - a) <= 2 && Math.abs(s.b - 1 - b) <= 2, `${id} ${foot} ${s.a}-${s.b - 1}, by eye ${a}-${b}`);
    }
  }
  assert.ok(ok >= 24, `${ok}/${n} edges within a frame`);
});

test('60 fps: each run shows its steps (was 0-7 clean steps, one clip none at all)', { skip: !have }, () => {
  for (const id of IDS) {
    const d = load(id), r = sprintFromMotion(d);
    assert.ok(!r.error, `${id}: ${r.error}`);
    const c = cleanSteps(r.steps, { fps: d.fps });
    assert.ok(c.length >= 9, `${id}: ${c.length} clean steps`);
    assert.ok(r.steps.every(s => s.flight == null || s.contact >= 0.04), id);
  }
});
