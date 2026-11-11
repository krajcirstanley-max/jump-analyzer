import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { cleanTrack, hampel, fillGaps, filtfilt, dropCollapsedFeet } from '../js/pose/clean.js';

const K = J.length, FPS = 120;

// A runner seen side-on: legs swing in opposite phase, body moves right.
function runner(n) {
  const frames = [];
  for (let i = 0; i < n; i++) {
    const t = i / FPS, ph = 2 * Math.PI * 1.6 * t, x0 = 300 + 400 * t;
    const f = new Float32Array(K * 3);
    const set = (name, x, y) => { const k = JI[name]; f[k * 3] = x; f[k * 3 + 1] = y; f[k * 3 + 2] = 0.9; };
    for (const s of ['l', 'r']) {
      const sg = s === 'l' ? 1 : -1, sw = sg * Math.sin(ph);
      set(s + 'sho', x0, 400); set(s + 'hip', x0, 700); set(s + 'ear', x0 + 10, 330);
      set(s + 'elb', x0 - 60 * sw, 550); set(s + 'wri', x0 - 90 * sw, 650);
      set(s + 'knee', x0 + 90 * sw, 850); set(s + 'ank', x0 + 140 * sw, 1000);
      set(s + 'heel', x0 + 125 * sw, 1015); set(s + 'bigtoe', x0 + 175 * sw, 1020); set(s + 'smalltoe', x0 + 170 * sw, 1022);
    }
    set('nose', x0 + 20, 340);
    frames.push(f);
  }
  return frames;
}
const swapLegs = f => {
  const g = Float32Array.from(f);
  for (const p of ['hip', 'knee', 'ank', 'heel', 'bigtoe', 'smalltoe']) for (let c = 0; c < 3; c++) {
    g[JI['l' + p] * 3 + c] = f[JI['r' + p] * 3 + c]; g[JI['r' + p] * 3 + c] = f[JI['l' + p] * 3 + c];
  }
  return g;
};

test('fixes short left/right leg swaps', () => {
  const truth = runner(240);
  const noisy = truth.map((f, i) => ((i >= 50 && i < 54) || (i >= 130 && i < 131) ? swapLegs(f) : f));
  const { clean, swapped } = cleanTrack(noisy, () => 0.3, FPS);
  assert.deepEqual([...swapped.legs].sort((a, b) => a - b), [50, 51, 52, 53, 130]);
  for (const i of [51, 130]) assert.ok(Math.abs(clean[i][JI.lknee * 3] - truth[i][JI.lknee * 3]) < 1);
});

test('leaves a clean track untouched', () => {
  const { swapped } = cleanTrack(runner(240), () => 0.3, FPS);
  assert.equal(swapped.legs.size + swapped.arms.size, 0);
});

test('spikes are removed and refilled', () => {
  const x = Float64Array.from({ length: 60 }, (_, i) => 100 + i);
  x[30] = 400;
  const h = hampel(x, 3);
  assert.deepEqual(h.flagged, [30]);
  assert.equal(fillGaps(h.out, 3)[30], 130);
});

test('gaps longer than the limit stay empty', () => {
  const x = Float64Array.from([1, NaN, NaN, NaN, NaN, 6]);
  assert.ok(Number.isNaN(fillGaps(x, 3)[2]));
  assert.equal(fillGaps(Float64Array.from([1, NaN, 3]), 3)[1], 2);
});

test('zero-phase low-pass keeps slow motion and removes jitter without shifting it', () => {
  const n = 480, slow = i => 100 * Math.sin(2 * Math.PI * 2 * i / FPS);
  const x = Float64Array.from({ length: n }, (_, i) => slow(i) + (i % 2 ? 3 : -3));
  const y = filtfilt(x, 12, FPS);
  let maxErr = 0;
  for (let i = 40; i < n - 40; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - slow(i)));
  assert.ok(maxErr < 3, `max error ${maxErr.toFixed(2)}`);
  // Peak stays on the same frame (no phase lag).
  const peak = a => { let m = 0; for (let i = 100; i < 160; i++) if (a[i] > a[m] || m < 100) m = i; return m; };
  assert.equal(peak(y), peak(Float64Array.from({ length: n }, (_, i) => slow(i))));
});

// IMG_4676: for three frames of the take-off contact the model put both feet where the swinging
// foot was; the stance foot vanished and the contact split in two.
test('drops the foot that jumped onto the other foot', () => {
  const truth = runner(120);
  const feet = ['ank', 'heel', 'bigtoe', 'smalltoe'];
  const noisy = truth.map((f, i) => {
    if (i < 60 || i > 62) return f;
    const g = Float32Array.from(f);
    for (const p of feet) for (let c = 0; c < 2; c++) g[JI['r' + p] * 3 + c] = f[JI['l' + p] * 3 + c] + 1;
    return g;
  });
  const frames = noisy.slice();
  const changed = dropCollapsedFeet(frames, (f, k) => f[k * 3 + 2] >= 0.3);
  assert.deepEqual(changed, [60, 61, 62]);
  for (const i of changed) for (const p of feet) { assert.equal(frames[i][JI['r' + p] * 3 + 2], 0); assert.ok(frames[i][JI['l' + p] * 3 + 2] > 0.3); }
  const { clean } = cleanTrack(noisy, () => 0.3, FPS);
  assert.ok(Math.abs(clean[61][JI.rbigtoe * 3] - truth[61][JI.rbigtoe * 3]) < 8);
  // feet that really pass each other are left alone
  assert.deepEqual(dropCollapsedFeet(truth.slice(), (f, k) => f[k * 3 + 2] >= 0.3), []);
});
