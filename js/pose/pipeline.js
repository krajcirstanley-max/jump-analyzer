// Automatic pose pipeline: find the jumper, follow them through the clip, and get
// keypoints on every frame. Accuracy where it matters: the heavy model runs on the
// frames where the athlete is large enough for it to help.
//
// frames: { N, W, H, fps, get(i) -> rgba, sequential(from, to, step) -> async iterable of { i, rgba } }
// engine: PoseEngine with 'detector', fast and accurate models loaded.
import { linkTracks, pickAthlete, rejoinTracks, predictBox, searchRoi, bestMatch, interpolateBoxes, boxFromKeypoints, boxH, iou } from './tracker.js';
import { meanScore } from './engine.js';
import { MODELS, boxToCenterScale, poseInput } from './models.js';
import { cleanTrack } from './clean.js';

export const DEFAULTS = {
  sampleStep: 8,        // full-frame detection every Nth frame
  fast: 'rtmpose-m',
  accurate: 'rtmw-l-384',
  minPoseHeight: 0.04,  // skip pose when the athlete is under 4% of frame height (far away)
  accurateHeight: 0.15, // heavy model when the athlete is at least 15% of frame height (last steps on)
  fastMinScore: 0.4,    // below this mean keypoint score, re-detect around the athlete
  batch: 16,            // heavy-model crops per run where the engine batches (server GPU)
};

export async function runPipeline(frames, engine, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { N, W, H } = frames;
  const progress = (stage, done, total) => o.onProgress?.({ stage, done, total });
  const t0 = performance.now(), spent0 = {};

  // Pass 1: find people every Nth frame, link them into tracks, pick the jumper.
  const samples = [];
  for await (const { i, rgba } of frames.sequential(0, N - 1, o.sampleStep)) {
    samples.push({ frame: i, boxes: await engine.detect(rgba, W, H) });
    progress('Finding the jumper', i, N);
  }
  const tracks = linkTracks(samples);
  const athlete = pickAthlete(tracks, W, H);
  if (!athlete) return { error: 'No person found in this clip.' };
  // opts.rejoinS: tracks that pick up within that many seconds where the athlete was lost are
  // the athlete (rejoinTracks). Only the RSI analysis asks for it; jumps and sprints are unchanged.
  if (o.rejoinS) rejoinTracks(athlete, tracks, o.rejoinS * (frames.fps || 30));
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
  spent0.find = Math.round(performance.now() - t0);
  const guide = interpolateBoxes(points, first, last);
  // the athlete's place on every frame is known from here: work that needs only that (the server's
  // camera tracking) can start while the pose models run
  o.onGuide?.({ first, last, guide });

  // Pass 2: fast model, crop from the previous posed frame's keypoints. Pass 3: heavy model where
  // the athlete is large (approach end, takeoff, flight, landing), in batches where the engine
  // takes them. Both run over `runs` of frames: every frame by default; with opts.coarse = k only
  // every k-th, and densify() adds every frame of the stretches the analysis asks for (2026-11-18:
  // an RSI clip needs its contacts frame by frame, not the half second standing on the box).
  const realFast = new Array(N).fill(null), realAcc = new Array(N).fill(null), boxes = new Array(N).fill(null);
  const posed = new Uint8Array(N);
  let redetects = 0, heavyCount = 0;
  const m = MODELS[o.accurate], size = 3 * m.w * m.h, B = engine.poseBatch && o.batch > 1 ? o.batch : 1;
  // two buffers: the next batch's crops are cut while the GPU runs the last one
  const bufs = B > 1 ? [new Float32Array(B * size), new Float32Array(B * size)] : null;
  // milliseconds per pass, summed over calls (the speed work is measured, not guessed)
  const spent = spent0;
  const took = (k, t) => { spent[k] = Math.round((spent[k] ?? 0) + performance.now() - t); };
  async function poseRuns(runs) {
    const heavy = [];
    let t = performance.now();
    for (const [a, b, step] of runs) {
      // the crop follows the last posed frame before the run, if it is close
      let prevBox = null;
      for (let j = a - 1; j >= Math.max(first, a - step); j--) if (posed[j]) { prevBox = boxFromKeypoints(realFast[j], 0.3) ?? boxes[j]; break; }
      for await (const { i, rgba } of frames.sequential(a, b, step)) {
        const g = guide.get(i);
        if (posed[i]) { prevBox = boxFromKeypoints(realFast[i], 0.3) ?? boxes[i]; continue; }
        if (boxH(g) < o.minPoseHeight * H) { prevBox = null; continue; }
        let box = prevBox && iou(prevBox, g) > 0.2 ? prevBox : g;
        const tf = performance.now();
        let kp = await engine.pose(rgba, W, H, box, o.fast);
        took('fastModel', tf);
        if (meanScore(kp) < o.fastMinScore) {
          const hit = bestMatch(await engine.detect(rgba, W, H, searchRoi(g, W, H, 2)), g);
          redetects++;
          if (hit) {
            const kp2 = await engine.pose(rgba, W, H, hit, o.fast);
            if (meanScore(kp2) > meanScore(kp)) { kp = kp2; box = hit; }
          }
        }
        realFast[i] = kp; boxes[i] = box; posed[i] = 1;
        prevBox = boxFromKeypoints(kp, 0.3) ?? box;
        if (o.accurate && boxH(g) >= o.accurateHeight * H) heavy.push(i);
        progress('Tracking pose', i - first, last - first);
      }
    }
    took('fast', t); t = performance.now();
    if (!heavy.length) return;
    heavyCount += heavy.length;
    let held = [], n = 0, cur = 0, buf = bufs?.[0];
    const running = [null, null];
    const flush = async () => {
      const batch = held, slot = cur;
      running[slot] = engine.poseBatch(bufs[slot], batch.map(h => h.cs), o.accurate, B).then(kps => {
        batch.forEach((h, k) => { realAcc[h.i] = kps[k]; });
        n += batch.length;
        progress('Precise pose', n, heavy.length);
      });
      held = []; cur = 1 - cur; buf = bufs[cur];
      if (running[cur]) { await running[cur]; running[cur] = null; }
    };
    // the crop is cut at once, so the decoder's reused frame buffer is never read after it moves on
    // Only the frames wanted, a batch at a time where the frames are a file (the server: reading
    // every frame of the span cost 2-3 s on a coarse pass that wants every 4th); a stream reads on.
    const want = new Set(heavy);
    const spans = [];
    for (const i of heavy) { const r = spans.at(-1); if (r && i - r[1] <= 8) r[1] = i; else spans.push([i, i]); }
    const each = frames.mode === 'disk'
      ? async function* () { for (let k = 0; k < heavy.length; k += 16) { const tr = performance.now(); const got = await frames.pick(heavy.slice(k, k + 16)); took('heavyRead', tr); for (const i of heavy.slice(k, k + 16)) if (got.has(i)) yield { i, rgba: got.get(i) }; } }
      : async function* () { for (const [lo, hi] of spans) for await (const f of frames.sequential(lo, hi, 1)) if (want.has(f.i)) yield f; };
    {
      for await (const { i, rgba } of each()) {
        const box = boxFromKeypoints(realFast[i], 0.3) ?? boxes[i];
        if (B > 1) {
          const cs = boxToCenterScale(box, m.w, m.h), tp = performance.now();
          poseInput(rgba, W, H, cs, m.w, m.h, buf, held.length * size);
          took('heavyPrep', tp);
          held.push({ i, cs });
          if (held.length === B) { const tw = performance.now(); await flush(); took('heavyWait', tw); }
          continue;
        }
        realAcc[i] = await engine.pose(rgba, W, H, box, o.accurate);
        progress('Precise pose', ++n, heavy.length);
      }
    }
    if (held.length) await flush();
    await Promise.all(running.filter(Boolean));
    took('heavy', t);
  }

  // Pass 4: one track (precise where available), skipped frames filled in, left/right fixed,
  // spikes removed, smoothed.
  function finish() {
    progress('Cleaning the track', 0, 1);
    const fast = realFast.slice(), accurate = realAcc.slice();
    const filled = o.coarse > 1 ? fillGaps(fast, accurate, first, last, 2 * o.coarse + 1) : [];
    const box = boxes.map((b, i) => b ?? (i >= first && i <= last && (fast[i] || accurate[i]) ? guide.get(i) : null));
    const raw = fast.map((f, i) => accurate[i] || f);
    const minScore = i => MODELS[accurate[i] ? o.accurate : o.fast].minScore;
    const { clean, smooth, swapped, flagged } = cleanTrack(raw, minScore, frames.fps);
    let posedN = 0; for (let i = 0; i < N; i++) posedN += posed[i];
    return {
      W, H, N, fps: frames.fps, first, last, fast, accurate, clean, smooth, boxes: box, track: points,
      models: { fast: o.fast, accurate: o.accurate },
      // frames the models saw; the rest of first..last was filled in between them
      posed: posedN, coarse: o.coarse > 1 ? o.coarse : 1, filled: filled.length, posedAt: i => posed[i] === 1,
      stats: {
        redetects, heavyFrames: heavyCount, posed: posedN, spent: { ...spent }, seconds: (performance.now() - t0) / 1000, ms: engine.ms,
        swappedLegs: swapped.legs.size, swappedArms: swapped.arms.size, spikes: flagged.size,
      },
      // every frame of these stretches through the models, and the track built again
      densify: async ranges => {
        const runs = ranges.map(([a, b]) => [Math.max(first, a), Math.min(last, b), 1]).filter(([a, b]) => a <= b);
        await poseRuns(runs);
        return finish();
      },
    };
  }

  const step = o.coarse > 1 ? o.coarse : 1;
  await poseRuns(step > 1 ? [[first, last, step], [last, last, 1]] : [[first, last, 1]]);
  return finish();
}

// Frames the coarse pass skipped, filled straight between the frames on either side that have a
// pose (in place). A gap goes into `accurate` when both sides came from the heavy model, so its
// scores keep that model's scale, else into `fast`. Gaps over maxGap frames stay empty. Returns
// the filled frames.
export function fillGaps(fast, accurate, first, last, maxGap = 8) {
  const has = i => accurate[i] || fast[i];
  const filled = [];
  let a = null;
  for (let i = first; i <= last; i++) {
    if (!has(i)) continue;
    if (a != null && i - a > 1 && i - a <= maxGap) {
      const A = has(a), B = has(i), heavy = !!accurate[a] && !!accurate[i];
      for (let f = a + 1; f < i; f++) {
        const t = (f - a) / (i - a), kp = new Float32Array(A.length);
        for (let j = 0; j < A.length; j += 3) {
          kp[j] = A[j] + (B[j] - A[j]) * t; kp[j + 1] = A[j + 1] + (B[j + 1] - A[j + 1]) * t;
          kp[j + 2] = Math.min(A[j + 2], B[j + 2]);
        }
        (heavy ? accurate : fast)[f] = kp;
        filled.push(f);
      }
    }
    a = i;
  }
  return filled;
}
