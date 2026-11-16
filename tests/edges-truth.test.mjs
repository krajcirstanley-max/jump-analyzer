// Contact frames against the hand truth on zoomed feet (2026-11-15/16; td = first frame on the
// ground, to = last frame on the ground), and a clip with no jump. Local clips only (tests/real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { pickContacts, checkEvents } from '../server/locate.mjs';

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

// 2026-11-16, box under the penultimate: IMG_4930 had pose edges and was right; IMG_4933's board
// contact came from Claude as 492/505 (by eye ~495-496 / 512, raw foot 497/513), which made the
// straight take-off knee read 140°.
test('Claude-only board edges are moved to the raw foot (IMG_4933), pose edges stay (IMG_4930)', { skip: !load(4933) || !load(4930) }, () => {
  const r = load(4933), j = analyzeJump(r, 'male', r.ts, { height: 186 });
  assert.ok(j.takeoff.td >= 495 && j.takeoff.td <= 498, `TD ${j.takeoff.td}`);
  assert.ok(j.takeoff.to >= 512 && j.takeoff.to <= 513, `TO ${j.takeoff.to}`);
  assert.ok(j.metrics.find(m => m.key === 'kneeTO').value > 160);
  const q = load(4930), k = analyzeJump(q, 'male', q.ts, { height: 186 });
  assert.equal(k.takeoff.td, 911);
  assert.ok(Math.abs(k.takeoff.to - 926.5) <= 1, `TO ${k.takeoff.to}`);
});

test('a pose contact covering only a piece of Claude\'s run does not replace it', () => {
  const runs = [{ td: 457, to: 467 }, { td: 470, to: 479 }, { td: 489, to: 509 }];
  const pose = [{ td: 472, to: 487 }, { td: 506, to: 512 }];
  const c = pickContacts(runs, pose, 504, 120);
  assert.deepEqual([c.take.td, c.take.to, c.take.from], [489, 509, 'claude']);
  assert.deepEqual([c.pen.td, c.pen.to, c.pen.from], [472, 487, 'pose']);
  const e = checkEvents({ penTD: 472, penTO: 487, TD: 489, TO: 509, landing: 597 }, 120, { claudeTake: true });
  assert.deepEqual(e.rejected, []);
});
