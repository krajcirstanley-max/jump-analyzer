// The overlay's timelines (js/hud.js, 2026-11-22): Freelap's clock hits each split at its cone, the
// board panel comes at the take-off, the jump panel shows the tape when typed and the estimate (marked)
// when not, and a gallery sprint runs its clock from the release.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { warp, rozbehTimeline, jumpTimeline, sprintTimeline, marksTimeline, hudOverlay } from '../js/hud.js';
import { fromWire } from '../js/cloud.js';
import { rozbehNumbers, fiveFromMarks } from '../js/rozbeh-view.js';

test('warp: the Freelap clock between the gates', () => {
  const k = [[7, 0], [8.2, 1.08], [8.8, 1.6], [9.4, 2.13]];
  assert.equal(warp(k, 6.9), null);
  assert.equal(warp(k, 7), 0);
  assert.ok(Math.abs(warp(k, 8.2) - 1.08) < 1e-12);
  assert.ok(Math.abs(warp(k, 7.6) - 0.54) < 1e-12);
  assert.equal(warp(k, 12), 2.13);
});

test('rozbeh timeline: rows fill at the gates, flags at the cones, the board panel at the take-off', () => {
  const legs = [1.08, 1.05], marks = { 21: 7.0, 11: 8.17, 6: 8.74, 1: 9.31 };
  const pieces = fiveFromMarks(legs, marks);
  const gates = [{ mark: 11, at: [[8.16, 400, 900], [8.17, 402, 900], [8.18, 404, 900]] }];
  const tl = rozbehTimeline({ legs, pieces, marks, tdT: 9.4, contact: 0.104, verdict: 'drží rýchlosť do dosky', name: 'Stanley', bestV: null, gates });
  const before = tl(6.5);
  assert.equal(before.freelap.clock, '0,00');
  assert.deepEqual(before.freelap.rows.map(r => r.state), ['dim', 'dim', 'dim']);
  const mid = tl(7.5);
  assert.deepEqual(mid.freelap.rows.map(r => r.state), ['now', 'dim', 'dim']);
  const at11 = tl(8.17);
  assert.equal(at11.freelap.clock, '1,08');
  assert.equal(at11.freelap.rows[0].value, '1,08 s · 9,26');
  assert.equal(at11.flags.length, 1);
  assert.equal(at11.flags[0].label, '11 m');
  assert.equal(tl(8.6).flags.length, 0);
  const end = tl(9.5);
  assert.equal(end.freelap.clock, '2,13');
  assert.equal(end.hud.left.v, '1,05');
  assert.equal(end.hud.right.v, '0,10');
  assert.equal(end.hud.top, 'drží rýchlosť do dosky');
  assert.equal(end.strip, null);
});

test('rozbeh timeline without Freelap: no panel, the board panel still comes', () => {
  const tl = rozbehTimeline({ legs: null, pieces: [], marks: {}, tdT: 2, contact: 0.11, verdict: '', name: '', gates: [] });
  assert.equal(tl(1).freelap, null);
  assert.equal(tl(2.1).hud.right.v, '0,11');
});

test('jump timeline: the tape when typed, the estimate marked when not, from toe-off to 2.5 s after landing', () => {
  const base = { toT: 5, landT: 5.7, split: 1.1, approach: 9.09, contact: 0.142, angle: 19.8, height: 41.3, est: 6.69, flight: 0.725, name: 'Stanley' };
  const est = jumpTimeline({ ...base, tape: null });
  assert.equal(est(4.9).hud, null);
  assert.equal(est(5.2).hud.ring.v, '≈6,69');
  assert.match(est(5.2).hud.ring.u, /odhad/);
  assert.equal(est(8.3).hud, null);
  assert.equal(est(5.2).freelap.rows[0].value, '1,10 s · 9,09');
  const tape = jumpTimeline({ ...base, tape: 6.85 });
  assert.equal(tape(5.2).hud.ring.v, '6,85');
  assert.match(tape(5.2).hud.ring.u, /pásmo/);
  assert.equal(tape(5.2).hud.top, 'uhol 19,8° · výška 41 cm');
});

test('sprint timeline: a seen start runs the clock, a fly shows the times still', () => {
  const acc = sprintTimeline({ legs: [1.9, 1.1, 1.0], zero: 2, name: 'Miška' });
  assert.equal(acc(1).freelap.clock, '0,00');
  assert.deepEqual(acc(3).freelap.rows.map(r => r.state), ['now', 'dim', 'dim']);
  assert.equal(acc(4.5).freelap.rows[1].state, 'now');
  assert.equal(acc(9).freelap.clock, '4,00');
  const fly = sprintTimeline({ legs: [0.95, 0.94], zero: null });
  assert.equal(fly(0).freelap.clock, '1,89');
  assert.ok(fly(0).freelap.rows.every(r => r.state === 'done'));
});

test('RSI marks as a timeline', () => {
  const tl = marksTimeline([{ from: 1, to: 2, hud: { top: 'Odraz', left: { cap: 'výška', v: '40', u: 'cm' }, right: null, ring: { v: '2,1', u: 'RSI', fill: 1 } } }]);
  assert.equal(tl(0.5).hud, null);
  assert.equal(tl(1.5).hud.ring.v, '2,1');
});

// The player calls an overlay with toCanvas(x, y); the panel was never drawn while hud.js passed [x, y]
// (2026-11-22). A canvas stub records whether anything was filled inside the frame.
test('hudOverlay draws with the player\'s toCanvas(x, y)', () => {
  const calls = [];
  const ctx = new Proxy({ canvas: { width: 400, height: 700 } }, { get: (o, k) => k in o ? o[k] : (...a) => { calls.push(k); return { width: 10 }; }, set: (o, k, v) => { o[k] = v; return true; } });
  const tl = jumpTimeline({ toT: 0.5, landT: 1.2, tape: 6.85, est: 6.6, name: 'Stanley' });
  const hit = { ring: null };
  hudOverlay(tl, { ts: [0, 0.5, 1] }, { W: 720, H: 1280 }, hit)(ctx, (x, y) => [x * 0.5, y * 0.5], 2);
  assert.ok(calls.includes('fillText'), 'nothing drawn');
  assert.ok(hit.ring && hit.ring.w > 0, 'no ring box for the tap');
});

// On a real run-up (gitignored answer): the clock reads Freelap's split exactly at each mark.
const R = new URL('./real/rb21/IMG_5155.json', import.meta.url);
test('rozbeh timeline on IMG_5155: Freelap 1.08 / 1.05 at the cones', { skip: !existsSync(R) }, () => {
  const n = rozbehNumbers(fromWire(JSON.parse(readFileSync(R)).result), 'male', 186), legs = [1.08, 1.05];
  const tl = rozbehTimeline({ legs, pieces: fiveFromMarks(legs, n.marks), marks: n.overlay.marks, tdT: n.tdT, contact: n.take.contact, gates: n.overlay.gates });
  assert.equal(tl(n.overlay.marks[11]).freelap.clock, '1,08');
  assert.equal(tl(n.overlay.marks[1]).freelap.clock, '2,13');
  assert.ok(tl(n.overlay.marks[11] + 0.05).flags.some(f => f.label === '11 m'));
  assert.ok(tl(n.tdT + 0.01).hud);
});
