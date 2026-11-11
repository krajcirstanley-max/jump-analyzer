import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homography, applyH, invertH } from '../js/analysis/homography.js';
import { detectRunway, detectRunwayZoomed, zoomFor } from '../server/ground.mjs';
import { groundAnalysis } from '../js/analysis/ground.js';
import { J, JI } from '../js/pose/models.js';

test('homography maps four points exactly and inverts', () => {
  const src = [[100, 200], [80, 300], [600, 210], [590, 320]], dst = [[0, 0], [0, 1.22], [2, 0], [2, 1.22]];
  const h = homography(src, dst), hi = invertH(h);
  src.forEach((p, i) => { const q = applyH(h, p); assert.ok(Math.hypot(q[0] - dst[i][0], q[1] - dst[i][1]) < 1e-9); });
  const p = applyH(hi, applyH(h, [333, 250])); assert.ok(Math.hypot(p[0] - 333, p[1] - 250) < 1e-6);
});

// A drawn runway: red rubber, two white lines, cream sand on the left with a slanted edge,
// a white take-off unit with a darker foul strip, as on Stanley's indoor runway.
function runwayImage() {
  const W = 1080, H = 900, px = new Uint8Array(W * H * 4);
  const far = x => 400 + 0.01 * x, near = x => 470 + 0.015 * x;          // the runway lines
  const sandEdge = y => 300 - 1.2 * (y - 400);                            // x of the sand edge
  const white0 = y => 650 - 0.08 * (y - 400);                             // pit side of the white unit
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let c = [200, 120, 95];                                                // rubber
    const inBand = y > far(x) && y < near(x);
    if (x < sandEdge(y) && y > 330 && y < 650) c = [235, 230, 215];        // sand
    if (Math.abs(y - far(x)) < 2 || Math.abs(y - near(x)) < 2) { if (x > sandEdge(y)) c = [245, 245, 245]; }
    if (inBand) { const d = x - white0(y); if (d >= 0 && d < 90) c = d >= 14 && d < 30 ? [175, 180, 175] : [240, 240, 236]; }
    const o = (y * W + x) * 4; px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
  }
  const cross = (edge, line) => { let x = 300; for (let k = 0; k < 50; k++) x = edge(line(x)); return [x, line(x)]; };
  return { px, W, H, truth: { sand: [cross(sandEdge, far), cross(sandEdge, near)], white: [cross(white0, far), cross(white0, near)], takeoff: [cross(y => white0(y) + 30, far), cross(y => white0(y) + 30, near)] } };
}

test('finds the runway lines, the sand edge and the take-off line', () => {
  const { px, W, H, truth } = runwayImage();
  // athlete running left (towards the sand), planted foot between the sand and the board
  const d = detectRunway(px, W, H, { toe: [460, 440], ground: [470, 450], foot: [455, 500], dir: -1 });
  assert.ok(!d.error, d.error);
  for (const k of ['sand', 'white', 'takeoff']) d.corners[k].forEach((p, i) => {
    const e = Math.hypot(p[0] - truth[k][i][0], p[1] - truth[k][i][1]);
    assert.ok(e < 2, `${k}[${i}] off by ${e.toFixed(2)} px: ${p.map(v => v.toFixed(1))} vs ${truth[k][i].map(v => v.toFixed(1))}`);
  });
});

// IMG_4658: filmed across the hall, the athlete about 200 px tall. The same runway at half size
// is enlarged around the foot first and the answer mapped back to the frame's own pixels.
test('far camera: the board area is enlarged before the runway is looked for', () => {
  const big = runwayImage(), W = big.W / 2, H = big.H / 2, px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) {
    let v = 0; for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) v += big.px[((2 * y + dy) * big.W + 2 * x + dx) * 4 + c];
    px[(y * W + x) * 4 + c] = v / 4;
  }
  const opts = { toe: [230, 220], ground: [235, 225], foot: [227, 250], dir: -1 };
  assert.equal(zoomFor(400), 1);
  const s = zoomFor(190);
  assert.ok(s > 1.9 && s <= 4);
  const d = detectRunwayZoomed(px, W, H, opts, s);
  assert.ok(!d.error, d.error);
  for (const k of ['sand', 'takeoff']) d.corners[k].forEach((p, i) => {
    const t = big.truth[k][i].map(v => v / 2), e = Math.hypot(p[0] - t[0], p[1] - t[1]);
    assert.ok(e < 1.5, `${k}[${i}] off by ${e.toFixed(2)} px`);
  });
});

// A rigid stick figure gliding at a known speed past a camera that pans with it; the runway
// rectangle is drawn in the same image space, so the true answers are known.
test('ground metres: speeds, take-off point and jump from a known scene', () => {
  const K = J.length, FPS = 120, PX = 200, v = 8, N = 220, TD = 100, TO = 118, LAND = 190;
  const sandX = 18, lineX = sandX - 2;                    // world metres along the run (running +x)
  const camAt = i => (i * v) / FPS * PX - 540;
  const img = (i, x, h, y = 0) => [x * PX - camAt(i), 1200 - h * PX + 60 * y];
  const track = [], frames = {}, ts = [];
  const toeX = (TD * v) / FPS + 0.4 + 0.17;               // planted toe through the contact
  for (let i = 0; i < N; i++) {
    ts.push(i / FPS);
    const hx = (i * v) / FPS, f = new Float32Array(K * 3);
    const set = (n, x, h) => { const [X, Y] = img(i, x, h); f[JI[n] * 3] = X; f[JI[n] * 3 + 1] = Y; f[JI[n] * 3 + 2] = 1; };
    for (const s of ['l', 'r']) {
      const planted = s === 'r' && i >= TD && i <= TO;
      const fx = planted ? toeX - 0.17 : hx + 0.2;
      set(s + 'hip', hx, 0.95); set(s + 'knee', (hx + fx) / 2 + 0.05, 0.5); set(s + 'ank', fx, 0.08);
      set(s + 'heel', fx - 0.06, 0.02); set(s + 'bigtoe', fx + 0.17, 0); set(s + 'smalltoe', fx + 0.15, 0);
      set(s + 'sho', hx, 1.45); set(s + 'elb', hx, 1.2); set(s + 'wri', hx + 0.05, 1.0); set(s + 'ear', hx, 1.65);
    }
    set('nose', hx + 0.08, 1.63);
    track.push(f);
    frames[i] = [img(i, sandX, 0, 0), img(i, sandX, 0, 1.22), img(i, lineX, 0, 0), img(i, lineX, 0, 1.22)];
  }
  const ev = { takeoff: { td: TD, to: TO }, takeoffFoot: 'r', pen: { td: 70, to: 84, foot: 'l' }, landing: LAND };
  const g = groundAnalysis({ frames }, track, ev, ts, 'male', 185);
  assert.ok(!g.error, g.error);
  assert.equal(g.boardM, 2);
  assert.ok(Math.abs(g.vxTO - v) < 0.02, `vxTO ${g.vxTO}`);
  assert.ok(Math.abs(g.speedLast - v) < 0.1, `last ${g.speedLast}`);
  // distances from the sand: toe behind the line is positive
  assert.ok(Math.abs(g.toeToLine - (sandX - toeX - 2)) < 0.01, `toeToLine ${g.toeToLine}`);
  const heelLand = (LAND * v) / FPS + 0.2 - 0.06;          // the heel is the mark nearest the board
  // straight through the homography the synthetic scene is exact; the reported jump is Hay's
  // partition with the reach on the body's scale
  assert.ok(Math.abs(g.jumpDirect - (heelLand - toeX)) < 0.01, `direct ${g.jumpDirect} vs ${heelLand - toeX}`);
  assert.ok(Math.abs(g.jump - (heelLand - toeX)) < 0.1, `jump ${g.jump} vs ${heelLand - toeX}`);
  // the stick figure's take-off foot jumps forward in one frame at toe-off, which moves the
  // centre of mass ~7 cm at once; real clips gave 0.02-0.10 m
  assert.ok(g.partsGap < 0.1, `Hay partition gap ${g.partsGap}`);
  // the last contacts: timing straight from the frames
  const pen = g.steps.find(x => x.id === 'pen'), take = g.steps.find(x => x.id === 'take');
  assert.ok(pen && take, 'steps for the penultimate and the board');
  assert.equal(Math.round(pen.contactMs), 125);
  assert.equal(Math.round(pen.stepMs), 250);
  assert.ok(Math.abs(pen.freqHz - 4) < 1e-9);
  assert.ok(Math.abs(take.speed - g.vxTO) < 1e-9, 'the board column shows the take-off speed');
});

test('hand-held phone: the camera tracker recovers the shake over a textured background', async () => {
  const { trackCamera } = await import('../server/ground.mjs');
  const { applyH } = await import('../js/analysis/homography.js');
  // a smooth random texture bigger than the frame; each frame is a window into it
  const BW = 520, BH = 440, W = 360, H = 280, fps = 240, N = 240;
  let seed = 5; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const noise = Float32Array.from({ length: BW * BH }, () => rnd() * 255);
  const base = new Float32Array(BW * BH);
  for (let y = 2; y < BH - 2; y++) for (let x = 2; x < BW - 2; x++) { let s = 0; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) s += noise[(y + dy) * BW + x + dx]; base[y * BW + x] = s / 25; }
  const shift = i => [80 + 30 * Math.sin(2 * Math.PI * 2.3 * i / fps), 80 + 25 * Math.sin(2 * Math.PI * 3.1 * i / fps + 1)];
  const boxes = [];
  const frame = i => {
    const [ox, oy] = shift(i), out = new Uint8ClampedArray(W * H * 4);
    const bx = 150 + 20 * Math.sin(i / 9), box = [bx, 60, bx + 60, 250]; boxes[i] = box; // the athlete: moves on its own
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const X = x + ox, Y = y + oy, x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0;
      const v = (1 - fy) * ((1 - fx) * base[y0 * BW + x0] + fx * base[y0 * BW + x0 + 1]) + fy * ((1 - fx) * base[(y0 + 1) * BW + x0] + fx * base[(y0 + 1) * BW + x0 + 1]);
      const inA = x > box[0] + 8 && x < box[2] - 8 && y > box[1] + 8 && y < box[3] - 8;
      const o = (y * W + x) * 4; out[o] = out[o + 1] = out[o + 2] = inA ? 200 + 40 * Math.sin(x + i) : v; out[o + 3] = 255;
    }
    return out;
  };
  const frames = { W, H, fps, N, async *sequential(from, to) { for (let i = from; i <= to; i++) yield { i, rgba: frame(i) }; } };
  const cam = await trackCamera(frames, { from: 0, to: N - 1, boxes, rate: 60 });
  assert.ok(cam, 'no track');
  assert.equal(cam.step, 4);
  assert.ok(cam.tracked >= 0.95, `tracked ${cam.tracked}`);
  // a background point at p in frame 0 sits at p + shift(0) - shift(i) in frame i
  const err = Object.entries(cam.h).map(([i, h]) => { const p = [60, 200], q = applyH(h, p), s0 = shift(0), si = shift(+i); return [q[0] - (p[0] + s0[0] - si[0]), q[1] - (p[1] + s0[1] - si[1])]; });
  // What the contacts need: no jump from one tracked frame to the next (a jump reads as foot
  // speed), and a slow drift that stays far inside the 2 cm band (10-20 px on a real clip).
  const stepErr = Math.max(...err.slice(1).map((e, k) => Math.hypot(e[0] - err[k][0], e[1] - err[k][1])));
  const drift = Math.max(...err.map(e => Math.hypot(...e)));
  assert.ok(stepErr < 1, `step ${stepErr.toFixed(2)} px`);
  assert.ok(drift < 3, `drift ${drift.toFixed(2)} px`);
});

// The board found 10 cm off (2.1 m drawn where 2 m is assumed: every metre 5 % short, as on
// IMG_4677) and Freelap cones at 0.2 and 10.2 m: the cones fix the scale, and the 1-11 m time
// comes from the centre of mass passing 80 cm before each cone.
test('Freelap cones: they fix a 5 % board scale error and give the 1-11 m time', () => {
  const K = J.length, FPS = 120, PX = 200, v = 8, N = 300, TD = 180, TO = 198, LAND = 270;
  const toeX = (TD * v) / FPS + 0.57, lineX = toeX + 0.1, sandX = lineX + 2;
  const camAt = i => (i * v) / FPS * PX - 540;
  const img = (i, x, h, y = 0) => [x * PX - camAt(i), 1200 - h * PX + 60 * y];
  const track = [], frames = {}, cones = {}, ts = [];
  for (let i = 0; i < N; i++) {
    ts.push(i / FPS);
    const hx = (i * v) / FPS, f = new Float32Array(K * 3);
    const set = (n, x, h) => { const [X, Y] = img(i, x, h); f[JI[n] * 3] = X; f[JI[n] * 3 + 1] = Y; f[JI[n] * 3 + 2] = 1; };
    for (const s of ['l', 'r']) {
      const planted = s === 'r' && i >= TD && i <= TO;
      const fx = planted ? toeX - 0.17 : hx + 0.2;
      set(s + 'hip', hx, 0.95); set(s + 'knee', (hx + fx) / 2 + 0.05, 0.5); set(s + 'ank', fx, 0.08);
      set(s + 'heel', fx - 0.06, 0.02); set(s + 'bigtoe', fx + 0.17, 0); set(s + 'smalltoe', fx + 0.15, 0);
      set(s + 'sho', hx, 1.45); set(s + 'elb', hx, 1.2); set(s + 'wri', hx + 0.05, 1.0); set(s + 'ear', hx, 1.65);
    }
    set('nose', hx + 0.08, 1.63);
    track.push(f);
    frames[i] = [img(i, sandX, 0, 0), img(i, sandX, 0, 1.22), img(i, sandX - 2.1, 0, 0), img(i, sandX - 2.1, 0, 1.22)];
    const seen = [lineX - 0.2, lineX - 10.2].map(x => img(i, x, 0, -0.2)).filter(p => p[0] > 0 && p[0] < 1080);
    if (seen.length) cones[i] = seen;
  }
  const ev = { takeoff: { td: TD, to: TO }, takeoffFoot: 'r', pen: { td: 150, to: 164, foot: 'l' }, landing: LAND };
  const plain = groundAnalysis({ frames }, track, ev, ts, 'male', 185);
  assert.ok(Math.abs(plain.vxTO - v * 2 / 2.1) < 0.05, `without cones the board scale is 5 % short: ${plain.vxTO}`);
  const g = groundAnalysis({ frames, cones }, track, ev, ts, 'male', 185);
  assert.ok(!g.error, g.error);
  assert.ok(Math.abs(g.splits.coneScale - 1.05) < 0.005, `cone scale ${g.splits.coneScale}`);
  assert.ok(Math.abs(g.vxTO - v) < 0.05, `vxTO ${g.vxTO}`);
  assert.ok(Math.abs(g.speedLast - v) < 0.1, `last ${g.speedLast}`);
  const heelLand = (LAND * v) / FPS + 0.2 - 0.06;
  assert.ok(Math.abs(g.jumpDirect - (heelLand - toeX)) < 0.02, `direct ${g.jumpDirect} vs ${heelLand - toeX}`);
  assert.ok(Math.abs(g.splits.s1to11 - 10 / v) < 0.02, `1-11 m ${g.splits.s1to11}`);
  assert.equal(plain.splits.s1to11, null, 'no cones, no split');
});
