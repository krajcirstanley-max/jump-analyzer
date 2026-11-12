import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { countSteps } from '../js/analysis/stepcount.js';

const FPS = 120, GROUND = 900, TORSO = 200;

// One frame: torso 200 px, each foot at its height above the ground (px).
function frame(lUp, rUp) {
  const kp = new Float32Array(J.length * 3);
  const set = (n, x, y) => { kp[JI[n] * 3] = x; kp[JI[n] * 3 + 1] = y; kp[JI[n] * 3 + 2] = 1; };
  set('lsho', 500, 400); set('rsho', 505, 400); set('lhip', 500, 600); set('rhip', 505, 600);
  for (const [s, up] of [['l', lUp], ['r', rUp]]) { set(s + 'ank', 500, GROUND - 10 - up); set(s + 'heel', 495, GROUND - up); set(s + 'bigtoe', 520, GROUND - up); }
  return kp;
}

// phases: [foot, from, to] = that foot is the lower one (the other up 0.6 torso); level elsewhere.
function track(n, phases, missing = []) {
  const t = Array.from({ length: n }, () => frame(0, 0));
  for (const [foot, a, b] of phases) for (let i = a; i <= b; i++) t[i] = foot === 'l' ? frame(0, 0.6 * TORSO) : frame(0.6 * TORSO, 0);
  for (const [a, b] of missing) for (let i = a; i <= b; i++) t[i] = null;
  return t;
}

// Running phases of 25 frames every 30 (0.25 s a step), alternating, the last one on foot `last`.
function run(start, count, last = 'r') {
  const out = [];
  for (let k = 0; k < count; k++) {
    const foot = (count - 1 - k) % 2 === 0 ? last : last === 'r' ? 'l' : 'r';
    out.push([foot, start + 30 * k, start + 30 * k + 24]);
  }
  return out;
}

test('step count: standing, a skip onto the mark, then ten steps to the board', () => {
  // standing to 99, skip: left 100-106, right 110-120 (0.08 s apart), then the run-up from 135
  const steps = run(135, 10);
  const td = steps.at(-1)[1];
  const t = track(td + 40, [['l', 100, 106], ['r', 110, 122], ...steps]);
  const c = countSteps(t, { td, foot: 'r', fps: FPS });
  assert.equal(c.seen, true);
  assert.equal(c.count, 10);
  assert.equal(c.contacts[0].foot, 'l');
  assert.equal(c.first, 135);
});

test('step count: the landing on the mark (take-off foot) is not counted, the count stays even', () => {
  // walk in slowly (0.6 s steps), right foot onto the mark, then eight steps
  const steps = run(200, 8);
  const td = steps.at(-1)[1];
  const t = track(td + 40, [['l', 60, 90], ['r', 140, 170], ...steps]);
  const c = countSteps(t, { td, foot: 'r', fps: FPS });
  assert.equal(c.seen, true);
  assert.equal(c.count, 8);
});

test('step count: a clip that starts mid run-up only reports what it shows', () => {
  const steps = run(0, 15);
  const td = steps.at(-1)[1];
  const t = track(td + 40, steps);
  const c = countSteps(t, { td, foot: 'r', fps: FPS });
  assert.equal(c.seen, false);
  assert.equal(c.count, 14); // the first phase is cut by the clip start
});

test('step count: a short hole in the track does not break the rhythm, a long one does', () => {
  const steps = run(135, 12);
  const td = steps.at(-1)[1];
  const short = countSteps(track(td + 40, [['l', 100, 106], ['r', 110, 122], ...steps], [[222, 238]]), { td, foot: 'r', fps: FPS });
  assert.equal(short.seen, true);
  assert.equal(short.count, 12);
  // a hole that swallows a whole step
  const long = countSteps(track(td + 40, [['l', 100, 106], ['r', 110, 122], ...steps], [[190, 260]]), { td, foot: 'r', fps: FPS });
  assert.equal(long.seen, false);
  assert.equal(long.why, 'hole');
});

test('step count: no count when the board phase is not the take-off foot', () => {
  const steps = run(135, 10);
  const td = steps.at(-1)[1];
  assert.equal(countSteps(track(td + 40, steps), { td, foot: 'l', fps: FPS }), null);
});
