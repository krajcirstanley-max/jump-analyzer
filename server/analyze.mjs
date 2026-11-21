// The one entry point on the server: pose, analyzeJump, coaching, all through the same JS the
// phone runs. One shot: node server/analyze.mjs <clip> <out.json> --sex male|female --name <n> [--history file]
// Long-lived (Modal keeps models on the GPU between jobs): node server/analyze.mjs --serve
import { identifyAthlete } from './identify.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ort from 'onnxruntime-node';
import { PoseEngine } from '../js/pose/engine.js';
import { MODELS, boxToCenterScale } from '../js/pose/models.js';
import { runPipeline, DEFAULTS } from '../js/pose/pipeline.js';
import { analyzeJump } from '../js/analysis/jump.js';
import { toWire, fromWire } from '../js/cloud.js';
import { writeCoaching } from './coach.mjs';
import { cliClient } from './claude-cli.mjs';
import { probe, openFrames, jpeg } from './frames.mjs';
import { locateEvents, locateGuess, locateLanding, nameEvents, LOCATE_MODEL, LANDING_MODEL } from './locate.mjs';
import { stepTakeoff } from './takeoff.mjs';
import { measureGround } from './ground.mjs';
import { analyzeRsiClip } from './rsi.mjs';
import { analyzeSprintClip } from './sprint.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = process.env.JUMP_MODELS_DIR || join(root, 'models');
const provider = process.env.JUMP_PROVIDER || (process.platform === 'linux' ? 'cuda' : 'cpu');

// engine.js asks for the wasm backend, which is right on the phone. The server passes an
// ort with the same surface whose sessions go to the GPU instead; engine.js stays shared.
const serverOrt = {
  Tensor: ort.Tensor,
  InferenceSession: {
    create: model => ort.InferenceSession.create(model, {
      executionProviders: provider === 'cuda' ? [{ name: 'cuda', deviceId: 0 }, 'cpu'] : ['cpu'],
      graphOptimizationLevel: 'all',
    }),
  },
};

export async function loadEngine() {
  ort.env.logLevel = process.env.JUMP_ORT_LOG || 'error';
  const engine = new PoseEngine(serverOrt);
  await engine.load(['detector', DEFAULTS.fast, DEFAULTS.accurate], f => join(MODELS_DIR, basename(f)));
  return engine;
}

const NO_PERSON = 'Vo videu som nenašiel skokana. Skontroluj, či je na zábere celý rozbeh.';

// Who pays for the coaching: that person's own subscription token if they have one. With no
// client, writeCoaching uses ANTHROPIC_API_KEY if set, otherwise the template. The local login
// is for the owner's Mac only, so the long-lived server never asks for it.
export function coachClient({ token, localLogin = false } = {}) {
  if (token) return cliClient({ token });
  return localLogin ? cliClient() : undefined;
}

// onResult fires before any coaching work, so a slow or failed coaching call can't hold up
// or lose the numbers. coachFallback is what to show if the coaching step never comes back.
// athletes: [{ id, sex, name, height, history }] when the app leaves it to the server to tell who
// is in the clip; the one found replaces sex, name, height and history.
// deferCoach: the coaching text is written elsewhere (a CPU container, worker.process_coach), so this
// GPU job ends with the numbers and the phase snapshots (2026-11-19: a job held its GPU 1-3 min for
// the text, ten jumps queued 25-60 min, and the GPU was paid while idle).
// mode 'rozbeh' (2026-11-19): a run-up, analysed like a jump but with no coaching text.
export async function analyzeClip(engine, { clip, sex = 'male', name = '', height = null, pb = null, history = [], athletes = null, client, onProgress, onResult, deferCoach = false, mode = 'jump', split = null }) {
  const t = { start: performance.now() };
  const mark = k => { t[k] = Math.round(performance.now() - t.start); };
  const meta = probe(clip);
  mark('probe');
  const frames = openFrames(clip, meta);
  engine.ms = {};
  try {
    // a run-up is posed like a jump: posing the far, small athlete (tried 2026-11-19) counted 2 of 18
    // steps on two of five run-ups and made the take-off pick worse
    const res = await runPipeline(frames, engine, { onProgress });
    mark('pose');
    if (res.error) return { error: NO_PERSON, ms: t };

    // Through the wire format first, so coaching sees the phone's exact numbers.
    const result = toWire(res, meta.ts);
    // Claude watches the frames and names the key frames; the pose track's guess only says
    // where to look. Without a client, or if it fails, the pose track's own frames stand.
    let who = null, groundDone = false;
    const runGround = async jumpGuess => {
      onProgress?.({ stage: 'ground', done: 0, total: 1 });
      try {
        const g = await measureGround({ frames, track: fromWire(result).smooth, jump: jumpGuess, boxes: res.boxes, backS: mode === 'rozbeh' ? 3.4 : 1.7 });
        if (!g.error) result.ground = g;
        else result.groundError = g.error;
      } catch (e) {
        console.error('ground failed:', e?.message || e);
        result.groundError = String(e?.message || e).slice(0, 300);
      }
      mark('ground');
    };
    if (client) {
      const guessed = locateGuess(fromWire(result), sex, meta.ts, { height, pb });
      // Skok (2026-11-20): the board contact from the sprint pass's foot contacts (server/takeoff.mjs),
      // then Claude reads only the landing while the runway is measured. A run-up keeps the full
      // reading: its far steps are missed by the contact pass (3 of 6 run-ups had no board contact).
      let fast = null;
      if (mode === 'jump') {
        fast = await stepTakeoff({ frames, meta, res, wire: result, sex, onProgress })
          .catch(e => ({ error: String(e?.message || e).slice(0, 300) }));
        mark('steps');
      }
      const near = fast?.seen?.T ?? guessed.TD ?? null;
      // Who is in the clip, read alongside the key frames.
      const whoP = athletes?.length > 1
        ? identifyAthlete({ frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, near, athletes, client })
          .catch(e => ({ id: null, error: String(e?.message || e).slice(0, 200) }))
        : null;
      const first = fast?.seen ? nameEvents({ ...fast.seen, sand: null, runThrough: false }, guessed, meta.fps) : null;
      if (first?.events.TD != null) {
        result.events = first.events;
        const landP = locateLanding({ frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, client, TO: first.events.TO, model: LANDING_MODEL })
          .catch(e => ({ sand: null, runThrough: false, error: String(e?.message || e).slice(0, 200) }));
        // The runway from the take-off alone; its frames run to gravity's landing plus 0.12 s
        // (gravity was up to 13 frames early, never more than 2 late, on 11 jumps checked by eye).
        const pre = analyzeJump(fromWire(result), sex, meta.ts, { height, pb, preGround: true });
        const groundP = pre.error ? Promise.resolve() : runGround({ ...pre, landing: pre.landing != null ? pre.landing + Math.round(0.12 * meta.fps) : null }).then(() => { groundDone = true; });
        const [land] = await Promise.all([landP, groundP]);
        mark('landing');
        const seen = { ...fast.seen, sand: land.sand, runThrough: land.runThrough };
        const n = nameEvents(seen, guessed, meta.fps);
        if (n.events.TD != null) result.events = n.events;
        // the same fields as the full reading, so tools/bench.mjs replays it the same way
        result.locate = { fast: true, ms: land.ms, model: land.model, runs: n.runs, edges: n.edges, windows: { T: seen.T, L: null }, rejected: n.rejected, seen,
          steps: fast.steps, pick: fast.pick, timing: fast.timing, landWindow: land.window, ...(land.error ? { landError: land.error } : {}) };
      } else {
        // Claude watches the frames and names the key frames; the pose track's guess only says
        // where to look. If it fails, the pose track's own frames stand.
        try {
          const loc = await locateEvents({
            frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, client, onProgress,
            guess: guessed,
          });
          if (loc.events.TD != null) result.events = loc.events;
          // What Claude answered and what was kept, so a wrong frame can be traced later.
          result.locate = { ms: loc.ms, model: loc.model, coarse: loc.coarse, runs: loc.runs, edges: loc.edges, windows: loc.windows, rejected: loc.rejected, seen: loc.seen,
            ...(fast ? { fastError: fast.error ?? 'naming rejected', steps: fast.steps } : {}) };
        } catch (e) {
          console.error('locate failed:', e?.message || e);
          result.locate = { error: String(e?.message || e).slice(0, 300) };
        }
      }
      who = await whoP;
      mark('located');
    }
    if (athletes?.length > 1) {
      const a = athletes.find(x => x.id === who?.id);
      if (a) ({ sex, name, height = null, pb = null, history = [] } = a);
      result.who = { id: a?.id ?? null, said: who?.said ?? null, ms: who?.ms, error: who?.error };
    }
    // Metres from the runway: the take-off line, the sand and the runway lines in every frame.
    // Without them the analysis falls back to the gravity fit. Already measured on the fast path
    // unless its first pass found no jump (a run-through before it was named one).
    if (!groundDone) {
      // a run-up keeps its own take-off rule (trustTakeoff: a run-through is the long flight, events.js)
      const pre = analyzeJump(fromWire(result), sex, meta.ts, { height, pb, preGround: true, trustTakeoff: mode === 'rozbeh' });
      if (!pre.error) await runGround(pre);
    }
    onProgress?.({ stage: 'analysis', done: 0, total: 1 });
    // split: Freelap's 1-11 m time the phone paired with this clip (2026-11-20), as if typed
    const jump = analyzeJump(fromWire(result), sex, meta.ts, { height, pb, split: split > 0.8 && split < 2.5 ? split : null });
    mark('analysis');
    const coachFallback = jump.error ? null : await writeCoaching({ jump, name, sex });
    await onResult?.({ result, coachFallback, ms: t });

    let coach = null;
    if (mode === 'rozbeh') return { result, coach: null, jumpError: jump.error ?? undefined, decode: frames.mode, provider, ms: t };
    if (!jump.error && deferCoach) {
      const snapshots = await phaseSnapshots(frames, jump, res.last).catch(() => null);
      mark('snapshots');
      return { result, coach: null, coachInput: { jump, snapshots, name, sex, history, coachFallback }, jumpError: undefined, decode: frames.mode, provider, ms: t };
    }
    if (!jump.error) {
      onProgress?.({ stage: 'coach', done: 0, total: 1 });
      try {
        const snapshots = await phaseSnapshots(frames, jump, res.last);
        mark('snapshots');
        coach = await writeCoaching({ jump, snapshots, name, sex, history, apiKey: process.env.ANTHROPIC_API_KEY, client });
      } catch (e) {
        console.error('coaching failed:', e?.message || e);
        coach = coachFallback;
      }
      mark('coach');
    }
    return { result, coach, jumpError: jump.error ?? undefined, decode: frames.mode, provider, ms: t };
  } finally {
    frames.close();
  }
}

// One JPEG per phase. A hidden landing has no frame of its own; the phase's last frame
// (or the end of the track) still shows what the camera saw.
export async function phaseSnapshots(frames, jump, last) {
  const at = p => Math.max(0, Math.min(frames.N - 1, p.frame ?? p.to ?? last));
  const wanted = jump.phases ?? [];
  const pixels = await frames.pick(wanted.map(at));
  const out = [];
  for (const p of wanted) {
    const rgba = pixels.get(at(p));
    if (rgba) out.push({ phase: p.id, frame: at(p), jpeg: await jpeg(rgba, frames.W, frames.H) });
  }
  return out;
}

// Times one inference per model on blank input; tells apart "on the GPU" from "silently on CPU".
export async function selftest(engine) {
  const W = 640, H = 480, rgba = new Uint8Array(W * H * 4);
  const report = {};
  for (let i = 0; i < 4; i++) {
    await engine.detect(rgba, W, H);
    await engine.pose(rgba, W, H, [100, 100, 300, 400], DEFAULTS.fast);
    await engine.pose(rgba, W, H, [100, 100, 300, 400], DEFAULTS.accurate);
    // the heavy model's batch size (pipeline.js), so the first job does not pick its kernels
    { const m = MODELS[DEFAULTS.accurate], cs = boxToCenterScale([100, 100, 300, 400], m.w, m.h); await engine.poseBatch(new Float32Array(DEFAULTS.batch * 3 * m.w * m.h), [cs], DEFAULTS.accurate, DEFAULTS.batch); }
    if (i === 0) engine.ms = {}; // first run includes kernel setup on the GPU
  }
  for (const [k, m] of Object.entries(engine.ms)) report[k] = Math.round(m.total / m.n);
  engine.ms = {};
  return { provider, msPerRun: report };
}

// JSON lines: stdin gets { id, clip, out, sex, name, history, claudeToken? }, stdout gets
// { ready } once, then { id, progress }, { id, result, coachFallback, ms } when the numbers
// exist, and finally { id, done } or { id, error }. The token comes over the pipe because
// argv and env are visible to other processes; it is never echoed.
async function serve() {
  const say = o => process.stdout.write(`${JSON.stringify(o)}\n`);
  const engine = await loadEngine();
  say({ ready: true, ...(await selftest(engine)) });
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const { claudeToken, ...job } = JSON.parse(line);
    try {
      if (job.ping) { say({ id: job.id, done: true, ...(await selftest(engine)) }); continue; }
      let last = 0;
      const onProgress = p => {
        const now = performance.now();
        if (now - last > 400) { last = now; say({ id: job.id, progress: p }); }
      };
      // RSI drills: contacts and flights only, no coaching text, so the numbers are the end.
      // RSI and sprint jobs: numbers only, no coaching text, so the numbers are the end.
      const out = job.mode === 'rsi'
        ? await analyzeRsiClip(engine, { clip: job.clip, sex: job.sex, height: job.height ?? null, boxCm: job.boxCm ?? null, athletes: job.athletes ?? null, client: coachClient({ token: claudeToken }), onProgress, onResult: r => say({ id: job.id, result: r, coachFallback: null }) })
        : job.mode === 'sprint'
        ? await analyzeSprintClip(engine, { clip: job.clip, athletes: job.athletes ?? null, who: job.who ?? null, client: coachClient({ token: claudeToken }), onProgress })
        : await analyzeClip(engine, {
          ...job,
          client: coachClient({ token: claudeToken }),
          onProgress,
          onResult: r => say({ id: job.id, ...r }),
        });
      if ((job.mode === 'rsi' || job.mode === 'sprint') && out.result) say({ id: job.id, result: out.result, coachFallback: null, ms: out.result.ms });
      writeFileSync(job.out, JSON.stringify(out));
      say({ id: job.id, done: true });
    } catch (e) {
      console.error(e);
      say({ id: job.id, error: e?.message || String(e) });
    }
  }
}

async function oneShot(argv) {
  const [clip, out, ...rest] = argv;
  const flag = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  if (!clip || !out) throw new Error('usage: analyze.mjs <clip> <out.json> --sex male|female --name <n> [--history file]');
  const t0 = performance.now();
  const engine = await loadEngine();
  const loaded = performance.now() - t0;
  const historyFile = flag('--history');
  let last = 0;
  const r = await analyzeClip(engine, {
    clip, sex: flag('--sex', 'male'), name: flag('--name', ''), height: Number(flag('--height', 0)) || null,
    history: historyFile ? JSON.parse(readFileSync(historyFile, 'utf8')) : [],
    client: coachClient({ localLogin: process.env.COACH_VIA === 'subscription' }),
    onProgress: ({ stage, done, total }) => {
      if (performance.now() - last > 5000) { last = performance.now(); console.error(`${stage} ${done}/${Math.round(total)}`); }
    },
  });
  writeFileSync(out, JSON.stringify(r));
  console.error(JSON.stringify({ modelsLoadMs: Math.round(loaded), totalMs: Math.round(performance.now() - t0), ...r.ms, decode: r.decode, provider: r.provider, error: r.error, stats: r.result?.stats }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  (argv[0] === '--serve' ? serve() : oneShot(argv)).catch(e => { console.error(e); process.exit(1); });
}
