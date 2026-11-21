// Eight run-ups filmed from across the hall on 20 Nov 2026 (IMG_5151-5158, Stanley and Miška in turn,
// cones at 0.2, 10.2 and 20.2 m from the board, a flat disc at 5.2 m), with Freelap's 21-11 and 11-1 m
// times as Stanley wrote them down. The server answers are gitignored (tests/real/rb21).
// Checks: the take-off is the board contact with no Claude reading (two run-throughs and a sand step
// had fooled the rise rule), every cone and the disc are passed in the picture, the picture's share of
// the far 10 m against the near 10 m agrees with Freelap's, and the 5 m pieces add up to Freelap's 10 m.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fromWire } from '../js/cloud.js';
import { rozbehNumbers, fiveFromMarks, targetPlan, targetOptions, targetCard } from '../js/rozbeh-view.js';

const R = new URL('./real/rb21/', import.meta.url);
const WHO = { 5151: 'stanley', 5152: 'miska', 5153: 'stanley', 5154: 'miska', 5155: 'stanley', 5156: 'miska', 5157: 'stanley', 5158: 'miska' };
const FL = { 5152: [1.21, 1.20], 5153: [1.07, 1.05], 5154: [1.19, 1.17], 5155: [1.08, 1.05], 5156: [1.21, 1.20], 5157: [1.12, 1.08], 5158: [1.21, 1.19] };
// the board contact's touchdown read blind on foot crops (2026-11-21; 5155 and 5157 by eye frame by frame,
// the blind crop had lost the foot there). The app: 928 1111 1216 834 1176 779 1100 1695.
const BOARD = { 5151: 927, 5152: 1109, 5153: 1216, 5154: 833, 5155: 1174, 5156: 779, 5157: 1099, 5158: 1694 };
const have = Object.keys(WHO).every(id => existsSync(new URL(`IMG_${id}.json`, R)));
const nums = id => { const r = fromWire(JSON.parse(readFileSync(new URL(`IMG_${id}.json`, R))).result), m = WHO[id] === 'miska'; return rozbehNumbers(r, m ? 'female' : 'male', m ? 171 : 186); };

test('run-ups across the hall: board contact, every cone passed, shares agree with Freelap', { skip: !have }, () => {
  const off = [];
  for (const id of Object.keys(WHO)) {
    const n = nums(id);
    assert.ok(!n.error, `${id} ${n.error}`);
    assert.ok(Math.abs(n.frames.TD - BOARD[id]) <= 3, `${id} take-off ${n.frames.TD}, board ${BOARD[id]}`);
    for (const m of [1, 6, 11, 21]) assert.ok(Number.isFinite(n.marks?.[m]), `${id} mark ${m} missing`);
    if (!FL[id]) continue;
    const [far, near] = FL[id], v = n.marks;
    // the picture stretches both 10 m evenly (about 8 %), so only their ratio is compared
    off.push(((v[11] - v[21]) / (v[1] - v[11])) / (far / near) - 1);
    const p = fiveFromMarks(FL[id], v);
    assert.deepEqual(p.map(x => `${x.to}-${x.from}`), ['21-11', '11-6', '6-1'], `${id} pieces`);
    assert.ok(Math.abs(p[1].s + p[2].s - near) < 0.002, `${id} halves sum`);
    assert.ok(p[1].s / near > 0.45 && p[1].s / near < 0.55, `${id} 11-6 share ${p[1].s / near}`);
  }
  // 2026-11-21: +0.0 to +3.1 %, mean +1.5 % (Freelap's 0.01 s rounding alone is about ±0.8 %)
  const mean = off.reduce((a, b) => a + b, 0) / off.length;
  assert.ok(off.every(x => Math.abs(x) < 0.04), `ratio off ${off.map(x => (x * 100).toFixed(1)).join(' ')}`);
  assert.ok(Math.abs(mean) < 0.025, `mean ${mean}`);
});

test('fiveFromMarks: no Freelap, no pieces; a missing 11 m mark splits by the 1-21 m share', () => {
  assert.deepEqual(fiveFromMarks(null, { 1: 10, 6: 9.4, 21: 7.7 }), []);
  const p = fiveFromMarks([1.1, 1.0], { 1: 10, 6: 9.45, 21: 7.7 });   // picture 2.30 s for Freelap's 2.10
  const k = 2.1 / 2.3;
  assert.equal(p.length, 3);
  assert.ok(Math.abs(p.find(x => x.from === 1).s - 0.55 * k) < 0.002);
  assert.ok(Math.abs(p.find(x => x.from === 6).s - (1.0 - 0.55 * k)) < 0.002);
  assert.equal(p.find(x => x.from === 11).s, 1.1);
});

// Every step the Rozbeh shows on those eight, read blind (rozbeh-blind.json: clip -> [index, TD, TO],
// the index counted over the steps shown, "a/b" either frame, "<f"/">f" outside the frames, "?").
test('blind hand reads: every run-up step across the hall', { skip: !have }, () => {
  const H = JSON.parse(readFileSync(new URL('./rozbeh-blind.json', import.meta.url)));
  const parse = v => (!v || v === '?' || v[0] === '<' || v[0] === '>' ? null : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(v.split('/').map(Number)));
  const E = { td: [], to: [] };
  for (const [clip, rows] of Object.entries(H)) {
    const n = nums(clip.slice(4)), r = fromWire(JSON.parse(readFileSync(new URL(`${clip}.json`, R))).result);
    const S = n.steps.filter(s => !s.missing).map(s => ({ td: s.td, to: Math.round(s.td + s.contact * r.fps - 1) }));
    for (const [k, tdS, toS] of rows) for (const [key, v] of [['td', tdS], ['to', toS]]) {
      const w = parse(v), a = S[k]?.[key]; if (!w || a == null) continue;
      E[key].push(a < w.lo ? a - w.lo : a > w.hi ? a - w.hi : 0);
    }
  }
  const within = (a, f) => a.filter(x => Math.abs(x) <= f).length / a.length;
  // 2026-11-21, truth = first blind read, a second blind reader on every disputed or unreadable edge
  // (agreeing within a frame, else the edge left out), the two board contacts by eye frame by frame.
  // Pose edges alone: TD 86 %, TO 75 % within a frame. With the sprint pass's edges (withMotion):
  // TD 95/109, TO 93/109 within a frame, 105 and 103 within two.
  assert.ok(within(E.td, 1) >= 0.84 && within(E.td, 2) >= 0.93, `TD ${within(E.td, 1)} / ${within(E.td, 2)}`);
  assert.ok(within(E.to, 1) >= 0.82 && within(E.to, 2) >= 0.92, `TO ${within(E.to, 1)} / ${within(E.to, 2)}`);
});

// The target card (2026-11-21): the athlete's own 21-11 / 11-6 / 6-1 shape scaled to the chosen 11-1 m
// time, the last 10 m held where the run dips by 1 % or more, the 21-11 m gain split 70 % rate.
test('target plan: options, shape kept, times add up, steps from the 21-11 m zone', () => {
  assert.deepEqual(targetOptions(1.05), [1.03, 1, 0.98]);
  assert.deepEqual(targetOptions(1.17), [1.15, 1.12, 1.09]);
  const marks = { 1: 10, 6: 9.475, 11: 8.95, 21: 7.87 };            // 1.08 s / 1.05 s legs, an even split at 6 m
  const ts = [], steps = []; for (let t = 7.6; t < 10.05; t += 0.24) { ts.push(t); steps.push({ contact: 0.12, air: 0.12, td: 0, missing: false }); }
  const P = targetPlan([1.08, 1.05], marks, steps, ts, 0.98);
  assert.ok(Math.abs(P.t21 - 1.08 * 0.98 / 1.05) < 1e-9);
  assert.ok(Math.abs(P.tgt[0].v / P.now[0].v - 1.05 / 0.98) < 1e-9);
  assert.ok(Math.abs(P.rate0 - 1 / 0.24) < 0.01 && P.rate1 > P.rate0 && P.len1 > P.len0);
  assert.ok(Math.abs(P.rate1 * P.len1 - P.v1) < 1e-9);
  assert.ok(P.ct1 < P.ct0);
  assert.equal(targetPlan(null, marks, steps, ts, 0.98), null);
  assert.match(targetCard([1.08, 1.05], null, steps, ts, 0.98), /kužeľ pri doske/);
  assert.match(targetCard(null, marks, steps, ts, 0.98), /časy z Freelapu/);
});

test('target plan on the run-ups across the hall: every one with Freelap gets a curve and steps', { skip: !have }, () => {
  for (const id of Object.keys(FL)) {
    const n = nums(id), [far, near] = FL[id], P = targetPlan(FL[id], n.marks, n.steps, n.ts, targetOptions(near)[2]);
    assert.ok(P, `${id} no plan`);
    assert.ok(P.rate0 > 3.4 && P.rate0 < 4.8, `${id} rate ${P.rate0}`);
    assert.ok(P.len0 > 1.9 && P.len0 < 2.5, `${id} step ${P.len0}`);
    assert.ok(Math.abs(P.t21 / P.target - far / near) < 1e-9, `${id} shape`);
  }
});

test('target shapes: own ratio, the 8 m group 0.97, a faster build-up 0.99, the last 10 m flat', () => {
  const marks = { 1: 10, 6: 9.475, 11: 8.95, 21: 7.87 };
  const ts = [], steps = []; for (let t = 7.6; t < 10.05; t += 0.24) { ts.push(t); steps.push({ contact: 0.12, air: 0.12, td: 0, missing: false }); }
  const own = targetPlan([1.08, 1.05], marks, steps, ts, 0.98, 'own');
  const elite = targetPlan([1.08, 1.05], marks, steps, ts, 0.98, 'elite');
  const fast = targetPlan([1.08, 1.05], marks, steps, ts, 0.98, 'fast');
  assert.ok(Math.abs(own.t21 - 1.08 * 0.98 / 1.05) < 1e-9);
  assert.ok(Math.abs(elite.t21 - 0.98 / 0.97) < 1e-9 && Math.abs(fast.t21 - 0.98 / 0.99) < 1e-9);
  for (const P of [elite, fast]) assert.ok(Math.abs(P.tgt[1].v - 10 / 0.98) < 1e-9 && Math.abs(P.tgt[2].v - 10 / 0.98) < 1e-9);
  assert.ok(fast.rate1 > elite.rate1 && fast.ct1 < elite.ct1);
  assert.match(targetCard([1.08, 1.05], marks, steps, ts, 0.98, 'x', 'fast'), /Zhou a Kang/);
});

// The board contact (boardContact, 2026-11-22) against the blind reads of the board step: the pose alone
// was 0.02 s short on average (up to 25 ms); now within 13 ms, 8 ms on average.
const HAND_BOARD = { 5151: 0.146, 5152: 0.129, 5153: 0.142, 5154: 0.125, 5155: 0.104, 5156: 0.129, 5157: 0.104, 5158: 0.129 };
test('board contact of the run-ups across the hall within 1.5 frames of the hand reads', { skip: !have }, () => {
  const err = Object.keys(HAND_BOARD).map(id => nums(id).take.contact - HAND_BOARD[id]);
  assert.ok(err.every(e => Math.abs(e) <= 0.014), err.map(e => Math.round(e * 1000)).join(' '));
  assert.ok(err.reduce((a, e) => a + Math.abs(e), 0) / err.length <= 0.01);
});
