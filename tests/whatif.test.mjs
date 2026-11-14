// "O koľko ďalej" (whatif.js): the norm is the target, couplings applied, one pick, cue only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whatIf } from '../js/analysis/whatif.js';
import { NORMS } from '../js/analysis/metrics.js';

const metric = (key, value, status) => ({ key, label: NORMS[key].label, unit: NORMS[key].unit, value, norm: NORMS[key].m, status, frame: 1 });
// IMG_4677's take-off: flat (15.7°), deep penultimate, slow into the board.
const jump = {
  metrics: [metric('takeoffAngle', 15.67, 'low'), metric('hipDrop', 10.31, 'high'), metric('speedLast', 8.83, 'low')],
  flight: { vxTO: 7.9, vyTO: 2.22, ground: { flightTime: 0.7 } },
};

test('every fault gets the norm edge as its target; the flat take-off pays horizontal speed for the angle', () => {
  const w = whatIf(jump, 'male');
  const flat = w.items.find(x => x.id === 'flat');
  assert.equal(flat.target, NORMS.takeoffAngle.m[0]);
  assert.equal(flat.basis, 'fyzika');
  const [lo, hi] = flat.gain;
  assert.ok(lo > 0.05 && hi < 0.6 && lo < hi, `flat ${lo}-${hi}`);
  // without the coupling (vx kept) the gain would be larger than the high end
  const T1 = (2.22 * 0 + Math.tan(19 * Math.PI / 180) * 7.9 + Math.sqrt((Math.tan(19 * Math.PI / 180) * 7.9) ** 2 + 2 * 9.81 * (((9.81 * 0.7 - 2.22) ** 2 - 2.22 ** 2) / (2 * 9.81)))) / 9.81;
  assert.ok(7.9 * T1 - 7.9 * 0.7 > hi, 'the coupling costs distance');
});

test('one pick, cues only, never summed', () => {
  const w = whatIf(jump, 'male');
  assert.equal(w.pick, w.items[0].id);
  for (const x of w.items) assert.ok(x.cue === null || typeof x.cue === 'string');
  for (const x of w.items) assert.ok(!('drill' in x) && !('exercise' in x));
  const best = Math.max(...w.items.filter(x => x.gain).map(x => x.gain[1]));
  const sum = w.items.filter(x => x.gain).reduce((a, x) => a + x.gain[1], 0);
  assert.ok(w.together[1] >= best && w.together[1] < sum);
});

test('the coaching on screen decides the pick when it leads with another fault', () => {
  const w = whatIf(jump, 'male', { preferKey: 'takeoffAngle' });
  assert.equal(w.pick, 'flat');
});

test('nothing out of the norm: an empty list, no pick', () => {
  const w = whatIf({ metrics: [metric('takeoffAngle', 21, 'ok')], flight: {} }, 'male');
  assert.equal(w.items.length, 0);
  assert.equal(w.pick, null);
});
