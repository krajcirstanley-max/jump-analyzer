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
export const BOARD_WHITE_M = 1.97;  // pit-side edge of the white unit from the sand (take-off line 2 m, strip ~3 cm behind it)
export const PLANK_M = 1.0;
export const PLANK_SEEN_M = 1.05;   // its length as the board measured it on 20 Nov (1.03-1.07, three jumps)   // Stanley's take-off plank ("debnička má 1m", 2026-11-20)

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
// Red minus blue: the track rubber is red-brown (about 85), a wooden or rubber take-off plank lying on
// it is grey-brown (about 50 on top, 30-40 on its dark side), white and sand are colourless.
export function chroma(rgba, W, H) {
  const out = new Float32Array(W * H);
  for (let i = 0, o = 0; i < out.length; i++, o += 4) out[i] = rgba[o] - rgba[o + 2];
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
  const wh = whiteness(rgba, W, H), lu = luma(rgba, W, H), ch = chroma(rgba, W, H);
  const footSkip = foot ? x => x >= foot[0] - 12 && x <= foot[1] + 12 : null;
  const [tx0, ty0] = toe;
  const pts = ridgePoints(wh, W, H, { x0: tx0 - span, x1: tx0 + span, y0: ty0 - 260, y1: ty0 + 260, skip: footSkip });
  let lines = ransacLines(pts, {}).filter(l => l.n >= 40);
  const yAt = (l, x) => l.m * x + l.c;
  const [tx, ty] = toe;
  const shoeEnd = foot ? (dir > 0 ? foot[1] : foot[0]) : tx;
  const heelEnd = foot ? (dir > 0 ? foot[0] : foot[1]) : tx;
  // Painted lines sorted top to bottom at the foot. The runway is the adjacent pair with the
  // sand on one side of the foot and the board on the other; the shoe keypoints sit above
  // the ground, so the foot alone cannot say which pair it stands between.
  const pickBand = () => {
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
    // A plank between the lines counts like the board it covers (2026-11-20: without it the band
    // scored under 12 on the server's empty-board frames of IMG_5166, the scan start 3 px off).
    const score = got.sandPts.length + got.whitePts.length + 3 * got.offsets.length + 2 * Math.min(got.plankFront.length, got.plankBack.length) + (inside ? 30 : 0) - 2 * past;
    if (!best || score > best.score) best = { far, near, band, score, ...got };
  }
  return best;
  };
  let best = pickBand();
  // 9 candidates when 6 found no runway: lane lines around the pit can outvote a runway line a plank
  // leaves short (2026-11-20, IMG_5166 on the server: the near runway line was the 7th). Only then,
  // so a runway found before is found the same way (9 always moved IMG_5163/5164 by 1-2 %).
  if (!best || best.score < 12) { lines = ransacLines(pts, { maxLines: 9 }).filter(l => l.n >= 40); best = pickBand(); }
  if (!best || best.score < 12) return { error: 'runway', debug: { lines } };
  const { far, near, band, sandPts, whitePts, offsets, plankFront, plankBack, boardBeside } = best;

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
  const sandPts = [], whitePts = [], offsets = [], plankFront = [], plankBack = [];
  // A take-off plank on the runway (Stanley's "debnička", 1 m long, lying along the runway over the
  // board; 2026-11-20): grey-brown, neither red rubber nor white. Walking from the scan's start
  // towards the run-up, its pit-side end is the take-off line and its far end is 1 m behind.
  // Only from a start on the rubber in front of it (an empty board frame, not the shoe on it).
  const plankAt = (u, x) => { const c = prof(ch, u, x), l = prof(lu, u, x), w = prof(wh, u, x); return c < 62 && l < 200 && w < 140; };
  const plankFrom = (u, xStart, step) => {
    let k = 0;
    for (; k < 700; k++) { const x = xStart + step * k; if (!Number.isFinite(prof(ch, u, x))) return null; if (plankAt(u, x)) { let n = 1; while (n < 10 && plankAt(u, x + step * n)) n++; if (n >= 10) break; } }
    if (k >= 700 || k < 4) return null;
    const front = xStart + step * k;
    let len = 0, gap = 0;
    while (len < 1200) { const x = front + step * (len + 1); if (!Number.isFinite(prof(ch, u, x))) return null; if (plankAt(u, x)) { len += gap + 1; gap = 0; } else if (++gap > 5) break; }
    return len >= 40 ? { front, back: front + step * len } : null;
  };
  // The board under the plank shows only beside it, in a thin strip along each runway line.
  const boardBeside = [];
  for (const u of [0.07, 0.1, 0.13, 0.87, 0.9, 0.93]) {
    const b = edgeFrom(u, heelEnd - dir * 6, -dir, { run: 8, maxRun: 260, maxDist: 700 });
    if (b && !b.tooLong) boardBeside.push([b.x, rowY(u, b.x)]);
  }
  for (const u of rows) {
    const pl = plankFrom(u, heelEnd - dir * 6, -dir);
    if (pl) { plankFront.push([pl.front, rowY(u, pl.front)]); plankBack.push([pl.back, rowY(u, pl.back)]); }
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
  return { sandPts, whitePts, offsets, plankFront, plankBack, boardBeside };
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
  const pFront = edge(plankFront, 5), pBack = edge(plankBack, 5);
  // The board's pit-side edge beside the plank, through the points on each side of it (one side
  // alone could be a shadow or the line). Not parallel to the plank's ends: on a low phone those
  // converge (IMG_5166: slopes -0.65 and +0.16), and the board's lies between them.
  let under = null;
  if (pFront && pBack && boardBeside.length >= 2) {
    const mid = (yAt(far, toe[0]) + yAt(near, toe[0])) / 2;
    const side = boardBeside.reduce((o, p) => (o[p[1] < (yAt(far, p[0]) + yAt(near, p[0])) / 2 ? 0 : 1].push(p), o), [[], []]);
    if (side[0].length && side[1].length) {
      const m0 = [median(side[0].map(p => p[0])), median(side[0].map(p => p[1]))], m1 = [median(side[1].map(p => p[0])), median(side[1].map(p => p[1]))];
      const m = (m1[0] - m0[0]) / (m1[1] - m0[1]), c = m0[0] - m * m0[1];
      const tight = boardBeside.every(([x, y]) => Math.abs(x - (m * y + c)) < 4);
      const xAt = (e, y) => e.m * y + e.c;
      const between = (xAt({ m, c }, mid) - xAt(pFront, mid)) * (xAt({ m, c }, mid) - xAt(pBack, mid)) < 0;
      if (tight && between) under = { m, c, n: boardBeside.length };
    }
  }
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
      plank: pFront && pBack && { front: [cross(pFront, far), cross(pFront, near)], back: [cross(pBack, far), cross(pBack, near)], n: Math.min(pFront.n, pBack.n), under: under && [cross(under, far), cross(under, near)] },
    },
    debug: { sandPts, whitePts, offsets, lines, plankFront, plankBack, boardBeside },
  };
}

// A far camera (IMG_4658, filmed across the hall: the athlete about 200 px tall at the board) makes
// the runway lines too thin and short for the line finder, whose pixel thresholds were set on
// clips where the athlete is 370-480 px tall. Then the area around the foot is enlarged first, so
// the runway looks the size it does from the usual spot, and the answer is mapped back.
export const ZOOM_BELOW = 300; // athlete box height in px under which the board area is enlarged
export function zoomFor(boxH) { return boxH > 0 && boxH < ZOOM_BELOW ? Math.min(4, 380 / boxH) : 1; }

function enlarge(rgba, W, H, x0, y0, w, h, s) {
  const OW = Math.round(w * s), OH = Math.round(h * s), out = new Uint8ClampedArray(OW * OH * 4);
  for (let Y = 0; Y < OH; Y++) {
    const y = Math.min(H - 1.001, Math.max(0, y0 + (Y + 0.5) / s - 0.5)), yi = Math.floor(y), fy = y - yi;
    for (let X = 0; X < OW; X++) {
      const x = Math.min(W - 1.001, Math.max(0, x0 + (X + 0.5) / s - 0.5)), xi = Math.floor(x), fx = x - xi;
      const a = (yi * W + xi) * 4, b = a + 4, c = a + W * 4, d = c + 4, o = (Y * OW + X) * 4;
      for (let k = 0; k < 4; k++) out[o + k] = (rgba[a + k] * (1 - fx) + rgba[b + k] * fx) * (1 - fy) + (rgba[c + k] * (1 - fx) + rgba[d + k] * fx) * fy;
    }
  }
  return { img: out, OW, OH };
}

export function detectRunwayZoomed(rgba, W, H, opts, s = 1) {
  if (!(s > 1.05)) return detectRunway(rgba, W, H, opts);
  const [tx, ty] = opts.toe;
  const x0 = Math.max(0, Math.floor(tx - 640 / s)), x1 = Math.min(W, Math.ceil(tx + 640 / s));
  const y0 = Math.max(0, Math.floor(ty - 330 / s)), y1 = Math.min(H, Math.ceil(ty + 330 / s));
  const { img, OW, OH } = enlarge(rgba, W, H, x0, y0, x1 - x0, y1 - y0, s);
  const fwd = p => p && [(p[0] - x0) * s, (p[1] - y0) * s];
  const d = detectRunway(img, OW, OH, {
    ...opts, toe: fwd(opts.toe), ground: fwd(opts.ground), foot: opts.foot && opts.foot.map(x => (x - x0) * s),
  });
  if (d.error) return d;
  const back = p => p && [p[0] / s + x0, p[1] / s + y0];
  // y = m x + c (lines) and x = m y + c (edges) keep their slope; the offset moves.
  const line = l => l && { ...l, c: y0 + l.c / s - l.m * x0 };
  const edge = e => e && { ...e, c: x0 + e.c / s - e.m * y0 };
  const pair = v => v && v.map(back);
  return {
    far: line(d.far), near: line(d.near), sand: edge(d.sand), white: edge(d.white),
    takeoff: d.takeoff && { ...edge(d.takeoff), offPx: d.takeoff.offPx / s }, band: d.band / s, zoom: s,
    corners: { sand: pair(d.corners.sand), white: pair(d.corners.white), takeoff: pair(d.corners.takeoff),
      plank: d.corners.plank && { front: pair(d.corners.plank.front), back: pair(d.corners.plank.back), n: d.corners.plank.n, under: pair(d.corners.plank.under) } },
    debug: { ...d.debug, zoom: s },
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
// The sums and squares of each window come from running sums over the searched area (whole
// numbers, so exactly what nccAt adds up): only the product with the template is left per
// position, about half the work (2026-11-18: the camera thread had become the job's longest leg).
const RS = 2 * (HALF + SEARCH) + 1, IS = new Float64Array((RS + 1) ** 2), IQ = new Float64Array((RS + 1) ** 2);
function matchPatch(L, W, H, tpl, px, py) {
  const X = Math.round(px), Y = Math.round(py), m = HALF + SEARCH + 1;
  if (X < m || Y < m || X > W - m - 1 || Y > H - m - 1) return null;
  const R = HALF + SEARCH, ox = X - R, oy = Y - R, S1 = RS + 1;
  for (let y = 0; y < RS; y++) {
    let rs = 0, rq = 0; const row = (oy + y) * W + ox;
    for (let x = 0; x < RS; x++) { const v = L[row + x]; rs += v; rq += v * v; IS[(y + 1) * S1 + x + 1] = IS[y * S1 + x + 1] + rs; IQ[(y + 1) * S1 + x + 1] = IQ[y * S1 + x + 1] + rq; }
  }
  const P = 2 * HALF + 1;
  let best = -2, bx = 0, by = 0; const sc = new Float32Array((2 * SEARCH + 1) ** 2);
  for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
    const x0 = dx + SEARCH, y0 = dy + SEARCH;   // window's top-left in the searched area
    const sum = IS[(y0 + P) * S1 + x0 + P] - IS[y0 * S1 + x0 + P] - IS[(y0 + P) * S1 + x0] + IS[y0 * S1 + x0];
    const sq = IQ[(y0 + P) * S1 + x0 + P] - IQ[y0 * S1 + x0 + P] - IQ[(y0 + P) * S1 + x0] + IQ[y0 * S1 + x0];
    let s = 0, k = 0;
    for (let yy = -HALF; yy <= HALF; yy++) { const row = (Y + dy + yy) * W + X + dx; for (let xx = -HALF; xx <= HALF; xx++) s += tpl[k++] * L[row + xx]; }
    const varB = sq - (sum * sum) / PN, v = varB > 1 ? s / (tpl.norm * Math.sqrt(varB)) : -1;
    sc[(dy + SEARCH) * (2 * SEARCH + 1) + dx + SEARCH] = v;
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
// Rotation + scale + shift as a homography: a hand-held phone's shake (pan and tilt shift the
// image, roll turns it, a step closer scales it). Least squares, closed form.
function similarity(src, dst) {
  const n = src.length; if (n < 2) return null;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - mx, y = src[i][1] - my, u = dst[i][0] - ux, v = dst[i][1] - uy;
    sa += x * u + y * v; sb += x * v - y * u; ss += x * x + y * y;
  }
  if (!(ss > 1e-9)) return null;
  const a = sa / ss, b = sb / ss;
  return [a, -b, ux - a * mx + b * my, b, a, uy - b * mx - a * my, 0, 0, 1];
}
function ransacH(src, dst, { tol = 2, iters = 300, rand = mulberry(11), model = 'homography' } = {}) {
  const n = src.length; if (n < 6) return null;
  const fitFn = model === 'similarity' ? similarity : homography, k = model === 'similarity' ? 2 : 4;
  let best = null;
  for (let it = 0; it < iters; it++) {
    const idx = new Set(); while (idx.size < k) idx.add((rand() * n) | 0);
    const s = [...idx]; const h = fitFn(s.map(i => src[i]), s.map(i => dst[i])); if (!h) continue;
    let inl = 0; for (let i = 0; i < n; i++) { const p = applyH(h, src[i]); if (Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < tol) inl++; }
    if (!best || inl > best.inl) best = { h, inl };
  }
  if (!best || best.inl < 6) return null;
  let inliers = []; for (let i = 0; i < n; i++) { const p = applyH(best.h, src[i]); if (Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]) < tol) inliers.push(i); }
  const h = fitFn(inliers.map(i => src[i]), inliers.map(i => dst[i]));
  if (!h) return null;
  const res = inliers.map(i => { const p = applyH(h, src[i]); return Math.hypot(p[0] - dst[i][0], p[1] - dst[i][1]); });
  return { h, inliers: new Set(inliers), rms: Math.sqrt(res.reduce((s, v) => s + v * v, 0) / res.length) };
}

// The camera's motion over the ground, frame by frame: H[i] maps ref-frame pixels on the
// ground plane to frame i. Ground texture is tracked with the athlete masked out; features
// that leave are replaced. getRGBA(i) may be async. box(i) -> [x0, y0, x1, y1] to avoid.
export async function trackGround(getRGBA, W, H, { ref, from, to, groundY, box, model = 'homography', sane = null, steps = [1, -1] }) {
  const out = { [ref]: { h: [1, 0, 0, 0, 1, 0, 0, 0, 1], n: 0, rms: 0 } };
  const inBox = (i, x, y) => { const b = box?.(i); if (!b) return false; const mx = (b[2] - b[0]) * 0.15 + 20, my = (b[3] - b[1]) * 0.1 + 20; return x > b[0] - mx && x < b[2] + mx && y > b[1] - my && y < b[3] + my; };
  for (const step of steps) {
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
      const fit = ransacH(idx.map(k => feats[k].ref), idx.map(k => [m[k].x, m[k].y]), { model });
      if (!fit || (sane && !sane(fit.h, h))) break;
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

// ---------- Freelap cones ----------
// Stanley's Freelap cones always stand at 0.2, 10.2 and 20.2 m from the board (the chip fires
// 80 cm before a cone, so the splits are the real 1-11 and 11-21 m). They are small, bright
// yellow and tall rather than wide; the base (bottom of the blob) is the point on the ground.
// IMG_4677: rgb about (220, 198, 78), 13 x 18 px at 15 m. Orange marker discs (R-G about 70)
// and the yellow-tan benches (thin, wide, G-B about 75) do not pass.
export function detectCones(rgba, W, H, { box = null, y0 = 0 } = {}) {
  const yel = o => { const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2]; return r > 185 && g > 165 && b < 125 && r - g < 45 && g - b > 85; };
  const seen = new Uint8Array(W * H), out = [];
  const athH = box ? box[3] - box[1] : H;
  for (let y = Math.max(0, Math.round(y0)); y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (seen[i] || !yel(i * 4)) continue;
    const st = [i]; seen[i] = 1; let n = 0, x0 = x, x1 = x, ya = y, yb = y;
    while (st.length) {
      const j = st.pop(), jx = j % W, jy = (j / W) | 0; n++;
      if (jx < x0) x0 = jx; if (jx > x1) x1 = jx; if (jy < ya) ya = jy; if (jy > yb) yb = jy;
      if (n > 20000) break;
      for (const k of [j - 1, j + 1, j - W, j + W]) if (k >= 0 && k < W * H && !seen[k] && yel(k * 4)) { seen[k] = 1; st.push(k); }
    }
    const w = x1 - x0 + 1, h = yb - ya + 1;
    if (n >= 20 && h >= 5 && h >= 0.7 * w && h <= 0.25 * athH && n >= 0.35 * w * h) out.push([(x0 + x1) / 2, yb + 0.5, h]);
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
  // From before the 3rd-last step: the last three steps are measured on the ground. And from
  // 1.7 s before the board, when the clip has it: the athlete passes 11 m (the Freelap split)
  // about 1.2-1.4 s before the board, and the 10.2 m cone has to be followed into the frame.
  const fps = frames.fps || 120;
  // (2.6 s was tried for the 20.2 m cone: the tracking error on IMG_4677 rose from 1.3 to 2.2 px
  // and moved the jump by 9 cm, and IMG_4658 still gave no 11-21 m time.)
  const from = Math.max(0, Math.min((jump.third?.td ?? (jump.pen?.td ?? T.td - 30) - 35) - 12, T.td - Math.round(1.7 * fps)));
  const to = Math.min(N - 1, (jump.landing ?? T.to + 90) + 6);
  const want = []; for (let i = from; i <= to; i++) want.push(i);
  // threaded (server): only the contact and the frames after it are looked at here, the rest on the
  // threads; the last frame is waited for, so the threads find every frame decoded
  const step3 = (a, b) => { const l = []; for (let i = a; i <= b; i += 3) l.push(i); return l; };
  const px = await frames.pick(frames.fd ? [...step3(T.td, T.to), ...step3(T.to + 3, Math.min(to, T.to + Math.round(0.6 * fps))), to] : want);
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
  const bT = boxes?.[T.td], zoom = zoomFor(bT ? bT[3] - bT[1] : 0);
  for (let i = T.td; i <= T.to; i += 3) {
    const f = footAt(i); if (!f || !get(i)) continue;
    const d = detectRunwayZoomed(get(i), W, H, { ...f, dir }, zoom);
    // The sand is enough here: when the shoe covers the board (IMG_4676) the board comes from
    // the frames after toe-off below.
    if (!d.error && d.corners.sand) dets.push({ i, d });
  }
  if (!dets.length) return { error: 'runway not found', ms: Date.now() - t0 };
  // Contact frames that also showed the board lead, as they did before sand-only frames counted.
  const boardDets = dets.filter(x => x.d.corners.white), base = boardDets.length ? boardDets : dets;
  const ref = base[0].i, d0 = base[0].d;
  const farY = d0.far.m * (W / 2) + d0.far.c;
  // On the server the two directions from the reference frame and the cones run on threads of their
  // own, reading the decoded file (2026-11-18: 12 s of a 43 s jump on one thread); the same numbers.
  const threaded = frames.fd ? await groundThreads(frames, { ref, from, to, gy: farY - 150, boxes, cones: want }).catch(e => { console.error('ground threads failed:', e?.message || e); return null; }) : null;
  const g = threaded?.g ?? await trackGround(get, W, H, { ref, from, to, groundY: () => farY - 150, box: i => boxes?.[i] });
  // The board again once the athlete has left it. During the contact the white shoe stands on
  // the white unit and the foul strip can't be read: on IMG_4677 (Ostrava, a white unit about
  // 40 cm wide) the line came out 10-17 cm too far up the runway, the 2 m ruler too long and
  // every distance 5 % short (6.44 m for 6.80 by tape). With the board clear, the darker
  // plasticine strip shows and the take-off line is its far edge. The scan starts from a point
  // between the sand and the board, carried from the contact's detection by the tracking. When
  // the contact showed no board, the foot on it stands in for the board.
  const clear = [], plankClear = [];
  const href = g[ref]?.h, back = href && invertH(href), f0 = footAt(ref);
  if (back && (d0.corners.white || f0)) {
    const c0 = d0.corners;
    const sandMid = [(c0.sand[0][0] + c0.sand[1][0]) / 2, (c0.sand[0][1] + c0.sand[1][1]) / 2];
    const board = c0.white ? [c0.white[0], c0.white[1]] : [f0.toe, f0.ground];
    const bMid = [(board[0][0] + board[1][0]) / 2, (board[0][1] + board[1][1]) / 2];
    const start = [(sandMid[0] + bMid[0]) / 2, (sandMid[1] + bMid[1]) / 2];
    for (let i = T.to + 3; i <= Math.min(to, T.to + Math.round(0.6 * fps)); i += 3) {
      if (!g[i] || !get(i)) continue;
      const toI = p => applyH(g[i].h, applyH(back, p));
      const s0 = toI(start);
      // the athlete's box must keep clear of the board and of the scan's start
      // (in x, and down to the ground: in the air above the board the box ends well above it)
      const pts = board.map(toI).concat([s0]), xs = pts.map(p => p[0]), b = boxes?.[i];
      if (b && b[0] <= Math.max(...xs) + 60 && b[2] >= Math.min(...xs) - 30 && b[3] >= Math.min(...pts.map(p => p[1])) - 25) continue;
      const d = detectRunwayZoomed(get(i), W, H, { toe: s0, dir, foot: [s0[0] - 4, s0[0] + 4], ground: s0 }, zoom);
      if (!d.error && d.corners.sand && d.corners.takeoff && d.takeoff.n >= 5) clear.push({ i, d });
      else if (!d.error && d.corners.sand && d.corners.plank) plankClear.push({ i, d });
    }
  }
  // A take-off plank (2026-11-20, IMG_5166/5168/5169: "take-off line not found") wins over the
  // board under it: the athlete leaves from its pit-side end, not from the board.
  const onPlank = plankClear.length >= 2 && plankClear.length >= clear.length;
  // Two clear frames at least: one alone was wrong on IMG_4676 (motion blur read the strip as
  // 7 px instead of about 30 and every distance came out 14 % long).
  const lineDets = onPlank ? plankClear : clear.length >= 2 ? clear : boardDets;
  if (!lineDets.length) return { error: 'take-off line not found', ms: Date.now() - t0 };
  // Every detection into the reference frame; corners that agree within 6 px are averaged.
  const med = v => [...v].sort((a, b) => a - b)[v.length >> 1];
  const toRef = (dets, get) => {
    const q = dets.filter(x => g[x.i]).map(x => applyH(invertH(g[x.i].h), get(x.d)));
    if (!q.length) return null;
    const mx = med(q.map(p => p[0])), my = med(q.map(p => p[1]));
    const keep = q.filter(p => Math.hypot(p[0] - mx, p[1] - my) < 6);
    return [keep.reduce((a, p) => a + p[0], 0) / keep.length, keep.reduce((a, p) => a + p[1], 0) / keep.length];
  };
  const pick = (d, k) => (k < 2 ? d.corners.sand[k] : onPlank ? d.corners.plank.front[k - 2] : (d.corners.takeoff ?? d.corners.white)[k - 2]);
  const refPts = [0, 1, 2, 3].map(k => toRef(((lineDets === clear || onPlank) && k < 2 ? base.concat(lineDets) : lineDets), d => pick(d, k)));
  // The plank's own length gives the distance from its end to the sand: its two ends where they
  // cross the runway lines are a 1 m x 1.22 m rectangle on the ground.
  // The board under it, seen beside it, is the better ruler: it stands BOARD_WHITE_M from the sand on
  // Stanley's runway, as every white-board jump measured (the plank's own 1 m read the board 1.85 m
  // from the sand on IMG_5166, and the leg 7 % short). The plank's length then only checks it.
  let boardM = null, plank = null;
  if (onPlank) {
    const back = [0, 1].map(k => toRef(plankClear, d => d.corners.plank.back[k]));
    const withUnder = plankClear.filter(x => x.d.corners.plank.under);
    const under = withUnder.length >= 2 ? [0, 1].map(k => toRef(withUnder, d => d.corners.plank.under[k])) : null;
    if (refPts.every(Boolean) && back.every(Boolean)) {
      const W4 = x => [[x, 0], [x, RUNWAY_W]];
      const at = (h, p) => applyH(h, p)[0];
      const hB = under?.every(Boolean) && homography([refPts[0], refPts[1], under[0], under[1]], [...W4(0), ...W4(BOARD_WHITE_M)]);
      let f = NaN, b = NaN, ruler = null;
      if (hB) {
        f = (at(hB, refPts[2]) + at(hB, refPts[3])) / 2; b = (at(hB, back[0]) + at(hB, back[1])) / 2; ruler = 'board';
        if (!(f > 0.3 && f < BOARD_WHITE_M && b > f + 0.6 && b < f + 1.6)) f = NaN;
      }
      if (!Number.isFinite(f)) {
        const h = homography([refPts[2], refPts[3], back[0], back[1]], [...W4(0), ...W4(PLANK_M)]);
        const sx = h ? [at(h, refPts[0]), at(h, refPts[1])] : null;
        if (sx && sx.every(x => x < -0.3 && x > -4)) { f = -(sx[0] + sx[1]) / 2; b = f + PLANK_M; ruler = 'plank'; }
      }
      // The rectangle the app works in runs from the sand to the plank's far end, 2.7 m: from the
      // sand to its pit-side end alone (1.7 m) the extrapolation back to the 3rd-last step went wrong
      // on IMG_5169 (a 2.9 m step, 11.5 m/s, the leg 27 % long; 2.2 m, 9.4 m/s, 1 % with the far end).
      // The take-off line stays the pit-side end (lineM), and the Freelap cones keep standing by the
      // board under it (coneZeroM: its take-off line, 2 m from the sand).
      if (Number.isFinite(f)) {
        // One rectangle from every edge seen, not from two corners: the plank's far corners alone
        // moved 4.5 px between two server runs of IMG_5166 and every speed by 9 % (8.90 / 9.67 m/s).
        // Least squares over the sand (0), the board (1.97 m), the plank's end (f) and its far end
        // (f + its measured length, held to 1.05 m when the board gave it: 1.03-1.07 on three jumps).
        const bSeen = b;
        if (ruler === 'board') b = f + PLANK_SEEN_M;
        const src = [refPts[0], refPts[1], refPts[2], refPts[3], back[0], back[1]], dst = [...W4(0), ...W4(f), ...W4(b)];
        if (under?.every(Boolean)) { src.push(under[0], under[1]); dst.push(...W4(BOARD_WHITE_M)); }
        const hL = homography(src, dst), hLi = hL && invertH(hL);
        if (hLi) { refPts[0] = applyH(hLi, [0, 0]); refPts[1] = applyH(hLi, [0, RUNWAY_W]); refPts[2] = applyH(hLi, [b, 0]); refPts[3] = applyH(hLi, [b, RUNWAY_W]); }
        else { refPts[2] = back[0]; refPts[3] = back[1]; }
        boardM = +b.toFixed(3);
        plank = { ruler, lengthM: +(bSeen - f).toFixed(3), lineM: +f.toFixed(3) };
      }
    }
  }
  const out = {}, cones = {};
  for (const [i, v] of Object.entries(g)) {
    out[i] = refPts.map(p => applyH(v.h, p).map(x => +x.toFixed(2)));
    // Cones anywhere in the frame: the analysis keeps those that land beside the runway. A band
    // from the tracked corners lost the 10.2 m cone on IMG_4677, where the tracking 10 m from
    // the board was tens of pixels off.
    const c = threaded ? threaded.cones[i] : get(+i) && detectCones(get(+i), W, H, { box: boxes?.[+i] });
    if (c?.length) cones[i] = c.map(p => p.map(x => +x.toFixed(1)));
  }
  const offs = lineDets.map(x => x.d.takeoff?.offPx).filter(Number.isFinite);
  return {
    frames: out, cones, ref, detections: dets.length, clearDetections: clear.length, zoom: +zoom.toFixed(2),
    line: onPlank ? 'take-off plank' : lineDets === clear ? 'foul strip, board clear' : offs.length ? 'foul strip' : 'white edge',
    ...(boardM ? { boardM, lineM: plank.lineM, coneZeroM: BOARD_WHITE_M + 0.03, plank } : {}),
    lineOffsetPx: offs.length ? +[...offs].sort((a, b) => a - b)[offs.length >> 1].toFixed(1) : null,
    trackRms: +Math.max(...Object.values(g).map(v => v.rms)).toFixed(2), ms: Date.now() - t0,
  };
}

// trackGround's two directions and detectCones over `cones` (frame list) on worker threads.
async function groundThreads(frames, { ref, from, to, gy, boxes, cones }) {
  const fd = await frames.fd(), { W, H } = frames;
  const { Worker } = await import('node:worker_threads');
  const bx = Array.from({ length: to + 1 }, (_, i) => boxes?.[i] ?? null);
  const run = task => new Promise((res, rej) => {
    const w = new Worker(new URL('./ground-worker.mjs', import.meta.url), { workerData: { fd, W, H, task } });
    w.once('message', m => (m.error ? rej(new Error(m.error)) : res(m.out)));
    w.once('error', rej);
  });
  const parts = 5, size = Math.ceil(cones.length / parts);
  const [fw, bw, ...cs] = await Promise.all([
    run({ kind: 'track', ref, from, to, gy, boxes: bx, steps: [1] }),
    run({ kind: 'track', ref, from, to, gy, boxes: bx, steps: [-1] }),
    ...Array.from({ length: parts }, (_, k) => cones.slice(k * size, (k + 1) * size)).filter(l => l.length).map(list => run({ kind: 'cones', list, boxes: bx })),
  ]);
  // the same key order as one pass: ref first, then forward, then backward
  const g = { [ref]: fw[ref] };
  for (const k of Object.keys(fw)) if (+k !== ref) g[k] = fw[k];
  for (const k of Object.keys(bw)) if (+k !== ref) g[k] = bw[k];
  return { g, cones: Object.assign({}, ...cs) };
}

// ---------- a hand-held phone (RSI clips) ----------
// The phone's own motion over a whole clip, from the background with the athlete masked out.
// Hand shake is mostly rotation, and a rotating camera moves every depth alike, so walls, floor
// and the box all count. Rotation + scale + shift: a full homography over a few seconds drifted
// into nonsense on a panning clip (6 million px at the frame centre). Tracked at about `rate` Hz (shake is far
// slower) and decoded once, in order. Returns { h: { [frame]: H ref->frame }, ref, moved, rms,
// tracked } or null when the background has too little texture.
// The same on a worker thread (camera-worker.mjs), from the decoded file: every frame up to `to`
// has to be on disk first. boxes: the athlete's box per frame (an array or a Map), kept out.
export async function trackCameraThread(frames, { from, to, boxes, rate = 60 }) {
  if (!frames.fd) return trackCamera(frames, { from, to, boxes, rate });
  await frames.get(to);
  const fd = await frames.fd();
  const { Worker } = await import('node:worker_threads');
  const list = Array.from({ length: to + 1 }, (_, i) => (boxes?.get ? boxes.get(i) : boxes?.[i]) ?? null);
  return new Promise((res, rej) => {
    const w = new Worker(new URL('./camera-worker.mjs', import.meta.url), { workerData: { fd, W: frames.W, H: frames.H, fps: frames.fps, from, to, boxes: list, rate } });
    w.once('message', m => (m.error ? rej(new Error(m.error)) : res(m.camera)));
    w.once('error', rej);
  });
}

export async function trackCamera(frames, { from, to, boxes, rate = 60 }) {
  const t0 = Date.now(), { W, H } = frames;
  const k = Math.max(1, Math.round(frames.fps / rate));
  const n = Math.floor((to - from) / k) + 1;
  const it = frames.sequential(from, to, 1);
  let refRGBA = null, at = -1, cur = null;
  const get = async j => {
    if (j === 0 && refRGBA) return refRGBA;
    const want = from + j * k;
    while (at < want) { const r = await it.next(); if (r.done) throw new Error('clip ended'); at = r.value.i; cur = r.value.rgba; }
    if (j === 0) refRGBA = Buffer.from(cur);
    return cur;
  };
  let g;
  try {
    // shake is small: stop at a fit that zooms past ±15 % of the first frame or jumps more than
    // a fifth of the frame in one step (a lost track, not a hand)
    const scale = h => Math.hypot(h[0], h[3]);
    const sane = (h, prev) => Math.abs(scale(h) - 1) < 0.15 && Math.hypot(h[2] - prev[2], h[5] - prev[5]) < 0.2 * Math.min(W, H);
    g = await trackGround(get, W, H, { ref: 0, from: 0, to: n - 1, groundY: () => 0, box: j => boxes?.[from + j * k], model: 'similarity', sane });
  } catch { g = null; } finally { await it.return?.(); }
  const keys = Object.keys(g ?? {}).map(Number);
  if (keys.length < 2) return null;
  const h = {}; let moved = 0, rms = 0;
  for (const j of keys) {
    h[from + j * k] = g[j].h;
    const c = applyH(g[j].h, [W / 2, H / 2]); moved = Math.max(moved, Math.hypot(c[0] - W / 2, c[1] - H / 2));
    rms = Math.max(rms, g[j].rms);
  }
  return { h, ref: from, step: k, moved: +moved.toFixed(1), rms: +rms.toFixed(2), tracked: +(keys.length / n).toFixed(2), ms: Date.now() - t0 };
}
