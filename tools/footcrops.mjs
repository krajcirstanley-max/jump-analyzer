// Tiles of the area around the athlete's feet for a frame range, for hand-labelling
// touchdown/toe-off. Each tile has a frame-number strip (binary-free: digits drawn as
// blocks would be overkill, so tiles are in order and the range is printed).
// Usage: node tools/footcrops.mjs <clip> <result.json> <out.jpg> <from> <to> [step] [size]
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { JI } from '../js/pose/models.js';

const [clip, resFile, out, from, to, step = '1', size = '360'] = process.argv.slice(2);
const r = JSON.parse(readFileSync(resFile, 'utf8'));
const dir = mkdtempSync(`${tmpdir()}/feet`);
const S = Number(size);
let n = 0;
for (let f = Number(from); f <= Number(to); f += Number(step)) {
  const k = r.clean?.[f] || r.fast?.[f];
  if (!k) continue;
  const pts = ['lheel', 'rheel', 'lbigtoe', 'rbigtoe'].map(p => [k[JI[p] * 3], k[JI[p] * 3 + 1]]).filter(p => p[0] != null);
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const x = Math.round(Math.max(0, Math.min(r.W - S, cx - S / 2))), y = Math.round(Math.max(0, Math.min(r.H - S, cy - S * 0.6)));
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', clip, '-vf', `select=eq(n\\,${f}),crop=${S}:${S}:${x}:${y},scale=200:200`,
    '-frames:v', '1', `${dir}/t${String(n++).padStart(3, '0')}.png`]);
}
const cols = Math.min(n, 10);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-pattern_type', 'glob', '-i', `${dir}/t*.png`, '-vf', `tile=${cols}x${Math.ceil(n / cols)}:padding=4:color=white`, '-frames:v', '1', out]);
console.log(`frames ${from}..${to} step ${step}, ${n} tiles, ${cols} per row`);
