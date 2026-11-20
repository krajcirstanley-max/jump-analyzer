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
    this.mirror = false;                  // drawn mirrored left-right (comparing a jump run the other way)
    this.frameHooks = [];                 // fn(index) after a frame is drawn, besides onFrame
    this.pending = null;                  // newest frame asked for and not drawn yet
    this.waiting = [];                    // show() promises to settle once it is drawn
    this.head = new Map();                // frames at the loop start, owned by the player
    this.headRun = 0;
    this.#build(root);
    this.#resize();
    this.ro = new ResizeObserver(() => { this.#resize(); this.#redraw(); });
    this.ro.observe(this.stage);
    this.filmRun = 0;
    this.#fillFilm();
  }

  #build(root) {
    root.innerHTML = `
      <div class="stage"><canvas></canvas></div>
      <div class="hud"><span class="fr"></span><span class="zm"></span></div>
      <div class="timeline"><div class="film"></div><div class="bands"></div><input type="range" class="scrub" min="0" value="0" step="1" aria-label="Snímka"></div>
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
    this.filmEl = root.querySelector('.film');
    this.playBtn = root.querySelector('.play');
    this.scrub.max = String(this.src.count - 1);
    this.canvas.style.touchAction = 'pan-y'; // the page still scrolls until zoomed in

    // A drag on the timeline runs on the phone's own video decoder, like playback does: through
    // the canvas every position was decoded from its keyframe and the drag stuttered while play ran
    // smooth (Stanley, 2026-11-20). The exact frame is drawn once the finger lets go.
    this.scrub.addEventListener('input', () => { this.pause(); this.#scrubTo(+this.scrub.value); });
    this.scrub.addEventListener('change', () => this.#scrubEnd());
    ['pointerup', 'pointercancel', 'touchend', 'touchcancel'].forEach(t => this.scrub.addEventListener(t, () => this.#scrubEnd()));
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
  // The filmstrip under the picture, like the iPhone's Photos in iOS 6-8 (Stanley 2026-11-16):
  // thumbnails across the range, and the finger dragged along them moves through the video (the
  // range input lies over them). Decoded once per range on a small sink of its own.
  async #fillFilm() {
    const run = ++this.filmRun, el = this.filmEl, { src } = this;
    if (!el || !src.mb || !src.track) return;
    const { from, to } = this.range, n = 10;
    const h = 44, w = Math.max(24, Math.round((h * src.width) / Math.max(1, src.height)));
    el.innerHTML = '';
    let sink;
    try { sink = new src.mb.CanvasSink(src.track, { width: w * 2, height: h * 2, fit: 'cover' }); } catch { return; }
    const idx = Array.from({ length: n }, (_, k) => Math.round(from + ((to - from) * (k + 0.5)) / n));
    const times = idx.map(i => this.ts[i]);
    const cells = idx.map(() => { const c = document.createElement('canvas'); c.width = w * 2; c.height = h * 2; el.appendChild(c); return c; });
    try {
      let k = 0;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        if (run !== this.filmRun) break;
        if (wc) cells[k].getContext('2d').drawImage(wc.canvas, 0, 0, cells[k].width, cells[k].height);
        k++;
      }
    } catch (e) { console.warn('filmstrip decode failed', e); }
  }

  setRange(from, to) {
    const last = this.src.count - 1;
    const a = clamp(Math.round(from), 0, last), z = clamp(Math.round(to), a, last);
    this.range = { from: a, to: z };
    this.scrub.min = String(a);
    this.scrub.max = String(z);
    this.#fillFilm();
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
        if (bmp && bmp.width) { this.index = i; this.bmp = bmp; this.#redraw(); this.onFrame?.(i); for (const f of this.frameHooks) f(i); }
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
    this.#placeVideo();
  }

  // Maps frame pixel coordinates to canvas pixels (for overlays).
  // Mirrored: the frame flips, and so do the points, so the skeleton stays on the athlete while
  // every label is still drawn the right way round.
  toCanvas = (x, y) => [(this.mirror ? this.src.width - x : x) * this.fit * this.view.s + this.view.tx, y * this.fit * this.view.s + this.view.ty];

  #redraw() {
    const { ctx, canvas } = this;
    // FrameSource may have evicted (closed) this bitmap; keep what's on the canvas.
    if (this.bmp && !this.bmp.width) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.scrubbing) {   // the video shows the picture underneath; only the drawings go on top
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const o of this.overlays) { try { o(ctx, this.toCanvas, this.index); } catch (e) { console.warn('overlay failed', e); } }
      return;
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!this.bmp) return;
    const k = this.fit * this.view.s;
    if (this.mirror) ctx.setTransform(-k, 0, 0, k, this.view.tx + this.src.width * k, this.view.ty);
    else ctx.setTransform(k, 0, 0, k, this.view.tx, this.view.ty);
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
    if (this.videoOn) { this.video.playbackRate = this.speed; return; } // speed change while playing
    this.playing = true;
    this.playBtn.textContent = 'Pauza';
    this.playBtn.setAttribute('aria-label', 'Pauza');
    if (this.#canUseVideo()) { this.#playVideo(); return; }
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
    if (this.videoOn) { this.#stopVideo(); return; }
    if (this.head.has(this.index)) this.show(this.target); // swap the head frame for a sharp one
  }

  // ---------- scrubbing on the video ----------
  #canScrubVideo() { return !!this.video && !this.video.error && this.view.s <= 1.01; }

  #scrubTo(i) {
    if (!this.#canScrubVideo()) { this.show(i); return; }
    const v = this.video;
    if (!this.scrubbing) {
      this.scrubbing = true;
      this.#placeVideo();
      v.style.transform = this.mirror ? 'scaleX(-1)' : '';
      v.style.visibility = 'visible';
      // iOS shows nothing on a video that never played: a muted play/pause inside the gesture wakes it
      if (v.readyState < 2) v.play().then(() => { if (this.scrubbing) v.pause(); }).catch(() => {});
    }
    this.scrubTarget = i;
    this.#videoFrame(i);
    this.#redraw();
    if (!this.seeking) this.#seekVideo(i);
  }

  // One seek at a time, always to the newest position: a queue of seeks lags behind the finger.
  #seekVideo(i) {
    const v = this.video;
    if (!v) return;
    this.seeking = true;
    const done = () => {
      v.removeEventListener('seeked', done);
      clearTimeout(this.seekTimer);
      this.seeking = false;
      if (this.scrubbing && this.scrubTarget !== i) this.#seekVideo(this.scrubTarget);
    };
    v.addEventListener('seeked', done);
    this.seekTimer = setTimeout(done, 400);   // a seek the browser drops must not stop the drag
    v.currentTime = this.ts[i] - this.ts[0];
  }

  // Back to the canvas on the exact frame, swapped in once it is drawn.
  #scrubEnd() {
    if (!this.scrubbing) return;
    this.scrubbing = false;
    const v = this.video, i = this.scrubTarget ?? this.index;
    this.show(i).then(() => {
      if (this.scrubbing || this.videoOn || !v) return;
      v.style.visibility = 'hidden';
      v.style.transform = '';
      this.#redraw();
    });
  }

  // ---------- native playback ----------
  // Stored RSI and sprint clips play through the phone's own video decoder: decoding every frame
  // onto the canvas could not keep up on the phone, so "Reálna" played slowed down and jerky, and
  // skipping late frames looked worse still (2026-11-15). The canvas stays for pause, frame steps,
  // scrubbing and zoom; while the video plays, the frame index follows its clock so the labels
  // and frameHooks (the RSI scoreboard) keep up.
  attachVideo(blob) {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'auto';
    v.setAttribute('muted', ''); v.setAttribute('playsinline', '');
    v.style.cssText = 'position:absolute;object-fit:fill;pointer-events:none;visibility:hidden';
    // OPFS hands a stored clip back with no type, and WebKit will not play an untyped blob
    // (the struck-out play button of 0.16.3).
    this.videoUrl = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: 'video/quicktime' }));
    v.addEventListener('error', () => { console.warn('native video failed', v.error); this.#dropVideo(); }, { once: true });
    v.src = this.videoUrl;
    if (getComputedStyle(this.stage).position === 'static') this.stage.style.position = 'relative';
    this.stage.prepend(v); // under anything the views put on the stage (the scoreboard)
    this.canvas.style.position = 'relative';
    this.video = v;
    this.#placeVideo();
  }

  #placeVideo() {
    const v = this.video, c = this.canvas;
    if (!v) return;
    Object.assign(v.style, { left: `${c.offsetLeft}px`, top: `${c.offsetTop}px`, width: c.style.width, height: c.style.height });
  }

  #canUseVideo() {
    // Not gated on readyState: iOS may load nothing before the first play().
    return !!this.video && !this.video.error && this.view.s <= 1.01 && !this.overlays.length;
  }

  async #playVideo() {
    const v = this.video, ts = this.ts, t0 = ts[0];
    const run = this.playRun = (this.playRun || 0) + 1;
    this.#placeVideo();
    v.playbackRate = this.speed;
    v.currentTime = ts[this.target] - t0;
    try { await v.play(); } catch (e) {
      console.warn('native playback refused', e);
      this.#dropVideo();
      if (this.playing && this.playRun === run) { this.playing = false; this.play(); } // canvas instead
      return;
    }
    if (!this.playing || this.playRun !== run) { v.pause(); return; }
    this.videoOn = true;
    v.style.visibility = 'visible';
    this.canvas.style.visibility = 'hidden';
    const tick = () => {
      if (!this.videoOn || this.playRun !== run) return;
      const { from, to } = this.range;
      const t = v.currentTime + t0;
      if (t >= ts[to] || v.ended) {
        if (!this.loop) { this.#videoFrame(to); this.pause(); return; }
        v.currentTime = ts[from] - t0;
        if (v.paused) v.play().catch(() => {});
      } else {
        const i = clamp(nearestIndex(ts, t), from, to);
        if (i !== this.index) this.#videoFrame(i);
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #videoFrame(i) {
    this.index = i;
    this.#label(i);
    this.onFrame?.(i);
    for (const f of this.frameHooks) f(i);
  }

  // Back to the canvas on the frame the video stopped at, swapped in once it is drawn.
  #stopVideo() {
    const v = this.video;
    this.videoOn = false;
    v.pause();
    const { from, to } = this.range;
    const i = clamp(nearestIndex(this.ts, v.currentTime + this.ts[0]), from, to);
    this.show(i).then(() => {
      if (this.videoOn) return;
      this.canvas.style.visibility = '';
      v.style.visibility = 'hidden';
    });
  }

  #dropVideo() {
    const v = this.video;
    if (!v) return;
    this.video = null;
    this.videoOn = false;
    v.pause(); v.removeAttribute('src'); v.load(); v.remove();
    this.canvas.style.visibility = '';
    if (this.videoUrl) URL.revokeObjectURL(this.videoUrl);
    this.videoUrl = null;
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
    if (this.videoOn) this.pause();
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
    this.filmRun++;
    this.#dropHead();
    this.#dropVideo();
    this.ro.disconnect();
    removeEventListener('keydown', this.keyHandler);
    this.src.dispose();
    this.#settle();
  }
}
