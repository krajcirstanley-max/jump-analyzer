// Coaching written by the model from the 5 phase snapshots and the numbers, checked in
// code against the Coaching SOP. Anything that fails the check, the network or the clock
// falls back to the template coach, so this never throws and never returns junk.
import { coaching, APPROVED_CUES, MISKA_ONLY_CUE, PHASE_IDS } from '../js/analysis/coach.js';

export const MODEL = 'claude-opus-5-5';
export const TIMEOUT_MS = 90_000;
const MAX_TOKENS = 16_000;

// Matched on lowercased text with the diacritics removed, so inflected forms and
// missing accents are caught too. Includes the UI rule: never "AI" or a brand name.
const BANNED = [
  [/zdvihn\w* kolen/, '„zdvihni koleno"'],
  [/natiahn\w* krok/, '„natiahni krok"'],
  [/cykl\w* nohu/, '„cykluj nohu"'],
  [/pritiahn\w* pat/, '„pritiahni pätu"'],
  [/odraz\w* silnejsie/, '„odraz silnejšie"'],
  [/\bvyssie\b/, '„vyššie"'],
  [/\bai\b|claude|anthropic|athleticsai/, 'názov značky alebo „AI"'],
  [/\bdril|\d\s*[×x]\s*\d/, 'cvičenie alebo dávkovanie'],   // the app prescribes no drills
];
const plain = s => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const bannedIn = s => BANNED.filter(([re]) => re.test(plain(s))).map(([, w]) => w);

const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const str = { type: 'string' };

// The exact `jump.coach` shape. Static so the API can reuse its compiled grammar; item
// counts and per-athlete rules are checked in validateCoach because the schema can't.
export const COACH_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['source', 'take', 'strength', 'fixes', 'nextCue'],
  properties: {
    source: { type: 'string', enum: ['claude'] },
    take: str,
    strength: nullable(str),
    fixes: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['title', 'body', 'phase', 'metricKey', 'cue', 'why'],
      properties: {
        title: str, body: str,
        phase: { type: 'string', enum: PHASE_IDS },
        metricKey: nullable(str),
        cue: nullable({ type: 'string', enum: APPROVED_CUES }),
        why: str,
      },
    } },
    nextCue: nullable({ type: 'string', enum: APPROVED_CUES }),
  },
};

const allStrings = v => (typeof v === 'string' ? [v]
  : Array.isArray(v) ? v.flatMap(allStrings)
  : v && typeof v === 'object' ? Object.values(v).flatMap(allStrings) : []);

// Returns a list of problems in plain words, empty when the object is usable. The list
// goes back to the model verbatim on the retry.
export function validateCoach(c, { metrics = [], sex = 'male', name } = {}) {
  if (!c || typeof c !== 'object') return ['Výstup nie je objekt.'];
  const errs = [];
  const fixes = Array.isArray(c.fixes) ? c.fixes : (errs.push('fixes musí byť pole.'), []);
  if (typeof c.take !== 'string' || !c.take.trim()) errs.push('take chýba.');
  else {
    if (/[.!?…]\s+\p{Lu}/u.test(c.take.trim())) errs.push('take musí byť jedna veta.');
    if (name && !c.take.includes(name)) errs.push(`take musí osloviť menom ${name}.`);
  }
  if (c.strength != null && typeof c.strength !== 'string') errs.push('strength musí byť text alebo null.');
  if (fixes.length > 3) errs.push('Najviac 3 opravy.');

  const by = new Map(metrics.map(m => [m.key, m]));
  fixes.forEach((f, i) => {
    const at = `fixes[${i}]`;
    if (!f || typeof f !== 'object') return errs.push(`${at} nie je objekt.`);
    for (const k of ['title', 'body', 'why']) if (typeof f[k] !== 'string' || !f[k].trim()) errs.push(`${at}.${k} chýba.`);
    if (!PHASE_IDS.includes(f.phase)) errs.push(`${at}.phase ${f.phase} neexistuje.`);
    if ('drills' in f) errs.push(`${at}.drills nemá existovať, aplikácia cvičenia nepredpisuje.`);

    if (f.cue != null) {
      if (!APPROVED_CUES.includes(f.cue)) errs.push(`${at}.cue „${f.cue}" nie je na schválenom zozname.`);
      if (f.cue === MISKA_ONLY_CUE && sex !== 'female') errs.push(`${at}.cue „${f.cue}" patrí len Miške.`);
      if (i > 0) errs.push(`${at}.cue musí byť null: jedno cue na ďalší rozbeh, a to v prvej oprave.`);
    }

    if (f.metricKey != null) {
      const m = by.get(f.metricKey);
      if (!m) errs.push(`${at}.metricKey ${f.metricKey} v meraniach neexistuje.`);
      else if (m.status === 'hidden') errs.push(`${at}.metricKey ${f.metricKey} je skrytá metrika, opravu z nej nestavaj.`);
      else if (m.status === 'ok') errs.push(`${at}.metricKey ${f.metricKey} je v norme, nevymýšľaj chybu.`);
    }
  });

  const first = fixes[0]?.cue ?? null;
  if ((c.nextCue ?? null) !== first) errs.push('nextCue sa musí rovnať fixes[0].cue.');
  if (fixes.some(f => f?.cue) && !first) errs.push('Cue patrí do prvej opravy.');
  for (const s of allStrings({ ...c, source: null })) for (const w of bannedIn(s)) errs.push(`Zakázané slovo ${w} v texte: „${s.slice(0, 60)}".`);
  return errs;
}

const SYSTEM = `You are the coach of two long jumpers who train without a coach and coach each other: Stanley (male, target 8.00 m) and Miška (Michaela, female, target 6.70 m). After each filmed jump you write the feedback the athlete reads on their phone. Everything the athlete reads is Slovak with correct diacritics.

What you return: one sentence of take that names the athlete, one strength, at most 3 fixes ordered by what costs the most distance. The first fix carries the single cue for the next run-up. Later fixes have cue null, because the athlete works on one cue at a time.

How to rank. Coaching order comes first: precise takeoff on the board, then taking off from the full approach, then vertical, then speed. Weigh that against how far the measurement is from its norm and how much the phase counts: pen .20, plant .35, toeoff .25, flight .05, landing .15. Speed is usually not the limiter here, so it rarely belongs on top.

Honesty. Base fixes on measurements with status low or high. Never mention a metric listed as hidden or build a fix on it. If nothing is out of range, say so plainly in the take, tell the athlete to keep the cue they have, return no fixes and nextCue null. Never invent a fault to fill the list.
Look at the 5 images for what the numbers can't show: arm action, posture, head position, where the eyes go. A fix based only on an image has metricKey null and must describe something clearly visible. These are single 2D frames from one phone: they can't show force, foot pressure, or anything out of the camera plane, and motion blur or a slightly wrong moment is common. When you rely on a frame, say so ("na snímke to vyzerá"), never report a joint angle you read off an image, and never let an image overrule a measured number.
Previous jumps are context. If the same fault keeps coming back, say that.

Cues. Copy one exactly from this list, or use null:
${APPROVED_CUES.map(c => `- ${c}`).join('\n')}
„${MISKA_ONLY_CUE}" is only for Miška, and it replaces „predposledný naplocho" for her. Cues are external images. Numbers go in the body, never in the cue. A landing or flight fix has no cue.
Never write these anywhere, in any form: „zdvihni koleno", „natiahni krok", „cykluj nohu", „pritiahni pätu k zadku", „odraz silnejšie", „vyššie". They are banned because they cause reaching, braking and a longer contact. Say what to do instead with the approved cue.
Why cues are limited: inside a 0.10-0.12 s contact nothing can be corrected, everything is set before touchdown. Cues reach foot placement, shin angle, pre-tension, trunk and the penultimate float. Strength and stiffness come from the gym and the bounds. Don't promise a cue will fix those.

Do not prescribe drills, exercises, sets, reps, distances or doses anywhere in the text. The app gives the cue and explains the fault; the training plan is separate.

Both athletes are healthy. Do not add physio advice, injury warnings or back caveats for either of them.

Feel before clock: end the first fix's why with one short sentence telling the athlete to say how the jump felt before looking at the numbers.

Write it the way a coach talks at the pit, not like a report. Use "ty". Vary the sentence length, and a short fragment is fine. Lead with the specific thing you saw, not a topic sentence. Don't end a paragraph by restating it. No parallel lists of three, no "je dôležité", "treba poznamenať", "celkovo", "navyše", "v neposlednom rade", "kľúčové", no praise for its own sake. Numbers belong in the body with the norm next to them, written the Slovak way (0,12 s). Use the athlete's grammatical gender in past-tense verbs. Direct quotes stay in their source language. Never use the word AI or any product name.`;

function userContent({ jump, snapshots, name, sex, history, errors, previous }) {
  const metrics = (jump.metrics ?? []).filter(m => m.status !== 'hidden')
    .map(({ key, label, unit, value, norm, status, score, target, estimate }) => ({ key, label, unit, value, norm, status, score, target, estimate }));
  const hidden = (jump.metrics ?? []).filter(m => m.status === 'hidden').map(m => m.key);
  const phases = (jump.phases ?? []).map(({ id, label, score }) => ({ id, label, score }));
  const facts = { athlete: name, sex, attempt: jump.kind === 'runthrough' ? 'run-through (pop-up): lands on one foot and runs out of the pit; there is no landing and no full flight, so do not coach the landing, flight time or distance' : 'full jump', score: jump.score?.score ?? null, phases, speed: jump.speed ?? null, metrics, hiddenDoNotMention: hidden, previousJumps: history ?? [] };

  const out = [];
  for (const s of snapshots ?? []) {
    out.push({ type: 'text', text: `Snímka, fáza ${s.phase}:` });
    out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(s.jpeg).toString('base64') } });
  }
  out.push({ type: 'text', text: `Merania a kontext tohto skoku:\n${JSON.stringify(facts)}` });
  if (errors) out.push({ type: 'text', text: `Predchádzajúci pokus neprešiel kontrolou. Oprav presne toto a zvyšok nechaj:\n- ${errors.join('\n- ')}\n\nPredchádzajúci pokus:\n${previous}` });
  return out;
}

// Rejects after ms even if the SDK hangs, and aborts the request.
function withTimeout(run, ms) {
  const ctrl = new AbortController();
  let timer;
  const clock = new Promise((_, rej) => { timer = setTimeout(() => { ctrl.abort(); rej(new Error(`timeout ${ms} ms`)); }, ms); });
  return Promise.race([run(ctrl.signal), clock]).finally(() => clearTimeout(timer));
}

async function makeClient(apiKey) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic({ apiKey });
}

async function ask(client, args, timeoutMs) {
  const res = await withTimeout(signal => client.beta.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',                     // a classifier decline reruns server-side instead of ending in the template
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: COACH_SCHEMA } },
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userContent(args) }],
  }, { signal, timeout: timeoutMs, maxRetries: 1 }), timeoutMs);
  if (res.stop_reason === 'refusal') throw new Error('refusal');
  return res.content?.find(b => b.type === 'text')?.text ?? '';
}

export async function writeCoaching({ jump, snapshots, name, sex = 'male', history, apiKey, client, timeoutMs = TIMEOUT_MS } = {}) {
  const fallback = why => {
    if (why) console.warn(`coach: template fallback (${String(why).slice(0, 200)})`);
    try { return coaching(jump?.metrics, sex, { name }); }
    catch { return { source: 'template', take: `${name ?? 'Skok'}, analýzu sa nepodarilo dokončiť.`, strength: null, fixes: [], nextCue: null }; }
  };
  if (!client && !apiKey) return fallback();

  try {
    const api = client ?? await makeClient(apiKey);
    const check = { metrics: jump.metrics ?? [], sex, name };
    let args = { jump, snapshots, name, sex, history };
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await ask(api, args, timeoutMs);
      let parsed = null, errors;
      try { parsed = JSON.parse(text); errors = validateCoach(parsed, check); }
      catch { errors = ['Výstup nie je platný JSON.']; }
      if (!errors.length) return { ...parsed, source: 'claude' };
      args = { ...args, errors, previous: text };
    }
    return fallback(`validation: ${args.errors.join(' | ')}`);
  } catch (e) {
    return fallback(e?.message ?? e);
  }
}
