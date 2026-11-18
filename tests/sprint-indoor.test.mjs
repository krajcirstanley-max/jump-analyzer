// Seven indoor sprints uploaded on 2026-11-18 at 120 fps (Stanley and Miška, the runner coming
// head-on from far away, the phone still or panning at the pass). The toe/track motion of each was
// dumped from the server (gitignored tests/real/sprint18b/). Hand frames: the first and last frame
// the shoe is on the track, read on fixed crops with a line at the planted toe's height (the phone
// held still) and on the pans by the shoe against the track lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sprintFromMotion, cleanSteps } from '../js/analysis/sprint.js';

const dir = new URL('./real/sprint18b/', import.meta.url);
const load = id => JSON.parse(readFileSync(new URL(`${id}.dump.json`, dir)));
// id: [foot, touchdown, toe-off (null where the foot left the picture)]
const HAND = {
  sp1795034127755: [['l', 455, 466], ['l', 662, 672]],
  sp1795034149961: [['l', 317, 331], ['l', 565, 577]],
  sp1795034174256: [['l', 594, 604], ['r', 987, 996]],
  sp1795034200508: [['r', 652, 663], ['r', 1053, null]],
  sp1795034233149: [['l', 1298, 1311], ['r', 1537, 1548]],
  sp1795034357691: [['r', 866, 877], ['l', 1212, 1220]],
  sp1795034390691: [['l', 680, 691], ['r', 882, 893]],
  // two more of the same evening (22:07); Miška's r 604-616 far away during a pan reads 612-617 and
  // is left out of the clean steps, so it is not held here
  sp1795036029184: [['l', 692, 704]],
  sp1795036059832: [['l', 707, 715], ['r', 833, 842]],
};
const have = Object.keys(HAND).every(id => existsSync(new URL(`${id}.dump.json`, dir)));

test('indoor 120 fps: hand-read contacts within a frame, every run shows its steps', { skip: !have }, () => {
  for (const [id, list] of Object.entries(HAND)) {
    const d = load(id), r = sprintFromMotion(d);
    assert.ok(!r.error, `${id}: ${r.error}`);
    assert.ok(cleanSteps(r.steps, { fps: d.fps }).length >= 14, `${id}: too few clean steps`);
    for (const [foot, td, to] of list) {
      const s = r.steps.find(x => x.foot === foot && x.frames[0] <= (to ?? td + 8) && x.frames[1] - 1 >= td);
      assert.ok(s, `${id} ${foot}${td} not found`);
      assert.ok(Math.abs(s.frames[0] - td) <= 1, `${id} ${foot} touchdown ${s.frames[0]}, by eye ${td}`);
      if (to != null) assert.ok(Math.abs(s.frames[1] - 1 - to) <= 1, `${id} ${foot} toe-off ${s.frames[1] - 1}, by eye ${to}`);
    }
  }
});
