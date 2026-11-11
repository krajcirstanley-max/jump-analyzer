// RSI jobs: pose on every frame, contacts and flights from the feet (js/analysis/rsi.js), and
// Claude naming the exercise from a contact sheet. Claude never sets a frame edge: on the long
// jump its contact edges were 3-8 frames off where the pose track was within one.
import { runPipeline } from '../js/pose/pipeline.js';
import { toWire, fromWire } from '../js/cloud.js';
import { rsiAnalysis } from '../js/analysis/rsi.js';
import { contactSheet } from './grid.mjs';
import { probe, openFrames } from './frames.mjs';

export const RSI_MODEL = 'claude-sonnet-5-5'; // naming a drill from a strip of frames is easy
export const EXERCISES = ['drop_jump', 'drop_jump_single', 'pogo', 'repeated_hops', 'hurdle_hops', 'cmj', 'squat_jump', 'single_leg_hops', 'other'];
const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['exercise', 'leg', 'box'],
  properties: {
    exercise: { type: 'string', enum: EXERCISES },
    leg: { type: 'string', enum: ['both', 'left', 'right'] },
    box: { type: 'boolean' },
  },
};
const PROMPT = `You see a plyometric jump drill filmed from the front with a still phone. The image is a contact sheet: frames in time order, row by row, each stamped with its frame number in yellow.
Name the drill: drop_jump (steps off a box, lands on both feet and rebounds up at once), drop_jump_single (the same on one leg), pogo (fast ankle bounces, knees nearly straight), repeated_hops (several rebound jumps in a row, both feet), hurdle_hops (repeated jumps over hurdles), cmj (one jump from standing with a dip first), squat_jump (one jump from a held squat, no dip), single_leg_hops (repeated hops on one leg), other.
leg: the leg(s) that take the contacts, from the athlete's point of view (the athlete's left foot is on the right side of the image when facing the camera). box: true if the athlete starts standing on a box or step.`;

async function nameExercise({ frames, first, last, boxes, client }) {
  const step = Math.max(1, Math.ceil((last - first + 1) / 40));
  const list = []; for (let i = first; i <= last; i += step) list.push(i);
  const sheet = await contactSheet(frames, list, { boxes, mode: 'full', cols: 8, tileW: 150 });
  const res = await client.beta.messages.create({
    model: RSI_MODEL, max_tokens: 1000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: PROMPT }],
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sheet.toString('base64') } }, { type: 'text', text: 'Answer in JSON.' }] }],
  });
  return JSON.parse(res.content?.find(b => b.type === 'text')?.text ?? 'null');
}

export async function analyzeRsiClip(engine, { clip, sex = 'male', height = null, boxCm = null, client, onProgress }) {
  const t0 = performance.now();
  const meta = probe(clip);
  const frames = openFrames(clip, meta);
  try {
    const res = await runPipeline(frames, engine, { onProgress });
    if (res.error) return { error: 'Vo videu som nenašiel športovca. Skontroluj, či sú v zábere celé nohy.' };
    const wire = toWire(res, meta.ts);
    onProgress?.({ stage: 'rsi', done: 0, total: 1 });
    const rsi = rsiAnalysis(fromWire(wire), meta.ts, { sex, height, boxCm });
    if (rsi.error) return { error: rsi.error };
    // Claude names the drill; the pattern of contacts is the fallback and the cross-check.
    let named = null, nameError = null;
    if (client) {
      const ev = rsi.events ?? [];
      const first = Math.max(0, (ev[0]?.td ?? res.first) - Math.round(meta.fps * 0.4));
      const last = Math.min(meta.N - 1, (ev.at(-1)?.to ?? res.last) + Math.round(meta.fps * 0.3));
      try { named = await nameExercise({ frames, first, last, boxes: res.boxes, client }); } catch (e) { nameError = String(e?.message || e).slice(0, 200); }
    }
    // Claude's name wins, 'other' included (a clip that is not a drill); without Claude, the pattern
    const exercise = named?.exercise ?? rsi.kind;
    const usesBox = named?.box ?? Boolean(rsi.boxEstCm);
    const result = {
      ...rsi, exercise, named, nameError, usesBox,
      // the box height is asked for when the drill starts from a box and the athlete gave none
      askBox: usesBox && !boxCm,
      W: meta.W, H: meta.H, N: meta.N, ts: wire.ts, ms: Math.round(performance.now() - t0),
    };
    return { result };
  } finally {
    frames.close();
  }
}
