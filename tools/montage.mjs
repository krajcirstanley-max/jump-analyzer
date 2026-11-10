// Contact sheet of pipeline results: crop around the tracked athlete with skeleton drawn.
// Usage: node tools/montage.mjs <clip> <result.json> <out.jpg> <every> [fast|accurate]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { J, JI } from '../js/pose/models.js';

const [clip, resFile, out, every = '40', which = 'best', from, to] = process.argv.slice(2);
const res = JSON.parse(readFileSync(resFile, 'utf8'));
const { W, H } = res;
const BONES = [['lsho', 'rsho'], ['lsho', 'lelb'], ['lelb', 'lwri'], ['rsho', 'relb'], ['relb', 'rwri'], ['lsho', 'lhip'], ['rsho', 'rhip'],
  ['lhip', 'rhip'], ['lhip', 'lknee'], ['lknee', 'lank'], ['rhip', 'rknee'], ['rknee', 'rank'], ['lank', 'lheel'], ['lheel', 'lbigtoe'],
  ['lank', 'lbigtoe'], ['rank', 'rheel'], ['rheel', 'rbigtoe'], ['rank', 'rbigtoe']];
const dir = mkdtempSync(`${tmpdir()}/mont`);
const T = 240;
const tiles = [];

function dot(b, w, h, x, y, r, c) {
  for (let yy = Math.round(y - r); yy <= y + r; yy++) for (let xx = Math.round(x - r); xx <= x + r; xx++)
    if (xx >= 0 && yy >= 0 && xx < w && yy < h && (xx - x) ** 2 + (yy - y) ** 2 <= r * r) { const p = (yy * w + xx) * 4; b[p] = c[0]; b[p + 1] = c[1]; b[p + 2] = c[2]; }
}
function line(b, w, h, x0, y0, x1, y1, r, c) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, r));
  for (let k = 0; k <= n; k++) dot(b, w, h, x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, r, c);
}

for (let f = Number(from ?? res.first); f <= Number(to ?? res.last); f += Number(every)) {
  const kp = which === 'smooth' ? res.smooth?.[f] : (which !== 'fast' && res.accurate?.[f]) || res.fast[f];
  const thr = which === 'smooth' ? 0.5 : res.accurate?.[f] && which !== 'fast' ? 1.0 : 0.3;
  const box = res.boxes[f];
  if (!box) continue;
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=eq(n\\,${f})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: W * H * 4 + 1024 });
  const s = Math.max(2, (box[3] - box[1]) / 150);
  if (kp) for (const [a, b] of BONES) {
    const ia = JI[a], ib = JI[b];
    if (!(kp[ia * 3 + 2] >= thr) || !(kp[ib * 3 + 2] >= thr)) continue;
    const col = a[0] === 'l' && b[0] === 'l' ? [40, 200, 255] : a[0] === 'r' && b[0] === 'r' ? [255, 120, 30] : [240, 240, 240];
    line(rgba, W, H, kp[ia * 3], kp[ia * 3 + 1], kp[ib * 3], kp[ib * 3 + 1], s, col);
  }
  const side = Math.max(box[3] - box[1], box[2] - box[0]) * 1.4;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const x = Math.max(0, Math.min(W - side, cx - side / 2)), y = Math.max(0, Math.min(H - side, cy - side / 2));
  const raw = `${dir}/f.rgba`;
  writeFileSync(raw, rgba);
  const tile = `${dir}/t${String(f).padStart(4, '0')}.png`;
  const tag = res.accurate?.[f] && which !== 'fast' ? 'A' : 'F';
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', raw,
    '-vf', `crop=${Math.round(Math.min(side, W))}:${Math.round(Math.min(side, H))}:${Math.round(x)}:${Math.round(y)},scale=${T}:${T}`, tile]);
  tiles.push(tile);
  console.log(f, tag, (box[3] - box[1]).toFixed(0) + 'px');
}
const cols = 8, rows = Math.ceil(tiles.length / cols);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', `${dir}/t*.png`, '-vf', `tile=${cols}x${rows}`, '-frames:v', '1', out]);
