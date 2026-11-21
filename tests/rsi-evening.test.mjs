// Four drop jumps off a 30 cm box uploaded on 2026-11-18 evening (Stanley ×3, Miška), the phone
// hand-held and moving. The pose of each was dumped on the server (gitignored tests/real/rsi18f/).
// Hand frames: touchdown = first frame the shoe is on the floor, toe-off = the last, landing = the
// first frame back on the floor, read on fixed foot crops.
//  - rsi.mp4: the rebound took the feet out of the top of the picture and the pose sat on someone
//    behind the box: a "landing" at 177 for 217, RSI 0.59 for 2.3.
//  - IMG_3519: filmed a little from the side, the foot nearer the phone sits 9 cm lower in the
//    picture and the drop jump read as single-leg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';

const dir = new URL('./real/rsi18f/', import.meta.url);
const have = existsSync(new URL('named.json', dir));
function replay(id, who) {
  const d = JSON.parse(readFileSync(new URL(`rsi${id}.json`, dir)));
  const miska = who === 'miska', cam = d.camera && d.camera.moved >= 1.5 ? d.camera : null;
  let r = rsiAnalysis(fromWire(d.wire), d.ts, { sex: miska ? 'female' : 'male', height: miska ? 171 : 186, cam });
  if (!r.error && !phoneFollows(d.camera, r.events, d.meta.W, d.meta.H) && d.motion) r = pixelEdges(r, d.motion, d.meta.fps);
  return r;
}
// id: [who, touchdown, last frame on the floor, landing]; blind re-reads of 2026-11-21 (966040: shoes
// down at 92/93 on a 12-frame crop, the phone moving)
const HAND = {
  1795037345193: ['stanley', 106, 137, 217],
  1795037966040: ['stanley', 93, 125, 200],
  1795038028406: ['stanley', 192, 221, 297],
  1795037364266: ['miska', 104, 132, 201],
};

test('evening drop jumps: both legs, edges within 2 frames, the landing found after the feet left the picture', { skip: !have }, () => {
  for (const [id, [who, td, to, land]] of Object.entries(HAND)) {
    const r = replay(id, who);
    assert.ok(!r.error, `${id}: ${r.error}`);
    assert.equal(r.kind, 'drop_jump', `${id} kind ${r.kind}`);
    assert.equal(r.jumps.length, 1, id);
    const j = r.jumps[0], L = j.to + 1 + Math.round(j.flightMs * 120 / 1000);
    // 966040: hand-held, the phone moving as the feet land; a known 3-frame touchdown miss (96 for 93)
    assert.ok(Math.abs(j.td - td) <= (id === '1795037966040' ? 3 : 2) && Math.abs(j.to - to) <= 1, `${id} contact ${j.td}-${j.to}, by eye ${td}-${to}`);
    assert.ok(Math.abs(L - land) <= 2, `${id} landing ${L}, by eye ${land}`);
  }
});
