// Metres from the runway itself. The take-off line and the near edge of the sand are a known
// distance apart (2 m on Stanley's runway), and the two runway lines are 1.22 m apart, so the
// four points where those edges cross the lines are a rectangle of known size on the ground.
// Its image gives a ground-plane homography in every frame where it is seen, and the camera's
// pan is followed by tracking ground texture, so frames where part of it has left the picture
// still get one. Measured on three handheld clips (2026-11-10): the leg length from this scale
// came out within 1 % of 0.491 x height for Stanley; the gravity fit was 6-28 % off.
//
// Everything here works on raw RGBA frames and plain arrays; no DOM, no ffmpeg.
import { homography, applyH, invertH } from '../js/analysis/homography.js';
import { JI as KP } from '../js/pose/models.js';
export { homography, applyH, invertH };

export const RUNWAY_W = 1.22;

// ---------- pixels ----------
// Whiteness: bright and colourless. Track rubber is red, sand cream, lines and boards white.
export function whiteness(rgba, W, H) {
  const out = new Float32Array(W * H);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) {
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    out[i] = (r + g + b) / 3 - 1.5 * (mx - mn);
  }
  return out;
}
export function luma(rgba, W, H) {
  const out = new Float32Array(W * H);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = 0.299 * rgba[o] + 0.587 * rgba[o + 1] + 0.114 * rgba[o + 2];
  return out;
}
const at = (img, W, H, x, y) => { // bilinear
  if (x < 0 || y < 0 || x > W - 2 || y > H - 2) return NaN;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return img[i] * (1 - fx) * (1 - fy) + img[i + 1] * fx * (1 - fy) + img[i + W] * (1 - fx) * fy + img[i + W + 1] * fx * fy;
};
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// ---------- lines ----------
// y = m x + c through points, least squares.
function fitY(pts) {
  const n = pts.length; let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1e-9);
  return { m, c: (sy - m * sx) / n };
}
// x = m y + c (near-vertical edges), least squares.
const fitX = pts => fitY(pts.map(([x, y]) => [y, x]));

function ransacLines(pts, { tol = 2, minIn = 40, minDx = 120, maxSlope = 0.3, maxLines = 6, iters = 400, rand = mulberry(7) }) {
  let left = pts.slice();
  const lines = [];
  for (let k = 0; k < maxLines && left.length >= minIn; k++) {
    let best = null;
    for (let it = 0; it < iters; it++) {
      const a = left[(rand() * left.length) | 0], b = left[(rand() * left.length) | 0];
      if (Math.abs(a[0] - b[0]) < minDx) continue;
      const m = (b[1] - a[1]) / (b[0] - a[0]);
      if (Math.abs(m) > maxSlope) continue;
      const c = a[1] - m * a[0];
      let n = 0; for (const p of left) if (Math.abs(p[1] - (m * p[0] + c)) < tol) n++;
      if (!best || n > best.n) best = { m, c, n };
    }
    if (!best || best.n < minIn) break;
    let inl = left.filter(p => Math.abs(p[1] - (best.m * p[0] + best.c)) < tol);
    const f = fitY(inl);
    inl = left.filter(p => Math.abs(p[1] - (f.m * p[0] + f.c)) < tol);
    const g = fitY(inl);
    const xs = inl.map(p => p[0]);
    lines.push({ ...g, n: inl.length, x0: Math.min(...xs), x1: Math.max(...xs) });
    left = left.filter(p => Math.abs(p[1] - (g.m * p[0] + g.c)) >= tol * 2);
  }
  return lines;
}
function mulberry(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Thin white ridges (painted lines) in columns around the foot.
function ridgePoints(wh, W, H, { x0, x1, y0, y1, skip }) {
  const pts = [], K = 6;
  for (let x = Math.max(2, x0 | 0); x <= Math.min(W - 3, x1); x += 3) {
    if (skip?.(x)) continue;
    let prev = -Infinity, prevY = -1;
    for (let y = Math.max(K + 1, y0 | 0); y <= Math.min(H - K - 2, y1); y++) {
      const v = wh[y * W + x];
      const r = v - Math.max(wh[(y - K) * W + x], wh[(y + K) * W + x]);
      if (r > 35 && v > 120 && v >= wh[(y - 1) * W + x] && v >= wh[(y + 1) * W + x]) {
        // sub-pixel peak
        const a = wh[(y - 1) * W + x], b = wh[(y + 1) * W + x], d = a - 2 * v + b;
        const sy = d < 0 ? (a - b) / (2 * d) : 0;
        if (y - prevY > 3) pts.push([x, y + Math.max(-0.5, Math.min(0.5, sy))]);
        prevY = y; prev = r;
      }
    }
  }
  return pts;
}

// ---------- the rectangle in one frame ----------
// toe: the planted take-off toe [x, y] (it is on the runway, between the two lines).
// dir: +1 if the athlete runs towards +x in the image. foot: [x0, x1] columns the shoe covers.
// ground: the foot's lowest keypoint, which must lie between the runway lines.
// Returns the runway lines, the sand edge, the board's pit-side white edge and the take-off line,
// each as x = m y + c, and the corners where they cross the lines.
export function detectRunway(rgba, W, H, { toe, dir, foot = null, ground = null, span = 520 }) {
  const wh = whiteness(rgba, W, H), lu = luma(rgba, W, H);
  const footSkip = foot ? x => x >= foot[0] - 12 && x <= foot[1] + 12 : null;
  const [tx0, ty0] = toe;
  const pts = ridgePoints(wh, W, H, { x0: tx0 - span, x1: tx0 + span, y0: ty0 - 260, y1: ty0 + 260, skip: footSkip });
  const lines = ransacLines(pts, {}).filter(l => l.n >= 40);
  const yAt = (l, x) => l.m * x + l.c;
  const [tx, ty] = toe;
  const shoeEnd = foot ? (dir > 0 ? foot[1] : foot[0]) : tx;
  const heelEnd = foot ? (dir > 0 ? foot[0] : foot[1]) : tx;
  // Painted lines sorted top to bottom at the foot. The runway is the adjacent pair with the
  // sand on one side of the foot and the board on the other; the shoe keypoints sit above
  // the ground, so the foot alone cannot say which pair it stands between.
  const sorted = lines.filter(l => Math.abs(yAt(l, tx) - ty) < 260).sort((a, b) => yAt(a, tx) - yAt(b, tx));
  let best = null;
  for (let k = 0; k + 1 < sorted.length; k++) {
    const far = sorted[k], near = sorted[k + 1], band = yAt(near, tx) - yAt(far, tx);
    if (band < 12 || band > 400 || yAt(near, tx) < ty - 20 || yAt(far, tx) > ty + band) continue;
    const got = scanBand(far, near);
    // The planted foot stands inside the runway: its lowest keypoint is between the lines.
    const [gx, gy] = ground ?? toe;
    const inside = gy > yAt(far, gx) - 3 && gy < yAt(near, gx) + 6;
    // Runway lines stop at the pit; lane lines of the track around it run on past the sand.
    let past = 0;
    if (got.sandPts.length >= 6) {
      const e = fitX(got.sandPts);
      for (const l of [far, near]) {
        const yy = (l.m * e.c + l.c) / (1 - l.m * e.m), sx = e.m * yy + e.c;
        past += pts.filter(([x, y]) => Math.abs(y - yAt(l, x)) < 2 && (x - sx) * dir > 25).length;
      }
    }
    const score = got.sandPts.length + got.whitePts.length + 3 * got.offsets.length + (inside ? 30 : 0) - 2 * past;
    if (!best || score > best.score) best = { far, near, band, score, ...got };
  }
  if (!best || best.score < 12) return { error: 'runway', debug: { lines } };
  const { far, near, band, sandPts, whitePts, offsets } = best;

  function scanBand(far, near) {
  const rows = [];
  for (let u = 0.22; u <= 0.78 + 1e-9; u += 0.04) rows.push(u);
  const rowY = (u, x) => yAt(far, x) + u * (yAt(near, x) - yAt(far, x));
  const prof = (img, u, x) => at(img, W, H, x, rowY(u, x));

  // Walks from x along step until the whiteness has been high for `run` px; returns the
  // half-level crossing between the track before it and the white after it.
  const edgeFrom = (u, xStart, step, { run = 30, maxRun = Infinity, maxDist = 900 } = {}) => {
    let n = 0;
    for (let k = 0, x = xStart; k < maxDist; k++, x += step) {
      const v = prof(wh, u, x);
      if (!Number.isFinite(v)) return null;
      if (v > 140) { if (++n >= run) {
        const startX = x - step * (n - 1);
        const before = median([...Array(16)].map((_, j) => prof(wh, u, startX - step * (4 + j))));
        const after = median([...Array(12)].map((_, j) => prof(wh, u, startX + step * (2 + j))));
        const half = (before + after) / 2;
        let ex = startX;
        for (let j = -8; j <= 4; j++) { const a = prof(wh, u, startX + step * j), b = prof(wh, u, startX + step * (j + 1)); if (a <= half && b > half) { ex = startX + step * (j + (half - a) / (b - a)); break; } }
        let len = 0; while (len < 400 && prof(wh, u, startX + step * len) > half) len++;
        if (len > maxRun) return { x: ex, len, tooLong: true };
        return { x: ex, len };
      } } else n = 0;
    }
    return null;
  };
  const sandPts = [], whitePts = [], offsets = [];
  for (const u of rows) {
    const s = edgeFrom(u, shoeEnd + dir * 14, dir, { run: 40 });
    if (s && !s.tooLong) sandPts.push([s.x, rowY(u, s.x)]);
    const b = edgeFrom(u, heelEnd - dir * 14, -dir, { run: 20, maxRun: 260 });
    if (b && !b.tooLong) {
      whitePts.push([b.x, rowY(u, b.x)]);
      // Inside the white unit the foul strip is darker: the take-off line is its far edge.
      const ls = []; for (let k = 0; k < b.len; k++) ls.push(prof(lu, u, b.x - dir * k));
      const sm = ls.map((_, i) => median(ls.slice(Math.max(0, i - 1), i + 2)));
      const top = median(sm);
      let mi = -1; for (let i = 3; i < sm.length - 3; i++) if (mi < 0 || sm[i] < sm[mi]) mi = i;
      if (mi > 0 && top - sm[mi] > 12) {
        const half = (top + sm[mi]) / 2;
        for (let i = mi; i < sm.length - 1; i++) if (sm[i] <= half && sm[i + 1] > half) { offsets.push(i + (half - sm[i]) / (sm[i + 1] - sm[i])); break; }
      }
    }
  }
  return { sandPts, whitePts, offsets };
  }
  const edge = (p, min) => {
    if (p.length < min) return null;
    let f = fitX(p);
    const res = p.map(([x, y]) => Math.abs(x - (f.m * y + f.c)));
    const keep = p.filter((_, i) => res[i] < Math.max(1.5, 2.5 * median(res)));
    if (keep.length < min) return null;
    f = fitX(keep);
    return { ...f, n: keep.length };
  };
  const sand = edge(sandPts, 6), white = edge(whitePts, 6);
  // The take-off line runs parallel to the white edge a few centimetres behind it, too close
  // for its own slope to be measured: the white edge shifted by the median offset.
  const off = offsets.length >= 5 ? median(offsets) : NaN;
  const takeoff = white && Number.isFinite(off) ? { m: white.m, c: white.c - dir * off, n: offsets.length, offPx: off } : null;
  // where x = m y + c meets y = M x + C
  const cross = (e, l) => { if (!e) return null; const y = (l.m * e.c + l.c) / (1 - l.m * e.m); return [e.m * y + e.c, y]; };
  return {
    far, near, sand, white, takeoff, band,
    corners: {
      sand: sand && [cross(sand, far), cross(sand, near)],
      white: white && [cross(white, far), cross(white, near)],
      takeoff: takeoff && [cross(takeoff, far), cross(takeoff, near)],
    },
    debug: { sandPts, whitePts, offsets, lines },
  };
}

// ---------- following the camera ----------
export function lumaU8(rgba, W, H) {
  const out = new Uint8Array(W * H);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = (77 * rgba[o] + 150 * rgba[o + 1] + 29 * rgba[o + 2]) >> 8;
  return out;
}
const HALF = 12, SEARCH = 10, PN = (2 * HALF + 1) ** 2;
function patch(L, W, x, y, out = new Float32Array(PN)) {
  let k = 0, s = 0; for (let dy = -HALF; dy <= HALF; dy++) { const row = (y + dy) * W; for (let dx = -HALF; dx <= HALF; dx++) { const v = L[row + x + dx]; out[k++] = v; s += v; } }
  const m = s / PN; let ss = 0; for (let i = 0; i < PN; i++) { out[i] -= m; ss += out[i] * out[i]; }
  out.norm = Math.sqrt(ss); return out;
}
function nccAt(L, W, tpl, x, y) {
  let s = 0, sum = 0, sq = 0, k = 0;
  for (let dy = -HALF; dy <= HALF; dy++) { const row = (y + dy) * W; for (let dx = -HALF; dx <= HALF; dx++) { const v = L[row + x + dx]; s += tpl[k++] * v; sum += v; sq += v * v; } }
  const varB = sq - (sum * sum) / PN; return varB > 1 ? s / (tpl.norm * Math.sqrt(varB)) : -1;
}
function matchPatch(L, W, H, tpl, px, py) {
  const X = Math.round(px), Y = Math.round(py), m = HALF + SEARCH + 1;
  if (X < m || Y < m || X > W - m - 1 || Y > H - m - 1) return null;
  let best = -2, bx = 0, by = 0; const sc = new Float32Array((2 * SEARCH + 1) ** 2);
  for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
    const v = nccAt(L, W, tpl, X + dx, Y + dy); sc[(dy + SEARCH) * (2 * SEARCH + 1) + dx + SEARCH] = v;
    if (v > best) { best = v; bx = dx; by = dy; }
  }
  if (Math.abs(bx) === SEARCH || Math.abs(by) === SEARCH) return { score: best, edge: true };
  const g = (dx, dy) => sc[(dy + SEARCH) * (2 * SEARCH + 1) + dx + SEARCH];
  const sub = (a, b) => { const d = a - 2 * best + b; return d < 0 ? Math.max(-0.5, Math.min(0.5, (a - b) / (2 * d))) : 0; };
  return { x: X + bx + sub(g(bx - 1, by), g(bx + 1, by)), y: Y + by + sub(g(bx, by - 1), g(bx, by + 1)), score: best };
}
// Strong two-directional texture (min eigenvalue of the structure tensor), one per grid cell.
export function pickFeatures(L, W, H, { y0, y1, cell = 64, max = 40, avoid }) {
  const out = [];
  for (let cy = Math.max(HALF + SEARCH + 2, Math.round(y0)); cy + cell <= Math.min(H - HALF - SEARCH - 2, y1); cy += cell)
    for (let cx = HALF + SEARCH + 2; cx + cell <= W - HALF - SEARCH - 2; cx += cell) {
      let best = null;
      for (let y = cy + 6; y < cy + cell - 6; y += 4) for (let x = cx + 6; x < cx + cell - 6; x += 4) {
        if (avoid?.(x, y)) continue;
        let a = 0, b = 0, c = 0;
        for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) { const i = (y + dy) * W + x + dx; const gx = L[i + 1] - L[i - 1], gy = L[i + W] - L[i - W]; a += gx * gx; b += gx * gy; c += gy * gy; }
        const lam = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
        if (!best || lam > best.lam) best = { x, y, lam };
      }
      if (best && best.lam > 150) out.push(best);
    }
  return out.sort((p, q) => q.lam - p.lam).slice(0, max);
}
function ransacH(src, dst, { tol = 2, iters = 300, rand = mulberry(11) } = {}) {
  const n = src.length; if (n < 6) return null;
  let best = null;
  for (let it = 0; it < iters; it++) {
    const idx = new Set(); while (idx.size < 4) idx.add((rand() * n) | 0);
    const s = [...idx]; const h = homography(s.map(i => src[i]), s.map(i => dst[i])); if (!h) continue;
    let inl = 0; for (let i = 0; i < n; i++) { const p = applyH(h, src[i]); if (Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < tol) inl++; }
    if (!best || inl > best.inl) best = { h, inl };
  }
  if (!best || best.inl < 6) return null;
  let inliers = []; for (let i = 0; i < n; i++) { const p = applyH(best.h, src[i]); if (Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < tol) inliers.push(i); }
  const h = homography(inliers.map(i => src[i]), inliers.map(i => dst[i]));
  if (!h) return null;
  const res = inliers.map(i => { const p = applyH(h, src[i]); return Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]); });
  return { h, inliers: new Set(inliers), rms: Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) };
}

// The camera's motion over the ground, frame by frame: H[i] maps ref-frame pixels on the
// ground plane to frame i. Ground texture is tracked with the athlete masked out; features
// that leave are replaced. getRGBA(i) may be async. box(i) -> [x0, y0, x1, y1] to avoid.
export async function trackGround(getRGBA, W, H, { ref, from, to, groundY, box }) {
  const out = { [ref]: { h: [1, 0, 0, 0, 1, 0, 0, 0, 1], n: 0, rms: 0 } };
  const inBox = (i, x, y) => { const b = box?.(i); if (!b) return false; const mx = (b[2] - b[0]) * 0.15 + 20, my = (b[3] - b[1]) * 0.1 + 20; return x > b[0] - mx && x < b[2] + mx && y > b[1] - my && y < b[3] + my; };
  for (const step of [1, -1]) {
    let L = lumaU8(await getRGBA(ref), W, H);
    let feats = pickFeatures(L, W, H, { y0: groundY(ref), y1: H, avoid: (x, y) => inBox(ref, x, y) })
      .map(f => ({ ref: [f.x, f.y], cur: [f.x, f.y], tpl: patch(L, W, f.x, f.y) }));
    let h = out[ref].h, vel = [0, 0];
    for (let i = ref + step; step > 0 ? i <= to : i >= from; i += step) {
      L = lumaU8(await getRGBA(i), W, H);
      // a big pan needs a coarse start: search the first step widely with the strongest feature
      if (i === ref + step && feats.length) {
        const f0 = feats[0]; let bs = -2;
        for (let dy = -24; dy <= 24; dy += 2) for (let dx = -60; dx <= 60; dx += 2) { const v = (() => { const X = Math.round(f0.cur[0] + dx), Y = Math.round(f0.cur[1] + dy); return X > HALF + 1 && Y > HALF + 1 && X < W - HALF - 2 && Y < H - HALF - 2 ? nccAt(L, W, f0.tpl, X, Y) : -2; })(); if (v > bs) { bs = v; vel = [dx, dy]; } }
      }
      const m = feats.map(f => (inBox(i, f.cur[0] + vel[0], f.cur[1] + vel[1]) ? null : matchPatch(L, W, H, f.tpl, f.cur[0] + vel[0], f.cur[1] + vel[1])));
      const ok = feats.map((f, k) => m[k] && !m[k].edge && m[k].score > 0.8);
      const idx = feats.map((_, k) => k).filter(k => ok[k]);
      const fit = ransacH(idx.map(k => feats[k].ref), idx.map(k => [m[k].x, m[k].y]));
      if (!fit) break;
      h = fit.h;
      const prevCur = feats.map(f => f.cur);
      feats = feats.map((f, k) => {
        if (!ok[k] || !fit.inliers.has(idx.indexOf(k))) return { ...f, cur: applyH(h, f.ref), lost: (f.lost || 0) + 1 };
        return { ref: f.ref, cur: [m[k].x, m[k].y], tpl: patch(L, W, Math.round(m[k].x), Math.round(m[k].y)), lost: 0 };
      });
      // next step's prediction: the median motion of the features that matched and fit
      const moved = feats.map((f, k) => (f.lost === 0 ? [f.cur[0] - prevCur[k][0], f.cur[1] - prevCur[k][1]] : null)).filter(Boolean);
      if (moved.length >= 3) vel = [0, 1].map(d => median(moved.map(v => v[d])));
      out[i] = { h, n: fit.inliers.size, rms: +fit.rms.toFixed(2) };
      // drop features that left or keep failing; top up from fresh texture
      feats = feats.filter(f => f.lost < 4 && f.cur[0] > HALF + SEARCH + 2 && f.cur[0] < W - HALF - SEARCH - 3 && f.cur[1] > HALF + SEARCH + 2 && f.cur[1] < H - HALF - SEARCH - 3);
      if (feats.length < 28) {
        const hInv = invertH(h);
        const gy = applyH(h, [W / 2, groundY(ref)])[1];
        const near = (x, y) => feats.some(f => Math.abs(f.cur[0] - x) < 40 && Math.abs(f.cur[1] - y) < 40);
        for (const f of pickFeatures(L, W, H, { y0: gy, y1: H, avoid: (x, y) => inBox(i, x, y) || near(x, y) }).slice(0, 40 - feats.length))
          feats.push({ ref: applyH(hInv, [f.x, f.y]), cur: [f.x, f.y], tpl: patch(L, W, f.x, f.y), lost: 0 });
      }
    }
  }
  return out;
}

// ---------- one call for the server ----------
// frames: openFrames() handle. track: smoothed keypoints. jump: analyzeJump() output (takeoff,
// takeoffFoot, pen, landing, dir). boxes: the athlete's box per frame. Returns
// { frames: { [i]: [sandFar, sandNear, lineFar, lineNear] }, ref, ... } or { error }.
export async function measureGround({ frames, track, jump, boxes }) {
  const t0 = Date.now();
  const { W, H, N } = frames, T = jump.takeoff, s = jump.takeoffFoot, dir = jump.dir;
  // From before the 3rd-last step: the last three steps are measured on the ground.
  const from = Math.max(0, (jump.third?.td ?? (jump.pen?.td ?? T.td - 30) - 35) - 12);
  const to = Math.min(N - 1, (jump.landing ?? T.to + 90) + 6);
  const want = []; for (let i = from; i <= to; i++) want.push(i);
  const px = await frames.pick(want);
  const get = i => px.get(i);
  const P = (k, n) => { const j = KP[n]; return k && Number.isFinite(k[j * 3]) ? [k[j * 3], k[j * 3 + 1]] : null; };
  const footAt = i => {
    const k = track[i], toe = P(k, s + 'bigtoe'), heel = P(k, s + 'heel');
    if (!toe || !heel) return null;
    const low = [toe, heel, P(k, s + 'smalltoe')].filter(Boolean).sort((a, b) => b[1] - a[1])[0];
    return { toe, ground: low, foot: [Math.min(toe[0], heel[0]), Math.max(toe[0], heel[0])] };
  };
  // Look for the runway in the takeoff contact, every third frame.
  const dets = [];
  for (let i = T.td; i <= T.to; i += 3) {
    const f = footAt(i); if (!f || !get(i)) continue;
    const d = detectRunway(get(i), W, H, { ...f, dir });
    if (!d.error && d.corners.sand && d.corners.white) dets.push({ i, d });
  }
  if (!dets.length) return { error: 'runway not found', ms: Date.now() - t0 };
  const ref = dets[0].i, d0 = dets[0].d;
  const farY = d0.far.m * (W / 2) + d0.far.c;
  const g = await trackGround(get, W, H, { ref, from, to, groundY: () => farY - 150, box: i => boxes?.[i] });
  // Every detection into the reference frame; corners that agree within 6 px are averaged.
  const pick = d => [...d.corners.sand, ...(d.corners.takeoff ?? d.corners.white)];
  const refPts = [0, 1, 2, 3].map(k => {
    const q = dets.filter(x => g[x.i]).map(x => applyH(invertH(g[x.i].h), pick(x.d)[k]));
    const med = v => [...v].sort((a, b) => a - b)[v.length >> 1];
    const mx = med(q.map(p => p[0])), my = med(q.map(p => p[1]));
    const keep = q.filter(p => Math.hypot(p[0] - mx, p[1] - my) < 6);
    return [keep.reduce((a, p) => a + p[0], 0) / keep.length, keep.reduce((a, p) => a + p[1], 0) / keep.length];
  });
  const out = {};
  for (const [i, v] of Object.entries(g)) out[i] = refPts.map(p => applyH(v.h, p).map(x => +x.toFixed(2)));
  const offs = dets.map(x => x.d.takeoff?.offPx).filter(Number.isFinite);
  return {
    frames: out, ref, detections: dets.length, line: offs.length ? 'foul strip' : 'white edge',
    lineOffsetPx: offs.length ? +[...offs].sort((a, b) => a - b)[offs.length >> 1].toFixed(1) : null,
    trackRms: +Math.max(...Object.values(g).map(v => v.rms)).toFixed(2), ms: Date.now() - t0,
  };
}
