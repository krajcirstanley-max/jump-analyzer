// The phone's motion over the background (ground.mjs trackCamera) on its own thread, reading the
// decoded file, so it runs while the pose models work instead of after them (2026-11-18: 4.6 s
// of a 19 s RSI job, all of it waiting on the pose before).
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { trackCamera } from './ground.mjs';

const { fd, W, H, fps, from, to, boxes, rate } = workerData;
const SIZE = W * H * 4;
try {
  const read = (buf, pos) => fs.readSync(fd, buf, 0, SIZE, pos);   // sync: 2 ms a frame, the async API was 15
  const frames = {
    W, H, fps,
    async *sequential(a, b, step) {
      for (let i = a; i <= b; i += step) { const buf = Buffer.allocUnsafeSlow(SIZE); read(buf, i * SIZE); yield { i, rgba: buf }; }
    },
  };
  const camera = await trackCamera(frames, { from, to, boxes, rate });
  parentPort.postMessage({ camera });
} catch (e) { parentPort.postMessage({ error: String(e?.stack ?? e) }); }
