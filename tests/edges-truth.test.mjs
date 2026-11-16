// Contact frames against the hand truth on zoomed feet (2026-11-15/16; td = first frame on the
// ground, to = last frame on the ground), and a clip with no jump. Local clips only (tests/real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';

const load = id => { const u = new URL(`./real/r${id}.json`, import.meta.url); return existsSync(u) ? JSON.parse(readFileSync(u)).result : null; };
const TRUTH = {
  4594: { who: ['female', 171], penTD: 388, penTO: 404, TD: 415, TO: 433 },
  4676: { who: ['male', 186], penTD: 520, penTO: 534, TD: 541, TO: 556 },
  4677: { who: ['male', 186], penTD: 674, penTO: 689, TD: 696, TO: 713 },
  4390: { who: ['female', 171], penTD: 453, penTO: 469, TD: 482, TO: 497 },
};

test('contact frames: penultimate exact on every clip, the rest within one frame', { skip: !Object.keys(TRUTH).every(load) }, () => {
  const off = {};
  for (const [id, t] of Object.entries(TRUTH)) {
    const r = load(id), j = analyzeJump(r, t.who[0], r.ts, { height: t.who[1] });
    const got = { penTD: j.pen.td, penTO: j.pen.to, TD: j.takeoff.td, TO: j.takeoff.to };
    for (const k of ['penTD', 'penTO', 'TD', 'TO']) off[`${id} ${k}`] = got[k] - t[k];
  }
  for (const [k, v] of Object.entries(off)) {
    if (k.endsWith('penTD') || k.endsWith('penTO')) assert.equal(v, 0, `${k} ${v}`);
    else assert.ok(Math.abs(v) <= 1, `${k} ${v}`);
  }
});

test('a sprint filmed in the jump mode is not a jump (IMG_4866)', { skip: !load(4866) }, () => {
  const r = load(4866), j = analyzeJump(r, 'female', r.ts, { height: 171 });
  assert.equal(j.error, 'V zázname sa nenašiel odraz.');
  assert.ok(j.noTakeoff.vy < 0.5, JSON.stringify(j.noTakeoff));
});
