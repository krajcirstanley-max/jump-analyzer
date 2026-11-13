// RSI jobs: pose on every frame, contacts and flights from the feet (js/analysis/rsi.js), and
// Claude naming the exercise from a contact sheet. Claude never sets a frame edge: on the long
// jump its contact edges were 3-8 frames off where the pose track was within one.
import { identifyAthlete } from './identify.mjs';
import { runPipeline } from '../js/pose/pipeline.js';
import { toWire, fromWire } from '../js/cloud.js';
import { rsiAnalysis } from '../js/analysis/rsi.js';
import { contactSheet } from './grid.mjs';
import { probe, openFrames } from './frames.mjs';
import { trackCamera } from './ground.mjs';

export const RSI_MODEL = 'claude-sonnet-5-5'; // naming a drill from a strip of frames is easy
export const EXERCISES = ['drop_jump', 'drop_jump_single', 'pogo', 'repeated_hops', 'hurdle_hops', 'cmj', 'squat_jump', 'single_leg_hops', 'other'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['exercise', 'leg', 'box', 'boxCm', 'boxFrom'],
  properties: {
    exercise: { type: 'string', enum: EXERCISES },
    leg: { type: 'string', enum: ['both', 'left', 'right'] },
    box: { type: 'boolean' },
    boxCm: { type: ['number', 'null'] },
    boxFrom: { type: 'string', enum: ['label', 'estimate', 'unknown', 'none'] },
  },
};
const PROMPT = `You see a plyometric jump drill filmed from the front with a phone (on a tripod or hand-held). The image is a contact sheet: frames in time order, row by row, each stamped with its frame number in yellow.
Name the drill: drop_jump (steps off a box, lands on both feet and rebounds up at once), drop_jump_single (the same on one leg), pogo (fast ankle bounces, knees nearly straight), repeated_hops (several rebound jumps in a row, both feet), hurdle_hops (repeated jumps over hurdles), cmj (one jump from standing with a dip first), squat_jump (one jump from a held squat, no dip), single_leg_hops (repeated hops on one leg), other.
leg: the leg(s) that take the contacts, from the athlete's point of view (the athlete's left foot is on the right side of the image when facing the camera). Decide it from the landing and rebound frames: if one foot stays off the floor while the other lands and pushes off, it is single-leg (left or right), even if the athlete stands on both feet before or after. A single-leg drop jump is drop_jump_single. box: true if the athlete starts standing on a box or step.
boxCm: the box height in centimetres, or null without a box. If a height is printed on the box, read it (boxFrom "label") and convert inches to cm (12" = 30 cm, 18" = 46 cm, 24" = 61 cm, 30" = 76 cm). Otherwise estimate it from the athlete standing next to or on it (boxFrom "estimate"; a shin is about a quarter of a person's height). If the box is not visible well enough to judge, boxCm null and boxFrom "unknown": the athlete will type it in. No box: null and "none". Always centimetres, never inches.`;

async function nameExercise({ frames, first, last, boxes, client, focus = null }) {
  const step = Math.max(1, Math.ceil((last - first + 1) / 32));
  const list = []; for (let i = first; i <= last; i += step) list.push(i);
  // The landing decides the leg: denser frames around the first contact on the floor.
  if (focus != null) for (let i = Math.max(first, focus - 12); i <= Math.min(last, focus + 36); i += 6) list.push(i);
  list.sort((a, b) => a - b);
  const sheet = await contactSheet(frames, list, { boxes, mode: 'full', cols: 8, tileW: 150 });
  const res = await client.beta.messages.create({
    model: RSI_MODEL, max_tokens: 1000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet.toString('base64') } }, { type: 'text', text: 'Answer in JSON.' }] }],
  });
  return JSON.parse(res.content?.find(b => b.type === 'text')?.text ?? 'null');
}

export async function analyzeRsiClip(engine, { clip, sex = 'male', height = null, boxCm = null, athletes = null, client, onProgress }) {
  const t0 = performance.now();
  const meta = probe(clip);
  const frames = openFrames(clip, meta);
  try {
    const res = await runPipeline(frames, engine, { onProgress });
    if (res.error) return { error: 'Vo videu som nenašiel športovca. Skontroluj, či sú v zábere celé nohy.' };
    const wire = toWire(res, meta.ts);
    // The phone may be hand-held: follow its motion over the background, then read the feet in
    // one fixed frame. Under 1.5 px of motion it was on a tripod and nothing changes.
    onProgress?.({ stage: 'camera', done: 0, total: 1 });
    let camera = null, cameraError = null;
    try { camera = await trackCamera(frames, { from: res.first, to: res.last, boxes: res.boxes }); } catch (e) { cameraError = String(e?.message || e).slice(0, 200); }
    const cam = camera && camera.moved >= 1.5 ? camera : null;
    // Who is in the clip (no athlete switch in the app): their sex and height go into the numbers.
    let who = null;
    if (client && athletes?.length > 1) {
      try { who = await identifyAthlete({ frames, boxes: res.boxes, first: res.first, last: res.last, fps: meta.fps, athletes, client }); }
      catch (e) { who = { id: null, error: String(e?.message || e).slice(0, 200) }; }
      const a = athletes.find(x => x.id === who.id);
      if (a) ({ sex, height = null } = a);
      who = { id: a?.id ?? null, said: who.said ?? null, ms: who.ms, error: who.error };
    }
    onProgress?.({ stage: 'rsi', done: 0, total: 1 });
    const rsi = rsiAnalysis(fromWire(wire), meta.ts, { sex, height, boxCm, cam });
    if (rsi.error) return { error: rsi.error };
    // Claude names the drill; the pattern of contacts is the fallback and the cross-check.
    let named = null, nameError = null;
    if (client) {
      const ev = rsi.events ?? [];
      const first = Math.max(0, (ev[0]?.td ?? res.first) - Math.round(meta.fps * 0.4));
      const last = Math.min(meta.N - 1, (ev.at(-1)?.to ?? res.last) + Math.round(meta.fps * 0.3));
      const focus = ev.find(e => !e.onBox)?.td ?? null;
      try { named = await nameExercise({ frames, first, last, boxes: res.boxes, client, focus }); } catch (e) { nameError = String(e?.message || e).slice(0, 200); }
    }
    // Claude's name wins, 'other' included (a clip that is not a drill); without Claude, the pattern
    const exercise = named?.exercise ?? rsi.kind;
    const usesBox = named?.box ?? Boolean(rsi.boxEstCm);
    // The box height read off the video (printed label or estimate), in cm, unless the app sent one.
    const boxSeen = usesBox && named?.boxCm > 0 ? { cm: Math.round(named.boxCm), from: named.boxFrom } : null;
    const ev = rsi.events ?? [];
    const noRebound = !rsi.jumps?.length && ev.some(e => e.onBox) && ev.some(e => !e.onBox && e.flightAfter == null);
    const result = {
      ...rsi, exercise, named, nameError, usesBox, noRebound, ...(boxCm == null && boxSeen ? { boxCm: boxSeen.cm, boxFrom: boxSeen.from } : {}), ...(who ? { who } : {}),
      camera: camera && { moved: camera.moved, rms: camera.rms, tracked: camera.tracked, step: camera.step, ms: camera.ms, used: !!cam }, cameraError,
      // RSI = jump height / contact time: the box never enters it. Its height is still noted, and
      // asked for only when the video could not show it (Stanley 2026-11-13: "ak nie tak treba
      // napísať že nevieš, treba dopísať").
      askBox: usesBox && boxCm == null && !boxSeen,
      W: meta.W, H: meta.H, N: meta.N, ts: wire.ts, ms: Math.round(performance.now() - t0),
    };
    return { result };
  } finally {
    frames.close();
  }
}
