// Background worker: decodes the clip at full resolution and runs the pose pipeline,
// so the app stays responsive. Messages in:  { file, opts }
// Messages out: { progress }, { result }, { error }
import * as ort from '../../vendor/ort/ort.wasm.min.mjs';
import * as mb from '../../vendor/mediabunny.min.mjs';
import { PoseEngine } from './engine.js';
import { runPipeline, DEFAULTS } from './pipeline.js';
import { nearestIndex } from '../frames.js';

ort.env.wasm.numThreads = 1; // no cross-origin isolation on the host, so no threads
ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.logLevel = 'error';

const root = new URL('../../', import.meta.url);
const loadBytes = async path => new Uint8Array(await (await fetch(new URL(path, root))).arrayBuffer());

async function openFrames(file) {
  const input = new mb.Input({ formats: mb.ALL_FORMATS, source: new mb.BlobSource(file) });
  const track = await input.getPrimaryVideoTrack();
  const ts = [];
  for await (const p of new mb.EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) ts.push(p.timestamp);
  ts.sort((a, b) => a - b);
  const W = track.displayWidth, H = track.displayHeight;
  const sink = new mb.CanvasSink(track);
  const work = new OffscreenCanvas(W, H);
  const ctx = work.getContext('2d', { willReadFrequently: true });
  const pixels = c => { ctx.drawImage(c, 0, 0); return ctx.getImageData(0, 0, W, H).data; };
  return {
    N: ts.length, W, H, ts, fps: (ts.length - 1) / (ts.at(-1) - ts[0]),
    async get(i) { return pixels((await sink.getCanvas(ts[i])).canvas); },
    async *sequential(from, to, step) {
      const end = to + 1 < ts.length ? ts[to + 1] : Infinity;
      for await (const wc of sink.canvases(ts[from], end)) {
        const i = nearestIndex(ts, wc.timestamp);
        if ((i - from) % step === 0) yield { i, rgba: pixels(wc.canvas) };
      }
    },
  };
}

self.onmessage = async e => {
  try {
    const opts = { ...DEFAULTS, ...e.data.opts };
    const frames = await openFrames(e.data.file);
    self.postMessage({ progress: { stage: 'Loading models', done: 0, total: 1 } });
    const engine = new PoseEngine(ort);
    await engine.load(['detector', opts.fast, ...(opts.accurate ? [opts.accurate] : [])], loadBytes);
    let last = 0;
    const result = await runPipeline(frames, engine, {
      ...opts,
      onProgress: p => { const now = performance.now(); if (now - last > 150) { last = now; self.postMessage({ progress: p }); } },
    });
    self.postMessage({ result: { ...result, ts: frames.ts } });
  } catch (err) {
    self.postMessage({ error: err?.message || String(err) });
  }
};
