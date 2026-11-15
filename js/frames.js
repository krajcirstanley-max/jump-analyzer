// Frame-exact access to a decoded clip by frame index.
// Decodes in runs (a whole stretch from the nearest keyframe), keeps an LRU cache of
// ImageBitmaps, and pre-decodes ahead so stepping and playback stay smooth.

const MAX_SIDE = 1280;   // decode size cap: plenty for a phone screen, ~3.7 MB per frame
const CACHE_FRAMES = 64; // ~235 MB at 1280x720
const AHEAD = 24;        // frames pre-decoded past the one asked for

export function nearestIndex(sorted, t) {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) < Math.abs(sorted[lo] - t)) lo--;
  return lo;
}

// Index of the last keyframe at or before frame i.
export function keyIndexAtOrBefore(timestamps, keyTimestamps, i) {
  const t = timestamps[i];
  let k = 0;
  for (const kt of keyTimestamps) { if (kt <= t + 1e-9) k = kt; else break; }
  return nearestIndex(timestamps, k);
}

export class FrameSource {
  constructor(mb, track, timestamps, keyTimestamps, { maxSide = MAX_SIDE, cacheFrames = CACHE_FRAMES } = {}) {
    this.ts = timestamps;
    this.keys = keyTimestamps.length ? keyTimestamps : [timestamps[0]];
    this.count = timestamps.length;
    const dw = track.displayWidth, dh = track.displayHeight;
    const s = Math.min(1, maxSide / Math.max(dw, dh));
    this.width = Math.round(dw * s);
    this.height = Math.round(dh * s);
    this.sink = new mb.CanvasSink(track, { width: this.width, height: this.height, fit: 'fill' });
    this.cacheFrames = cacheFrames;
    this.cache = new Map();   // index -> ImageBitmap, insertion order = LRU order
    this.waiters = new Map(); // index -> [resolve]
    this.job = null;          // { from, to, cancelled }
    this.focus = 0;           // frame the user is looking at; protected from eviction
    this.dir = 1;             // direction of travel: +1 forward, -1 backward
    this.stats = { decoded: 0, runs: 0 };
  }

  has(i) { return this.cache.has(i); }

  // Resolves with the ImageBitmap of frame i.
  get(i) {
    i = Math.max(0, Math.min(this.count - 1, i));
    if (i !== this.focus) this.dir = i > this.focus ? 1 : -1;
    this.focus = i;
    const hit = this.cache.get(i);
    if (hit) {
      this.cache.delete(i); this.cache.set(i, hit);
      this.#prefetch(i);
      return Promise.resolve(hit);
    }
    const p = new Promise(res => {
      if (!this.waiters.has(i)) this.waiters.set(i, []);
      this.waiters.get(i).push(res);
    });
    this.#ensure(i);
    return p;
  }

  #prefetch(i) {
    const end = Math.min(this.count - 1, i + AHEAD);
    for (let j = i + 1; j <= end; j++) {
      if (!this.cache.has(j)) { this.#ensure(j, true); return; }
    }
  }

  // Makes sure a decode run will produce frame i. One run stays alive and is extended
  // forward (no re-decoding from the keyframe); it restarts only for backward or far jumps.
  #ensure(i, background = false) {
    const j = this.job;
    if (j && !j.cancelled) {
      if (i >= j.pos && i <= j.to) return;
      const restartFrom = keyIndexAtOrBefore(this.ts, this.keys, i);
      // Ahead of the decoder and no closer keyframe to jump to: just keep decoding further.
      if (i >= j.pos && restartFrom <= j.pos) {
        j.to = Math.min(this.count - 1, i + AHEAD);
        j.wake?.();
        return;
      }
      if (background) return; // don't interrupt real work for prefetch
      j.cancelled = true;
      j.wake?.();
    } else if (background && this.waiters.size) return;
    const from = keyIndexAtOrBefore(this.ts, this.keys, i);
    // Keep a stretch before i too, so stepping backward from here is instant.
    const keepFrom = Math.max(from, i - (this.cacheFrames - AHEAD - 8));
    this.#run({ from, pos: from, keepFrom, to: Math.min(this.count - 1, i + AHEAD), cancelled: false });
  }

  async #run(job) {
    this.job = job;
    this.stats.runs++;
    const it = this.sink.canvases(this.ts[job.from]);
    let failed = null;
    try {
      for await (const wc of it) {
        if (job.cancelled) break;
        this.fails = 0;
        const idx = nearestIndex(this.ts, wc.timestamp);
        job.pos = idx;
        this.stats.yielded = (this.stats.yielded || 0) + 1;
        if (idx >= job.keepFrom && !this.cache.has(idx)) {
          const bmp = await createImageBitmap(wc.canvas);
          this.#put(idx, bmp);
          this.stats.decoded++;
        }
        const ws = this.waiters.get(idx);
        if (ws) { this.waiters.delete(idx); ws.forEach(r => r(this.cache.get(idx))); }
        if (idx >= this.count - 1) break;
        // Requests left over from cancelled runs: serve them (extends or restarts this run).
        if (idx >= job.to && this.waiters.size) {
          const next = this.#nextWaiter(idx);
          if (next != null) this.#ensure(next);
        }
        // Reached the end of the requested stretch: park until extended or cancelled.
        while (idx >= job.to && !job.cancelled) {
          await new Promise(res => { job.wake = res; });
          job.wake = null;
        }
        if (job.cancelled) break;
      }
    } catch (e) {
      // iOS refuses a new hardware decoder while others are still open (the loop head's run,
      // the pose worker) or after the app was in the background: "_createDecoder" rejected,
      // nothing caught it, and the red error bar came up (Stanley's phone, 2026-11-14). The
      // player times the frame out and asks again; here the run is retried a few times.
      failed = e;
    } finally {
      try { await it.return?.(); } catch { /* the decoder never opened */ }
      if (this.job === job) this.job = null;
    }
    if (failed) {
      if (this.disposed) return;
      this.fails = (this.fails ?? 0) + 1;
      console.warn('frame decode failed, retry', this.fails, failed);
      if (this.fails <= 4) setTimeout(() => { if (!this.disposed && this.waiters.size && !this.job) this.#ensure(this.#nextWaiter(job.pos)); }, 250 * this.fails);
      return;
    }
    // Anything still waiting gets a fresh run.
    if (this.waiters.size && !this.job) this.#ensure(this.#nextWaiter(job.pos));
  }

  // Waiting frame to serve next: the nearest one at or after pos, else the lowest.
  #nextWaiter(pos) {
    let ahead = null, any = null;
    for (const k of this.waiters.keys()) {
      if (this.cache.has(k)) {
        const ws = this.waiters.get(k);
        this.waiters.delete(k);
        ws.forEach(r => r(this.cache.get(k)));
        continue;
      }
      if (k >= pos && (ahead == null || k < ahead)) ahead = k;
      if (any == null || k < any) any = k;
    }
    // The frame the user is looking at always goes first.
    if (this.waiters.has(this.focus)) return this.focus;
    return ahead ?? any;
  }

  #put(i, bmp) {
    this.cache.set(i, bmp);
    while (this.cache.size > this.cacheFrames) {
      // Evict the frame farthest from the one being viewed. Frames behind the direction
      // of travel count triple: playback and stepping need the ones ahead next.
      let victim = null, worst = -1;
      for (const k of this.cache.keys()) {
        const off = (k - this.focus) * this.dir;
        const d = off >= 0 ? off : -off * 3;
        if (d > worst && Math.abs(k - this.focus) > 2) { worst = d; victim = k; }
      }
      if (victim == null) break;
      this.cache.get(victim).close?.();
      this.cache.delete(victim);
    }
  }

  dispose() {
    this.disposed = true;
    if (this.job) { this.job.cancelled = true; this.job.wake?.(); }
    for (const b of this.cache.values()) b.close?.();
    this.cache.clear();
    this.waiters.clear();
  }
}
