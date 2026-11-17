// The gym session of 2026-11-17: 15 RSI clips filmed in the app, 30 cm box, Stanley in the blue
// shirt and Miška. Stanley: "podľa mňa je to zle veľakrát". The pose of each clip was dumped on the
// server (gitignored tests/real/rsi17/, with Claude's naming from that day in named.json), so this
// replays the server's RSI steps without a GPU. Skipped when the files are not there.
// Hand frames: touchdown = first frame the shoe is on the floor, toe-off = last one, landing =
// first frame back on the floor, read on 3x foot crops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, refineEdges, touchdowns } from '../js/analysis/rsi.js';
import { footContacts, SPRINT } from '../js/analysis/sprint.js';
import { fromWire } from '../js/cloud.js';
import { applyH, invertH } from '../js/analysis/homography.js';

const DIR = new URL('./real/rsi17/', import.meta.url);
const have = existsSync(new URL('named.json', DIR));
const NAMED = have ? JSON.parse(readFileSync(new URL('named.json', DIR))) : {};

// the steps of server/rsi.mjs analyzeRsiClip after the pose, on a dump
function replay(id) {
  const d = JSON.parse(readFileSync(new URL(`rsi${id}.json`, DIR)));
  const miska = NAMED[id]?.who?.id === 'miska';
  const sex = miska ? 'female' : 'male', height = miska ? 171 : 186;
  const camera = d.camera, cam = camera && camera.moved >= 1.5 ? camera : null;
  let rsi = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam });
  if (rsi.error) return rsi;
  const follows = !!camera && camera.moved > 0.1 * Math.min(d.meta.W, d.meta.H);
  let toe = null, land = null;
  if (!follows && d.motion) {
    const keys = Object.keys(cam?.h ?? {}).map(Number).sort((a, b) => a - b);
    for (const m of d.motion) {
      if (!m || m.g) continue;
      const a = keys.findLast(k => k <= m.f), b = keys.find(k => k > m.f), p = m.l?.slice(3, 5) ?? m.r?.slice(3, 5);
      if (!cam) m.g = [0, 0];
      else if (a != null && b != null && p) { const q = applyH(invertH(cam.h[a]), p), pa = applyH(cam.h[a], q), pb = applyH(cam.h[b], q); m.g = [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)]; }
    }
    toe = ['l', 'r'].flatMap(s => footContacts(d.motion, s, d.ts, d.meta.fps, { ...SPRINT, planted: 0.12 }));
    land = ['l', 'r'].flatMap(s => touchdowns(d.motion, s, d.meta.fps));
    rsi = refineEdges(rsi, toe, d.meta.fps, land);
  }
  if (NAMED[id]?.named?.box === false && (rsi.events ?? []).some(e => e.onBox)) {
    const again = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam, noBox: true });
    if (!again.error) rsi = toe ? refineEdges(again, toe, d.meta.fps, land) : again;
  }
  return rsi;
}

// id: [touchdown, toe-off, landing] by eye (landing null where not checked)
const HAND = {
  1794924872722: [311, 338, 419],
  1794924921055: [186, 210, 289],
  1794924961224: [266, 298, 377],
  1794924995468: [359, 387, 469],
  1794925041151: [258, 285, null], // the one that read as a pogo
  1794925090410: [376, 403, 485],  // no landing before: the head left the picture in the air (needs the rejoined pose)
  1794924142275: [270, 300, null], // Miška, the stepping foot had counted as a rebound
  1794932384646: [53, 82, null],   // Miška, had read as hops
};

test('gym 2026-11-17: every drop jump is a drop jump off the box, edges within 2 frames', { skip: !have }, () => {
  for (const [id, [td, to, landing]] of Object.entries(HAND)) {
    const r = replay(id);
    assert.ok(!r.error, `${id}: ${r.error}`);
    assert.equal(r.kind, 'drop_jump', `${id} kind ${r.kind}`);
    assert.equal(r.jumps.length, 1, `${id}: ${r.jumps.length} rebounds`);
    const j = r.jumps[0];
    assert.equal(j.dropFrom, 'box', id);
    assert.ok(Math.abs(j.td - td) <= 2 && Math.abs(j.to - to) <= 2, `${id} contact ${j.td}-${j.to}, by eye ${td}-${to}`);
    if (landing != null) { const L = j.to + 1 + Math.round(j.flightMs * 120 / 1000); assert.ok(Math.abs(L - landing) <= 2, `${id} landing ${L}, by eye ${landing}`); }
  }
});

test('gym 2026-11-17: Miška\'s other drop jumps are drop jumps too', { skip: !have }, () => {
  for (const id of ['1794924056156', '1794932342732', '1794932429138']) {
    const r = replay(id);
    assert.equal(r.kind, 'drop_jump', `${id} kind ${r.kind}`);
    assert.equal(r.jumps.length, 1, id);
  }
});

test('gym 2026-11-17: only the legs in the picture says so instead of numbers', { skip: !have }, () => {
  for (const id of ['1794929272459', '1794932202395', '1794932274606', '1794924114112']) {
    const r = replay(id);
    assert.equal(r.framing, 'legs', `${id}: ${r.error ?? r.kind}`);
  }
});
