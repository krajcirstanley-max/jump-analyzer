import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkTracks, pickAthlete, predictBox, interpolateBoxes, boxFromKeypoints, bestMatch, searchRoi, iou } from '../js/pose/tracker.js';

const W = 1080, H = 1920;
// Athlete runs toward the camera: grows from 40 px to 900 px tall, centred.
// Two spectators stand still, small, off to the side.
function scene(frames) {
  return frames.map(f => {
    const t = f / 880, h = 40 + 860 * t * t, x = 540 + 60 * Math.sin(f / 50);
    return {
      frame: f,
      boxes: [
        [x - h * 0.2, 900 - h * 0.6, x + h * 0.2, 900 + h * 0.4, 0.9],
        [100, 880, 115, 920, 0.6],
        [950, 870, 968, 915, 0.5],
      ],
    };
  });
}

test('links detections into tracks and picks the jumper over spectators', () => {
  const samples = scene(Array.from({ length: 111 }, (_, i) => i * 8));
  const tracks = linkTracks(samples);
  const a = pickAthlete(tracks, W, H);
  assert.ok(a.points.length > 100, `athlete track has ${a.points.length} points`);
  assert.ok(a.points.at(-1).box[3] - a.points.at(-1).box[1] > 800);
});

test('picks the jumper even when he is detected only in the last third', () => {
  const samples = scene(Array.from({ length: 111 }, (_, i) => i * 8)).map(s =>
    s.frame < 600 ? { ...s, boxes: s.boxes.slice(1) } : s);
  const a = pickAthlete(linkTracks(samples), W, H);
  assert.ok(a.points[0].frame >= 600 && a.points.at(-1).box[3] - a.points.at(-1).box[1] > 800);
});

test('does not jump to a smaller bystander after losing the jumper in the sand (IMG_4594)', () => {
  const jumper = { 488: [426, 875, 625, 1205, 1], 496: [461, 997, 620, 1192, 1], 504: [442, 1037, 615, 1207, 1] };
  const bystander = f => [362 + (f - 528) * 4, 897 - (f - 528), 397 + (f - 528) * 4, 993 - (f - 528), 1];
  const samples = [];
  for (let f = 488; f <= 560; f += 8) samples.push({ frame: f, boxes: [jumper[f], f >= 528 ? bystander(f) : null].filter(Boolean) });
  const t = linkTracks(samples).find(tr => tr.points[0].frame === 488);
  assert.equal(t.points.at(-1).frame, 504);
});

test('constant-velocity prediction both ways', () => {
  const pts = [{ frame: 0, box: [0, 0, 10, 10] }, { frame: 8, box: [8, 0, 18, 10] }];
  assert.deepEqual(predictBox(pts, 16), [16, 0, 26, 10]);
  assert.deepEqual(predictBox(pts, -8), [-8, 0, 2, 10]);
});

test('interpolates a box for every frame', () => {
  const m = interpolateBoxes([{ frame: 0, box: [0, 0, 10, 10] }, { frame: 4, box: [4, 0, 14, 10] }], 0, 4);
  assert.equal(m.size, 5);
  assert.deepEqual(m.get(2), [2, 0, 12, 10]);
});

test('box from keypoints needs enough confident points', () => {
  const kp = new Float32Array(21 * 3);
  for (let j = 0; j < 21; j++) { kp[j * 3] = 100 + j; kp[j * 3 + 1] = 200 + j * 10; kp[j * 3 + 2] = j < 5 ? 0.1 : 0.9; }
  const b = boxFromKeypoints(kp, 0.3);
  assert.ok(b[0] < 105 && b[2] > 120 && b[1] < 250);
  assert.equal(boxFromKeypoints(kp, 0.95), null);
});

test('best match rejects a far-away person', () => {
  const pred = [500, 500, 600, 800];
  assert.deepEqual(bestMatch([[510, 505, 610, 805, 0.9], [100, 100, 120, 140, 0.9]], pred).slice(0, 4), [510, 505, 610, 805]);
  assert.equal(bestMatch([[100, 100, 120, 140, 0.9]], pred), null);
});

test('search window stays inside the frame and is not tiny', () => {
  const r = searchRoi([1070, 10, 1080, 30], W, H);
  assert.ok(r[0] >= 0 && r[1] >= 0 && r[0] + r[2] <= W && r[3] >= 160);
  assert.ok(iou([0, 0, 10, 10], [5, 0, 15, 10]) > 0.3);
});
