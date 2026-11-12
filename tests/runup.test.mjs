import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceFraction, expectedDistance, runupNorm, adjustForRunup, runupTable, fullFrom, judgedSteps } from '../js/analysis/runup.js';

const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${a} vs ${b}`);

test('run-up: distance share follows Béres 2014 at 6-12 strides and is 1 at 18', () => {
  near(distanceFraction(6), 0.805); near(distanceFraction(10), 0.878); near(distanceFraction(12), 0.90);
  near(distanceFraction(18), 1); near(distanceFraction(11), 0.889);
  near(distanceFraction(4), 0.805);   // no data under 6: read as 6
});

test('run-up: expected distance from the full run-up PB', () => {
  const e = expectedDistance(10, 7.0);
  near(e.mid, 6.146); near(e.lo, 7.0 * 0.838); near(e.hi, 7.0 * 0.908);
  assert.equal(expectedDistance(4, 7), null);
  assert.equal(expectedDistance(10, null), null);
  near(fullFrom(12, 6.3), 7.0);
});

test('run-up: speed-dependent norms move, the rest stay', () => {
  assert.deepEqual(runupNorm('takeoffAngle', [19, 27], 8), [22, 30]);
  assert.deepEqual(runupNorm('kneeTD', [160, 178], 6), [150, 168]);
  assert.deepEqual(runupNorm('legTD', [55, 65], 6), [55, 65]);
  assert.deepEqual(runupNorm('takeoffAngle', [19, 27], 18), [19, 27]);
  const loss = runupNorm('speedLossTO', [-22, -12], 6);
  near(loss[0], -13.86); near(loss[1], -7.56);
  const dist = runupNorm('estDistance', [7.8, 8.6], 10, { pb: 7.0 });
  near(dist[0], 7.0 * 0.838);
});

test('run-up: a 25° take-off from 8 steps is in range, not a fault', () => {
  const m = [{ key: 'takeoffAngle', value: 28.5, norm: [19, 27], status: 'high' }, { key: 'legTD', value: 60, norm: [55, 65], status: 'ok' }];
  const out = adjustForRunup(m, 8);
  assert.equal(out[0].status, 'ok');
  assert.deepEqual(out[0].fullNorm, [19, 27]);
  assert.equal(out[1], m[1]);
  assert.equal(adjustForRunup(m, null), m);
});

test('run-up: judged steps are the confirmed ones, else only a count with the start seen', () => {
  assert.equal(judgedSteps(14, { seen: false, count: 10 }), 14);
  assert.equal(judgedSteps(null, { seen: true, count: 10 }), 10);
  assert.equal(judgedSteps(null, { seen: false, count: 10 }), null);
});

test('run-up table: best per step count, tape over video, full run-up estimate', () => {
  const rec = (runup, toe, measured) => ({ runup, measured, jump: { speed: { jumpFromToe: toe } } });
  const t = runupTable([rec(10, 6.0), rec(10, 6.2), rec(12, 6.1, 6.3), rec(null, 6.5)], 7.0);
  assert.deepEqual(t.rows.map(r => [r.steps, r.jumps, r.best]), [[10, 2, 6.2], [12, 1, 6.3]]);
  near(t.rows[0].pctPb, 6.2 / 7);
  assert.equal(t.rows[1].taped, 1);
  near(t.full, (6.2 / 0.878 + 6.3 / 0.9) / 2);
});
