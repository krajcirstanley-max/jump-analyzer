// Runs the full automatic pose pipeline on a clip in Node (ffmpeg decodes the frames)
// and writes the result as JSON, plus overlay snapshots of chosen frames.
// Usage: node tools/run_pipeline.mjs <clip> <out.json> [--no-accurate] [--snap 600,700,...]
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import * as ort from '../vendor/ort/ort.wasm.min.mjs';
import { PoseEngine } from '../js/pose/engine.js';
import { runPipeline } from '../js/pose/pipeline.js';
import { DEFAULTS } from '../js/pose/pipeline.js';

ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';
const [clip, outFile, ...rest] = process.argv.slice(2);
const noAccurate = rest.includes('--no-accurate');

const q = e => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', e, '-of', 'csv=p=0', clip]).toString();
let [W, H] = q('stream=width,height').match(/\d+/g).map(Number);
if (Math.abs(Number(q('stream_side_data=rotation').match(/-?\d+/)?.[0] ?? 0)) === 90) [W, H] = [H, W];
const N = Number(q('stream=nb_read_packets').match(/\d+/)[0]);
const [num, den] = q('stream=avg_frame_rate').match(/\d+/g).map(Number);
const fps = num / den;
const FRAME = W * H * 4;

const frames = {
  N, W, H, fps,
  get(i) {
    return execFileSync('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=eq(n\\,${i})`, '-frames:v', '1',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: FRAME + 1024 });
  },
  async *sequential(from, to, step) {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', clip, '-vf', `select=between(n\\,${from}\\,${to})`, '-vsync', '0',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = Buffer.alloc(0), i = from;
    for await (const chunk of p.stdout) {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= FRAME) {
        const rgba = buf.subarray(0, FRAME);
        buf = buf.subarray(FRAME);
        if ((i - from) % step === 0) yield { i, rgba: Buffer.from(rgba) };
        i++;
      }
    }
  },
};

const engine = new PoseEngine(ort);
await engine.load(['detector', DEFAULTS.fast, ...(noAccurate ? [] : [DEFAULTS.accurate])], f => readFileSync(f));
let lastLog = 0;
const res = await runPipeline(frames, engine, {
  accurate: noAccurate ? null : DEFAULTS.accurate,
  onProgress: ({ stage, done, total }) => {
    if (performance.now() - lastLog > 5000) { lastLog = performance.now(); console.log(`${stage} ${done}/${Math.round(total)}`); }
  },
});
const ser = a => a?.map(k => (k ? Array.from(k, v => +v.toFixed(2)) : null));
writeFileSync(outFile, JSON.stringify({ ...res, fast: ser(res.fast), accurate: ser(res.accurate), boxes: res.boxes?.map(b => b && b.map(v => +v.toFixed(1))) }));
console.log(JSON.stringify({ W, H, N, first: res.first, last: res.last, trackPoints: res.track?.length, stats: res.stats }, null, 1));
