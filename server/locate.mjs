// Claude watches the clip and names the key moments, the way a coach scrubs a video. The
// work is split by what each side does best, measured on three clips (2026-11-10):
// - Claude reads which frames have a foot on the ground and when the body meets the sand.
//   Its landing frame was exact on all three clips; its contact edges were 3-8 frames off.
// - The pose track's contact edges were within a frame where they exist.
// So Claude says which contacts are the last steps and the takeoff and when the landing is,
// and each contact keeps the pose track's edges when the pose track found that contact.
// An overview of the whole clip runs alongside and moves the search if the pose track picked
// the wrong place. Anything implausible falls back to the pose track.
import { contactSheet } from './grid.mjs';

export const LOCATE_MODEL = 'claude-opus-5-5';    // per-frame reading: Sonnet merged steps on IMG_2674
export const OVERVIEW_MODEL = 'claude-sonnet-5-5'; // finding the jump in a thumbnail strip is easy
const TIMEOUT_MS = 60_000;

const frameOrNull = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
const OVERVIEW_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['takeoff', 'landing'],
  properties: { takeoff: frameOrNull, landing: frameOrNull },
};
const FRAMES_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['on_ground', 'sand', 'run_through'],
  properties: { on_ground: { type: 'array', items: { type: 'integer' } }, sand: frameOrNull, run_through: { type: 'boolean' } },
};

const OVERVIEW_PROMPT = `You see a long jump filmed on a phone that pans with the athlete. The image is a contact sheet: frames in time order, row by row, each stamped with its frame number in yellow.
Find the jump. Answer with the printed frame numbers of the tile closest to the takeoff (the last foot contact before the athlete flies into the pit) and of the tile closest to the landing (the first touch of the sand). Use null for one you cannot see.`;

const FRAMES_PROMPT = `You see a long jump filmed on a phone that pans with the athlete. Each image is a contact sheet of consecutive frames, row by row, cropped around the athlete, each stamped with its frame number in yellow.
For every frame, decide whether a foot of the athlete is touching the running surface. A foot touches when it is flat on the ground or meets its own shadow; a foot above its shadow is in the air. Ignore the board and markings.
List every frame number with a foot on the running surface in on_ground. In sand, give the first frame where any part of the body touches the sand pit, or null if it is not shown.
Set run_through to true if this is a run-through (pop-up) instead of a full jump: after the takeoff the athlete comes down onto one foot in the sand and keeps running, rather than landing with both legs reaching forward. If the landing is not shown, judge from the flight: a run-through has no leg extension forward before the sand.`;

const image = jpeg => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg.toString('base64') } });

export async function ask(client, model, prompt, images, schema) {
  let timer;
  const res = await Promise.race([
    client.beta.messages.create({
      model, max_tokens: 4000,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system: [{ type: 'text', text: prompt }],
      messages: [{ role: 'user', content: [...images.map(image), { type: 'text', text: 'Answer in JSON.' }] }],
    }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('locate timeout')), TIMEOUT_MS); }),
  ]).finally(() => clearTimeout(timer));
  return JSON.parse(res.content?.find(b => b.type === 'text')?.text ?? 'null');
}

const range = (a, b, step = 1) => { const out = []; for (let i = a; i <= b; i += step) out.push(i); return out; };
const chunks = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

// Runs of consecutive ground frames; a one- or two-frame miss inside a contact is bridged.
export function groundRuns(frames, gap = 2) {
  const runs = [];
  for (const f of [...new Set(frames)].sort((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last && f - last.to <= gap) last.to = f; else runs.push({ td: f, to: f });
  }
  return runs;
}

// Claude's runs say which contacts are which; the pose track's overlapping contact gives the
// edges. takeoffAt: the frame the takeoff contact should cover (the pose track's guess).
export function pickContacts(runs, poseContacts, takeoffAt, fps) {
  const real = runs.filter(r => (r.to - r.td + 1) / fps >= 0.03);
  if (!real.length) return {};
  const dist = r => (takeoffAt >= r.td && takeoffAt <= r.to ? 0 : Math.min(Math.abs(takeoffAt - r.td), Math.abs(takeoffAt - r.to)));
  const ti = real.reduce((b, r, k) => (dist(r) < dist(real[b]) ? k : b), 0);
  const edges = r => {
    const p = poseContacts.find(c => Math.min(c.to, r.to) >= Math.max(c.td, r.td));
    return p ? { td: p.td, to: p.to, from: 'pose' } : { td: r.td, to: r.to, from: 'claude' };
  };
  const take = real[ti], pen = real[ti - 1], third = real[ti - 2];
  return { take: edges(take), pen: pen && edges(pen), third: third && edges(third) };
}

// Keeps only answers that fit a long jump: the right order and human contact and flight times.
export function checkEvents(e, fps) {
  const ok = {}, bad = [];
  const s = (a, b) => (e[b] - e[a]) / fps;
  const keep = (k, valid) => { if (e[k] == null) return; if (valid) ok[k] = e[k]; else bad.push(k); };
  const inRange = (v, lo, hi) => v >= lo && v <= hi;
  keep('TD', Number.isInteger(e.TD));
  keep('TO', e.TD != null && inRange(s('TD', 'TO'), 0.06, 0.26));
  keep('landing', ok.TO != null && inRange(s('TO', 'landing'), 0.3, 1.3));
  keep('penTO', ok.TD != null && inRange(s('penTO', 'TD'), 0.02, 0.2));
  keep('penTD', ok.penTO != null && inRange(s('penTD', 'penTO'), 0.05, 0.25));
  keep('td3', ok.penTD != null && inRange(s('td3', 'penTD'), 0.15, 0.5));
  if (ok.TO == null) { delete ok.TD; if (e.TD != null && !bad.includes('TD')) bad.push('TD'); }
  return { events: ok, rejected: bad };
}

// guess: the pose track's own reading { TD, TO, landing, contacts }, possibly empty.
export async function locateEvents({ frames, boxes, first, last, fps, client, guess = {}, model = LOCATE_MODEL, onProgress }) {
  const t0 = Date.now();
  const f = s => Math.round(s * fps), per = Math.max(1, Math.round(fps / 120));
  const clamp = v => Math.max(first, Math.min(last, v));
  onProgress?.({ stage: 'locate', done: 0, total: 1 });

  const step = Math.max(1, Math.ceil((last - first + 1) / 48));
  const overview = contactSheet(frames, range(first, last, step), { boxes, mode: 'full', cols: 10, tileW: 150 })
    .then(sheet => ask(client, OVERVIEW_MODEL, OVERVIEW_PROMPT, [sheet], OVERVIEW_SCHEMA))
    .catch(() => null);

  const read = async (T, L) => {
    const windows = [
      range(clamp(T - f(0.6)), clamp(T - f(0.06)), per),
      range(clamp(T - f(0.06) + per), clamp(T + f(0.22)), per),
      L != null ? range(clamp(L - f(0.2)), clamp(L + f(0.12)), per) : range(clamp(T + f(0.6)), clamp(T + f(1.0)), per),
    ];
    const sheets = [];
    for (const w of windows) for (const part of chunks(w, 36)) sheets.push(await contactSheet(frames, part, { boxes, cols: 9, tileW: 160 }));
    const ans = await ask(client, model, FRAMES_PROMPT, sheets, FRAMES_SCHEMA);
    const shown = new Set(windows.flat());
    return { ans, T, L, ground: (ans?.on_ground ?? []).filter(i => shown.has(i)), sand: shown.has(ans?.sand) ? ans.sand : null, runThrough: ans?.run_through === true };
  };

  // With no pose guess the overview has to come first; otherwise both run at once.
  let coarse = guess.TD == null ? await overview : null;
  const T0 = guess.TD ?? coarse?.takeoff;
  if (T0 == null) return { events: {}, rejected: ['TD'], coarse, model, ms: Date.now() - t0 };
  let seen = await read(T0, guess.TD != null ? guess.landing ?? null : coarse?.landing ?? null);
  coarse ??= await overview;
  // The overview disagrees by more than half a second: the pose track picked the wrong place.
  if (coarse?.takeoff != null && Math.abs(coarse.takeoff - T0) > f(0.5)) seen = await read(coarse.takeoff, coarse.landing ?? null);
  onProgress?.({ stage: 'locate', done: 1, total: 1 });

  const runs = groundRuns(seen.ground);
  const at = seen.T === guess.TD && guess.TO != null ? Math.round((guess.TD + guess.TO) / 2) : seen.T;
  const c = pickContacts(runs, guess.contacts ?? [], at, fps);
  const named = {
    td3: c.third?.td ?? null, penTD: c.pen?.td ?? null, penTO: c.pen?.to ?? null,
    TD: c.take?.td ?? null, TO: c.take?.to ?? null, landing: seen.sand,
  };
  const checked = checkEvents(named, fps);
  // A run-through (pop-up) is the same jump up to the flight, then the athlete runs out of the pit.
  if (checked.events.TD != null) checked.events.kind = seen.runThrough ? 'runthrough' : 'jump';
  return {
    ...checked, coarse, runs, edges: { take: c.take?.from, pen: c.pen?.from, third: c.third?.from },
    windows: { T: seen.T, L: seen.L }, model, ms: Date.now() - t0,
  };
}
