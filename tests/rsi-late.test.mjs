// Nine RSI clips uploaded on 2026-11-18 at 23:00-23:08: seven drop jumps,
// two countermovement jumps filmed from the front. The pose was dumped on the server (gitignored
// tests/real/rsi18g/). Hand frames on fixed foot crops: touchdown, last frame on the floor, landing.
//  - the two CMJs landed nearer the phone, lower in the picture: the stand read as a box, no jump came out
//  - a drop jump from the side and above: both feet still 197-216, the far one 12.5 cm higher, read single-leg
//  - IMG_5320 (cut in Photos) has 42 frames before 0 that ffmpeg never outputs: the server job failed
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';
import { probe } from '../server/frames.mjs';
import { fileURLToPath } from 'node:url';

const dir = new URL('./real/rsi18g/', import.meta.url);
const have = existsSync(new URL('named.json', dir));
function replay(id, who) {
  const d = JSON.parse(readFileSync(new URL(`rsi${id}.json`, dir)));
  const f = who === 'f', cam = d.camera && d.camera.moved >= 1.5 ? d.camera : null;
  let r = rsiAnalysis(fromWire(d.wire), d.ts, { sex: f ? 'female' : 'male', height: f ? 171 : 186, cam });
  if (!r.error && !phoneFollows(d.camera, r.events, d.meta.W, d.meta.H) && d.motion) r = pixelEdges(r, d.motion, d.meta.fps);
  return r;
}
// drop jumps: [sex, touchdown, last on the floor, landing]
const DROP = {
  // blind re-reads of 2026-11-21 (the first readings put toe-offs 1-2 frames early)
  1795039297296: ['f', 185, 211, 281], 1795039346888: ['m', 197, 216, 288], 1795039437665: ['m', 123, 147, 215],
  1795039466572: ['m', 241, 264, 338], 1795039518904: ['m', 214, 239, 313], 1795039616947: ['f', 119, 141, 212],
  1795039696623: ['f', 118, 144, 210],
};
// CMJs: [sex, last on the floor, landing]
const CMJ = { 1795039249135: ['f', 494, 565], 1795039369692: ['m', 124, 211] };

test('late uploads: drop jumps on both feet, edges and landings within 2 frames', { skip: !have }, () => {
  for (const [id, [who, td, to, land]] of Object.entries(DROP)) {
    const r = replay(id, who);
    assert.equal(r.kind, 'drop_jump', `${id} kind ${r.kind}`);
    const j = r.jumps[0], L = j.to + 1 + Math.round(j.flightMs * 120 / 1000);
    assert.ok(Math.abs(j.td - td) <= 1 && Math.abs(j.to - to) <= 1, `${id} contact ${j.td}-${j.to}, by eye ${td}-${to}`);
    assert.ok(Math.abs(L - land) <= 2, `${id} landing ${L}, by eye ${land}`);
  }
});

test('late uploads: a CMJ filmed from the front is a CMJ, its flight as by hand', { skip: !have }, () => {
  for (const [id, [who, to, land]] of Object.entries(CMJ)) {
    const r = replay(id, who);
    assert.equal(r.kind, 'cmj', `${id} kind ${r.kind}`);
    const s = r.standing[0], frames = Math.round(s.flightMs * 120 / 1000);
    assert.ok(Math.abs(s.to - to) <= 1 && Math.abs(s.to + 1 + frames - land) <= 1, `${id} ${s.to} +${frames}, by eye ${to}-${land}`);
  }
});

test('a clip cut in Photos: frames before 0 are not counted', { skip: !existsSync(new URL('rsi1795039369692.mov', dir)) }, () => {
  const p = probe(fileURLToPath(new URL('rsi1795039369692.mov', dir)));
  assert.equal(p.N, 321);
  assert.ok(p.ts[0] >= 0);
});
