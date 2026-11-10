// Clip access for the server: one ffmpeg decode, frames kept in RAM so pipeline.js never
// re-decodes. Falls back to streaming when the whole clip would not fit the budget.
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';

// Same conversion the local tests ran through (tools/run_pipeline.mjs): ffmpeg's default
// yuv420p10 -> rgba with autorotate on, no explicit tone mapping. Do not add filters here
// without re-running the fixture comparison; the models were checked on these pixels.
const OUT = ['-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'];

const probeJson = (clip, args) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', ...args, '-of', 'json', clip], { maxBuffer: 64 * 1024 * 1024 }).toString());

// Parses ffprobe's two answers. Kept apart from the exec so tests can feed it text.
export function parseProbe(stream, packets) {
  let W = +stream.width, H = +stream.height;
  // ffmpeg autorotates on decode, so a ±90 clip comes out with the sides swapped.
  const rot = Number(stream.side_data_list?.find(s => s.rotation != null)?.rotation ?? 0);
  if (Math.abs(rot) % 180 === 90) [W, H] = [H, W];
  // Packets are in decode order; sorted, they are the frame times, as on the phone.
  const ts = packets.map(p => Number(p.pts_time)).filter(Number.isFinite).sort((a, b) => a - b);
  const N = ts.length;
  if (!(W > 0 && H > 0 && N > 1)) throw new Error(`ffprobe: unusable stream (${W}x${H}, ${N} frames)`);
  // The worker's frame rate formula, so both paths compute the same number.
  return { N, W, H, ts, fps: (N - 1) / (ts[N - 1] - ts[0]), rotation: rot };
}

export function probe(clip) {
  const s = probeJson(clip, ['-show_entries', 'stream=width,height:stream_side_data=rotation']).streams?.[0];
  if (!s) throw new Error('ffprobe: no video stream');
  const { packets } = probeJson(clip, ['-show_entries', 'packet=pts_time']);
  return parseProbe(s, packets);
}

export function defaultBudget() {
  if (process.env.JUMP_FRAME_BUDGET_GB) return Number(process.env.JUMP_FRAME_BUDGET_GB) * 2 ** 30;
  const mem = Math.min(os.totalmem(), process.constrainedMemory?.() || Infinity);
  return mem * 0.6;
}

function decoder(clip, vf) {
  const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', clip, ...(vf ? ['-vf', vf] : []), ...OUT], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', d => { err = (err + d).slice(-400); });
  p.failure = new Promise(res => {
    p.on('error', e => res(e));
    p.on('close', code => res(code && !p.killed ? new Error(`ffmpeg exited ${code}: ${err.trim()}`) : null));
  });
  return p;
}

// Whole frames out of a raw pipe. fresh=false reuses one buffer: the caller must be done
// with a frame before asking for the next, which holds for every pass in pipeline.js.
async function* rawFrames(p, size, fresh) {
  let buf = Buffer.allocUnsafeSlow(size), used = 0;
  for await (const chunk of p.stdout) {
    let at = 0;
    while (at < chunk.length) {
      const n = Math.min(size - used, chunk.length - at);
      chunk.copy(buf, used, at, at + n);
      used += n; at += n;
      if (used === size) {
        yield buf;
        if (fresh) buf = Buffer.allocUnsafeSlow(size);
        used = 0;
      }
    }
  }
  const failed = await p.failure;
  if (failed) throw failed;
}

// { N, W, H, fps, ts, get(i), sequential(from, to, step), pick(list), close() }
export function openFrames(clip, meta, { budget = defaultBudget() } = {}) {
  const { N, W, H } = meta;
  const SIZE = W * H * 4;
  return { ...meta, ...(N * SIZE <= budget ? inMemory(clip, N, SIZE) : streaming(clip, N, SIZE)) };
}

// The decode runs ahead in the background, so pass 1 starts as soon as frame 0 exists.
function inMemory(clip, N, SIZE) {
  const slots = new Array(N);
  let have = 0, finished = false, failure = null, waiters = [];
  const wake = () => { const w = waiters; waiters = []; w.forEach(r => r()); };
  const p = decoder(clip);
  (async () => { for await (const f of rawFrames(p, SIZE, true)) { if (have < N) slots[have++] = f; wake(); } })()
    .catch(e => { failure = e; })
    .finally(() => { finished = true; wake(); });

  const ready = async i => {
    while (have <= i && !finished) await new Promise(r => waiters.push(r));
    if (failure) throw failure;
    return i < have;
  };
  return {
    mode: 'memory',
    async get(i) {
      if (!(await ready(i))) throw new Error(`frame ${i} of ${N} was not decoded`);
      return slots[i];
    },
    async *sequential(from, to, step) {
      for (let i = from; i <= to && await ready(i); i += step) yield { i, rgba: slots[i] };
    },
    async pick(list) {
      const out = new Map();
      for (const i of list) if (await ready(i)) out.set(i, slots[i]);
      return out;
    },
    close() { if (!finished) p.kill('SIGKILL'); slots.length = 0; },
  };
}

// Too big for RAM: pass 1 keeps its sampled frames, so the track extension (which asks
// for exactly those frames via get) never starts a process of its own.
function streaming(clip, N, SIZE) {
  const kept = new Map();
  const live = new Set();
  const run = vf => { const p = decoder(clip, vf); live.add(p); p.on('close', () => live.delete(p)); return p; };
  const stop = p => { if (p.exitCode === null) p.kill('SIGKILL'); };
  return {
    mode: 'stream',
    async get(i) {
      if (kept.has(i)) return kept.get(i);
      return (await this.pick([i])).get(i);
    },
    async *sequential(from, to, step) {
      const sampling = step > 1;
      const p = run(`select=between(n\\,${from}\\,${to})`);
      let i = from;
      try {
        for await (const f of rawFrames(p, SIZE, false)) {
          if ((i - from) % step === 0) {
            if (sampling) kept.set(i, Buffer.from(f));
            yield { i, rgba: sampling ? kept.get(i) : f };
          }
          if (++i > to) break;
        }
      } finally { stop(p); }
    },
    async pick(list) {
      const want = [...new Set(list)].sort((a, b) => a - b);
      // Runs of consecutive frames as between(): one eq() per frame overflows ffmpeg's parser
      // for a window of a hundred frames or more.
      const runs = [];
      for (const i of want) { const r = runs.at(-1); if (r && i === r[1] + 1) r[1] = i; else runs.push([i, i]); }
      const p = run(`select='${runs.map(([a, b]) => (a === b ? `eq(n\\,${a})` : `between(n\\,${a}\\,${b})`)).join('+')}'`);
      const out = new Map();
      let k = 0;
      try {
        for await (const f of rawFrames(p, SIZE, true)) {
          out.set(want[k++], f);
          if (k === want.length) break;
        }
      } finally { stop(p); }
      return out;
    },
    close() { for (const p of live) stop(p); kept.clear(); },
  };
}

// RGBA -> JPEG, long side capped: bigger only costs upload time for the vision call.
export function jpeg(rgba, W, H, { maxSide = 1568, q = 4 } = {}) {
  const vf = W > H ? `scale='min(${maxSide},iw)':-2` : `scale=-2:'min(${maxSide},ih)'`;
  return new Promise((res, rej) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-i', '-',
      '-frames:v', '1', '-vf', vf, '-q:v', String(q), '-f', 'image2pipe', '-c:v', 'mjpeg', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', d => out.push(d));
    p.stderr.on('data', d => { err += d; });
    p.on('error', rej);
    p.on('close', code => (code ? rej(new Error(`jpeg: ${err.trim()}`)) : res(Buffer.concat(out))));
    p.stdin.on('error', () => {});
    p.stdin.end(rgba);
  });
}
