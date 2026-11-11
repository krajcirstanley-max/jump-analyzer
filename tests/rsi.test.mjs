import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { rsiAnalysis } from '../js/analysis/rsi.js';

// A front-view athlete, 1.80 m: hips, knees, ankles and feet in image pixels. feetY(i) gives the
// lowest point of each foot (larger y = lower). 900 px per metre.
function clip({ fps = 120, plan, single = false, noisePx = 0 }) {
  let seed = 3; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const PX = 900, floorY = 1700, K = J.length, frames = [], ts = [];
  const footAt = t => { // metres above the floor at time t, from the plan
    let t0 = 0;
    for (const p of plan) { if (t < t0 + p.s) return p.h(t - t0); t0 += p.s; }
    return plan.at(-1).h(plan.at(-1).s);
  };
  const dur = plan.reduce((a, p) => a + p.s, 0);
  for (let i = 0; i * (1 / fps) <= dur; i++) {
    const t = i / fps; ts.push(t);
    const h = footAt(t), f = new Float32Array(K * 3);
    const set = (n, x, y) => { f[JI[n] * 3] = x + noisePx * 2 * rnd(); f[JI[n] * 3 + 1] = y + noisePx * 2 * rnd(); f[JI[n] * 3 + 2] = 0.9; };
    for (const [s, x] of [['l', 500], ['r', 580]]) {
      const lift = single && s === 'l' ? 0.25 : 0;              // the free leg held up
      const fy = floorY - (h + lift) * PX;
      set(s + 'heel', x, fy - 5); set(s + 'bigtoe', x, fy); set(s + 'smalltoe', x + 10, fy);
      set(s + 'ank', x, fy - 0.08 * PX);
      set(s + 'knee', x, fy - 0.08 * PX - 0.442 * PX); set(s + 'hip', x, fy - 0.08 * PX - 0.884 * PX);
    }
    frames.push(f);
  }
  return { result: { fast: frames, accurate: frames.map(() => null) }, ts };
}
const stand = (s, h0 = 0) => ({ s, h: () => h0 });
const fall = (from, s) => ({ s, h: t => Math.max(0, from - (9.81 * t * t) / 2) });
const air = s => ({ s, h: t => Math.max(0, (9.81 / 2) * t * (s - t)) }); // up and down in s seconds

test('drop jump from a 40 cm box: contact, flight, height and RSI from the frames', () => {
  const tFall = Math.sqrt((2 * 0.4) / 9.81);                          // 0.286 s
  const { result, ts } = clip({ plan: [stand(0.6, 0.4), fall(0.4, tFall), stand(0.2), air(0.5), stand(0.8)] });
  const r = rsiAnalysis(result, ts, { sex: 'male', height: 180 });
  assert.ok(!r.error, r.error);
  assert.equal(r.kind, 'drop_jump', JSON.stringify({ events: r.events, pxM: r.pxM }));
  assert.equal(r.jumps.length, 1);
  const j = r.jumps[0];
  assert.ok(Math.abs(j.contactMs - 200) <= 2 * r.edgeMs, `contact ${j.contactMs}`);
  assert.ok(Math.abs(j.flightMs - 500) <= 2 * r.edgeMs, `flight ${j.flightMs}`);
  assert.ok(Math.abs(j.heightCm - 30.7) < 2, `height ${j.heightCm}`);
  assert.ok(Math.abs(r.boxEstCm - 40) < 3, `box ${r.boxEstCm}`);
});

test('repeated hops: every reactive contact is a jump', () => {
  const plan = [stand(0.6), air(0.4)];
  for (let k = 0; k < 5; k++) plan.push(stand(0.18), air(0.4));
  plan.push(stand(0.8));
  const { result, ts } = clip({ plan });
  const r = rsiAnalysis(result, ts, { sex: 'male', height: 180 });
  assert.equal(r.kind, 'repeated_hops');
  assert.equal(r.jumps.length, 5);
  r.jumps.forEach(j => assert.ok(Math.abs(j.contactMs - 180) <= 2 * r.edgeMs, `contact ${j.contactMs}`));
});

test('single-leg drop jump: the free foot never lands', () => {
  const tFall = Math.sqrt((2 * 0.3) / 9.81);
  const { result, ts } = clip({ single: true, plan: [stand(0.6, 0.3), fall(0.3, tFall), stand(0.25), air(0.4), stand(0.8)] });
  const r = rsiAnalysis(result, ts, { sex: 'male', height: 180 });
  assert.equal(r.kind, 'drop_jump_single');
  assert.equal(r.leg, 'r');
});

test('countermovement jump: height from flight, no RSI', () => {
  const { result, ts } = clip({ plan: [stand(1.0), air(0.55), stand(0.8)] });
  const r = rsiAnalysis(result, ts, { sex: 'male', height: 180 });
  assert.equal(r.kind, 'cmj');
  assert.equal(r.jumps.length, 0);
  assert.ok(Math.abs(r.standing[0].heightCm - 37.1) < 2, `height ${r.standing[0]?.heightCm}`);
});

test('pose jitter of ±3 px (about 3 mm) moves the edges by at most a frame', () => {
  for (const fps of [120, 240]) {
    const tFall = Math.sqrt((2 * 0.4) / 9.81);
    const { result, ts } = clip({ fps, noisePx: 3, plan: [stand(0.6, 0.4), fall(0.4, tFall), stand(0.2), air(0.5), stand(0.8)] });
    const r = rsiAnalysis(result, ts, { sex: 'male', height: 180 });
    assert.equal(r.kind, 'drop_jump', `${fps} fps`);
    const j = r.jumps[0];
    assert.ok(Math.abs(j.contactMs - 200) <= 2 * r.edgeMs + 1e-9, `${fps} fps contact ${j.contactMs}`);
    assert.ok(Math.abs(j.flightMs - 500) <= 2 * r.edgeMs + 1e-9, `${fps} fps flight ${j.flightMs}`);
  }
});

// A hand-held phone: the whole image shakes (pan, tilt and a little roll, 2-4 Hz, up to ~40 px)
// while the athlete jumps. The camera tracker's H (reference -> frame) undoes it.
function shake(i, fps) {
  const t = i / fps, a = 0.012 * Math.sin(2 * Math.PI * 1.7 * t);       // roll, rad
  const tx = 30 * Math.sin(2 * Math.PI * 2.3 * t), ty = 25 * Math.sin(2 * Math.PI * 3.1 * t + 1);
  const c = Math.cos(a), s = Math.sin(a), cx = 540, cy = 960;
  return [c, -s, cx - c * cx + s * cy + tx, s, c, cy - s * cx - c * cy + ty, 0, 0, 1];
}
function shaken(result, ts) {
  const fps = (ts.length - 1) / (ts.at(-1) - ts[0]), h = {};
  const fast = result.fast.map((kp, i) => {
    const H = shake(i, fps); h[i] = H;
    const m = Float32Array.from(kp);
    for (let j = 0; j < m.length; j += 3) if (m[j + 2] > 0) { const x = m[j], y = m[j + 1]; m[j] = H[0] * x + H[1] * y + H[2]; m[j + 1] = H[3] * x + H[4] * y + H[5]; }
    return m;
  });
  return { result: { fast, accurate: fast.map(() => null) }, cam: { h } };
}

test('hand-held phone: with the camera motion taken out the drop jump reads the same', () => {
  const tFall = Math.sqrt((2 * 0.4) / 9.81);
  for (const fps of [120, 240]) {
    const { result, ts } = clip({ fps, plan: [stand(0.6, 0.4), fall(0.4, tFall), stand(0.2), air(0.5), stand(0.8)] });
    const sh = shaken(result, ts);
    const raw = rsiAnalysis(sh.result, ts, { sex: 'male', height: 180 });
    const fixed = rsiAnalysis(sh.result, ts, { sex: 'male', height: 180, cam: sh.cam });
    // uncorrected, the shake hides or splits the contact
    assert.ok(raw.error || raw.jumps.length !== 1 || Math.abs(raw.jumps[0].contactMs - 200) > 2 * raw.edgeMs, `${fps} fps: shake did not matter`);
    assert.equal(fixed.kind, 'drop_jump', `${fps} fps`);
    const j = fixed.jumps[0];
    assert.ok(Math.abs(j.contactMs - 200) <= 2 * fixed.edgeMs + 1e-9, `${fps} fps contact ${j.contactMs}`);
    assert.ok(Math.abs(j.flightMs - 500) <= 2 * fixed.edgeMs + 1e-9, `${fps} fps flight ${j.flightMs}`);
  }
});

test('hand-held phone, tracked every 4th frame: interpolated H is enough', () => {
  const { result, ts } = clip({ fps: 240, plan: [stand(0.5), ...Array(6).fill(0).flatMap(() => [air(0.4), stand(0.18)]), stand(0.5)] });
  const sh = shaken(result, ts);
  const sparse = { h: Object.fromEntries(Object.entries(sh.cam.h).filter(([i]) => i % 4 === 0)) };
  const r = rsiAnalysis(sh.result, ts, { sex: 'male', height: 180, cam: sparse });
  assert.equal(r.jumps.length, 5, JSON.stringify(r.events));
  r.jumps.forEach(j => assert.ok(Math.abs(j.contactMs - 180) <= 2 * r.edgeMs + 1e-9, `contact ${j.contactMs}`));
});
