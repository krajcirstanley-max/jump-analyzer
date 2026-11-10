// Generates synthetic test clips whose frames carry their own index as a barcode.
// Barcode: 12 blocks across the top 100 px, block k white when bit (11-k) of the
// frame index is set. A moving dot stands in for the athlete.
// Run: node tools/make_fixtures.mjs
import { spawn, execFileSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
const W = 1920, H = 1080, BITS = 12;

function fill(buf, x0, y0, x1, y1, [r, g, b]) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    let o = (y * W + Math.max(0, x0)) * 3;
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) { buf[o++] = r; buf[o++] = g; buf[o++] = b; }
  }
}

function frame(i, n) {
  const buf = Buffer.alloc(W * H * 3, 70);
  const bw = Math.floor(W / BITS);
  for (let k = 0; k < BITS; k++) {
    const on = (i >> (BITS - 1 - k)) & 1;
    fill(buf, k * bw + 8, 0, (k + 1) * bw - 8, 100, on ? [255, 255, 255] : [0, 0, 0]);
  }
  fill(buf, 0, 130, 100, 230, [220, 40, 40]); // orientation marker, top-left
  const t = i / Math.max(1, n - 1);
  const x = Math.round(150 + (W - 300) * t), y = Math.round(700 - 1600 * t * (1 - t));
  fill(buf, x - 40, y - 40, x + 40, y + 40, [93, 202, 165]);
  return buf;
}

async function make(name, n, fps, x265) {
  const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24',
    '-s', `${W}x${H}`, '-r', String(fps), '-i', '-', '-c:v', 'libx265', '-tag:v', 'hvc1', '-preset', 'ultrafast',
    '-x265-params', 'log-level=error:' + x265, '-pix_fmt', 'yuv420p', OUT + name], { stdio: ['pipe', 'inherit', 'inherit'] });
  for (let i = 0; i < n; i++) {
    if (!p.stdin.write(frame(i, n))) await new Promise(r => p.stdin.once('drain', r));
  }
  p.stdin.end();
  const code = await new Promise(r => p.on('close', r));
  if (code !== 0) throw new Error(`ffmpeg failed for ${name}`);
}

await make('bar240_gop30_bframes.mov', 720, 240, 'keyint=30:min-keyint=30:bframes=3');
await make('bar240_gop250.mov', 720, 240, 'keyint=250:min-keyint=250:bframes=0');
await make('tmp_rot.mov', 240, 240, 'keyint=60:bframes=0');
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation:v:0', '-90',
  '-i', OUT + 'tmp_rot.mov', '-c', 'copy', OUT + 'bar240_portrait.mov']);
unlinkSync(OUT + 'tmp_rot.mov');
console.log('ok');
