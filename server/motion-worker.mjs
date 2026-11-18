// Pieces of the foot/track motion pass (sprint.mjs motionPool): reads its frames straight from the
// decoded file and measures them like the single pass does. One message per piece { from, to,
// track, base }, answered with { out, ms }; null ends the thread.
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { measureMotionRaw } from './sprint.mjs';

const { fd, W, H } = workerData;
const SIZE = W * H * 4;
// the parent's open descriptor (worker threads share it): the file has no name any more. Read
// synchronously: the async API queued behind the other threads' reads.
const readAt = (buf, n, pos) => { fs.readSync(fd, buf, 0, n, pos); };
let rows = Buffer.alloc(0);
const one = Buffer.allocUnsafeSlow(SIZE);
parentPort.on('message', async job => {
  if (!job) { parentPort.close(); return; }
  const t0 = performance.now();
  try {
    const { from, to, track, base } = job;
    let readMs = 0;
    const getRGBA = async f => { readAt(one, SIZE, f * SIZE); return one; };
    const getRows = async (f, oy, rh) => {
      const n = rh * W * 4, tr = performance.now();
      if (rows.length < n) rows = Buffer.allocUnsafeSlow(n);
      readAt(rows, n, f * SIZE + oy * W * 4);
      readMs += performance.now() - tr;
      return rows;   // shrink copies it out before the next read
    };
    const out = await measureMotionRaw({ getRGBA, getRows, W, H, track, from, to, trackBase: base });
    parentPort.postMessage({ out, ms: { read: Math.round(readMs), all: Math.round(performance.now() - t0), n: to - from } });
  } catch (e) { parentPort.postMessage({ error: String(e?.stack ?? e) }); }
});
