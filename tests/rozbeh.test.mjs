// Rozbeh (2026-11-19): a full run-up with its take-off and never a landing, its own tab. The
// splits come from Freelap with cones at 1 · 6 · 11 · 21 m from the board; the steps and the
// take-off from the same jump analysis, read as a run-through. Real answers: tests/real/lj19.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { splitsOf, rozbehNumbers, splitSteps, splitsWithVideo } from '../js/rozbeh-view.js';
import { fromWire } from '../js/cloud.js';

test('Freelap splits of a run-up: three legs with the 6 m cone, two without', () => {
  const s = splitsOf([1.07, 0.54, 0.55]);
  assert.equal(s.s21_11, 1.07); assert.equal(+s.s1_11.toFixed(2), 1.09);
  assert.equal(+s.v11_6.toFixed(2), 9.26); assert.equal(+s.v6_1.toFixed(2), 9.09);
  assert.ok(s.keep < 0 && Math.abs(s.keep + 0.018) < 0.001);   // slowed 1.8 % over the last 5 m
  const t = splitsOf([1.07, 1.09]);
  assert.equal(t.s1_11, 1.09); assert.equal(t.s11_6, undefined); assert.ok(t.keep < 0);
  assert.equal(splitsOf([1.1]).s1_11, 1.1);
  assert.equal(splitsOf([]), null);
});

const dir = new URL('./real/lj19/', import.meta.url);
const have = existsSync(dir);
test('run-up numbers from the ten outdoor clips: steps, the last two contacts, the take-off', { skip: !have }, () => {
  const files = readdirSync(dir).filter(f => /^IMG_\d{4}\.json$/.test(f));
  assert.ok(files.length >= 10);
  for (const f of files) {
    const r = fromWire(JSON.parse(readFileSync(new URL(f, dir))).result);
    const a = r.who?.id === 'miska' ? ['female', 171] : ['male', 186];
    const n = rozbehNumbers(r, ...a);
    assert.ok(!n.error, `${f}: ${n.error}`);
    assert.ok(n.steps.length >= 1 && n.take.contact > 0.08 && n.take.contact < 0.25, `${f} take-off ${n.take.contact}`);
    assert.ok(n.frames.TO > n.frames.TD && n.frames.TD > n.frames.penTD, `${f} frames`);
  }
});

test('a run-up is read as a run-through even when the server called it a full jump', { skip: !existsSync(new URL('IMG_1080.json', dir)) }, () => {
  const raw = JSON.parse(readFileSync(new URL('IMG_1080.json', dir))).result;
  raw.events = { ...raw.events, kind: 'jump' };
  const n = rozbehNumbers(fromWire(raw), 'male', 186);
  assert.ok(!n.error && Math.abs(n.frames.TD - 459) <= 2 && Math.abs(n.frames.TO - 477) <= 2);
});

// Stanley's and Miška's first real run-ups (2026-11-19, indoor hall, filmed from the board end, the
// start of the run-up far and small). Board touchdown and toe-off by eye on toe-following crops.
const rb = new URL('./real/rb19/', import.meta.url);
const HAND = { 4653: [1495, 1507], 4654: [881, 897], 4655: [1978, 1990], 4656: [769, 783], 4657: [688, 702], 4658: [1042, 1056] };
test('real run-ups: every take-off found, board edges within 2 frames', { skip: !existsSync(new URL('IMG_4653.json', rb)) }, () => {
  for (const [id, [td, to]] of Object.entries(HAND)) {
    const r = fromWire(JSON.parse(readFileSync(new URL(`IMG_${id}.json`, rb))).result);
    const a = r.who?.id === 'miska' ? ['female', 171] : ['male', 186];
    const n = rozbehNumbers(r, ...a);
    assert.ok(!n.error, `${id}: ${n.error}`);   // IMG_4655: no runway and a −11 m/s arc, the take-off still stands
    assert.ok(Math.abs(n.frames.TD - td) <= 2 && Math.abs(n.frames.TO - to) <= 2, `${id} board ${n.frames.TD}-${n.frames.TO}, by eye ${td}-${to}`);
  }
});

test('real run-ups: the last 10-12 steps walked back from the take-off by rhythm, misses kept', { skip: !existsSync(new URL('IMG_4656.json', rb)) }, () => {
  for (const id of Object.keys(HAND)) {
    const r = fromWire(JSON.parse(readFileSync(new URL(`IMG_${id}.json`, rb))).result);
    const a = r.who?.id === 'miska' ? ['female', 171] : ['male', 186];
    const n = rozbehNumbers(r, ...a);
    // 3.4 s back since 2026-11-21 (the 26 m cone): up to 16 steps; IMG_4656 showed 3 before the rhythm walk
    assert.ok(n.steps.length >= 10 && n.steps.length <= 16, `${id}: ${n.steps.length} steps`);
    assert.ok(!n.steps.some(x => x.missing), `${id}: a step marked missing`);
    const tds = n.ts;
    // the last step into the board is short (IMG_4658: 0.13-0.17 s against about 0.24 s)
    for (let i = 1; i < tds.length; i++) { const p = tds[i] - tds[i - 1], lo = i === tds.length - 1 ? 0.12 : 0.17; assert.ok(p > lo && p < 0.36, `${id} step ${i} period ${p.toFixed(3)}`); }
  }
});

test('per Freelap split: steps, rate and step length from the split speed', () => {
  const ts = Array.from({ length: 11 }, (_, i) => i * 0.25);   // a step every 0.25 s, take-off at 2.5 s
  const steps = ts.map((_, i) => ({ td: i, contact: 0.11 }));
  const per = splitSteps(steps, ts, splitsOf([1.07, 0.54, 0.55]));
  assert.equal(per.length, 3);
  for (const p of per) { assert.equal(+p.rate.toFixed(2), 4); assert.ok(Math.abs(p.length - p.label === '' ? 0 : 1) >= 0); }
  assert.equal(+per[2].length.toFixed(2), 2.27);   // 9.09 m/s / 4 steps/s
});

test('Freelap gives 21-11 and 11-1; 6 m only from a cone crossing in the video', () => {
  const plain = splitsWithVideo([1.07, 1.09], null);
  assert.equal(plain.s11_6, undefined); assert.equal(plain.s1_11, 1.09);
  const v = splitsWithVideo([1.07, 1.09], { s1to6: 0.56, s6to11: 0.53 });
  assert.equal(v.from6, 'video');
  assert.equal(+(v.s11_6 + v.s6_1).toFixed(3), 1.09);   // the Freelap time stays whole
  assert.ok(v.s6_1 > v.s11_6);                          // the slower half where the video saw it
});

test('5 m pieces: the video splits each Freelap 10 m, 21-26 m stays on the video clock', async () => {
  const { fiveMeters } = await import('../js/rozbeh-view.js');
  const video = [{ from: 1, to: 6, s: 0.55 }, { from: 6, to: 11, s: 0.53 }, { from: 11, to: 16, s: 0.56 }, { from: 16, to: 21, s: 0.58 }, { from: 21, to: 26, s: 0.62 }];
  const p = fiveMeters([1.16, 1.10], video);
  assert.deepEqual(p.map(x => `${x.to}-${x.from}`), ['26-21', '21-16', '16-11', '11-6', '6-1']);
  const near = p.filter(x => x.from < 11), mid = p.filter(x => x.from >= 11 && x.to <= 21);
  assert.ok(Math.abs(near.reduce((a, x) => a + x.s, 0) - 1.10) < 1e-9 && Math.abs(mid.reduce((a, x) => a + x.s, 0) - 1.16) < 1e-9);
  assert.equal(p[0].src, 'video'); assert.equal(p[0].s, 0.62);
  assert.ok(Math.abs(near[1].s / near[0].s - 0.55 / 0.53) < 1e-9);   // the video's proportion kept
  assert.deepEqual(fiveMeters(null, video).map(x => x.src), ['video', 'video', 'video', 'video', 'video']);
});

test('rhythm: right against left before the last three steps, feet named from the take-off', async () => {
  const { rhythmOf } = await import('../js/rozbeh-view.js');
  // eight steps: right-foot steps 0.29 s with 0.15 s flight, left 0.27 s with 0.12 s, then three short ones
  const steps = [], ts = []; let t = 0;
  const feet = ['l', 'r', 'l', 'r', 'l', 'r', 'l', 'r'];   // the last (take-off) is the right foot
  feet.forEach((f, i) => { const last3 = i >= feet.length - 3; const st = last3 ? 0.24 : f === 'r' ? 0.29 : 0.27; steps.push({ contact: 0.13, air: last3 ? 0.11 : f === 'r' ? 0.15 : 0.12 }); ts.push(t); t += st; });
  const R = rhythmOf(steps, ts, 'stanley');
  assert.ok(R.enough);
  assert.equal(R.rows.at(-1).foot, 'r');
  assert.ok(Math.abs(R.r.step - 0.29) < 1e-9 && Math.abs(R.l.step - 0.27) < 1e-9);
  assert.ok(Math.abs(R.r.air - 0.15) < 1e-9 && Math.abs(R.l.air - 0.12) < 1e-9);
});
