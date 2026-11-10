import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homography, applyH, invertH } from '../js/analysis/homography.js';
import { detectRunway } from '../server/ground.mjs';
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
