// Every contact of every sprint clip we have, read blind (2026-11-21): the touchdown and the toe-off
// of each step the app finds, read by eye on foot crops without seeing the app's frames (outdoors
// the shoe meeting its shadow, indoors the sole stopping). sprint-blind.json: clip -> [foot, TD, TO],
// "a/b" = either frame, "<f" / ">f" = before / after the frames shown, "?" = unreadable.
// The clips' pose and toe motion are gitignored (tests/real); skipped without them.
// Before the settle rule the toe alone put touchdowns a frame late at 120 fps (106 of 198 +1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sprintFromMotion } from '../js/analysis/sprint.js';

const R = new URL('./real/', import.meta.url);
const HAND = JSON.parse(readFileSync(new URL('./sprint-blind.json', import.meta.url)));
const file = c => [`sprint18b/${c}.dump.json`, `sprint60/${c}.dump.json`, `sprint18/sp1794744${c.slice(2)}.json`].map(p => new URL(p, R)).find(existsSync);
const have = Object.keys(HAND).every(c => file(c));
const parse = v => (v === '?' ? null : v[0] === '<' || v[0] === '>' ? { out: v[0], f: +v.slice(1) } : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(v.split('/').map(Number)));
const off = (app, h) => (h.out ? null : app < h.lo ? app - h.lo : app > h.hi ? app - h.hi : 0);
const mid = h => (h ? (h.out ? h.f : (h.lo + h.hi) / 2) : null);

test('blind hand reads: touchdowns and toe-offs of every step', { skip: !have }, () => {
  const tally = { 120: { td: [], to: [] }, 60: { td: [], to: [] } };
  for (const [clip, list] of Object.entries(HAND)) {
    let d = JSON.parse(readFileSync(file(clip))); if (d.dump) d = d.dump;
    const fps = d.fps ?? d.meta.fps, r = sprintFromMotion({ motion: d.motion, ts: d.ts, fps });
    const T = tally[fps < 90 ? 60 : 120];
    for (const [foot, tdS, toS] of list) {
      const td = parse(tdS), to = parse(toS), c = mid(td) ?? mid(to) - 5;
      const s = r.steps.find(x => x.foot === foot && x.frames[0] - 8 <= (mid(to) ?? c + 8) && x.frames[1] + 8 >= c);
      if (!s) continue;
      if (td && !td.out) T.td.push(off(s.frames[0], td));
      if (to && !to.out) T.to.push(off(s.frames[1], to));
    }
  }
  const rate = a => a.filter(x => Math.abs(x) <= 1).length / a.length, mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  // 2026-11-21 with the settle and toe-off rules, every step found (shown or not): 120 fps TD 96 %
  // within a frame, TO 96 %; 60 fps TD 90 %, TO 96 %; no bias either way. A second pose run of the
  // same clips (T4) gave 95 / 95 / 88 / 94. The floors leave room for that run-to-run wobble.
  assert.ok(rate(tally[120].td) >= 0.93, `120 fps touchdowns within a frame ${rate(tally[120].td)}`);
  assert.ok(Math.abs(mean(tally[120].td)) <= 0.25, `120 fps touchdown bias ${mean(tally[120].td)}`);
  assert.ok(rate(tally[120].to) >= 0.93, `120 fps toe-offs within a frame ${rate(tally[120].to)}`);
  assert.ok(Math.abs(mean(tally[120].to)) <= 0.25, `120 fps toe-off bias ${mean(tally[120].to)}`);
  assert.ok(rate(tally[60].td) >= 0.86, `60 fps touchdowns within a frame ${rate(tally[60].td)}`);
  assert.ok(rate(tally[60].to) >= 0.93, `60 fps toe-offs within a frame ${rate(tally[60].to)}`);
});
