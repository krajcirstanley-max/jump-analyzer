// Two jumps side by side (js/compare-view.js): lining them up on the jump's own moments and
// saying what changed, only from measured numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyFramesOf, anchorPairs, mapTime, nearestFrame, changeText, rowsFor, headline } from '../js/compare-view.js';

const ts = (n, fps, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + i / fps);
const jump = (kf, phases = []) => ({ phases: [{ id: 'pen', keyFrames: Object.entries(kf).map(([id, frame]) => ({ id, frame })), metrics: [] }, ...phases] });

test('lined up on the shared moments: each moment passes in both at once, same pace outside', () => {
  const tA = ts(2400, 240, 5), tB = ts(1200, 120);   // different frame rates and start times
  const A = jump({ penTD: 1000, TD: 1060, TO: 1090, land: 1300 }), B = jump({ penTD: 300, TD: 335, TO: 352, apex: 400, land: 470 });
  const pairs = anchorPairs(A, tA, B, tB);
  assert.deepEqual(pairs.map(p => p.id), ['penTD', 'TD', 'TO', 'land']);   // apex is not in A
  for (const p of pairs) assert.ok(Math.abs(mapTime(pairs, p.b) - p.a) < 1e-9, p.id);
  assert.equal(nearestFrame(tA, mapTime(pairs, tB[335] - tB[0])), 1060);    // B's board = A's board
  assert.ok(Math.abs(mapTime(pairs, -0.5) - (pairs[0].a - 0.5 - pairs[0].b)) < 1e-9);   // before: same pace
  const mid = mapTime(pairs, (pairs[1].b + pairs[2].b) / 2);
  assert.ok(Math.abs(mid - (pairs[1].a + pairs[2].a) / 2) < 1e-9);          // straight between
});

test('a moment out of order in one jump is left out, so time never runs backwards', () => {
  const A = jump({ penTD: 100, TD: 90, TO: 130 }), B = jump({ penTD: 100, TD: 120, TO: 130 });
  const pairs = anchorPairs(A, ts(300, 120), B, ts(300, 120));
  assert.deepEqual(pairs.map(p => p.id), ['penTD', 'TO']);
  assert.deepEqual(keyFramesOf(B), { penTD: 100, TD: 120, TO: 130 });
});

test('the change is said as what moved, toward the norm when it did', () => {
  const hip = { key: 'hipTO', unit: '°', norm: [200, 215], label: 'Vystretie bedra pri odraze' };
  assert.equal(changeText(hip, 192, 208).text, 'o 16° viac, do normy');
  assert.equal(changeText(hip, 192, 198).text, 'o 6° viac, bližšie k norme');
  assert.equal(changeText(hip, 205, 210).text, 'obe v norme');
  assert.equal(changeText(hip, 205, 205).text, 'rovnako');
  assert.equal(changeText(hip, 210, 222).good, false);
  const sp = { key: 'speedTO', unit: 'm/s', norm: [8.5, 9.8] };
  assert.equal(changeText(sp, 7.9, 8.1).text, 'o 0,20 m/s viac, bližšie k norme');
  // two athletes: their norms differ, so the change alone
  assert.deepEqual(changeText(hip, 192, 208, false), { text: 'o 16° viac', good: null });
});

test('rows: the phase measurements of both jumps, hidden ones as not measured', () => {
  const m = (key, value, status = 'ok') => ({ key, label: key, unit: '°', norm: [150, 170], value, status });
  const A = { phases: [{ id: 'toeoff', label: 'Odraz', score: 60, metrics: [m('kneeTO', 163), m('hipTO', 192)] }] };
  const B = { phases: [{ id: 'toeoff', label: 'Odraz', score: 82, metrics: [m('kneeTO', 157), m('hipTO', 0, 'hidden')] }] };
  const rows = rowsFor('toeoff', A, B);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].a, rows[0].b], [163, 157]);
  assert.equal(rows[1].b, null);
  assert.equal(rows[1].change, null);
  assert.match(headline(A, B), /na odraze \(\+22\)/);
});
