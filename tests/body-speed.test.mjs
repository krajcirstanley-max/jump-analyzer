// The penultimate-step speed on the body's own scale (flight.js lastStepByBody, 2026-11-25).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastStepByBody } from '../js/analysis/flight.js';
import { JI } from '../js/pose/models.js';

// A side-on jumper running right at v m/s, H cm tall, drawn at pxPerM: the whole body slides while the
// left foot stands on the runway (toe and heel fixed), as on a phone that may pan (only differences count).
function track({ v = 9, H = 186, pxPerM = 150, fps = 120, n = 40, pan = 0 } = {}) {
  const h = H / 100, torso = 0.288 * h, thigh = 0.245 * h, shank = 0.246 * h;
  const out = [], ts = [];
  for (let i = 0; i < n; i++) {
    const t = i / fps, cam = pan * t, x = v * t - cam;           // metres, in the picture
    const kp = new Float32Array(Object.keys(JI).length * 3).fill(NaN);
    const put = (name, mx, my) => { const j = JI[name]; kp[j * 3] = 500 + mx * pxPerM; kp[j * 3 + 1] = 1500 - my * pxPerM; kp[j * 3 + 2] = 0.9; };
    const hipY = shank + thigh + 0.05;
    for (const s of ['l', 'r']) {
      put(s + 'sho', x, hipY + torso); put(s + 'hip', x, hipY); put(s + 'knee', x, hipY - thigh); put(s + 'ank', x, 0.05);
      put(s + 'ear', x, hipY + torso + 0.2);
    }
    put('nose', x + 0.1, hipY + torso + 0.2);
    // the planted foot stays where it touched down (picture moves with the camera)
    put('lbigtoe', 0.15 - cam, 0); put('lheel', -0.1 - cam, 0);
    put('rbigtoe', x + 0.15, 0.3); put('rheel', x - 0.1, 0.3);
    out.push(kp); ts.push(t);
  }
  return { out, ts };
}
const ev = { pen: { foot: 'l', td: 5, to: 20 } };

// The centre of mass moves ~1.4 % slower than the body here: the planted foot (1.4 % of the mass,
// de Leva) stands still. That is the real centre of mass, so 2 % is allowed.
test('the body scale gives the speed it was drawn at', () => {
  const { out, ts } = track({ v: 9.2 });
  const r = lastStepByBody(out, ev, ts, 'male', 1, 186);
  assert.ok(Math.abs(r.v / 9.2 - 1) < 0.02, `read ${r.v}`);
  assert.equal(r.from, 'toe');
});

test('a phone that follows the jumper changes nothing', () => {
  const { out, ts } = track({ v: 8.1, H: 171, pan: 7.5 });
  const r = lastStepByBody(out, ev, ts, 'female', 1, 171);
  assert.ok(Math.abs(r.v / 8.1 - 1) < 0.02, `read ${r.v}`);
});

test('too small a body, or no height, gives no speed', () => {
  const { out, ts } = track({ pxPerM: 60 });
  assert.equal(lastStepByBody(out, ev, ts, 'male', 1, 186).why, 'small');
  const t2 = track();
  assert.equal(lastStepByBody(t2.out, ev, t2.ts, 'male', 1, null).why, 'height');
});
