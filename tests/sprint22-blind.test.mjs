// The sprint session of 22 Nov 2026, filmed from the finish with the runner coming straight at the
// phone (13 flying 20 m, 4 standing 30 m, Freelap on every one). That day the app found every step of
// only 1 of 17 Freelap stretches: the strips beside the feet saw one flat red track and their match
// jumped 10-18 px a frame while the phone panned a steady 8. Since then the toes are held against the
// camera's motion (server/camflow.py) and a toe the pose loses as the legs cross gets its touchdown
// back (glitchBack).
// sprint22-blind.json: every stance read blind on foot crops by six readers (clip -> [foot, TD, TO],
// "a/b" either frame, "<f"/">f" outside the frames, "?" unreadable). The server's pose and motion of
// those clips (with the camera's motion in g) and the phone's records are gitignored (tests/real/sprint22).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { sprintFromMotion, analyzeSprint } from '../js/analysis/sprint.js';

const R = new URL('./real/sprint22/', import.meta.url);
const HAND = JSON.parse(readFileSync(new URL('./sprint22-blind.json', import.meta.url)));
const dump = c => new URL(`dump2/${c}.json`, R);
const have = Object.keys(HAND).every(c => existsSync(dump(c))) && existsSync(new URL('jump.sprint.analyses.json', R));
const parse = v => (!v || v === '?' ? null : v[0] === '<' || v[0] === '>' ? { out: true } : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(String(v).split('/').map(Number)));
const off = (app, h) => (app < h.lo ? app - h.lo : app > h.hi ? app - h.hi : 0);
const mid = h => (h && !h.out ? (h.lo + h.hi) / 2 : null);
const stepsOf = c => { const d = JSON.parse(readFileSync(dump(c))).dump; return sprintFromMotion({ motion: d.motion, ts: d.ts, fps: d.meta.fps }).steps; };

test('head-on sprints of 22 Nov: every stance found, edges within a frame or two of the hand', { skip: !have }, () => {
  const td = [], to = [], missed = [];
  for (const [clip, list] of Object.entries(HAND)) {
    const steps = stepsOf(clip), used = new Set();
    for (const [foot, tdS, toS] of list) {
      const a = parse(tdS), b = parse(toS);
      const c = mid(a) ?? (mid(b) != null ? mid(b) - 12 : null);
      if (c == null) continue;   // nothing readable at either edge (the walk into the set position, a cut-off end)
      const s = steps.find(x => !used.has(x) && x.frames[0] <= (mid(b) ?? c + 12) + 3 && x.frames[1] >= c - 3);
      if (!s) { missed.push(`${clip} ${foot} ${tdS}-${toS}`); continue; }
      used.add(s);
      if (a && !a.out) td.push(off(s.frames[0], a));
      if (b && !b.out) to.push(off(s.frames[1], b));
    }
  }
  const within = (x, k) => x.filter(v => Math.abs(v) <= k).length / x.length;
  // 2026-11-22, 294 stances of 18 clips: 9 not found (73 with the strips), TD 90 % within a frame and
  // 96 % within two, TO 92 / 97 % (strips 79 / 87, 83 / 87). The misses are standing starts 30 m away
  // and stances cut off at a clip end.
  assert.ok(missed.length <= 8, `missed ${missed.length}: ${missed.join(', ')}`);
  assert.ok(within(td, 1) >= 0.85 && within(td, 2) >= 0.92, `TD ${within(td, 1)} / ${within(td, 2)}`);
  assert.ok(within(to, 1) >= 0.88 && within(to, 2) >= 0.95, `TO ${within(to, 1)} / ${within(to, 2)}`);
});

test('head-on sprints of 22 Nov: every flying 20 m has its steps in both 10 m', { skip: !have }, () => {
  const recs = JSON.parse(readFileSync(new URL('jump.sprint.analyses.json', R)));
  for (const r of recs.filter(x => x.run?.legs?.length === 2 && x.video?.finishAt != null && existsSync(dump(x.id)))) {
    const a = analyzeSprint({ ...r.video, steps: stepsOf(r.id) }, r.run, { who: r.who, height: r.who === 'miska' ? 171 : 186 });
    assert.equal(a.kind, 'fly', r.id);
    assert.ok(a.steps.length >= 8, `${r.id} ${a.steps.length} steps in the 20 m`);
    for (const l of a.legStats) assert.ok(l.steps >= 4 && l.stepLength > 1.8 && l.stepLength < 2.5, `${r.id} 10 m: ${JSON.stringify(l)}`);
  }
});
