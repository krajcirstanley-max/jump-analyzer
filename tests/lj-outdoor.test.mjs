// Ten outdoor long jumps uploaded 2026-11-19 (Stanley and Miška, full run-ups, phone panning; server
// answers kept in gitignored tests/real/lj19/). Three of them were refused as "no take-off":
//  - IMG_1083 and IMG_1084, run-throughs: the sand came 0.22 s after the board, under the 0.3 s a full
//    jump needs, so the flight fit ran into the running out of the pit (vx 965 m/s), and on 1084 the
//    low arc's gravity scale gave vx −49 m/s although the runway was measured
//  - IMG_2432: the runway read wrong (0.5, 1.1, 28 m/s steps), and the penultimate touchdown came
//    10 frames early (the phone panned at the swinging foot's speed; by eye 505)
// Edges by eye on toe-following crops: board touchdown and toe-off within 1-2 frames on all ten.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { nameEvents, locateGuess } from '../server/locate.mjs';

const dir = new URL('./real/lj19/', import.meta.url);
const A = { stanley: ['male', 186], miska: ['female', 171] };
function run(id) {
  const r = JSON.parse(readFileSync(new URL(`IMG_${id}.json`, dir))).result;
  const [sex, height] = A[r.who?.id ?? 'stanley'];
  if (r.locate?.seen) {   // the server's naming again with the current code
    const r0 = { ...r }; delete r0.events; delete r0.locate; delete r0.ground; delete r0.groundError;
    const n = nameEvents({ ...r.locate.seen, T: r.locate.windows.T }, locateGuess(r0, sex, r.ts, { height }), r.fps);
    if (n.events.TD != null) r.events = n.events;
  }
  return analyzeJump(r, sex, r.ts, { height });
}
// [who, board touchdown, board toe-off] by eye
const BOARD = { 1080: ['stanley', 459, 477], 1081: ['miska', 539, 555], 1083: ['stanley', 957, 971], 1084: ['miska', 1008, 1022],
  1085: ['stanley', 927, 941], 1086: ['miska', 968, 984], 2432: ['stanley', 530, 550], 2433: ['stanley', 504, 525],
  2434: ['stanley', 958, 980], 2435: ['stanley', 604, 625] };
const have = existsSync(new URL('IMG_1080.json', dir));

test('outdoor long jumps 19 Nov: all ten analyse, board edges within 2 frames', { skip: !have }, () => {
  for (const [id, [who, td, to]] of Object.entries(BOARD)) {
    const j = run(id);
    assert.ok(!j.error, `${id}: ${j.error}`);
    assert.ok(Math.abs(j.takeoff.td - td) <= 2 && Math.abs(j.takeoff.to - to) <= 2, `${id} board ${j.takeoff.td}-${j.takeoff.to}, by eye ${td}-${to}`);
  }
});

test('run-throughs keep an early sand frame and are read as run-throughs', { skip: !have }, () => {
  for (const id of [1083, 1084]) assert.equal(run(id).kind, 'runthrough', `${id}`);
});

test('IMG_2432: the penultimate touchdown is not read in the air', { skip: !have }, () => {
  const j = run(2432);
  assert.ok(Math.abs(j.pen.td - 505) <= 2, `pen touchdown ${j.pen.td}, by eye 505`);
});
