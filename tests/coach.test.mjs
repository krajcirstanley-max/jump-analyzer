import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { coaching, APPROVED_CUES, MISKA_ONLY_CUE } from '../js/analysis/coach.js';
import { validateCoach, writeCoaching, MODEL, COACH_SCHEMA } from '../server/coach.mjs';

// Metric to the contract; status follows the norm unless overridden.
const metric = (key, value, norm, extra = {}) => ({
  key, label: key, unit: extra.unit ?? '°', value, norm,
  status: value < norm[0] ? 'low' : value > norm[1] ? 'high' : 'ok', ...extra,
});
const ms = (key, value, norm) => metric(key, value, norm, { unit: 'ms' });

const OK = [ms('contactTO', 120, [110, 130]), metric('legTD', 60, [58, 64]), ms('contactPen', 115, [100, 125]), metric('kneeLand', 130, [125, 140])];
const BAD = [ms('contactTO', 165, [110, 130]), metric('legTD', 60, [58, 64]), ms('contactPen', 160, [100, 125]), metric('takeoffAngle', 15, [18, 25])];

const silent = fn => async () => { const w = console.warn; console.warn = () => {}; try { await fn(); } finally { console.warn = w; } };
const clips = [['IMG_2674', 'male', 'Stanley'], ['IMG_4390', 'female', 'Miška']];
async function analyse(id, sex) {
  const here = new URL('../js/analysis/', import.meta.url);
  const r = JSON.parse(readFileSync(new URL(`fixtures/_real_${id}_pose.json`, import.meta.url), 'utf8'));
  const fps = r.fps ?? 120;
  const ts = Array.from({ length: r.clean.length }, (_, i) => i / fps);
  if (existsSync(new URL('jump.js', here))) return (await import(new URL('jump.js', here))).analyzeJump(r, sex, ts);
  // jump.js is another agent's file; until it lands, build the metrics the same way.
  const { detectContacts, keyFrames } = await import(new URL('events.js', here));
  const { measure, flightMetrics } = await import(new URL('metrics.js', here));
  const { flightAnalysis } = await import(new URL('flight.js', here));
  const contacts = detectContacts(r.clean, r.first, r.last, fps);
  const ev = keyFrames(r.clean, contacts, fps, sex);
  const dir = contacts[0]?.dir ?? 1;
  const flight = flightAnalysis(r.smooth, ev, ts, sex, dir);
  return { ...ev, metrics: [...measure(r.smooth, ev, fps, sex, dir), ...flightMetrics(flight, ev, sex)] };
}

for (const [id, sex, name] of clips) {
  test(`template coach is valid on the real clip ${id}`, async () => {
    const jump = await analyse(id, sex);
    assert.equal(jump.error, undefined, jump.error);
    const c = coaching(jump.metrics, sex, { name });
    assert.equal(c.source, 'template');
    assert.deepEqual(validateCoach(c, { metrics: jump.metrics, sex, name }), []);
    assert.ok(c.fixes.length <= 3);
    assert.equal(c.nextCue, c.fixes[0]?.cue ?? null);
    for (const f of c.fixes) {
      assert.equal(jump.metrics.find(m => m.key === f.metricKey)?.status !== 'hidden', true);
      assert.equal('drills' in f, false);
    }
    assert.match(c.take, new RegExp(`^${name},`));
  });
}

test('approved cues are short and the template only uses them', () => {
  for (const c of APPROVED_CUES) assert.ok(c.split(/\s+/).length <= 5, c);
  const worst = [
    ms('contactTO', 200, [110, 130]), metric('legTD', 40, [58, 64]), metric('flexion', 60, [25, 36]), metric('kneeTD', 140, [166, 175]),
    ms('contactPen', 200, [100, 125]), metric('hipDrop', 25, [6, 12], { unit: 'cm' }), metric('takeoffAngle', 40, [18, 25]),
    metric('trunkTO', 30, [-3, 5]), metric('kneeTO', 140, [168, 178]), metric('kneeDrive', 10, [60, 90]),
  ];
  for (const sex of ['male', 'female']) {
    const c = coaching(worst, sex);
    assert.equal(c.fixes.length, 3);
    assert.ok(APPROVED_CUES.includes(c.nextCue));
    assert.deepEqual(c.fixes.slice(1).map(f => f.cue), [null, null]);
    assert.deepEqual(validateCoach(c, { metrics: worst, sex }), []);
  }
});

test('Miška gets the float cue on a penultimate fault, Stanley does not', () => {
  const pen = [ms('contactPen', 170, [100, 125])];
  assert.equal(coaching(pen, 'female').nextCue, MISKA_ONLY_CUE);
  assert.equal(coaching(pen, 'male').nextCue, 'predposledný naplocho');
});

test('a takeoff fault outranks an equally bad penultimate fault', () => {
  const c = coaching([ms('contactPen', 175, [100, 125]), ms('contactTO', 170, [110, 130])], 'male');
  assert.equal(c.fixes[0].metricKey, 'contactTO');
  assert.equal(c.nextCue, 'tvrdá pružina');
});

test('a much worse lower-priority fault can overtake a marginal board fault', () => {
  const c = coaching([ms('contactTO', 141, [110, 130]), ms('contactPen', 240, [100, 125])], 'male');
  assert.equal(c.fixes[0].metricKey, 'contactPen');
});

test('a landing fault never takes the cue slot from a fault that has a cue', () => {
  const c = coaching([metric('kneeLand', 175, [125, 140]), ms('contactTO', 145, [110, 130])], 'male');
  assert.ok(c.nextCue);
  assert.equal(c.fixes[0].metricKey, 'contactTO');
});

test('hidden metrics never drive a fix', () => {
  const hidden = [{ ...ms('contactTO', 200, [110, 130]), status: 'hidden' }, metric('legTD', 60, [58, 64])];
  const c = coaching(hidden, 'male');
  assert.deepEqual(c.fixes, []);
});

test('nothing out of range: says so and invents nothing', () => {
  const c = coaching(OK, 'female', { name: 'Miška' });
  assert.deepEqual(c.fixes, []);
  assert.equal(c.nextCue, null);
  assert.match(c.take, /nie je nič mimo normy/);
  assert.match(c.take, /cue nechaj/);
  assert.ok(c.strength);
});

test('misses inside the measurement margin are not faults', () => {
  assert.deepEqual(coaching([ms('contactTO', 133, [110, 130])], 'male').fixes, []);
});

test('no metrics at all still gives a valid object', () => {
  for (const input of [[], undefined, null, [{ key: 'contactTO', status: 'hidden' }]]) {
    const c = coaching(input, 'male');
    assert.equal(c.source, 'template');
    assert.deepEqual(validateCoach(c, { metrics: [], sex: 'male', name: 'Stanley' }), []);
  }
});

// A well-formed model answer for the BAD metrics.
const goodReply = () => ({
  source: 'claude',
  take: 'Stanley, na doske si dnes stál dlho a rozbeh sa tam zastavil.',
  strength: 'Noha dopadá pod správnym uhlom.',
  fixes: [
    { title: 'Dlhý kontakt', body: 'Kontakt 165 ms, finalisti 110–130 ms.', phase: 'plant', metricKey: 'contactTO', cue: 'tvrdá pružina', why: 'Pred dotykom je rozhodnuté. Najprv povedz, aký to bol pocit.' },
    { title: 'Sedíš', body: 'Predposledný 160 ms.', phase: 'pen', metricKey: 'contactPen', cue: null, why: 'Brzdí to.' },
  ],
  nextCue: 'tvrdá pružina',
});
const ctx = { metrics: BAD, sex: 'male', name: 'Stanley' };
const edit = fn => { const c = goodReply(); fn(c); return c; };

test('validator accepts a correct answer', () => assert.deepEqual(validateCoach(goodReply(), ctx), []));

const rejected = {
  'banned cue': [c => { c.fixes[0].cue = 'zdvihni koleno'; c.nextCue = 'zdvihni koleno'; }, /schválenom/],
  'invented cue': [c => { c.fixes[0].cue = 'bež rýchlo'; c.nextCue = 'bež rýchlo'; }, /schválenom/],
  'banned phrase in body': [c => { c.fixes[0].body = 'Musíš odraziť silnejšie a zdvihnúť koleno.'; }, /Zakázané/],
  'banned word in why': [c => { c.fixes[0].why = 'Skáč vyššie.'; }, /Zakázané/],
  'banned word without accents': [c => { c.take = 'Stanley, skoc vyssie.'; }, /Zakázané/],
  'brand name in the text': [c => { c.fixes[0].why = 'Podľa Claude je to tak.'; }, /Zakázané/],
  'a drills field': [c => { c.fixes[0].drills = []; }, /nemá existovať/],
  'a drill named in the text': [c => { c.fixes[0].body = 'Sprav drill na členok.'; }, /Zakázané/],
  'a dose in the text': [c => { c.fixes[0].why = 'Daj si 3 × 20 m.'; }, /Zakázané/],
  'four fixes': [c => { c.fixes.push(c.fixes[1], c.fixes[1]); }, /Najviac 3/],
  'unknown metric': [c => { c.fixes[0].metricKey = 'nope'; }, /neexistuje/],
  'in-range metric': [c => { c.fixes[0].metricKey = 'legTD'; }, /v norme/],
  'second cue': [c => { c.fixes[1].cue = 'vysoké boky'; }, /jedno cue/],
  'nextCue out of step': [c => { c.nextCue = 'vysoké boky'; }, /nextCue/],
  'two-sentence take': [c => { c.take = 'Stanley, zlé. Zajtra znova.'; }, /jedna veta/],
  'take without the name': [c => { c.take = 'Na doske dlho.'; }, /menom/],
};
for (const [what, [fn, re]] of Object.entries(rejected)) {
  test(`validator rejects: ${what}`, () => {
    const errs = validateCoach(edit(fn), ctx);
    assert.ok(errs.some(e => re.test(e)), errs.join(' / ') || 'no errors');
  });
}

test('validator rejects a fix built on a hidden metric', () => {
  const metrics = [{ ...ms('contactTO', 165, [110, 130]), status: 'hidden' }, ms('contactPen', 160, [100, 125])];
  const errs = validateCoach(goodReply(), { ...ctx, metrics });
  assert.ok(errs.some(e => /skrytá/.test(e)), errs.join(' / '));
});

test('float cue is rejected for Stanley and accepted for Miška', () => {
  const c = edit(x => { x.fixes[0].cue = MISKA_ONLY_CUE; x.nextCue = MISKA_ONLY_CUE; x.take = 'Miška, na doske dlho.'; });
  assert.ok(validateCoach(c, ctx).some(e => /len Miške/.test(e)));
  assert.deepEqual(validateCoach(c, { metrics: BAD, sex: 'female', name: 'Miška' }), []);
});

// --- writeCoaching with a mocked client ---
const jump = { metrics: BAD, score: { score: 70 }, phases: [{ id: 'plant', label: 'Plant', score: 60, extra: 'x' }], speed: null };
const snapshots = ['pen', 'plant', 'toeoff', 'flight', 'landing'].map(phase => ({ phase, jpeg: Buffer.from([0xff, 0xd8, 0xff]) }));
const args = { jump, snapshots, name: 'Stanley', sex: 'male', history: [{ date: '2026-11-01', score: 66, phases: {}, metrics: {} }] };
const reply = obj => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] });
function mock(...outs) {
  const calls = [];
  return { calls, beta: { messages: { create: async (req, opts) => { calls.push({ req, opts }); const o = outs.shift(); if (o instanceof Error) throw o; return o; } } } };
}

test('writeCoaching returns the validated model answer', async () => {
  const client = mock(reply(goodReply()));
  const c = await writeCoaching({ ...args, client });
  assert.equal(c.source, 'claude');
  assert.equal(c.nextCue, 'tvrdá pružina');
  assert.equal(client.calls.length, 1);

  const { req, opts } = client.calls[0];
  assert.equal(req.model, MODEL);
  assert.equal(req.tool_choice, undefined, 'forced tool choice is a 400 on this model');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema, COACH_SCHEMA);
  assert.deepEqual(req.thinking, { type: 'adaptive' });
  assert.ok(opts.signal);
  const content = req.messages[0].content;
  assert.equal(content.filter(b => b.type === 'image').length, 5);
  assert.equal(content.find(b => b.type === 'image').source.media_type, 'image/jpeg');
  const facts = content.at(-1).text;
  assert.match(facts, /contactTO/);
  assert.match(facts, /previousJumps/);
  for (const cue of APPROVED_CUES) assert.ok(req.system[0].text.includes(cue), cue);
  assert.match(req.system[0].text, /Do not prescribe drills/);
  assert.equal('drills' in COACH_SCHEMA.properties.fixes.items.properties, false);
});

test('hidden metrics are not sent as usable numbers', async () => {
  const client = mock(reply(goodReply()));
  const metrics = [...BAD, { ...metric('trunkTD', 3, [0, 1]), status: 'hidden' }];
  await writeCoaching({ ...args, jump: { ...jump, metrics }, client });
  const facts = JSON.parse(client.calls[0].req.messages[0].content.at(-1).text.split('\n')[1]);
  assert.ok(!facts.metrics.some(m => m.key === 'trunkTD'));
  assert.deepEqual(facts.hiddenDoNotMention, ['trunkTD']);
});

test('one validation failure is retried with the error, then accepted', async () => {
  const bad = edit(c => { c.fixes[0].cue = 'zdvihni koleno'; c.nextCue = 'zdvihni koleno'; });
  const client = mock(reply(bad), reply(goodReply()));
  const c = await writeCoaching({ ...args, client });
  assert.equal(c.source, 'claude');
  assert.equal(client.calls.length, 2);
  assert.match(client.calls[1].req.messages[0].content.at(-1).text, /schválenom zozname/);
});

test('unparseable JSON is retried', silent(async () => {
  const client = mock(reply('not json'), reply(goodReply()));
  assert.equal((await writeCoaching({ ...args, client })).source, 'claude');
}));

test('two validation failures fall back to the template', silent(async () => {
  const bad = edit(c => { c.fixes[0].body = 'Skáč vyššie.'; });
  const client = mock(reply(bad), reply(bad));
  const c = await writeCoaching({ ...args, client });
  assert.equal(c.source, 'template');
  assert.equal(client.calls.length, 2);
  assert.deepEqual(validateCoach(c, ctx), []);
}));

test('network error falls back without retrying', silent(async () => {
  const client = mock(new Error('ECONNRESET'));
  const c = await writeCoaching({ ...args, client });
  assert.equal(c.source, 'template');
  assert.equal(client.calls.length, 1);
}));

test('a refusal falls back to the template', silent(async () => {
  const c = await writeCoaching({ ...args, client: mock({ stop_reason: 'refusal', content: [] }) });
  assert.equal(c.source, 'template');
}));

test('a hanging request times out to the template', silent(async () => {
  let aborted = false;
  const client = { beta: { messages: { create: (_, { signal }) => new Promise(() => signal.addEventListener('abort', () => { aborted = true; })) } } };
  const c = await writeCoaching({ ...args, client, timeoutMs: 20 });
  assert.equal(c.source, 'template');
  assert.ok(aborted);
}));

test('no key and bad input never throw', silent(async () => {
  assert.equal((await writeCoaching({ ...args })).source, 'template');
  assert.equal((await writeCoaching({ jump: null, apiKey: 'x', client: mock(new Error('boom')) })).source, 'template');
  assert.equal((await writeCoaching()).source, 'template');
}));

test('missing SDK falls back rather than throwing', silent(async () => {
  assert.equal((await writeCoaching({ ...args, apiKey: 'x', timeoutMs: 2000 })).source, 'template');
}));
