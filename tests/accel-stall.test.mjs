// Where an acceleration stops gaining (accel-stall.js): synthetic steps, and the head-on 30 m runs of
// 22 Nov when their pose is on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { stepStall, accelStall, legParts } from '../js/analysis/accel-stall.js';
import { sprintFromMotion, analyzeSprint } from '../js/analysis/sprint.js';

const mk = (contacts, step = 0.24) => contacts.map((c, i) => ({ td: i * step, contact: c, step, leg: Math.floor(i / 6) }));

test('a contact that stops getting shorter by 3 frames for two steps is a stall; one-frame noise is not', () => {
  assert.equal(stepStall(mk([0.17, 0.16, 0.15, 0.14, 0.135, 0.13, 0.125, 0.12, 0.12, 0.115])), null);
  assert.equal(stepStall(mk([0.17, 0.16, 0.15, 0.14, 0.15, 0.13, 0.14, 0.12, 0.13, 0.12])), null, 'single-frame wobble');
  const s = stepStall(mk([0.17, 0.16, 0.15, 0.13, 0.12, 0.12, 0.15, 0.155, 0.16, 0.16]));
  assert.ok(s && s.contact && s.step >= 7 && s.step <= 8, JSON.stringify(s));
});

test('a 10 m gain splits into step length and rate, exactly', () => {
  const a = { kind: 'accel', legs: [1.9, 1.2], steps: mk([0.17, 0.16, 0.15, 0.14, 0.13, 0.12, 0.12, 0.11, 0.11, 0.11, 0.11, 0.11], 0.25).map(s => ({ ...s, td: 0.4 + s.td })),
    legStats: [{ time: 1.9, stepLength: 1.4, end: 1.9 }, { time: 1.2, stepLength: 1.9, end: 3.1 }] };
  a.steps.forEach(s => { s.leg = s.td < 1.9 ? 0 : 1; });
  a.steps.push({ td: 3.2, contact: 0.11, step: 0.25, leg: 2 });
  const r = accelStall(a);
  const g = r.gains[0];
  assert.ok(Math.abs(g.byLength + g.byRate - g.dv) < 1e-9);
  assert.ok(g.byLength > 0);
});

const R = new URL('./real/sprint22/', import.meta.url);
const have = existsSync(new URL('jump.sprint.analyses.json', R)) && existsSync(new URL('dump2/sp1795352344038.json', R));
test('head-on 30 m runs: no step length from a 10 m with lost steps', { skip: !have }, () => {
  const recs = JSON.parse(readFileSync(new URL('jump.sprint.analyses.json', R)));
  const r = recs.find(x => x.id === 'sp1795352344038'), d = JSON.parse(readFileSync(new URL(`dump2/${r.id}.json`, R))).dump;
  const a = analyzeSprint({ ...r.video, steps: sprintFromMotion({ motion: d.motion, ts: d.ts, fps: d.meta.fps }).steps }, r.run, { who: 'stanley', height: 186 });
  const P = legParts(a);
  // the blind reads have 8 touchdowns in 0-10 m, the app 6 (the start is 30 m from the phone): no length there
  assert.equal(P[0].length, null);
  assert.equal(P[1].length != null, true);
});
