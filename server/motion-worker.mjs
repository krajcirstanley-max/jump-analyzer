// One part of the foot/track motion pass (sprint.mjs measureMotionParallel): reads its frames
// straight from the decoded file and measures them like the single pass does.
import { workerData, parentPort } from 'node:worker_threads';
import fs from 'node:fs';
import { measureMotionRaw } from './sprint.mjs';

const { fd, W, H, from, to, track, base } = workerData;
const SIZE = W * H * 4;
try {
  // the parent's open descriptor (worker threads share it): the file has no name any more
  const read = (buf, n, pos) => new Promise((res, rej) => fs.read(fd, buf, 0, n, pos, e => (e ? rej(e) : res())));
  const fh = { read: (buf, off, n, pos) => read(buf, n, pos), close: async () => {} };
  const cache = new Map();
  const getRGBA = async f => {
    if (cache.has(f)) return cache.get(f);
    const b = Buffer.allocUnsafeSlow(SIZE);
    await fh.read(b, 0, SIZE, f * SIZE);
    cache.clear(); cache.set(f, b);
    return b;
  };
  let rows = Buffer.alloc(0);
  const getRows = async (f, oy, rh) => {
    const n = rh * W * 4;
    if (rows.length < n) rows = Buffer.allocUnsafeSlow(n);
    await fh.read(rows, 0, n, f * SIZE + oy * W * 4);
    return rows;   // shrink copies it out before the next read
  };
  const out = await measureMotionRaw({ getRGBA, getRows, W, H, track, from, to, trackBase: base });
  await fh.close();
  parentPort.postMessage({ out });
} catch (e) { parentPort.postMessage({ error: String(e?.stack ?? e) }); }
