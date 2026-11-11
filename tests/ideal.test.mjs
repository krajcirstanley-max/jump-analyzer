import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { idealTouchdown } from '../js/analysis/ideal.js';
import { P, dist, angle3, mid } from '../js/analysis/kinematics.js';

// A side-on athlete at board touchdown running left (dir -1), stance leg left: the leg too steep
// and the knee too bent for the norms, the trunk upright.
function athlete() {
  const kp = new Float32Array(J.length * 3);
  const set = (n, x, y) => { kp[JI[n] * 3] = x; kp[JI[n] * 3 + 1] = y; kp[JI[n] * 3 + 2] = 1; };
  set('lank', 300, 900); set('lheel', 320, 910); set('lbigtoe', 270, 912); set('lsmalltoe', 272, 912);
  set('lknee', 300, 760); set('lhip', 360, 640);            // knee ~153°, leg steep (~70°)
  set('rhip', 362, 642); set('rknee', 440, 700); set('rank', 520, 780);
  set('rheel', 535, 785); set('rbigtoe', 545, 800); set('rsmalltoe', 545, 798);
  set('lsho', 358, 420); set('rsho', 362, 420); set('lelb', 330, 520); set('relb', 400, 500);
  set('lwri', 300, 580); set('rwri', 430, 560); set('nose', 345, 370); set('lear', 360, 372); set('rear', 362, 372);
  return kp;
}

test('ideal at board touchdown: own segment lengths, angles moved into the norms', () => {
  const kp = athlete();
  const id = idealTouchdown(kp, { s: 'l', dir: -1, sex: 'male' });
  assert.ok(id);
  const k = id.kp, seg = (q, a, b) => dist(P(q, a), P(q, b));
  // segments kept
  for (const [a, b] of [['lhip', 'lknee'], ['lknee', 'lank'], ['rhip', 'rknee'], ['rknee', 'rank']]) assert.ok(Math.abs(seg(kp, a, b) - seg(k, a, b)) < 0.01, `${a}-${b}`);
  const tr = q => dist(mid(P(q, 'lsho'), P(q, 'rsho')), mid(P(q, 'lhip'), P(q, 'rhip')));
  assert.ok(Math.abs(tr(kp) - tr(k)) < 0.5);
  // the stance foot does not move
  for (const n of ['lank', 'lheel', 'lbigtoe']) assert.deepEqual(P(k, n), P(kp, n));
  // every reported ideal sits inside its band, and the moved ones really moved
  const by = Object.fromEntries(id.items.map(it => [it.key, it]));
  for (const it of id.items.filter(x => !x.derived)) assert.ok(it.ideal >= it.band[0] - 0.01 && it.ideal <= it.band[1] + 0.01, `${it.key} ${it.ideal}`);
  // the lean follows from the leg and trunk: it moves towards its band, as far as their norms allow
  const miss = (v, [lo, hi]) => (v < lo ? lo - v : v > hi ? v - hi : 0);
  assert.ok(miss(by.inclTD.ideal, by.inclTD.band) <= miss(by.inclTD.you, by.inclTD.band));
  assert.ok(by.kneeTD.set && by.legTD.set);
  assert.ok(Math.abs(angle3(P(k, 'lhip'), P(k, 'lknee'), P(k, 'lank')) - by.kneeTD.ideal) < 0.01);
  // the knee stays on its own side of the hip-ankle line (bent forward, not backward)
  const cross = q => { const h = P(q, 'lhip'), a = P(q, 'lank'), n = P(q, 'lknee'); return Math.sign((a[0] - h[0]) * (n[1] - h[1]) - (a[1] - h[1]) * (n[0] - h[0])); };
  assert.equal(cross(k), cross(kp));
});

test('ideal: nothing changes when every angle is already in the norm', () => {
  const kp = athlete();
  const id0 = idealTouchdown(kp, { s: 'l', dir: -1 });
  const id = idealTouchdown(id0.kp, { s: 'l', dir: -1 });
  for (const it of id.items) assert.ok(!it.set || Math.abs(it.ideal - it.you) < 0.6, it.key);
});
