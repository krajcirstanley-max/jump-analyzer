// measureGround's heavy parts on a thread of their own (ground.mjs groundThreads): one direction of
// the runway tracking from the reference frame, or the cones over a list of frames, reading the
// decoded file.
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { trackGround, detectCones } from './ground.mjs';

const { fd, W, H, task } = workerData;
const SIZE = W * H * 4;
const get = i => { const b = Buffer.allocUnsafeSlow(SIZE); fs.readSync(fd, b, 0, SIZE, i * SIZE); return b; };
try {
  let out;
  if (task.kind === 'track') out = await trackGround(async i => get(i), W, H, { ref: task.ref, from: task.from, to: task.to, groundY: () => task.gy, box: i => task.boxes[i], steps: task.steps });
  else { out = {}; for (const i of task.list) { const c = detectCones(get(i), W, H, { box: task.boxes[i] }); out[i] = c.length ? c : null; } }
  parentPort.postMessage({ out });
} catch (e) { parentPort.postMessage({ error: String(e?.stack ?? e) }); }
