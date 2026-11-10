// Automatic pose pipeline: find the jumper, follow them through the clip, and get
// keypoints on every frame. Accuracy where it matters: the heavy model runs on the
// frames where the athlete is large enough for it to help.
//
// frames: { N, W, H, fps, get(i) -> rgba, sequential(from, to, step) -> async iterable of { i, rgba } }
// engine: PoseEngine with 'detector', fast and accurate models loaded.
import { linkTracks, pickAthlete, predictBox, searchRoi, bestMatch, interpolateBoxes, boxFromKeypoints, boxH, iou } from './tracker.js';
import { meanScore } from './engine.js';
import { MODELS } from './models.js';
import { cleanTrack } from './clean.js';

export const DEFAULTS = {
  sampleStep: 8,        // full-frame detection every Nth frame
  fast: 'rtmpose-m',
  accurate: 'rtmw-l-384',
  minPoseHeight: 0.04,  // skip pose when the athlete is under 4% of frame height (far away)
  accurateHeight: 0.15, // heavy model when the athlete is at least 15% of frame height (last steps on)
  fastMinScore: 0.4,    // below this mean keypoint score, re-detect around the athlete
};

export async function runPipeline(frames, engine, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { N, W, H } = frames;
  const progress = (stage, done, total) => o.onProgress?.({ stage, done, total });
  const t0 = performance.now();

  // Pass 1: find people every Nth frame, link them into tracks, pick the jumper.
  const samples = [];
  for await (const { i, rgba } of frames.sequential(0, N - 1, o.sampleStep)) {
    samples.push({ frame: i, boxes: await engine.detect(rgba, W, H) });
    progress('Finding the jumper', i, N);
  }
  const athlete = pickAthlete(linkTracks(samples), W, H);
  if (!athlete) return { error: 'No person found in this clip.' };
  const points = athlete.points.map(p => ({ frame: p.frame, box: p.box }));

  // Extend the track both ways by searching around the predicted position. This
  // re-finds the athlete while they are too small for the full-frame detector.
  for (const dir of [-1, 1]) {
    let misses = 0;
    for (let f = (dir < 0 ? points[0].frame : points.at(-1).frame) + dir * o.sampleStep;
      f >= 0 && f < N && misses < 2; f += dir * o.sampleStep) {
      const pred = predictBox(points, f);
      const roi = searchRoi(pred, W, H);
      const hit = bestMatch(await engine.detect(await frames.get(f), W, H, roi), pred);
      if (hit) { misses = 0; dir < 0 ? points.unshift({ frame: f, box: hit }) : points.push({ frame: f, box: hit }); }
      else misses++;
      progress('Following the jumper', points.length, N / o.sampleStep);
    }
  }
  // A short tail past the last detection: the landing (sand, a crouched body) is where the
  // detector loses the jumper first, and the keypoints can still follow them from frame to frame.
  const first = points[0].frame, last = Math.min(N - 1, points.at(-1).frame + 2 * o.sampleStep);
  const guide = interpolateBoxes(points, first, last);

  // Pass 2: fast model on every frame, crop from the previous frame's keypoints.
  const fast = new Array(N).fill(null);
  const boxes = new Array(N).fill(null);
  let prevBox = null, redetects = 0;
  for await (const { i, rgba } of frames.sequential(first, last, 1)) {
    const g = guide.get(i);
    if (boxH(g) < o.minPoseHeight * H) { prevBox = null; progress('Tracking pose', i - first, last - first); continue; }
    let box = prevBox && iou(prevBox, g) > 0.2 ? prevBox : g;
    let kp = await engine.pose(rgba, W, H, box, o.fast);
    if (meanScore(kp) < o.fastMinScore) {
      const hit = bestMatch(await engine.detect(rgba, W, H, searchRoi(g, W, H, 2)), g);
      redetects++;
      if (hit) {
        const kp2 = await engine.pose(rgba, W, H, hit, o.fast);
        if (meanScore(kp2) > meanScore(kp)) { kp = kp2; box = hit; }
      }
    }
    fast[i] = kp;
    boxes[i] = box;
    prevBox = boxFromKeypoints(kp, 0.3) ?? box;
    progress('Tracking pose', i - first, last - first);
  }

  // Pass 3: heavy model where the athlete is large (approach end, takeoff, flight, landing).
  const accurate = new Array(N).fill(null);
  const heavyFrames = [];
  for (let i = first; i <= last; i++) if (fast[i] && boxH(guide.get(i)) >= o.accurateHeight * H) heavyFrames.push(i);
  if (o.accurate && heavyFrames.length) {
    const lo = heavyFrames[0], hi = heavyFrames.at(-1);
    const want = new Set(heavyFrames);
    let n = 0;
    for await (const { i, rgba } of frames.sequential(lo, hi, 1)) {
      if (!want.has(i)) continue;
      const box = boxFromKeypoints(fast[i], 0.3) ?? boxes[i];
      accurate[i] = await engine.pose(rgba, W, H, box, o.accurate);
      progress('Precise pose', ++n, heavyFrames.length);
    }
  }

  // Pass 4: one track (precise where available), left/right fixed, spikes removed, smoothed.
  progress('Cleaning the track', 0, 1);
  const raw = fast.map((f, i) => accurate[i] || f);
  const minScore = i => MODELS[accurate[i] ? o.accurate : o.fast].minScore;
  const { clean, smooth, swapped, flagged } = cleanTrack(raw, minScore, frames.fps);

  return {
    W, H, N, fps: frames.fps, first, last, fast, accurate, clean, smooth, boxes, track: points,
    models: { fast: o.fast, accurate: o.accurate },
    stats: {
      redetects, heavyFrames: heavyFrames.length, seconds: (performance.now() - t0) / 1000, ms: engine.ms,
      swappedLegs: swapped.legs.size, swappedArms: swapped.arms.size, spikes: flagged.size,
    },
  };
}
