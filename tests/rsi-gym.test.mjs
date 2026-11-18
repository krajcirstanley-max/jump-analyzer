// The gym session of 2026-11-17: 15 RSI clips filmed in the app, 30 cm box, Stanley in the blue
// shirt and Miška. Stanley: "podľa mňa je to zle veľakrát". The pose of each clip was dumped on the
// server (gitignored tests/real/rsi17/, with Claude's naming from that day in named.json), so this
// replays the server's RSI steps without a GPU. Skipped when the files are not there.
// Hand frames: touchdown = first frame the shoe is on the floor, toe-off = last one, landing =
// first frame back on the floor, read on 3x foot crops.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';
import { applyH, invertH } from '../js/analysis/homography.js';

// Server runs of the same clips (2026-11-17, 2026-11-18, and two on 2026-11-18 with the coarse pose:
// every 4th frame, every frame only around the contacts): the pose moves by up to two frames
// between runs, so every rule has to hold on all of them.
const RUNS = ['./real/rsi18e/', './real/rsi18d/', './real/rsi18c/', './real/rsi17/', './real/rsi17_run1/'].map(p => new URL(p, import.meta.url)).filter(u => existsSync(new URL('named.json', u)));
let DIR = RUNS[0];
const have = RUNS.length > 0;
let NAMED = have ? JSON.parse(readFileSync(new URL('named.json', DIR))) : {};
const eachRun = f => () => { for (const u of RUNS) { DIR = u; NAMED = JSON.parse(readFileSync(new URL('named.json', DIR))); f(); } };

// the steps of server/rsi.mjs analyzeRsiClip after the pose, on a dump
function replay(id) {
  const d = JSON.parse(readFileSync(new URL(`rsi${id}.json`, DIR)));
  const miska = NAMED[id]?.who?.id === 'miska';
  const sex = miska ? 'female' : 'male', height = miska ? 171 : 186;
  const camera = d.camera, cam = camera && camera.moved >= 1.5 ? camera : null;
  let rsi = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam });
  if (rsi.error) return rsi;
  const follows = phoneFollows(camera, rsi.events, d.meta.W, d.meta.H);
  let motion = null;
  if (!follows && d.motion) {
    motion = d.motion;
    // dumps from before 2026-11-18 have no ground motion where the floor strip missed: the camera's
    const keys = Object.keys(cam?.h ?? {}).map(Number).sort((a, b) => a - b);
    for (const m of motion) {
      if (!m || m.g) continue;
      const a = keys.findLast(k => k <= m.f), b = keys.find(k => k > m.f), p = m.l?.slice(3, 5) ?? m.r?.slice(3, 5);
      if (!cam) m.g = [0, 0];
      else if (a != null && b != null && p) { const q = applyH(invertH(cam.h[a]), p), pa = applyH(cam.h[a], q), pb = applyH(cam.h[b], q); m.g = [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)]; }
    }
    rsi = pixelEdges(rsi, motion, d.meta.fps);
  }
  if (NAMED[id]?.named?.box === false && (rsi.events ?? []).some(e => e.onBox)) {
    const again = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam, noBox: true });
    if (!again.error) rsi = motion ? pixelEdges(again, motion, d.meta.fps) : again;
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
  // only the legs in the picture, phone close and following (the way Stanley films): the stand on
  // the box came in pieces, a 0.03 RSI "rebound" on it, touchdowns 3-4 frames early
  1794929272459: [239, 262, 347],
  1794932202395: [309, 331, 411],
  1794932274606: [214, 245, 328],  // touchdown re-read 2026-11-18 on a tighter crop: sole down at 214, not 216
  1794924114112: [131, 157, 227],  // Miška, legs at the top edge, the landing in the last frames
  // 2026-11-18, an older clip uploaded: Miška off 50 cm, filmed from the front, the phone tilting
  // down while she stood. The last piece of the stand (one foot, 844-861) read as a rebound of RSI
  // 0,13 and toe runs in the air around the contact stretched it to 888-919: RSI 1,07 for 2,05.
  1794991005508: [887, 909, 978],
};
// still phone (toe edges): every edge within one frame (2026-11-18, Stanley: "nepresne")
const STILL = ['1794924872722', '1794924921055', '1794924995468', '1794925041151', '1794925090410', '1794932384646', '1794991005508'];

test('gym 2026-11-17: every drop jump is a drop jump off the box, edges within 2 frames', { skip: !have }, eachRun(() => {
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
}));

test('gym 2026-11-17: Miška\'s other drop jumps are drop jumps too', { skip: !have }, eachRun(() => {
  for (const id of ['1794924056156', '1794932342732', '1794932429138']) {
    const r = replay(id);
    assert.equal(r.kind, 'drop_jump', `${id} kind ${r.kind}`);
    assert.equal(r.jumps.length, 1, id);
  }
}));

test('still phone: contact edges and the landing within one frame of the hand frames', { skip: !have }, eachRun(() => {
  for (const id of STILL) {
    const [td, to, landing] = HAND[id], j = replay(id).jumps[0];
    assert.ok(Math.abs(j.td - td) <= 1 && Math.abs(j.to - to) <= 1, `${id} contact ${j.td}-${j.to}, by eye ${td}-${to}`);
    if (landing != null) { const L = j.to + 1 + Math.round(j.flightMs * 120 / 1000); assert.ok(Math.abs(L - landing) <= 1, `${id} landing ${L}, by eye ${landing}`); }
  }
  const j = replay('1794991005508').jumps[0];
  assert.ok(Math.abs(j.rsi - 2.05) <= 0.05, `Miška 18 Nov RSI ${j.rsi}`);
}));

// 2026-11-18: Miška's clip cut to the jump on the phone (0.27.0), as the server got it. The phone
// tilted while she stood, 112 px over the cut clip against a limit of 108 for the whole clip, and
// the pose's edges replaced the pixels': toe-off 2 frames late, RSI 1,78. Only the phone's motion
// within the contacts decides now. IMG_2213 (hops, the phone swinging after the athlete) keeps the
// pose's edges.
const E = new URL('./real/rsi18e/', import.meta.url);
test('cut clip with a phone tilting during the stand: pixel edges, RSI as by hand', { skip: !existsSync(new URL('rsimiska18trim.json', E)) }, () => {
  DIR = E; NAMED = JSON.parse(readFileSync(new URL('named.json', DIR)));
  const j = replay('miska18trim').jumps[0];
  assert.ok(Math.abs(j.td - 121) <= 1 && Math.abs(j.to - 143) <= 1, `contact ${j.td}-${j.to}, by eye 121-143`);
  assert.ok(Math.abs(j.rsi - 2.05) <= 0.05, `RSI ${j.rsi}`);
  const h = JSON.parse(readFileSync(new URL('rsihop2213.json', E)));
  const r = rsiAnalysis(fromWire(h.wire), h.ts, { sex: 'male', height: 186, cam: h.camera });
  assert.ok(phoneFollows(h.camera, r.events, h.meta.W, h.meta.H), 'IMG_2213: the phone follows');
});
