// Contact frames against the hand truth on zoomed feet (2026-11-15/16; td = first frame on the
// ground, to = last frame on the ground), and a clip with no jump. Local clips only (tests/real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { pickContacts, checkEvents, groundRuns } from '../server/locate.mjs';

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
  // two server runs of the same clip: Claude named 492/505 the first time, 497/510 the second
  for (const id of [4933, '4933b']) {
    const r = load(id); if (!r) continue;
    const j = analyzeJump(r, 'male', r.ts, { height: 186 });
    assert.ok(j.takeoff.td >= 495 && j.takeoff.td <= 498, `${id} TD ${j.takeoff.td}`);
    assert.ok(j.takeoff.to >= 512 && j.takeoff.to <= 513, `${id} TO ${j.takeoff.to}`);
    assert.ok(j.metrics.find(m => m.key === 'kneeTO').value > 160);
  }
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

// 2026-11-16, five jumps from a 5 cm box on the board (Stanley 4950, 4954; Miška 4940, 4951, 4953),
// landings checked by eye: 733, 800, 789, 973, 627. r49xxh = Miška's with the hand-checked contacts.
const BOX = { 4950: ['male', 186, 733], 4954: ['male', 186, 800], '4940h': ['female', 171, 789], '4951h': ['female', 171, 973], '4953h': ['female', 171, 627] };
test('landings from a 5 cm box: gravity bounds the sand frame', { skip: !Object.keys(BOX).every(load) }, () => {
  for (const [id, [sex, h, truth]] of Object.entries(BOX)) {
    const r = load(id), j = analyzeJump(r, sex, r.ts, { height: h });
    // 4951: gravity says 960 and there is no sand frame; the rest within 4 frames
    assert.ok(Math.abs(j.landing - truth) <= (id === '4951h' ? 14 : 4), `${id} landing ${j.landing} vs ${truth}`);
  }
});

test('a raised take-off is recognised, its runway line comes from the penultimate, its lowering is hidden', { skip: !load(4954) || !load(4677) || !load(4930) }, () => {
  for (const id of [4950, 4954, '4951h', '4953h']) {
    const r = load(id); if (!r) continue;
    const [sex, h] = BOX[id], j = analyzeJump(r, sex, r.ts, { height: h });
    assert.equal(j.flight.ground.raised, true, `${id}`);
    assert.equal(j.metrics.find(m => m.key === 'comDropBoard').status, 'hidden');
  }
  for (const id of [4677, 4930, '4933b']) {
    const r = load(id), j = analyzeJump(r, 'male', r.ts, { height: 186 });
    assert.equal(j.flight.ground.raised, false, `${id}`);
  }
  // with the line on the runway Stanley's box jumps come out at 6.30 and 6.65 m (he jumps 6.30-6.70
  // there); read on the box's line they were 8.64 and 9.33 m/s into the board, 0.6-0.8 too fast
  const sp = id => { const r = load(id); return analyzeJump(r, 'male', r.ts, { height: 186 }).metrics.find(m => m.key === 'speedLast').value; };
  assert.ok(sp(4954) < 8.9 && sp(4950) < 8.4, `${sp(4950)} ${sp(4954)}`);
});

test('Claude\'s pieces of one contact become one; an unbacked piece in the air is not a step (IMG_4953)', () => {
  const runs = groundRuns([474, 475, 476, 477, 492, 493, 494, 495, 496, 502, 503, 504, 505, 506, 510, 511, 512, 519, 520, 521, 522, 528, 529, 530, 531, 532, 536, 537, 538, 539, 540, 541]);
  const pose = [{ td: 469, to: 483 }, { td: 502, to: 517 }, { td: 529, to: 531 }, { td: 546, to: 550 }];
  const c = pickContacts(runs, pose, 548, 120);
  assert.deepEqual([c.pen.td, c.pen.to, c.pen.from], [502, 517, 'pose']);
  // the take-off is a piece of 529-547; the app finds its edges on the raw foot (530/547)
  assert.deepEqual([c.take.td, c.take.to, c.take.from], [536, 541, 'claude']);
  assert.deepEqual(checkEvents({ penTD: 502, penTO: 517, TD: 536, TO: 541 }, 120, { claudeTake: true }).rejected, []);
  // two stray frames in each flight must not join IMG_4954's last contacts (pose 668-683, 693-710)
  const c2 = pickContacts([{ td: 652, to: 656 }, { td: 668, to: 675 }, { td: 681, to: 687 }, { td: 696, to: 703 }],
    [{ td: 639, to: 652 }, { td: 668, to: 683 }, { td: 693, to: 710 }], 702, 120);
  assert.deepEqual([c2.pen.td, c2.pen.to, c2.take.td, c2.take.to], [668, 683, 693, 710]);
});
