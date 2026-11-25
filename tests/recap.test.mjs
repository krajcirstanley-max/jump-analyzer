// "Video z tréningu" (js/recap.js): what the cut says, on Stanley's two jumps of 11.11. (local clips).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { story, fmt, plan, FULL_RUNUP } from '../js/recap.js';

const have = existsSync(new URL('./real/r4676.json', import.meta.url)) && existsSync(new URL('./real/r4677.json', import.meta.url));
const mk = (id, split, tape, runup = null) => {
  const d = JSON.parse(readFileSync(new URL(`./real/r${id}.json`, import.meta.url))); const pose = d.result;
  const j = analyzeJump(pose, 'male', pose.ts, { height: 186, split, tape, tapeFrom: tape ? 'toe' : null, runup });
  j.split = split; j.coach = d.final?.coach ?? j.coach;
  return { jump: j, pose: { smooth: pose.smooth, fps: pose.fps, W: pose.W, H: pose.H } };
};

test('values are shown the way the app shows them', () => {
  assert.equal(fmt('contactTO', 125.05), '0,125 s');
  assert.equal(fmt('inclTD', -23.2), '23°');
  assert.equal(fmt('hipDrop', 10.3), '10 cm');
  assert.equal(fmt('speedLast', 8.87), '8,9 m/s');
});

test('two jumps: whole jump first, phases with values, same-measure improvement, best of each, next', { skip: !have }, () => {
  const s = story([mk('4676', 1.09, null), mk('4677', 1.10, 6.85)], { athlete: { name: 'Stanley' }, date: '2026-11-11T14:43:00Z', height: 186 });
  const p = s.plan;
  // 2026-11-24 audit: ungraded metrics left the score, so 4677 is now the better jump overall
  assert.equal(p.count, 2); assert.equal(p.intro, 2); assert.equal(p.best, 2); assert.equal(p.split, 1.10);
  assert.deepEqual(p.phases.slice(0, 3), ['pen:0,133 s', 'plant:61°', 'toeoff:0,142 s']);
  assert.deepEqual(p.improved, { key: 'legTD', from: '63°', to: '61°', a: 1, b: 2 });
  assert.deepEqual(p.bestOf, ['pen:2', 'plant:2', 'toeoff:1']);   // knee at toe-off graded again for men (2026-11-25)
  assert.equal(p.together, null, 'no "spolu" without a confirmed full run-up');
  assert.equal(p.next.value, '1,10 s');
  // no scores anywhere on screen; only measured words
  const words = s.frames.flatMap(f => (f.w ?? []).map(w => w.t));
  assert.ok(!words.some(t => /^\d{2,3}$/.test(t)), 'a bare score shows up');
  assert.ok(words.includes('TRÉNING') && words.includes('ČO SA') && words.includes('NAJLEPŠIE') && words.includes('NABUDÚCE'));
  // every frame the renderer needs is there, with its keypoints
  for (const f of s.frames) for (const q of [f, ...(f.panes ?? [])]) if (q.c != null) { assert.ok(s.clips[q.c].frames.includes(q.f)); assert.ok(s.clips[q.c].kp[q.f]); }
  assert.ok(s.seconds > 25 && s.seconds < 60, `${s.seconds} s`);
});

test('"spolu" only from full run-ups, one model run on top of the fastest jump', { skip: !have }, () => {
  const J = [mk('4676', 1.09, null, FULL_RUNUP), mk('4677', 1.10, 6.85, FULL_RUNUP)];
  const P = plan(J, { height: 186 });
  // Since 2026-11-20 the angle comes from the flight time: 4677 leaves at 19.3° (was 15.4° from the
  // fitted apex), already near its best angle, so the best parts are one jump and nothing is added.
  assert.equal(P.together, null, JSON.stringify(P.together?.gain));
  // A faster, flatter take-off still gets the other jump's angle on top, as one model run.
  const flat = structuredClone(J[1]); const f = flat.jump.flight;
  f.vxTO += 0.6; f.vyTO = 1.8; f.takeoffAngle = (Math.atan2(f.vyTO, f.vxTO) * 180) / Math.PI;
  const Q = plan([J[1], flat], { height: 186 });
  assert.ok(Q.together && Q.together.gain > 0.03 && Q.together.gain < 1, JSON.stringify(Q.together?.gain));
  assert.equal(Q.together.speed, flat); assert.equal(Q.together.angle, J[1]);
});

test('one jump: no comparison shots', { skip: !have }, () => {
  const s = story([mk('4676', 1.09, null)], { athlete: { name: 'Stanley' }, height: 186 });
  assert.equal(s.plan.improved, null); assert.equal(s.plan.bestOf, null);
  assert.ok(!s.frames.some(f => f.panes));
});
