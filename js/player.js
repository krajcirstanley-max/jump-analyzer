// Replay player: frame steps, hold-to-repeat, scrub, loop inside a range, pinch-zoom/pan.
// Draws through a view transform so overlays (skeleton, labels) line up.
import { nearestIndex, keyIndexAtOrBefore } from './frames.js';

const SPEEDS = [{ label: '0,5×', v: 0.5 }, { label: 'Reálna', v: 1 }];
const HOLD_DELAY = 350, HOLD_EVERY = 50, MAX_ZOOM = 8;
const HEAD_FRAMES = 72;   // frames kept ready at the loop start when no keyframe is in reach
const HEAD_MIN = 24, HEAD_MAX = 128; // otherwise the head runs up to a keyframe this far away
const HEAD_SCALE = 0.75;  // played in motion only; ~2 MB a frame instead of 3.7
const GET_TIMEOUT = 8000; // a decode that never answers must not freeze the player
const MAX_RETRIES = 3;
const MAX_TICK = 100;     // ms; a background tab must not leap across the range
const SLOW_ON = 4, SLOW_OFF = 20; // ticks, so one late frame doesn't flash the badge

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// One step of the media clock inside [from, to]. A loop carries the overshoot across the
// seam, so a cycle lasts exactly the range and doesn't round to a frame on every wrap.
export function advance(ts, t, dt, from, to, loop) {
  const want = t + dt;
  const gap = to > from ? (ts[to] - ts[from]) / (to - from) : 0;
  if (loop ? want < ts[to] + gap : want < ts[to]) {
    return { t: want, i: clamp(nearestIndex(ts, want), from, to), wrapped: false, ended: false };
  }
  if (!loop) return { t: ts[to], i: to, wrapped: false, ended: true };
  const span = ts[to] - ts[from] + gap;
  if (!(span > 0)) return { t: ts[from], i: from, wrapped: false, ended: false };
  const next = ts[from] + ((want - ts[from]) % span);
  return { t: next, i: clamp(nearestIndex(ts, next), from, to), wrapped: true, ended: false };
}

// Timeline bands as percentages of the range, clipped to it. Value v sits at
// (v - from) / (to - from) on a range input, so bands use the same mapping.
export function bandLayout(bands, from, to) {
  const span = Math.max(1, to - from);
  return bands.filter(b => b.to >= from && b.from <= to).map(b => {
    // +1: phases are consecutive frame ranges, so bands must meet with no sliver between.
    const a = clamp(b.from, from, to), z = clamp(b.to + 1, from, to);
    return { id: b.id, on: !!b.on, left: ((a - from) / span) * 100, width: ((z - a) / span) * 100 };
  });
}

// How many frames to hold at the loop start. Ending on a keyframe lets the decoder
// resume there with nothing to pre-roll after a wrap.
export function headLength(ts, keys, from, to) {
  const room = to - from + 1;
  for (const kt of keys) {
    const n = nearestIndex(ts, kt) - from;
    if (n >= HEAD_MIN && n <= HEAD_MAX) return Math.min(room, n);
  }
  return Math.min(room, HEAD_FRAMES);
}

export class Player {
  constructor(root, source) {
    this.src = source;
    this.ts = source.ts;
    this.index = 0;
    this.range = { from: 0, to: source.count - 1 };
    this.loop = false;
    this.speed = SPEEDS[0].v;
    this.playing = false;
    this.view = { s: 1, tx: 0, ty: 0 };   // zoom/pan on top of the fit-to-stage scale
    this.overlays = [];                   // fn(ctx, toCanvas, index)
    this.pending = null;                  // newest frame asked for and not drawn yet
    this.waiting = [];                    // show() promises to settle once it is drawn
    this.head = new Map();                // frames at the loop start, owned by the player
    this.headRun = 0;
    this.#build(root);
    this.#resize();
    this.ro = new ResizeObserver(() => { this.#resize(); this.#redraw(); });
    this.ro.observe(this.stage);
  }

  #build(root) {
    root.innerHTML = `
      <div class="stage"><canvas></canvas></div>
      <div class="hud"><span class="fr"></span><span class="zm"></span></div>
      <div class="timeline"><div class="bands"></div><input type="range" class="scrub" min="0" value="0" step="1" aria-label="Snímka"></div>
      <div class="controls controls-v1">
        <button class="btn step" data-step="-1" aria-label="O snímku späť">‹</button>
        <button class="btn play" aria-label="Prehrať">Prehrať</button>
        <button class="btn step" data-step="1" aria-label="O snímku vpred">›</button>
      </div>
      <div class="speeds" role="radiogroup" aria-label="Rýchlosť prehrávania">
        ${SPEEDS.map((s, i) => `<button class="chip${i === 0 ? ' on' : ''}" data-speed="${s.v}" role="radio" aria-checked="${i === 0}">${s.label}</button>`).join('')}
      </div>`;
    this.stage = root.querySelector('.stage');
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.frLabel = root.querySelector('.fr');
    this.zmLabel = root.querySelector('.zm');
    this.scrub = root.querySelector('.scrub');
    this.bandsEl = root.querySelector('.bands');
    this.playBtn = root.querySelector('.play');
    this.scrub.max = String(this.src.count - 1);
    this.canvas.style.touchAction = 'pan-y'; // the page still scrolls until zoomed in

    this.scrub.addEventListener('input', () => { this.pause(); this.show(+this.scrub.value); });
    this.playBtn.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    root.querySelectorAll('[data-step]').forEach(b => this.#holdToRepeat(b, +b.dataset.step));
    root.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
      this.speed = +b.dataset.speed;
      root.querySelectorAll('[data-speed]').forEach(x => {
        x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b));
      });
      if (this.playing) this.play();
    }));
    this.#gestures();
    this.keyHandler = e => {
      if (e.target.closest?.('input:not([type=range]), textarea')) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault(); this.pause(); this.step(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === ' ') { e.preventDefault(); this.playing ? this.pause() : this.play(); }
      else if (e.key === 'Home') { this.pause(); this.show(this.range.from); }
      else if (e.key === 'End') { this.pause(); this.show(this.range.to); }
      else if (e.key === '0') this.resetZoom();
      else if (/^[1-2]$/.test(e.key)) root.querySelectorAll('[data-speed]')[+e.key - 1].click();
    };
    addEventListener('keydown', this.keyHandler);
  }

  #holdToRepeat(btn, delta) {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    btn.addEventListener('pointerdown', e => {
      e.preventDefault(); this.pause(); this.step(delta);
      // One frame at a time: while a frame is decoding, don't queue the next.
      timer = setTimeout(() => { timer = setInterval(() => { if (this.pending == null) this.step(delta); }, HOLD_EVERY); }, HOLD_DELAY);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(t => btn.addEventListener(t, stop));
    btn.addEventListener('click', e => e.preventDefault());
  }

  // ---------- range, loop, bands ----------
  setRange(from, to) {
    const last = this.src.count - 1;
    const a = clamp(Math.round(from), 0, last), z = clamp(Math.round(to), a, last);
    this.range = { from: a, to: z };
    this.scrub.min = String(a);
    this.scrub.max = String(z);
    this.#drawBands();
    this.#fillHead();
    return this.show(this.target);
  }

  setLoop(on) {
    this.loop = !!on;
    this.#fillHead();
  }

  setBands(bands) { this.bands = bands ?? []; this.#drawBands(); }

  #drawBands() {
    const { from, to } = this.range, rows = bandLayout(this.bands ?? [], from, to);
    this.bandsEl.innerHTML = rows.map(b =>
      `<div class="band band-${b.id}${b.on ? ' on' : ''}" style="left:${b.left}%;width:${b.width}%"></div>`).join('');
    if (rows.some(b => b.on)) this.bandsEl.dataset.focus = '1'; else delete this.bandsEl.dataset.focus;
  }

  // Decodes the first frames of the range once, on a decoder of its own. FrameSource has
  // one forward run and a wrap sends it back to a keyframe up to a second of frames away;
  // the head plays across that restart, so the seam never waits for it.
  async #fillHead() {
    const run = ++this.headRun;
    this.#dropHead();
    this.headEnd = null;
    const { src, ts } = this, { from, to } = this.range;
    if (!this.loop || !src.sink) return;
    const n = headLength(ts, src.keys, from, to);
    const last = from + n - 1;
    this.headEnd = Math.min(to, from + n);
    const start = keyIndexAtOrBefore(ts, src.keys, from);
    const small = document.createElement('canvas');
    small.width = Math.round(src.width * HEAD_SCALE);
    small.height = Math.round(src.height * HEAD_SCALE);
    const sctx = small.getContext('2d');
    try {
      for await (const wc of src.sink.canvases(ts[start])) {
        if (run !== this.headRun) break;
        const idx = nearestIndex(ts, wc.timestamp);
        if (idx >= from && !this.head.has(idx)) {
          sctx.drawImage(wc.canvas, 0, 0, small.width, small.height);
          const bmp = await createImageBitmap(small);
          if (run !== this.headRun) { bmp.close?.(); break; }
          this.head.set(idx, bmp);
        }
        if (idx >= last) break;
      }
    } catch (e) { console.warn('loop head decode failed', e); } // playback still works, it just waits at the seam
  }

  #dropHead() {
    for (const b of this.head.values()) if (b !== this.bmp) b.close?.();
    this.head.clear();
  }

  // ---------- frame display ----------
  step(d) { return this.show(this.target + d); }
  get target() { return this.pending ?? this.index; }

  // Shows frame i, kept inside the range. Rapid calls coalesce on the newest.
  show(i) {
    if (this.gone) return Promise.resolve(this.index);
    i = clamp(i, this.range.from, this.range.to);
    this.pending = i;
    this.#label(i);
    if (this.inflight != null && i < this.inflight) this.preempt?.();
    const done = new Promise(res => this.waiting.push(res));
    this.#pump();
    return done;
  }

  // One request at a time reaches the decoder. FrameSource serves every waiter it holds,
  // so a queue of stale frames would drag it away from the one on screen.
  async #pump() {
    if (this.pumping) return;
    this.pumping = true;
    let retries = 0, lastTry = null;
    try {
      while (this.pending != null && !this.gone) {
        const i = this.pending;
        if (i !== lastTry) { lastTry = i; retries = 0; }
        // The head is for motion; a paused frame is always the full-size one.
        const bmp = (this.playing && this.head.get(i)) || await this.#fetch(i);
        if (this.gone) break;
        // A run can pass a frame without keeping it (undefined) or it can be evicted before
        // we get here (closed). Asking again starts a run that keeps it.
        if ((bmp === undefined || (bmp && !bmp.width)) && this.pending === i && retries++ < MAX_RETRIES) continue;
        // A drag draws what arrives, so it keeps moving even when requests outrun the decoder.
        if (bmp && bmp.width) { this.index = i; this.bmp = bmp; this.#redraw(); this.onFrame?.(i); }
        if (this.pending === i) { this.pending = null; this.#settle(); }
      }
    } finally {
      this.pumping = false;
      if (this.gone) this.#settle();
    }
  }

  // Null when overtaken by an earlier frame (the run has to restart anyway) or timed out.
  #fetch(i) {
    this.inflight = i;
    return new Promise(res => {
      const timer = setTimeout(() => finish(null), GET_TIMEOUT);
      const finish = b => { clearTimeout(timer); this.inflight = null; this.preempt = null; res(b); };
      // Forget the overtaken request too, or FrameSource goes back to decode it later.
      this.preempt = () => { this.src.waiters?.delete(i); finish(null); };
      this.src.get(i).then(finish, () => finish(null));
    });
  }

  #settle() {
    const w = this.waiting; this.waiting = [];
    w.forEach(res => res(this.index));
  }

  #label(i) {
    const { from, to } = this.range;
    const t = (this.ts[i] - this.ts[from]).toFixed(3).replace('.', ',');
    this.frLabel.textContent = `snímka ${i - from + 1} / ${to - from + 1} · ${t} s`;
    this.scrub.value = String(i);
  }

  #resize() {
    const dpr = devicePixelRatio || 1;
    const w = this.stage.clientWidth || 360;
    const maxH = Math.max(200, innerHeight * 0.62);
    const aspect = this.src.height / this.src.width;
    const cssW = Math.min(w, maxH / aspect);
    const cssH = cssW * aspect;
    this.canvas.style.width = `${cssW}px`;
    this.canvas.style.height = `${cssH}px`;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.fit = this.canvas.width / this.src.width;
    this.#clampView();
  }

  // Maps frame pixel coordinates to canvas pixels (for overlays).
  toCanvas = (x, y) => [x * this.fit * this.view.s + this.view.tx, y * this.fit * this.view.s + this.view.ty];

  #redraw() {
    const { ctx, canvas } = this;
    // FrameSource may have evicted (closed) this bitmap; keep what's on the canvas.
    if (this.bmp && !this.bmp.width) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.bmp) return;
    const k = this.fit * this.view.s;
    ctx.setTransform(k, 0, 0, k, this.view.tx, this.view.ty);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.bmp, 0, 0, this.src.width, this.src.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const o of this.overlays) {
      try { o(ctx, this.toCanvas, this.index); } catch (e) { console.warn('overlay failed', e); }
    }
    if (!this.slowOn) this.zmLabel.textContent = this.#zoomText();
  }

  #zoomText() { return this.view.s > 1.01 ? `${this.view.s.toFixed(1).replace('.', ',')}×` : ''; }

  // ---------- playback ----------
  play() {
    if (this.index >= this.range.to && !this.loop) this.show(this.range.from);
    this.playing = true;
    this.playBtn.textContent = 'Pauza';
    this.playBtn.setAttribute('aria-label', 'Pauza');
    // Media clock: runs on wall time × speed but holds while a frame is still decoding,
    // so playback settles at the speed the clip can really be decoded.
    this.#resumeDecoder();
    let clock = this.ts[this.target], last = performance.now();
    let held = 0, smooth = 0;
    const run = this.playRun = (this.playRun || 0) + 1;
    const tick = now => {
      if (!this.playing || this.playRun !== run) return;
      const dt = (clamp(now - last, 0, MAX_TICK) / 1000) * this.speed;
      last = now;
      if (this.pending != null) {
        smooth = 0;
        if (++held >= SLOW_ON) this.#badge(true);
        requestAnimationFrame(tick);
        return;
      }
      held = 0;
      if (++smooth >= SLOW_OFF) this.#badge(false);
      const { from, to } = this.range;
      const st = advance(this.ts, clock, dt, from, to, this.loop);
      clock = st.t;
      if (st.i !== this.index) this.show(st.i);
      if (st.wrapped) this.#resumeDecoder();
      if (st.ended && this.index === to) { this.pause(); return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // While the head plays, send the decoder to where the head runs out.
  #resumeDecoder() {
    if (this.headEnd != null && this.head.has(this.target) && !this.src.has(this.headEnd)) this.src.get(this.headEnd);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.playBtn.textContent = 'Prehrať';
    this.playBtn.setAttribute('aria-label', 'Prehrať');
    this.#badge(false);
    if (this.head.has(this.index)) this.show(this.target); // swap the head frame for a sharp one
  }

  #badge(on) {
    if (!!this.slowOn === on) return;
    this.slowOn = on;
    this.zmLabel.dataset.slow = on ? '1' : '';
    this.zmLabel.textContent = on ? 'spomalené' : this.#zoomText();
  }

  // ---------- zoom and pan ----------
  #clampView() {
    const v = this.view, W = this.canvas.width, H = this.canvas.height;
    v.s = Math.max(1, Math.min(MAX_ZOOM, v.s));
    v.tx = Math.min(0, Math.max(W - W * v.s, v.tx));
    v.ty = Math.min(0, Math.max(H - H * v.s, v.ty));
    this.canvas.style.touchAction = v.s > 1 ? 'none' : 'pan-y'; // zoomed: one finger pans the picture
  }

  #zoomAt(cx, cy, factor) {
    const v = this.view, s0 = v.s;
    const s1 = Math.max(1, Math.min(MAX_ZOOM, s0 * factor));
    v.tx = cx - (cx - v.tx) * (s1 / s0);
    v.ty = cy - (cy - v.ty) * (s1 / s0);
    v.s = s1;
    this.#clampView();
    this.#redraw();
  }

  resetZoom() { this.view = { s: 1, tx: 0, ty: 0 }; this.#clampView(); this.#redraw(); }

  // Redraws the current frame, e.g. after overlays change.
  refresh() { this.#redraw(); }

  #gestures() {
    const c = this.canvas, pts = new Map();
    let last = null, lastTap = null;
    const pos = e => {
      const r = c.getBoundingClientRect(), k = c.width / r.width;
      return [(e.clientX - r.left) * k, (e.clientY - r.top) * k];
    };
    const state = () => {
      const p = [...pts.values()];
      if (p.length === 1) return { x: p[0][0], y: p[0][1], d: 0 };
      const [a, b] = p;
      return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2, d: Math.hypot(a[0] - b[0], a[1] - b[1]) };
    };
    c.addEventListener('pointerdown', e => {
      c.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, pos(e));
      last = state();
      const now = performance.now(), p = pos(e);
      if (pts.size === 1 && lastTap && now - lastTap.t < 300 &&
          Math.hypot(p[0] - lastTap.x, p[1] - lastTap.y) < 10 * (devicePixelRatio || 1)) {
        this.resetZoom(); lastTap = null;
      } else lastTap = { t: now, x: p[0], y: p[1] };
    });
    c.addEventListener('pointermove', e => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, pos(e));
      const s = state();
      if (pts.size >= 2 && last.d > 0) {
        this.view.tx += s.x - last.x; this.view.ty += s.y - last.y;
        this.#zoomAt(s.x, s.y, s.d / last.d);
      } else if (pts.size === 1 && this.view.s > 1) {
        this.view.tx += s.x - last.x; this.view.ty += s.y - last.y;
        this.#clampView(); this.#redraw();
      }
      last = s;
    });
    const up = e => { pts.delete(e.pointerId); last = pts.size ? state() : null; };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', e => {
      e.preventDefault();
      const [x, y] = pos(e);
      this.#zoomAt(x, y, Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    // Stop iOS Safari's own page pinch-zoom while gesturing on the video.
    ['gesturestart', 'gesturechange'].forEach(t => c.addEventListener(t, e => e.preventDefault()));
  }

  dispose() {
    this.gone = true;
    this.pause();
    this.headRun++;
    this.#dropHead();
    this.ro.disconnect();
    removeEventListener('keydown', this.keyHandler);
    this.src.dispose();
    this.#settle();
  }
}
