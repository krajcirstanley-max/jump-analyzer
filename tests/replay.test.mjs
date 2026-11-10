import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { J, JI } from '../js/pose/models.js';
import { hiddenFrames } from '../js/pose/occlusion.js';
import { labelLeg, jointAngles, placePills, jointLabels } from '../js/analysis/labels.js';
import { advance, bandLayout, headLength } from '../js/player.js';
import { detectContacts, keyFrames } from '../js/analysis/events.js';
import { measure } from '../js/analysis/metrics.js';

const pose = n => JSON.parse(readFileSync(new URL(`./fixtures/_real_${n}_pose.json`, import.meta.url)));
const scored = v => { const f = new Array(J.length * 3).fill(0); for (let j = 0; j < J.length; j++) f[j * 3 + 2] = v; return f; };
const ts = Array.from({ length: 600 }, (_, i) => i / 120);

test('occlusion: flags the pillar on IMG_4390 and nothing else', () => {
  assert.deepEqual([...hiddenFrames(pose('IMG_4390'))], Array.from({ length: 31 }, (_, i) => 241 + i));
});

test('occlusion: flags nothing on the clear outdoor clip', () => {
  assert.equal(hiddenFrames(pose('IMG_2674')).size, 0);
});

test('occlusion: a short dip is blur, not cover', () => {
  const fast = Array.from({ length: 100 }, (_, i) => scored(i === 40 || i === 41 ? 0.2 : 0.8));
  assert.equal(hiddenFrames({ fast }).size, 0);
});

test('occlusion: thresholds follow a dim clip', () => {
  const fast = Array.from({ length: 100 }, (_, i) => scored(i >= 40 && i < 50 ? 0.15 : 0.45));
  assert.deepEqual([...hiddenFrames({ fast })], [40, 41, 42, 43, 44, 45, 46, 47, 48, 49]);
});

test('occlusion: untracked frames are not flagged', () => {
  assert.equal(hiddenFrames({ fast: [null, null, scored(0.8)] }).size, 0);
  assert.equal(hiddenFrames({}).size, 0);
});

test('labels: stance leg in the penultimate contact, takeoff leg otherwise', () => {
  const jump = { pen: { td: 10, to: 20, foot: 'r' }, takeoff: { td: 30, to: 40 }, takeoffFoot: 'l' };
  assert.equal(labelLeg(jump, 15), 'r');
  assert.equal(labelLeg(jump, 20), 'r');
  assert.equal(labelLeg(jump, 21), 'l');
  assert.equal(labelLeg(jump, 35), 'l');
  assert.equal(labelLeg({ ...jump, pen: null }, 15), 'l');
});

// Upright athlete, side-on, leg straight down, trunk leaning `lean` px forward (x+).
function body({ lean = 0, kneeFwd = 0, hipW = 4 } = {}) {
  const f = new Array(J.length * 3).fill(0);
  const set = (n, x, y) => { const k = JI[n]; f[k * 3] = x; f[k * 3 + 1] = y; f[k * 3 + 2] = 1; };
  for (const s of ['l', 'r']) {
    const w = s === 'l' ? -hipW / 2 : hipW / 2;
    set(s + 'hip', 500 + w, 500); set(s + 'sho', 500 + w + lean, 200);
    set(s + 'knee', 500 + w + kneeFwd, 700); set(s + 'ank', 500 + w, 900);
  }
  return f;
}

test('labels: angles use the metrics conventions', () => {
  const a = jointAngles(body({ lean: 300 }), 'l', 1);
  assert.ok(Math.abs(a.knee - 180) < 0.01);
  assert.ok(Math.abs(a.lean - 45) < 0.01, 'forward lean is positive');
  assert.ok(Math.abs(jointAngles(body({ lean: 300 }), 'l', -1).lean + 45) < 0.01, 'same picture running left leans back');
  assert.ok(jointAngles(body({ kneeFwd: -100 }), 'l', 1).hip > 180, 'thigh behind the trunk line reads over 180');
  assert.ok(jointAngles(body({ kneeFwd: 100 }), 'l', 1).hip < 180);
  assert.equal(jointAngles(scored(0), 'l', 1), null);
});

test('labels: the numbers agree with the measured metrics at the key frames', () => {
  const r = pose('IMG_2674');
  const fps = 120;
  const c = detectContacts(r.clean, r.first, r.last, fps);
  const ev = keyFrames(r.clean, c, fps, 'male');
  const dir = c[0].dir;
  const by = Object.fromEntries(measure(r.smooth, ev, fps, 'male', dir).map(m => [m.key, m.value]));
  const s = ev.takeoffFoot;
  const td = jointAngles(r.smooth[ev.takeoff.td], s, dir), to = jointAngles(r.smooth[ev.takeoff.to], s, dir);
  assert.ok(Math.abs(td.knee - by.kneeTD) < 0.01);
  assert.ok(Math.abs(to.knee - by.kneeTO) < 0.01);
  assert.ok(Math.abs(to.hip - by.hipTO) < 0.01);
  assert.ok(Math.abs(td.lean - by.trunkTD) < 0.01);
  assert.ok(Math.abs(to.lean - by.trunkTO) < 0.01);
});

test('labels: pills stay apart and inside the canvas', () => {
  const pills = [
    { ax: 100, ay: 300, w: 120, h: 30, side: 1 }, { ax: 102, ay: 296, w: 120, h: 30, side: -1 }, { ax: 101, ay: 290, w: 120, h: 30, side: 1 },
  ];
  const out = placePills(pills, 400, 700, 10);
  for (let i = 0; i < out.length; i++) {
    assert.ok(out[i].x >= 0 && out[i].x + out[i].w <= 400 && out[i].y >= 0 && out[i].y + out[i].h <= 700);
    for (let j = 0; j < i; j++) {
      const a = out[i], b = out[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `pills ${i} and ${j} overlap`);
    }
  }
});

test('labels: a pill at the canvas edge is pulled inside', () => {
  const [p] = placePills([{ ax: 395, ay: 5, w: 100, h: 30, side: 1 }], 400, 700, 10);
  assert.ok(p.x + p.w <= 400 && p.y >= 0);
});

function fakeCtx() {
  const texts = [];
  return {
    texts, canvas: { width: 1170, height: 2080, clientWidth: 390 }, save() {}, restore() {}, beginPath() {}, roundRect() {}, fill() {}, stroke() {},
    measureText: t => ({ width: t.length * 18 }), fillText: t => texts.push(t),
  };
}

test('labels: only inside the replay, withheld off side-on and on covered frames', () => {
  const clear = body({ lean: 30 });
  const turned = body({ hipW: 300 }); // hips as wide as a square-on view
  const smooth = Array.from({ length: 30 }, (_, i) => (i === 12 ? turned : clear));
  const fast = Array.from({ length: 30 }, (_, i) => scored(i >= 20 && i < 25 ? 0.2 : 0.8));
  const jump = { replay: { from: 5, to: 25 }, takeoffFoot: 'l', pen: null, takeoff: { td: 8, to: 9 }, dir: 1 };
  const draw = jointLabels(jump, { smooth, fast }, 1);
  const at = i => { const c = fakeCtx(); draw(c, (x, y) => [x, y], i); return c.texts; };
  assert.equal(at(10).length, 3);
  assert.ok(at(10).some(t => t.startsWith('koleno')) && at(10).some(t => t.startsWith('bedro')) && at(10).some(t => t.startsWith('náklon')));
  assert.equal(at(4).length, 0, 'before the replay');
  assert.equal(at(26).length, 0, 'after the replay');
  assert.equal(at(12).length, 0, 'camera too far off side-on');
  assert.equal(at(22).length, 0, 'athlete covered');
});

test('labels: joints zoomed out of view get no pill', () => {
  const smooth = [body()], fast = [scored(0.8)];
  const draw = jointLabels({ replay: { from: 0, to: 0 }, takeoffFoot: 'l', pen: null, dir: 1 }, { smooth, fast }, 1);
  const c = fakeCtx();
  draw(c, (x, y) => [x, y - 650], 0); // only knee and ankle remain on screen
  assert.equal(c.texts.length, 1);
  assert.ok(c.texts[0].startsWith('koleno'));
});

test('clock: advances inside the range', () => {
  const s = advance(ts, ts[100], 2 / 120, 100, 200, true);
  assert.equal(s.i, 102);
  assert.equal(s.wrapped, false);
});

test('clock: the last frame gets its full time before the seam', () => {
  const s = advance(ts, ts[200], 0.5 / 120, 100, 200, true);
  assert.equal(s.i, 200);
  assert.equal(s.wrapped, false);
});

test('clock: never reports a frame past the range', () => {
  const s = advance(ts, ts[200], 0.4 / 120, 100, 200, true);
  assert.ok(s.i <= 200);
});

test('clock: a loop carries the overshoot across the seam', () => {
  const s = advance(ts, ts[200], 3 / 120, 100, 200, true);
  assert.equal(s.wrapped, true);
  assert.equal(s.i, 102);
  assert.ok(Math.abs(s.t - ts[102]) < 1e-9);
});

test('clock: without loop it ends on the last frame', () => {
  const s = advance(ts, ts[199], 5 / 120, 100, 200, false);
  assert.deepEqual([s.i, s.ended, s.wrapped], [200, true, false]);
});

test('clock: a one-frame range does not spin', () => {
  const s = advance(ts, ts[50], 1, 50, 50, true);
  assert.equal(s.i, 50);
});

test('bands: positioned in the range and clipped to it', () => {
  const out = bandLayout([
    { from: 0, to: 50, id: 'pen' }, { from: 100, to: 150, id: 'plant', on: true },
    { from: 180, to: 300, id: 'flight' }, { from: 400, to: 500, id: 'landing' },
  ], 100, 200);
  assert.deepEqual(out.map(b => b.id), ['plant', 'flight']);
  assert.deepEqual([out[0].left, out[0].width, out[0].on], [0, 51, true]);
  assert.deepEqual([out[1].left, out[1].width, out[1].on], [80, 20, false]);
});

test('head: ends on a keyframe when one is near', () => {
  assert.equal(headLength(ts, [0, 1, 2], 90, 300), 30); // keyframes every 120 frames
});

test('head: skips a keyframe too close to bridge a restart', () => {
  assert.equal(headLength(ts, [0, 1, 2], 110, 400), 130 > 128 ? 72 : 130);
  assert.equal(headLength(ts, [0, 1.5], 110, 400), 70);
});

test('head: falls back to a fixed length, never past the range', () => {
  assert.equal(headLength(ts, [0], 10, 300), 72);
  assert.equal(headLength(ts, [0], 10, 30), 21);
});
