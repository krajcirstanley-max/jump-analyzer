// Sprint jobs: pose on every frame, then each toe's motion measured against the track beside the
// athlete, frame by frame. A foot is on the ground while its toe stands still relative to the
// track, not while it looks low: from a hand-held, panning, low camera a foot a few cm up looks
// grounded (Stanley's IMG_3479 read 0.16 s by eye, 0.10 s this way; "určite nie som na zemi 0,16 s",
// 2026-11-13). No tripod, ever. The phone pairs the steps with the Freelap run and does the metres
// (js/analysis/sprint.js), so Freelap data never leaves it.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { identifyAthlete } from './identify.mjs';
import { runPipeline } from '../js/pose/pipeline.js';
import { toWire, fromWire } from '../js/cloud.js';
import { JI } from '../js/pose/models.js';
import { sprintFromMotion, sprintLooks, withCamera } from '../js/analysis/sprint.js';
import { probe, openFrames } from './frames.mjs';

// ---------- Pixels ----------
// Grey image shrunk by an integer factor (box average), so the athlete is about 200 px tall
// whatever the clip: the patch sizes below are fractions of the athlete, and the search stays cheap.
// ox, oy, rw, rh: only that region (full-resolution px), so a frame costs the band around the
// feet instead of the whole 1080x1920 (2026-11-15: the whole frame made this pass 20 s a clip).
export function shrink(rgba, W, H, d, ox = 0, oy = 0, rw = W - ox, rh = H - oy) {
  const w = Math.floor(rw / d), h = Math.floor(rh / d), out = new Float32Array(w * h), n = d * d;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < d; j++) {
      let o = ((oy + y * d + j) * W + ox + x * d) * 4;
      for (let i = 0; i < d; i++, o += 4) s += rgba[o] * 0.299 + rgba[o + 1] * 0.587 + rgba[o + 2] * 0.114;
    }
    out[y * w + x] = s / n;
  }
  return { L: out, w, h };
}

// Best normalised cross-correlation of the patch of A at (cx, cy) inside B, searched around
// (px, py) within r. Returns the displacement from (cx, cy) with a sub-pixel parabola fit.
export function match(A, B, cx, cy, pw, ph, px, py, r, step = 1) {
  const { L: a, w, h } = A, b = B.L;
  const x0 = Math.round(cx - pw / 2), y0 = Math.round(cy - ph / 2);
  if (x0 < 0 || y0 < 0 || x0 + pw > w || y0 + ph > h) return null;
  let m = 0, n = 0;
  for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) { m += a[(y0 + y) * w + x0 + x]; n++; }
  m /= n;
  let va = 0;
  for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) { const v = a[(y0 + y) * w + x0 + x] - m; va += v * v; }
  if (va < n * 4) return null; // flat patch: nothing to match on
  const ox = Math.round(px - cx), oy = Math.round(py - cy), R = 2 * r + 1, score = new Float32Array(R * R).fill(-2);
  let best = -2, bx = 0, by = 0;
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const sx = x0 + ox + dx, sy = y0 + oy + dy;
    if (sx < 0 || sy < 0 || sx + pw > w || sy + ph > h) continue;
    let mb = 0;
    for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) mb += b[(sy + y) * w + sx + x];
    mb /= n;
    let ab = 0, vb = 0;
    for (let y = 0; y < ph; y += step) for (let x = 0; x < pw; x += step) {
      const u = a[(y0 + y) * w + x0 + x] - m, v = b[(sy + y) * w + sx + x] - mb;
      ab += u * v; vb += v * v;
    }
    const s = vb > 0 ? ab / Math.sqrt(va * vb) : -2;
    score[(dy + r) * R + dx + r] = s;
    if (s > best) { best = s; bx = dx; by = dy; }
  }
  if (best < -1) return null;
  const at = (dx, dy) => (Math.abs(dx) <= r && Math.abs(dy) <= r ? score[(dy + r) * R + dx + r] : -2);
  const sub = (l, c, rr) => (l > -2 && rr > -2 && l - 2 * c + rr < 0 ? (0.5 * (l - rr)) / (l - 2 * c + rr) : 0);
  const fx = sub(at(bx - 1, by), best, at(bx + 1, by)), fy = sub(at(bx, by - 1), best, at(bx, by + 1));
  return { dx: ox + bx + fx, dy: oy + by + fy, score: best };
}

const pt = (kp, n) => (kp && kp[JI[n] * 3 + 2] >= 0.3 && Number.isFinite(kp[JI[n] * 3]) ? [kp[JI[n] * 3], kp[JI[n] * 3 + 1]] : null);
export function athleteBox(kp) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let j = 0; j < kp.length; j += 3) {
    if (!(kp[j + 2] >= 0.3) || !Number.isFinite(kp[j])) continue;
    x0 = Math.min(x0, kp[j]); x1 = Math.max(x1, kp[j]); y0 = Math.min(y0, kp[j + 1]); y1 = Math.max(y1, kp[j + 1]);
  }
  return x1 > x0 ? { x0, x1, y0, y1, h: y1 - y0 } : null;
}

// Per frame f (motion from f to f+1): the athlete's height h in px, the track's motion beside
// the athlete at the feet (g), and each toe's motion (l, r), all in full-resolution px.
// getRGBA(f) -> RGBA buffer, frames in increasing order. track: keypoints per frame.
export async function measureMotion(args) { return smoothGround(await measureMotionRaw(args), { shake: true }); }

// A toe the pose lost for a few frames (2026-11-18: the right toe of today's 7.3 s clip at 262-265,
// 13:06 at 1079-1083, both while the shoe stood on the track) gets its place straight between the
// frames either side, up to `maxGap` frames, so the toe's pixels are still matched there. Marked by
// the score FILLED, exact in float32; the steps keep a stance only where a real toe stood (sprint.js).
export const FILLED = 0.3125;
export function fillToes(track, maxGap = 6) {
  const out = track.map(k => (k ? Float32Array.from(k) : k));
  for (const s of ['l', 'r']) {
    const j = JI[`${s}bigtoe`] * 3, ok = k => k && k[j + 2] >= 0.3 && Number.isFinite(k[j]);
    let last = -1;
    for (let i = 0; i < out.length; i++) {
      if (!ok(track[i])) continue;
      if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
        for (let f = last + 1; f < i; f++) {
          if (!out[f]) continue;
          const t = (f - last) / (i - last);
          out[f][j] = track[last][j] + t * (track[i][j] - track[last][j]);
          out[f][j + 1] = track[last][j + 1] + t * (track[i][j + 1] - track[last][j + 1]);
          out[f][j + 2] = FILLED;
        }
      }
      last = i;
    }
  }
  return out;
}

// The same pass split over worker threads (2026-11-15: one core took 13-17 s of a 13 s clip while
// seven idled). Each part starts a few frames early so the ground's predicted motion (g0) is warm
// at its first frame as it would be in one pass; the early frames are dropped. Frames come from
// the decoded file (frames.mjs 'disk'), which every worker reads on its own.
// The frames are handed out in pieces of `chunk` to whichever thread is free (2026-11-18: six equal
// parts of a cut sprint took 0.35 s to 5.8 s, as the runner grows in the picture and a frame's cost
// with them). Each piece starts `warm` frames early, those dropped, so the joined pieces are the
// one pass's numbers.
export async function measureMotionParallel({ fd, W, H, track, from, to, parts = Math.max(1, Math.min(7, os.cpus().length - 1)), warm = 10, chunk = 40 }) {
  const n = to - from;
  if (parts < 2 || n < 60) return null;   // a clip cut to the Freelap stretch is 250-500 frames
  const pieces = [];
  for (let a = from; a < to; a += chunk) pieces.push([a, Math.min(to, a + chunk)]);
  const out = await motionPool({ fd, W, H, track, pieces, warm, threads: Math.min(parts, pieces.length) });
  const all = smoothGround(out.flat(), { shake: true });
  all.stats = { pieces: out.length, threads: Math.min(parts, pieces.length), cpuMs: out.stats.reduce((x, m) => x + m.all, 0), readMs: out.stats.reduce((x, m) => x + m.read, 0) };
  return all;
}

// Runs measureMotionRaw over pieces [a, b, floor?) on `threads` worker threads, each piece from
// a - warm (not before its floor, else `floor`) with the warm frames dropped. -> one array of
// records per piece, in order.
export async function motionPool({ fd, W, H, track, pieces, warm = 10, threads = 6, floor = null }) {
  const { Worker } = await import('node:worker_threads');
  const lo = floor ?? Math.min(...pieces.map(p => p[0]));
  const out = new Array(pieces.length);
  let next = 0;
  const stats = [];
  const run = () => new Promise((res, rej) => {
    const w = new Worker(new URL('./motion-worker.mjs', import.meta.url), { workerData: { fd, W, H } });
    const give = () => {
      if (next >= pieces.length) { w.postMessage(null); return; }
      const k = next++, [a, b, f0] = pieces[k], s0 = Math.max(f0 ?? lo, a - warm);
      w.once('message', m => {
        if (m.error) { w.terminate(); return rej(new Error(m.error)); }
        out[k] = m.out.slice(a - s0); stats.push(m.ms);
        give();
      });
      w.postMessage({ from: s0, to: b, track: track.slice(s0, b + 1), base: s0 });
    };
    w.once('exit', () => res());
    w.once('error', rej);
    give();
  });
  await Promise.all(Array.from({ length: threads }, run));
  out.stats = stats;
  return out;
}

// getRows(f, oy, rh): only the rows oy..oy+rh of frame f (a part reading the file needs the band
// around the feet, about a sixth of the frame, not all 8 MB of it).
export async function measureMotionRaw({ getRGBA, getRows = null, W, H, track, from, to, trackBase = 0 }) {
  const out = [];
  let prev = null, prevD = 0, g0 = [0, 0];
  for (let f = from; f < to; f++) {
    const kp = track[f - trackBase], kq = track[f + 1 - trackBase], box = kp && athleteBox(kp);
    if (!box || !kq || box.h < 20) { prev = null; out.push(null); continue; }
    const d = Math.max(1, Math.floor(box.h / 200));   // ceil (100-200 px) was 6x faster but lost steps and toe-offs (2026-11-18)
    const toes = ['l', 'r'].map(s => pt(kp, `${s}bigtoe`)).filter(Boolean);
    const lowFull = toes.length ? Math.max(...toes.map(p => p[1])) : box.y1;
    const fp = ['l', 'r'].flatMap(s => ['bigtoe', 'smalltoe', 'heel', 'ank'].map(n => pt(kp, s + n))).filter(Boolean);
    const fx0 = fp.length ? Math.min(...fp.map(p => p[0])) : box.x0, fx1 = fp.length ? Math.max(...fp.map(p => p[0])) : box.x1;
    // The band the strips and toe patches can reach, with their search room; whole multiples of d.
    const snap = v => Math.floor(v / d) * d;
    const top = Math.min(lowFull, ...fp.map(p => p[1])) - 0.3 * box.h;
    const ox = Math.max(0, snap(fx0 - 1.1 * box.h)), oy = Math.max(0, snap(top));
    const rw = snap(Math.min(W, fx1 + 1.1 * box.h) - ox), rh = snap(Math.min(H, lowFull + 0.45 * box.h) - oy);
    const roi = [ox, oy, rw, rh].join();
    const img = async g => (getRows ? shrink(await getRows(g, oy, rh), W, rh, d, ox, 0, rw, rh) : shrink(await getRGBA(g), W, H, d, ox, oy, rw, rh));
    const A = prev && prevD === d && prev.f === f && prev.roi === roi ? prev.img : await img(f);
    const B = await img(f + 1);
    prev = { f: f + 1, img: B, roi }; prevD = d;
    const hs = box.h / d, rec = { f, h: box.h };
    // The track at the feet: strips left and right of the athlete at the lower toe's height, and
    // one just under the feet. A close athlete fills the width, so each is cut to what is in frame.
    const X = v => (v - ox) / d, Y = v => (v - oy) / d;   // full-resolution px -> region px
    const low = Y(lowFull);
    // The search: up to 8 %h around where the track and the toe are expected, never more than 16 / 12 px
    // of the shrunk image (the search grew with the 4th power of a close athlete's size: 5 s -> 2 s,
    // the same steps to the frame on four clips, 2026-11-18).
    const sh = Math.max(9, Math.round(0.12 * hs)), gap = 0.08 * hs, R = Math.min(16, Math.max(6, Math.round(0.08 * hs))), edge = R + 2;
    const strips = [];
    // Beside the feet, not beside the whole body: filmed close from the front (RSI, IMG_3521) the
    // body and arms fill the width and no strip beside them fits, while the floor next to the
    // feet is in view.
    const lx0 = edge, lx1 = X(fx0) - gap, rx0 = X(fx1) + gap, rx1 = A.w - edge;
    const sw = x => Math.min(Math.round(0.6 * hs), Math.floor(x));
    if (lx1 - lx0 >= 0.25 * hs) { const w = sw(lx1 - lx0); strips.push([lx1 - w / 2, low + 0.03 * hs, w]); }
    if (rx1 - rx0 >= 0.25 * hs) { const w = sw(rx1 - rx0); strips.push([rx0 + w / 2, low + 0.03 * hs, w]); }
    const by = low + 0.06 * hs + sh / 2;
    if (by + sh / 2 + edge < A.h) strips.push([X((fx0 + fx1) / 2), by, Math.min(Math.round(0.8 * hs), A.w - 2 * edge)]);
    const gs = [];
    // (2026-11-18: dropping strips that move with the hips fixed one close step and lost 5-6 others)
    for (const [cx, cy, w] of strips) {
      const m = match(A, B, cx, cy, w, sh, cx + g0[0] / d, cy + g0[1] / d, R, 2);
      if (m && m.score > 0.5) gs.push(m);
    }
    if (gs.length) {
      const med = k => gs.map(m => m[k]).sort((a, b) => a - b)[Math.floor((gs.length - 1) / 2)];
      rec.g = [med('dx') * d, med('dy') * d]; g0 = rec.g;
    } else rec.g = null;
    for (const s of ['l', 'r']) {
      const p = pt(kp, `${s}bigtoe`), q = pt(kq, `${s}bigtoe`);
      if (!p || !q) continue;
      const pw = Math.max(9, Math.round(0.12 * hs)), ph = Math.max(7, Math.round(0.1 * hs));
      const m = match(A, B, X(p[0]), Y(p[1]), pw, ph, X(q[0]), Y(q[1]), Math.min(12, Math.max(4, Math.round(0.06 * hs))));
      if (m) rec[s] = [m.dx * d, m.dy * d, +m.score.toFixed(2), +p[0].toFixed(1), +p[1].toFixed(1)];
      if (m && (kp[JI[`${s}bigtoe`] * 3 + 2] === FILLED || kq[JI[`${s}bigtoe`] * 3 + 2] === FILLED)) rec[`${s}f`] = 1;
    }
    out.push(rec);
  }
  return out;
}

// The camera turns smoothly: a frame whose track match failed takes its neighbours' motion, and
// odd matches are replaced by the median around them.
// shake (sprints): a match is kept as it is unless it is more than 3 % of the athlete's height off
// the median of its 13 frames. A phone in the hand bobs up and down within a stance (13:11 clip:
// the track moved +3 then -6 px a frame within 0.1 s), and the median took that bob away, so a toe
// standing on the track seemed to move with it: touchdowns 2-4 frames late, toe-offs 2 early. The
// raw match follows the standing toe to under 0.5 % of the height. RSI keeps the plain median.
export function smoothGround(out, { shake = false } = {}) {
  const idx = out.map((r, i) => (r?.g ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return out;
  const raw = out.map(r => r?.g ?? null);
  for (let i = 0; i < out.length; i++) if (out[i] && raw[i]) out[i].gRaw = raw[i];   // the match itself, before any filling or median
  for (let i = 0; i < out.length; i++) {
    if (!out[i] || raw[i]) continue;
    const a = idx.findLast(j => j < i), b = idx.find(j => j > i);
    if (a == null && b == null) continue;
    if (a == null || b == null) { out[i].g = [...raw[a ?? b]]; out[i].gFill = true; continue; }
    if (b - a > 12) continue; // a long hole: leave it unknown rather than guess
    const t = (i - a) / (b - a);
    out[i].g = [raw[a][0] + t * (raw[b][0] - raw[a][0]), raw[a][1] + t * (raw[b][1] - raw[a][1])];
    out[i].gFill = true;
  }
  // The pan changes slowly: a median over 13 frames (0.1 s) rides out a run of up to six bad
  // matches (IMG_3480 on the GPU: -18 px, then -34, then +8..+38 for a few frames).
  const filled = out.map(r => r?.g ?? null);
  for (let i = 0; i < out.length; i++) {
    if (!filled[i]) continue;
    const win = filled.slice(Math.max(0, i - 6), i + 7).filter(Boolean);
    if (win.length < 3) continue;
    const med = k => win.map(g => g[k]).sort((x, y) => x - y)[Math.floor(win.length / 2)];
    const m = [med(0), med(1)];
    out[i].g = shake && raw[i] && Math.hypot(raw[i][0] - m[0], raw[i][1] - m[1]) <= 0.03 * out[i].h ? [...raw[i]] : m;
  }
  return out;
}

// The camera's own motion from frame to frame, measured on the whole picture outside the runner
// (camflow.py, 2026-11-22). Straight at the phone, the strips beside the feet see one flat red
// track and their match jumped 10-18 px a frame while the phone panned a steady 8: 16 of 17
// Freelap stretches of that day lost most of their steps. -> Map f -> [dx, dy], or null if the
// pass could not run (then the strips stand, as before).
export async function cameraMotion({ fd, W, H, track, from, to }) {
  if (process.platform !== 'linux' || fd == null) return null;
  const { spawn } = await import('node:child_process');
  const boxes = {};
  for (let f = from; f < to; f++) {
    const kp = track[f], box = kp && athleteBox(kp);
    if (!box) continue;
    const toes = ['l', 'r'].map(s => pt(kp, `${s}bigtoe`)).filter(Boolean);
    boxes[f] = [box.x0, box.y0, box.x1, box.y1, toes.length ? Math.max(...toes.map(p => p[1])) : box.y1].map(v => +v.toFixed(1));
  }
  const one = (a, b) => new Promise((res, rej) => {
    const p = spawn(process.env.JUMP_PYTHON || 'python3', [new URL('./camflow.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', d => { o += d; });
    p.stderr.on('data', d => { e = (e + d).slice(-600); });
    p.on('error', rej);
    p.on('close', code => (code ? rej(new Error(`camflow exited ${code}: ${e.trim()}`)) : res(JSON.parse(o))));
    p.stdin.end(JSON.stringify({ path: `/proc/${process.pid}/fd/${fd}`, W, H, from: a, to: b, boxes }));
  });
  // one process took 9-19 s of a 400-680 frame clip (2026-11-22, beside a 3 s toe pass): the frames
  // are independent pairs, so the range is split over processes
  const n = to - from, parts = Math.max(1, Math.min(8, Math.ceil(n / 60))), step = Math.ceil(n / parts);
  const outs = await Promise.all(Array.from({ length: parts }, (_, k) => one(from + k * step, Math.min(to, from + (k + 1) * step))));
  const cam = new Map();
  for (const out of outs) for (const [f, all, band] of out) cam.set(f, band ?? all);
  return cam;
}

// When the clip was filmed: the iPhone's own creation date (local time with offset), else the
// container's UTC time. The phone pairs it with the Freelap run heard at that moment.
export function recordedAt(clip) {
  try {
    const t = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', clip]).toString()).format?.tags ?? {};
    const s = t['com.apple.quicktime.creationdate'] ?? t.creation_time;
    const ms = s ? Date.parse(s) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

// The sprint's foot contacts for a clip already posed (2026-11-20): the long jump finds its board
// contact among them instead of asking Claude to read every frame, the way the sprint counts its
// steps. Same toe-against-track rule, same parallel pass. timing gets motion / motionParts.
export async function stepsOf({ frames, meta, res, wire, timing = {} }) {
  const pose = fromWire(wire).clean, track = fillToes(pose);
  const tM = performance.now();
  let motion = null;
  if (frames.fd) {
    await frames.get(res.last);
    motion = await measureMotionParallel({ fd: await frames.fd(), W: meta.W, H: meta.H, track, from: res.first, to: res.last })
      .catch(e => { timing.motionError = String(e?.message || e).slice(0, 300); return null; });
  }
  if (!motion) {
    const it = frames.sequential(res.first, res.last, 1);
    let at = -1, cur = null;
    const getRGBA = async f => {
      while (at < f) { const r = await it.next(); if (r.done) throw new Error('clip ended'); at = r.value.i; cur = r.value.rgba; }
      return cur;
    };
    try { motion = await measureMotion({ getRGBA, W: meta.W, H: meta.H, track, from: res.first, to: res.last }); }
    finally { await it.return?.(); }
  }
  timing.motion = Math.round(performance.now() - tM);
  timing.motionParts = motion?.stats;
  return sprintFromMotion({ motion, ts: meta.ts, fps: meta.fps });
}

export async function analyzeSprintClip(engine, { clip, athletes = null, who: known = null, client, onProgress, dump = false }) {
  const t0 = performance.now();
  const meta = probe(clip);
  const frames = openFrames(clip, meta);
  // where the seconds go, stage by stage (kept on the result: the speed work is measured, not guessed)
  const timing = { probe: Math.round(performance.now() - t0), decode: frames.mode };
  let stage = null, st0 = performance.now();
  const tick = p => { if (p?.stage !== stage) { if (stage) timing[stage] = Math.round(performance.now() - st0); stage = p?.stage; st0 = performance.now(); } onProgress?.(p); };
  try {
    const res = await runPipeline(frames, engine, { onProgress: tick });
    if (stage) timing[stage] = Math.round(performance.now() - st0);
    stage = null;
    if (res.error) return { error: 'Vo videu som nenašiel bežca. Skontroluj, či sú v zábere celé nohy.' };
    const wire = toWire(res, meta.ts);
    const pose = fromWire(wire).clean, track = fillToes(pose);
    onProgress?.({ stage: 'contacts', done: 0, total: 1 });
    const it = frames.sequential(res.first, res.last, 1);
    let at = -1, cur = null;
    const getRGBA = async f => {
      while (at < f) { const r = await it.next(); if (r.done) throw new Error('clip ended'); at = r.value.i; cur = r.value.rgba; }
      return cur;
    };
    // who it is (a vision call, seconds) runs while the feet are measured, not after
    const tId = performance.now();
    const whoP = known && athletes?.some(a => a.id === known) ? Promise.resolve({ id: known, said: 'freelap', ms: 0 })
      : client && athletes?.length > 1
      ? identifyAthlete({ frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, athletes, client })
        .catch(e => ({ id: null, error: String(e?.message || e).slice(0, 200) }))
        .then(w => { timing.identify = Math.round(performance.now() - tId); return { id: athletes.find(x => x.id === w.id)?.id ?? null, said: w.said ?? null, ms: w.ms, error: w.error }; })
      : Promise.resolve(null);
    const tM = performance.now();
    let motion = null, camP = Promise.resolve(null);
    if (frames.fd) {
      await frames.get(res.last);   // the file holds every frame the parts will read
      timing.cpus = os.cpus().length;
      const fd = await frames.fd(), tC = performance.now();
      // the camera's motion runs beside the toe pass, not after it
      camP = cameraMotion({ fd, W: meta.W, H: meta.H, track, from: res.first, to: res.last })
        .then(c => { timing.camera = Math.round(performance.now() - tC); return c; })
        .catch(e => { timing.cameraError = String(e?.message || e).slice(0, 300); return null; });
      motion = await measureMotionParallel({ fd, W: meta.W, H: meta.H, track, from: res.first, to: res.last }).catch(e => { console.error('parallel motion failed, one pass instead:', e); timing.motionError = String(e?.message || e).slice(0, 300); return null; });
      timing.parallel = !!motion;
    }
    try { motion ??= await measureMotion({ getRGBA, W: meta.W, H: meta.H, track, from: res.first, to: res.last }); }
    finally { await it.return?.(); }
    const cam = await camP;
    timing.cameraFrames = cam?.size ?? 0;
    motion = Object.assign(withCamera(motion, cam), { stats: motion.stats });
    timing.motion = Math.round(performance.now() - tM);
    timing.motionParts = motion?.stats;
    const who = await whoP;
    const sprint = sprintFromMotion({ motion, ts: meta.ts, fps: meta.fps });
    const dumpOf = () => ({ meta: { fps: meta.fps, W: meta.W, H: meta.H, N: meta.N }, ts: meta.ts, wire, motion, first: res.first, last: res.last });
    if (sprint.error) return dump ? { result: { error: sprint.error, steps: [], dump: dumpOf() } } : { error: sprint.error };
    // how each step looks from the side (foot against the hips, shin, trunk, knee): the advice's
    // "ako to vyzerá"; null where the camera did not see the step from the side
    sprint.looks = sprintLooks(pose, sprint.steps);
    const result = {
      kind: 'sprint', ...sprint, ...(who ? { who } : {}),
      // The raw toe/track motion, rounded: lets a better contact rule be re-run on the phone or
      // checked here without another upload. The phone does not keep it.
      motion: motion.map(m => m && { f: m.f, h: +m.h.toFixed(1), g: m.g && m.g.map(v => +v.toFixed(2)), l: m.l && m.l.slice(0, 3).map(v => +v.toFixed(2)), r: m.r && m.r.slice(0, 3).map(v => +v.toFixed(2)), ...(m.lf ? { lf: 1 } : {}), ...(m.rf ? { rf: 1 } : {}) }),
      ts0: meta.ts[0],
      recordedAt: recordedAt(clip), duration: +(meta.ts[meta.N - 1] - meta.ts[0]).toFixed(3),
      W: meta.W, H: meta.H, N: meta.N, fps: +meta.fps.toFixed(3), ms: Math.round(performance.now() - t0), timing,
    };
    // dump: the pose and the raw toe motion (with the toe's place) for the offline tests
    if (dump) result.dump = dumpOf();
    return { result };
  } finally {
    frames.close();
  }
}
