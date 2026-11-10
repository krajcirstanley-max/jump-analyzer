// Finding and following the jumper. Pure functions, unit-tested in Node.

export const boxH = b => b[3] - b[1];
export const boxW = b => b[2] - b[0];
const cx = b => (b[0] + b[2]) / 2;
const cy = b => (b[1] + b[3]) / 2;

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  return inter / (boxW(a) * boxH(a) + boxW(b) * boxH(b) - inter || 1);
}

// Similarity of two boxes allowing for movement: centre distance relative to size.
function linkCost(a, b, frames) {
  const s = Math.max(boxH(a), boxH(b));
  const d = Math.hypot(cx(a) - cx(b), cy(a) - cy(b)) / s;
  const size = Math.abs(Math.log(boxH(a) / boxH(b)));
  return d / Math.max(1, frames / 8) + size; // allow more movement over longer gaps
}

// Links per-frame detections into tracks. samples: [{ frame, boxes: [[x1,y1,x2,y2,s]] }].
export function linkTracks(samples, maxCost = 1.2, maxGapSamples = 3) {
  const tracks = [];
  for (const { frame, boxes } of samples) {
    const used = new Set();
    // Greedy by cost: good enough for a handful of people per frame.
    const pairs = [];
    tracks.forEach((t, ti) => {
      const last = t.points[t.points.length - 1];
      const gap = frame - last.frame;
      if (gap > maxGapSamples * (t.step || 8)) return;
      boxes.forEach((b, bi) => pairs.push([linkCost(last.box, b, gap), ti, bi]));
    });
    pairs.sort((a, b) => a[0] - b[0]);
    const taken = new Set();
    for (const [c, ti, bi] of pairs) {
      if (c > maxCost || taken.has(ti) || used.has(bi)) continue;
      const t = tracks[ti];
      t.step = frame - t.points[t.points.length - 1].frame;
      t.points.push({ frame, box: boxes[bi] });
      taken.add(ti); used.add(bi);
    }
    boxes.forEach((b, bi) => { if (!used.has(bi)) tracks.push({ points: [{ frame, box: b }] }); });
  }
  return tracks;
}

// The jumper: the person who is big in frame, near the centre, and moving.
// Panning keeps the athlete central; spectators are small, off-centre or static.
export function athleteScore(track, W, H) {
  let sum = 0;
  for (const { box } of track.points) {
    const centr = 1 - Math.min(1, Math.abs(cx(box) - W / 2) / (W / 2));
    sum += (boxH(box) / H) * (0.5 + 0.5 * centr);
  }
  const p = track.points;
  const growth = p.length > 1 ? Math.abs(Math.log(boxH(p[p.length - 1].box) / boxH(p[0].box))) : 0;
  const moved = p.length > 1 ? Math.hypot(cx(p[p.length - 1].box) - cx(p[0].box), cy(p[p.length - 1].box) - cy(p[0].box)) / H : 0;
  return sum * (1 + growth + moved);
}

export function pickAthlete(tracks, W, H) {
  let best = null, bestScore = -1;
  for (const t of tracks) {
    const s = athleteScore(t, W, H);
    if (s > bestScore) { bestScore = s; best = t; }
  }
  return best;
}

// Constant-velocity guess of where the athlete's box will be at `frame`,
// from the two nearest known points on the side we're extending from.
export function predictBox(points, frame) {
  const n = points.length;
  if (n === 1) return points[0].box.slice(0, 4);
  const [a, b] = frame < points[0].frame ? [points[1], points[0]] : [points[n - 2], points[n - 1]];
  const t = (frame - b.frame) / (b.frame - a.frame);
  return [0, 1, 2, 3].map(k => b.box[k] + (b.box[k] - a.box[k]) * t);
}

// Search window around a predicted box: big enough to re-find a small, moving athlete.
export function searchRoi(box, W, H, grow = 3) {
  const w = Math.max(boxW(box) * grow, boxH(box) * grow * 0.8, 160);
  const h = Math.max(boxH(box) * grow, 160);
  const x = Math.max(0, Math.min(W - w, cx(box) - w / 2));
  const y = Math.max(0, Math.min(H - h, cy(box) - h / 2));
  return [x, y, Math.min(w, W), Math.min(h, H)];
}

// Box for every frame from first to last known point, linearly interpolated.
export function interpolateBoxes(points, first, last) {
  const out = new Map();
  let k = 0;
  for (let f = first; f <= last; f++) {
    while (k < points.length - 2 && points[k + 1].frame < f) k++;
    const a = points[k], b = points[Math.min(k + 1, points.length - 1)];
    if (f <= a.frame || a === b) { out.set(f, a.box.slice(0, 4)); continue; }
    if (f >= b.frame) { out.set(f, b.box.slice(0, 4)); continue; }
    const t = (f - a.frame) / (b.frame - a.frame);
    out.set(f, [0, 1, 2, 3].map(i => a.box[i] + (b.box[i] - a.box[i]) * t));
  }
  return out;
}

// Tight box around confident keypoints, or null if too few are confident.
export function boxFromKeypoints(kp, minScore, minCount = 8) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
  for (let j = 0; j < kp.length / 3; j++) {
    if (kp[j * 3 + 2] < minScore) continue;
    const x = kp[j * 3], y = kp[j * 3 + 1];
    x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); n++;
  }
  if (n < minCount) return null;
  // Keypoints sit inside the body outline: add a margin for head top and limbs.
  const mw = (x2 - x1) * 0.1, mh = (y2 - y1) * 0.12;
  return [x1 - mw, y1 - mh, x2 + mw, y2 + mh * 0.5];
}

// Picks the detection that best continues the track.
export function bestMatch(boxes, predicted) {
  let best = null, bestCost = Infinity;
  for (const b of boxes) {
    const c = linkCost(predicted, b, 8);
    if (c < bestCost) { bestCost = c; best = b; }
  }
  return bestCost < 1.2 ? best : null;
}
