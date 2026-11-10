// Runs the detector and every pose model on chosen frames of a clip, prints speed and
// keypoints, and writes an overlay image per model so placement can be checked by eye.
// Usage: node tools/bench_pose.mjs <clip> <outDir> <frame> [frame...]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { MODELS, DETECTOR, J, boxToCenterScale, poseInput, decodeSimcc, detectorInput, decodeDetections } from '../js/pose/models.js';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const [clip, outDir, ...frames] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// Display size after rotation (ffmpeg auto-rotates the frames it outputs).
function probeSize(file) {
  const q = e => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', e, '-of', 'csv=p=0', file]).toString();
  const [w, h] = q('stream=width,height').match(/\d+/g).map(Number);
  const rot = Number(q('stream_side_data=rotation').match(/-?\d+/)?.[0] ?? 0);
  return Math.abs(rot) === 90 ? [h, w] : [w, h];
}

function frameRGBA(file, n, W, H) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1',
    '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 1024 });
}

function drawDot(buf, W, H, x, y, r, [R, G, B]) {
  for (let yy = Math.round(y - r); yy <= y + r; yy++) for (let xx = Math.round(x - r); xx <= x + r; xx++) {
    if (xx < 0 || yy < 0 || xx >= W || yy >= H || (xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
    const p = (yy * W + xx) * 4; buf[p] = R; buf[p + 1] = G; buf[p + 2] = B;
  }
}

const [W, H] = probeSize(clip);
const det = await ort.InferenceSession.create(readFileSync(DETECTOR.file));
const sessions = {};
for (const [k, m] of Object.entries(MODELS)) sessions[k] = await ort.InferenceSession.create(readFileSync(m.file));

for (const f of frames.map(Number)) {
  const rgba = frameRGBA(clip, f, W, H);
  let t0 = performance.now();
  const di = detectorInput(rgba, W, H);
  const dr = await det.run({ input: new ort.Tensor('float32', di.tensor, [1, 3, DETECTOR.size, DETECTOR.size]) });
  const boxes = decodeDetections(dr.dets.data, dr.labels.data, dr.dets.dims[1], di.ratio, di.roi);
  const detMs = performance.now() - t0;
  boxes.sort((a, b) => (b[3] - b[1]) - (a[3] - a[1]));
  console.log(`frame ${f}: ${boxes.length} people, detect ${detMs.toFixed(0)} ms, tallest ${boxes[0] ? boxes[0].map(v => v.toFixed(0)).join(',') : '-'}`);
  if (!boxes.length) continue;
  for (const [k, m] of Object.entries(MODELS)) {
    const cs = boxToCenterScale(boxes[0], m.w, m.h);
    t0 = performance.now();
    const input = poseInput(rgba, W, H, cs, m.w, m.h);
    const r = await sessions[k].run({ input: new ort.Tensor('float32', input, [1, 3, m.h, m.w]) });
    const ms = performance.now() - t0;
    const [, K, Wx] = r.simcc_x.dims, Wy = r.simcc_y.dims[2];
    const kp = decodeSimcc(r.simcc_x.data, r.simcc_y.data, Wx, Wy, K, 0, cs, m.w, m.h, m.map);
    const feet = ['lheel', 'rheel', 'lbigtoe', 'rbigtoe'].map(n => kp[J.indexOf(n) * 3 + 2]);
    console.log(`  ${k.padEnd(11)} ${ms.toFixed(0).padStart(4)} ms  mean score ${(J.reduce((a, _, j) => a + kp[j * 3 + 2], 0) / J.length).toFixed(2)}  feet ${feet.map(s => s.toFixed(2)).join(' ')}  lank ${kp[13 * 3].toFixed(0)},${kp[13 * 3 + 1].toFixed(0)}`);
    const img = Buffer.from(rgba);
    for (let j = 0; j < J.length; j++) {
      const left = J[j].startsWith('l'), right = J[j].startsWith('r');
      drawDot(img, W, H, kp[j * 3], kp[j * 3 + 1], 7, left ? [40, 220, 255] : right ? [255, 120, 30] : [255, 255, 255]);
    }
    const [x1, y1, x2, y2] = boxes[0];
    const cx = Math.max(0, Math.round(x1 - 80)), cy = Math.max(0, Math.round(y1 - 80));
    const cw = Math.min(W - cx, Math.round(x2 - x1 + 160)) & ~1, ch = Math.min(H - cy, Math.round(y2 - y1 + 160)) & ~1;
    const raw = `${outDir}/f${f}_${k}.rgba`;
    writeFileSync(raw, img);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', raw,
      '-vf', `crop=${cw}:${ch}:${cx}:${cy},scale=-2:420`, '-frames:v', '1', `${outDir}/f${f}_${k}.jpg`]);
    execFileSync('rm', [raw]);
  }
}
