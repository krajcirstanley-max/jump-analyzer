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
import { analyzeJump, poseContacts } from '../js/analysis/jump.js';

export const LOCATE_MODEL = 'claude-opus-5-5';    // per-frame reading: Sonnet merged steps on IMG_2674
export const OVERVIEW_MODEL = 'claude-sonnet-5-5'; // finding the jump in a thumbnail strip is easy
// The sand frame alone. Sonnet tried 2026-11-20 on five clips: no faster (5-10 s against Opus 8-10 s),
// a run-through read as a full jump (IMG_2432) and a run-through's sand 6 frames late (IMG_1084).
export const LANDING_MODEL = 'claude-opus-5-5';
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
For every frame, decide whether a foot of the athlete is touching the running surface. A foot touches when it is flat on the ground or meets its own shadow; a foot above its shadow is in the air. Ignore the board and markings. A low box, mat or plate lying on the runway (often at the board) is running surface too: a foot standing on it is touching.
List every frame number with a foot on the running surface in on_ground. In sand, give the first frame where any part of the body touches the sand pit, or null if it is not shown.
Set run_through to true if this is a run-through (pop-up) instead of a full jump: after the takeoff the athlete comes down onto one foot in the sand and keeps running, rather than landing with both legs reaching forward. If the landing is not shown, judge from the flight: a run-through has no leg extension forward before the sand.`;

// The landing alone (2026-11-20): with the board contact found from the foot contacts, Claude only
// says when the body meets the sand and whether it is a run-through. One window from just after the
// toe-off (a run-through lands 0.22 s after the board) to 0.95 s, about a third of the frames the
// full reading sent, so it runs alongside the runway measurement instead of before it.
const LANDING_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['sand', 'run_through'],
  properties: { sand: frameOrNull, run_through: { type: 'boolean' } },
};
const LANDING_PROMPT = `You see the flight and landing of a long jump filmed on a phone that pans with the athlete. Each image is a contact sheet of consecutive frames after the take-off, row by row, cropped around the athlete, each stamped with its frame number in yellow.
In sand, give the first frame where any part of the body touches the sand pit, or null if it is not shown.
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
export function pickContacts(runs, poseContacts, takeoffAt, fps, sand = null) {
  // Claude sometimes reads one contact in pieces (IMG_4953, 2026-11-16: 492-496, 502-506 and
  // 510-512 for a 500-516 penultimate, with the pose track's 502-517 right): pieces inside one
  // pose contact of at least 0.06 s are one contact.
  const whole = poseContacts.filter(c => (c.to - c.td + 1) / fps >= 0.06);
  const units = [];
  for (const r of [...runs].sort((a, b) => a.td - b.td)) {
    const sh = c => Math.min(c.to, r.to) - Math.max(c.td, r.td);
    const p = whole.filter(c => sh(c) >= 0).sort((a, b) => sh(b) - sh(a))[0], last = units.at(-1);
    if (p && last?.p === p) last.to = Math.max(last.to, r.to); else units.push({ td: r.td, to: r.to, p });
  }
  // Pieces no pose contact backs, up to 0.035 s apart, are one contact too: a rerun of IMG_4953
  // read its box take-off (529-547) as 529-533 and 537-541, both too short to count alone, and the
  // penultimate became the take-off. Pose-backed units are never joined this way (IMG_4954 at 4).
  const joined = [];
  for (const u of units) {
    const last = joined.at(-1);
    if (last && !last.p && !u.p && u.td - last.to <= Math.max(2, Math.round(0.035 * fps))) last.to = u.to; else joined.push({ ...u });
  }
  // A piece no pose contact backs has to be 0.05 s long to count: IMG_4953's 519-522, in the air
  // between the last two steps, otherwise became the penultimate.
  const real = joined.filter(r => (r.to - r.td + 1) / fps >= (r.p ? 0.03 : 0.05)).map(({ td, to, p }) => ({ td, to, posed: !!p }));
  if (!real.length) return {};
  const dist = r => (takeoffAt >= r.td && takeoffAt <= r.to ? 0 : Math.min(Math.abs(takeoffAt - r.td), Math.abs(takeoffAt - r.to)));
  let ti = real.reduce((b, r, k) => (dist(r) < dist(real[b]) ? k : b), 0);
  // Claude's take-off tile between two contacts: the later one is the take-off when it still ends
  // before the sand (2026-11-19, a rerun of IMG_1083: the tile at 946 sat nearer the penultimate
  // 928-937 than the board contact 958-967, with the sand at 990). Only a contact the pose track also
  // sees planted, and never when the tile is inside a contact: Claude marks flight frames as ground
  // too (IMG_4677 715-720, IMG_4933 520-530, after the real take-off).
  if (Number.isInteger(sand) && dist(real[ti]) > 0) {
    const k = real.findIndex(r => r.td > takeoffAt);
    if (k > ti && real[k].posed && real[k].to < sand - Math.round(0.1 * fps)) ti = k;
  }
  // A pose contact that covers only a piece of Claude's run is a broken detection, not better
  // edges: on IMG_4933 (2026-11-16) the pose track had 506-512 of a 497-513 take-off, Claude
  // 489-509; taking the pose piece (0.058 s) failed the contact-time check and the whole jump
  // fell back to a wrong place. The app refines Claude's own edges from the raw foot.
  const edges = r => {
    // the pose contact sharing the most frames with the run (a run can touch two)
    const shared = c => Math.min(c.to, r.to) - Math.max(c.td, r.td);
    const p = poseContacts.filter(c => shared(c) >= 0).sort((a, b) => shared(b) - shared(a))[0];
    // A full-length pose contact (0.09 s and more) wins even when Claude's run is longer: on a
    // rerun of IMG_4390 (2026-11-17) Claude marked flight frames as ground, 470-497 for a 482-497
    // take-off, and the pose track's right 15 frames lost to the 0.6 rule (IMG_4933: 452-480 for 472-487).
    const len = p ? p.to - p.td + 1 : 0;
    const whole = p && len / fps >= 0.06 && (len >= 0.6 * (r.to - r.td + 1) || len / fps >= 0.09);
    return whole ? { td: p.td, to: p.to, from: 'pose' } : { td: r.td, to: r.to, from: 'claude' };
  };
  const take = real[ti], pen = real[ti - 1], third = real[ti - 2];
  return { take: edges(take), pen: pen && edges(pen), third: third && edges(third) };
}

// Keeps only answers that fit a long jump: the right order and human contact and flight times.
export function checkEvents(e, fps, { claudeTake = false, runThrough = false } = {}) {
  const ok = {}, bad = [];
  const s = (a, b) => (e[b] - e[a]) / fps;
  const keep = (k, valid) => { if (e[k] == null) return; if (valid) ok[k] = e[k]; else bad.push(k); };
  const inRange = (v, lo, hi) => v >= lo && v <= hi;
  keep('TD', Number.isInteger(e.TD));
  // Claude's own take-off can be a piece of the contact (IMG_4953 on a box: 536-541 of 529-547);
  // the app then finds both edges on the raw foot, so 0.04 s is enough to say where it is.
  keep('TO', e.TD != null && inRange(s('TD', 'TO'), claudeTake ? 0.04 : 0.06, 0.26));
  // a run-through (pop-up) comes down early: IMG_1083 (2026-11-19) touched the sand 0.22 s after the
  // board, and without the sand frame the flight fit ran on into the running out of the pit
  keep('landing', ok.TO != null && inRange(s('TO', 'landing'), runThrough ? 0.1 : 0.3, 1.3));
  // Claude's own board touchdown can be a few frames early (the app moves it), so then the
  // flight into the board only has to be positive.
  keep('penTO', ok.TD != null && inRange(s('penTO', 'TD'), claudeTake ? 0.5 / fps : 0.02, 0.2));
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
    const Lok = L != null && L > T + f(0.3) && L < T + f(1.2) ? L : null;
    const windows = [
      range(clamp(T - f(0.6)), clamp(T - f(0.06)), per),
      range(clamp(T - f(0.06) + per), clamp(T + f(0.22)), per),
      // The landing window always covers 0.5-0.95 s after the take-off as well: the overview's
      // landing tile was 0.23 s early on IMG_4951 (2026-11-16) and the sand never got shown.
      range(clamp(Math.min(Lok ?? Infinity, T + f(0.7)) - f(0.2)), clamp(Math.max(Lok ?? -Infinity, T + f(0.83)) + f(0.12)), per),
    ];
    // the sheets at once, in the same order (they were built one after another)
    const sheets = await Promise.all(windows.flatMap(w => chunks(w, 36)).map(part => contactSheet(frames, part, { boxes, cols: 9, tileW: 160 })));
    const ans = await ask(client, model, FRAMES_PROMPT, sheets, FRAMES_SCHEMA);
    const shown = new Set(windows.flat());
    return { ans, T, L, ground: (ans?.on_ground ?? []).filter(i => shown.has(i)), sand: shown.has(ans?.sand) ? ans.sand : null, runThrough: ans?.run_through === true };
  };

  // With no pose guess the overview has to come first; otherwise both run at once.
  let coarse = guess.TD == null ? await overview : null;
  const T0 = guess.TD ?? coarse?.takeoff;
  if (T0 == null) return { events: {}, rejected: ['TD'], coarse, model, ms: Date.now() - t0 };
  // a failed reading waits for the overview, so no call of this job is still out after it fails
  let seen = await read(T0, guess.TD != null ? guess.landing ?? null : coarse?.landing ?? null).catch(async e => { await overview; throw e; });
  coarse ??= await overview;
  // The overview disagrees by more than half a second: the pose track picked the wrong place.
  if (coarse?.takeoff != null && Math.abs(coarse.takeoff - T0) > f(0.5)) seen = await read(coarse.takeoff, coarse.landing ?? null);
  onProgress?.({ stage: 'locate', done: 1, total: 1 });

  // Two frames bridged, not more: at 4 (2026-11-16) Claude's stray frames in the flights joined
  // IMG_4954's last three contacts into 652-675 and 681-703, and the board became the penultimate.
  const n = nameEvents(seen, guess, fps);
  return {
    ...n, coarse, windows: { T: seen.T, L: seen.L }, model, ms: Date.now() - t0,
    // what Claude answered, kept so tools/bench.mjs can replay the choice above with new code
    seen: { ground: seen.ground, sand: seen.sand, runThrough: seen.runThrough },
  };
}

// TO: the board toe-off. One retry: a failed call leaves gravity's landing and a full jump.
export async function locateLanding({ frames, boxes, first, last, fps, client, TO, model = LANDING_MODEL }) {
  const t0 = Date.now();
  const f = s => Math.round(s * fps), per = Math.max(1, Math.round(fps / 120));
  const clamp = v => Math.max(first, Math.min(last, v));
  const win = range(clamp(TO + f(0.08)), clamp(TO + f(0.95)), per);
  if (win.length < 4) return { sand: null, runThrough: false, ms: 0, window: null };
  const sheets = await Promise.all(chunks(win, 36).map(part => contactSheet(frames, part, { boxes, cols: 9, tileW: 160 })));
  const ans = await ask(client, model, LANDING_PROMPT, sheets, LANDING_SCHEMA)
    .catch(() => ask(client, model, LANDING_PROMPT, sheets, LANDING_SCHEMA));
  const shown = new Set(win);
  return { sand: shown.has(ans?.sand) ? ans.sand : null, runThrough: ans?.run_through === true, ms: Date.now() - t0, window: [win[0], win.at(-1)], model };
}

// From Claude's ground frames and sand frame to the named key frames. Pure, so the benchmark can
// replay it on stored answers: seen { ground, sand, runThrough, T }, guess as for locateEvents.
export function nameEvents(seen, guess, fps) {
  const runs = groundRuns(seen.ground);
  const at = seen.T === guess.TD && guess.TO != null ? Math.round((guess.TD + guess.TO) / 2) : seen.T;
  const c = pickContacts(runs, guess.contacts ?? [], at, fps, seen.sand);
  const named = {
    td3: c.third?.td ?? null, penTD: c.pen?.td ?? null, penTO: c.pen?.to ?? null,
    TD: c.take?.td ?? null, TO: c.take?.to ?? null, landing: seen.sand,
  };
  const checked = checkEvents(named, fps, { claudeTake: c.take?.from === 'claude', runThrough: seen.runThrough });
  // A run-through (pop-up) is the same jump up to the flight, then the athlete runs out of the pit.
  if (checked.events.TD != null) checked.events.kind = seen.runThrough ? 'runthrough' : 'jump';
  return { ...checked, runs, edges: { take: c.take?.from, pen: c.pen?.from, third: c.third?.from } };
}

// What locateEvents gets from the pose track: where it thinks the jump is and its contacts. Runs
// before the runway is measured; without a jump its contacts still give Claude's runs their edges
// (Miška's IMG_4940, 2026-11-16: the horizontal-speed floor failed it and no contacts reached Claude).
export function locateGuess(result, sex, ts, opts = {}) {
  const g = analyzeJump(result, sex, ts, { ...opts, preGround: true });
  return g.error ? { contacts: g.contacts?.length ? g.contacts : poseContacts(result) }
    : { TD: g.takeoff.td, TO: g.takeoff.to, landing: g.landing, contacts: g.contacts };
}
