// Sprint contacts and metres, on the toe/track motion of two real clips (2026-10-18, tunnel):
// IMG_3479 Stanley 20 m fly (Freelap run 1: 1.04 / 1.01) and IMG_3480 Miška 20 m accel from a
// 4-point start on the Touch Pro (1.99 / 1.30). Frame numbers checked by hand, 2026-11-13.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sprintFromMotion, analyzeSprint, pairRun, modeOfRun, fitAccel, profileFromRuns, posAt } from '../js/analysis/sprint.js';
import { smoothGround } from '../server/sprint.mjs';

const load = c => JSON.parse(readFileSync(new URL(`./fixtures/sprint-motion-${c}.json`, import.meta.url)));
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} ±${tol}`);

test('Stanley fly: contact about 0.1 s, not the 0.16 s it looks like by eye', () => {
  const m = load('3479');
  const v = sprintFromMotion({ motion: m.motion, ts: m.ts, fps: m.fps });
  assert.equal(v.modeGuess, 'fly');
  assert.equal(v.start, null);
  // touchdowns read by hand from the toe against the track: 713 (L), 738 (R), 765 (L), 789 (R), 816 (L)
  const tds = v.steps.map(s => s.frames[0]);
  for (const f of [713, 738, 765, 789, 816]) assert.ok(tds.some(t => Math.abs(t - f) <= 1), `touchdown near ${f}`);
  const a = analyzeSprint(v, { legs: [1.04, 1.01], lap: 2.05 }, { who: 'stanley' });
  near(a.freq, 4.66, 0.06, 'frequency'); // his own 4-step count for 18.10: 4.65
  near(a.contact, 0.098, 0.01, 'contact');
  near(a.flight, 0.118, 0.01, 'flight');
  near(a.legStats[0].stepLength, 2.06, 0.03, 'step length 1st 10 m');
  near(a.legStats[1].stepLength, 2.12, 0.03, 'step length 2nd 10 m');
});

test('Miška accel: first step, timer zero, steps per 10 m, contacts shortening', () => {
  const m = load('3480');
  const v = sprintFromMotion({ motion: m.motion, ts: m.ts, fps: m.fps });
  assert.equal(v.modeGuess, 'accel');
  const hand = [1192, 1230, 1261, 1292, 1323, 1352, 1381, 1409, 1440, 1468, 1497, 1525, 1555];
  hand.forEach((f, i) => near(v.steps[i].frames[0], f, 1.5, `touchdown ${i + 1}`));
  near(v.start.release * m.fps, 1150, 3, 'Touch Pro release frame (hand off 1148-1153)');
  const a = analyzeSprint(v, { legs: [1.99, 1.3], lap: 3.29 }, { who: 'miska' });
  assert.equal(a.kind, 'accel');
  near(a.legStats[0].steps, 7.5, 0.4, 'steps 0-10 m');
  near(a.legStats[1].steps, 5.3, 0.3, 'steps 10-20 m');
  near(a.legStats[1].stepLength, 1.88, 0.05, 'mean step 10-20 m');
  assert.ok(a.contactFrom > a.contactTo + 0.03, 'contact shortens');
  assert.ok(a.flightTo > a.flightFrom + 0.02, 'flight lengthens');
  assert.equal(a.steps.length, 12);
  assert.ok(a.steps.every((s, i) => i === 0 || s.length >= a.steps[i - 1].length - 0.15), 'steps lengthen');
  near(a.curve.find(c => c.x === 20).v, 8.0, 0.25, 'speed at 20 m');
});

test('the Freelap run filmed is the one heard during the clip', () => {
  const rec = Date.parse('2026-10-18T14:20:46+02:00');
  const runs = [
    { who: 'miska', at: rec - 60000, legs: [1.11, 1.10] },
    { who: 'stanley', at: rec + 9000, legs: [2.0, 1.21] },
    { who: 'miska', at: rec + 11000, legs: [1.99, 1.30] },
    { who: 'miska', at: rec + 90000, legs: [1.95, 1.27] },
  ];
  assert.deepEqual(pairRun(runs, { recordedAt: rec, duration: 13.35 }, 'miska').legs, [1.99, 1.30]);
  assert.equal(pairRun(runs, { recordedAt: null }), null);
  assert.equal(modeOfRun({ legs: [1.99, 1.30] }), 'accel');
  assert.equal(modeOfRun({ legs: [1.04, 1.01] }), 'fly');
});

test('the speed curve goes through the split times', () => {
  const fit = fitAccel([1.91, 1.30, 1.16, 1.15]);
  assert.ok(fit.rms < 0.01, `rms ${fit.rms}`);
  near(fit.vmax, 9.08, 0.05, 'Miška vmax'); near(fit.tau, 1.54, 0.05, 'Miška tau');
  // the chip reaches 10 m after the first split
  let t = 0; while (posAt(t, fit) < 10) t += 0.001;
  near(t, 1.91, 0.02, 'time to 10 m');
});

test('profile from 30-40 m runs: no cap on top speed (Stanley 9.7, not 9.47)', () => {
  const runs = [
    { who: 'stanley', legs: [1.89, 1.20, 1.09, 1.06], lap: 5.24 }, { who: 'stanley', legs: [0.97, 1.04], lap: 2.01 },
    { who: 'miska', legs: [1.91, 1.30, 1.16, 1.15], lap: 5.52 }, { who: 'miska', legs: [1.09, 1.12], lap: 2.21 },
  ];
  const s = profileFromRuns(runs, 'stanley'), mi = profileFromRuns(runs, 'miska');
  near(s.vmax, 9.74, 0.1, 'S vmax'); near(s.F0, 6.9, 0.2, 'S F0'); near(s.pctOfFly, 95, 1, 'S % of fly');
  near(mi.vmax, 9.08, 0.05, 'M vmax'); near(mi.F0, 5.9, 0.1, 'M F0'); near(mi.pctOfFly, 99, 1, 'M % of fly');
  assert.equal(profileFromRuns(runs.filter(r => r.legs.length < 3), 'stanley'), null);
});

test('a failed track match takes its neighbours\' motion', () => {
  const out = smoothGround([{ g: [-10, 1] }, { g: null }, { g: [-12, 1] }, { g: [-11, 1] }, { g: [40, 1] }, { g: [-12, 1] }, { g: [-13, 1] }]);
  near(out[1].g[0], -11, 0.6, 'filled');
  assert.ok(out[4].g[0] < 0, 'outlier replaced by the median');
});
