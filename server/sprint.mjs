// Sprint jobs: pose on every frame, then each toe's motion measured against the track beside the
// athlete, frame by frame. A foot is on the ground while its toe stands still relative to the
// track, not while it looks low: from a hand-held, panning, low camera a foot a few cm up looks
// grounded (Stanley's IMG_3479 read 0.16 s by eye, 0.10 s this way; "určite nie som na zemi 0,16 s",
// 2026-11-13). No tripod, ever. The phone pairs the steps with the Freelap run and does the metres
// (js/analysis/sprint.js), so Freelap data never leaves it.
import { execFileSync } from 'node:child_process';
import { identifyAthlete } from './identify.mjs';
import { runPipeline } from '../js/pose/pipeline.js';
import { toWire, fromWire } from '../js/cloud.js';
import { JI } from '../js/pose/models.js';
import { sprintFromMotion } from '../js/analysis/sprint.js';
import { probe, openFrames } from './frames.mjs';

// ---------- Pixels ----------
// Grey image shrunk by an integer factor (box average), so the athlete is about 200 px tall
// whatever the clip: the patch sizes below are fractions of the athlete, and the search stays cheap.
export function shrink(rgba, W, H, d) {
  const w = Math.floor(W / d), h = Math.floor(H / d), out = new Float32Array(w * h), n = d * d;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    for (let j = 0; j < d; j++) {
      let o = ((y * d + j) * W + x * d) * 4;
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
export async function measureMotion({ getRGBA, W, H, track, from, to }) {
  const out = [];
  let prev = null, prevD = 0, g0 = [0, 0];
  for (let f = from; f < to; f++) {
    const kp = track[f], kq = track[f + 1], box = kp && athleteBox(kp);
    if (!box || !kq || box.h < 20) { prev = null; out.push(null); continue; }
    const d = Math.max(1, Math.floor(box.h / 200));
    const A = prev && prevD === d && prev.f === f ? prev.img : shrink(await getRGBA(f), W, H, d);
    const B = shrink(await getRGBA(f + 1), W, H, d);
    prev = { f: f + 1, img: B }; prevD = d;
    const hs = box.h / d, rec = { f, h: box.h };
    // The track at the feet: strips left and right of the athlete at the lower toe's height, and
    // one just under the feet. A close athlete fills the width, so each is cut to what is in frame.
    const toes = ['l', 'r'].map(s => pt(kp, `${s}bigtoe`)).filter(Boolean);
    const low = (toes.length ? Math.max(...toes.map(p => p[1])) : box.y1) / d;
    const sh = Math.max(9, Math.round(0.12 * hs)), gap = 0.12 * hs, R = Math.max(6, Math.round(0.08 * hs)), edge = R + 2;
    const strips = [];
    const lx0 = edge, lx1 = box.x0 / d - gap, rx0 = box.x1 / d + gap, rx1 = A.w - edge;
    const sw = x => Math.min(Math.round(0.6 * hs), Math.floor(x));
    if (lx1 - lx0 >= 0.25 * hs) { const w = sw(lx1 - lx0); strips.push([lx1 - w / 2, low + 0.03 * hs, w]); }
    if (rx1 - rx0 >= 0.25 * hs) { const w = sw(rx1 - rx0); strips.push([rx0 + w / 2, low + 0.03 * hs, w]); }
    const by = low + 0.06 * hs + sh / 2;
    if (by + sh / 2 + edge < A.h) strips.push([(box.x0 + box.x1) / 2 / d, by, Math.min(Math.round(0.8 * hs), A.w - 2 * edge)]);
    const gs = [];
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
      const m = match(A, B, p[0] / d, p[1] / d, pw, ph, q[0] / d, q[1] / d, Math.max(4, Math.round(0.06 * hs)));
      if (m) rec[s] = [m.dx * d, m.dy * d, +m.score.toFixed(2), +p[0].toFixed(1), +p[1].toFixed(1)];
    }
    out.push(rec);
  }
  return smoothGround(out);
}

// The camera turns smoothly: a frame whose track match failed takes its neighbours' motion, and
// one odd match is replaced by the median of five.
export function smoothGround(out) {
  const idx = out.map((r, i) => (r?.g ? i : -1)).filter(i => i >= 0);
  if (!idx.length) return out;
  const raw = out.map(r => r?.g ?? null);
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
  const filled = out.map(r => r?.g ?? null);
  for (let i = 0; i < out.length; i++) {
    if (!filled[i]) continue;
    const win = filled.slice(Math.max(0, i - 2), i + 3).filter(Boolean);
    if (win.length < 3) continue;
    const med = k => win.map(g => g[k]).sort((x, y) => x - y)[Math.floor(win.length / 2)];
    out[i].g = [med(0), med(1)];
  }
  return out;
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

export async function analyzeSprintClip(engine, { clip, athletes = null, client, onProgress }) {
  const t0 = performance.now();
  const meta = probe(clip);
  const frames = openFrames(clip, meta);
  try {
    const res = await runPipeline(frames, engine, { onProgress });
    if (res.error) return { error: 'Vo videu som nenašiel bežca. Skontroluj, či sú v zábere celé nohy.' };
    const wire = toWire(res, meta.ts);
    const track = fromWire(wire).clean;
    onProgress?.({ stage: 'contacts', done: 0, total: 1 });
    const it = frames.sequential(res.first, res.last, 1);
    let at = -1, cur = null;
    const getRGBA = async f => {
      while (at < f) { const r = await it.next(); if (r.done) throw new Error('clip ended'); at = r.value.i; cur = r.value.rgba; }
      return cur;
    };
    let motion;
    try { motion = await measureMotion({ getRGBA, W: meta.W, H: meta.H, track, from: res.first, to: res.last }); }
    finally { await it.return?.(); }
    let who = null;
    if (client && athletes?.length > 1) {
      try { who = await identifyAthlete({ frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, athletes, client }); }
      catch (e) { who = { id: null, error: String(e?.message || e).slice(0, 200) }; }
      who = { id: athletes.find(x => x.id === who.id)?.id ?? null, said: who.said ?? null, ms: who.ms, error: who.error };
    }
    const sprint = sprintFromMotion({ motion, ts: meta.ts, fps: meta.fps });
    if (sprint.error) return { error: sprint.error };
    const result = {
      kind: 'sprint', ...sprint, ...(who ? { who } : {}),
      recordedAt: recordedAt(clip), duration: +(meta.ts[meta.N - 1] - meta.ts[0]).toFixed(3),
      W: meta.W, H: meta.H, N: meta.N, fps: +meta.fps.toFixed(3), ms: Math.round(performance.now() - t0),
    };
    return { result };
  } finally {
    frames.close();
  }
}
