// "O koľko ďalej" (whatif.js): the norm is the target, each effect in cm, the change's total is the
// sum of its effects, ranked by cost, one pick, cue only, different changes never summed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatIf } from '../js/analysis/whatif.js';
import { NORMS } from '../js/analysis/metrics.js';

const metric = (key, value, status) => ({ key, label: NORMS[key].label, unit: NORMS[key].unit, value, norm: NORMS[key].m, status, frame: 1 });
// IMG_4677's take-off: flat (15.7°), deep penultimate, slow into the board, low take-off CoM.
const jump = () => ({
  metrics: [metric('takeoffAngle', 15.67, 'low'), metric('hipDrop', 10.31, 'high'), metric('speedLast', 8.83, 'low'),
    metric('contactTO', 141.7, 'high'), metric('toHeight', 58.5, 'low')],
  flight: { vxTO: 7.9, vyTO: 2.22, ground: { flightTime: 0.7, steps: [{ id: 'third', speed: 8.47 }, { id: 'pen', speed: 8.83 }] } },
});

test('flat take-off (Linthorne 2005 curve): vertical gain, horizontal cost and shorter take-off/landing distances; the total is their sum', () => {
  const x = whatIf(jump(), 'male', { height: 186 }).items.find(i => i.id === 'flat');
  assert.equal(x.target, NORMS.takeoffAngle.m[0]);
  const [up, down, dist] = x.effects;
  assert.equal(up.kind, 'up'); assert.equal(down.kind, 'down'); assert.equal(dist.kind, 'down');
  const net = up.cm[0] + down.cm[0] + dist.cm[0];
  assert.ok(x.total[0] <= net && net <= x.total[1]);
  // the verification's recomputation for IMG_4677: +24 cm (21-27)
  assert.ok(net > 0.21 && net < 0.27, `${net}`);
  assert.ok(x.total[1] - x.total[0] < 0.07, 'the range stays narrow');
});

test('speed: 55-70 % of the approach gain reaches take-off (Béres 2014), times his own flight time', () => {
  const x = whatIf(jump(), 'male', { height: 186 }).items.find(i => i.id === 'speedLow');
  const vxRow = x.effects[0];
  assert.ok(Math.abs(vxRow.cm[0] - 0.55 * 0.53 * 0.7) < 0.002 && Math.abs(vxRow.cm[1] - 0.70 * 0.53 * 0.7) < 0.002);
});

test('deep sit: the take-off CoM rises by the extra drop (capped by the height norm); no speed was lost in this jump', () => {
  const x = whatIf(jump(), 'male', { height: 186 }).items.find(i => i.id === 'hipDropHigh');
  const com = x.effects.find(e => e.label.startsWith('Ťažisko'));
  assert.ok(com.cm[0] > 0.05 && com.cm[0] < 0.09, `${com.cm[0]}`);
  const sp = x.effects.find(e => e.label.startsWith('Rýchlosť'));
  assert.deepEqual(sp.cm, [0, 0]);
});

test('ranked by cost, one pick, cues only, never summed across changes', () => {
  const w = whatIf(jump(), 'male', { height: 186 });
  const mids = w.items.filter(x => x.total).map(x => (x.total[0] + x.total[1]) / 2);
  assert.deepEqual(mids, [...mids].sort((a, b) => b - a));
  assert.equal(w.pick, w.items[0].id);
  for (const x of w.items) assert.ok(x.cue === null || typeof x.cue === 'string');
  const sum = w.items.filter(x => x.total).reduce((a, x) => a + x.total[1], 0);
  assert.ok(w.together[1] >= w.items[0].total[1] && w.together[1] < sum);
});

test('nothing out of the norm: an empty list, no pick', () => {
  const w = whatIf({ metrics: [metric('takeoffAngle', 21, 'ok')], flight: {} }, 'male');
  assert.equal(w.items.length, 0);
  assert.equal(w.pick, null);
});
