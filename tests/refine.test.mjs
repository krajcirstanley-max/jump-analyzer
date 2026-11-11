import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { refineTouchdowns } from '../js/analysis/refine.js';

// A foot coming down to the ground at frame 100 (heel first, forefoot two frames later) and
// leaving at 115; the other foot in the air. The detector said 98: two frames early, the
// IMG_4677 case. 200 px per metre, so 1.5 cm is 3 px.
function scene({ land = 100, off = 115 } = {}) {
  const K = J.length, PX = 200, G = 1500, fast = [];
  for (let i = 0; i < 140; i++) {
    const f = new Float32Array(K * 3);
    const set = (n, x, y) => { f[JI[n] * 3] = x; f[JI[n] * 3 + 1] = y; f[JI[n] * 3 + 2] = 0.9; };
    // stance foot: falls 4 px a frame until it lands
    const heelUp = i < land ? (land - i) * 4 : 0, toeUp = i < land + 2 ? (land + 2 - i) * 4 : i > off - 4 ? (i - off + 4) * 3 : 0;
    const x = 500;
    set('lheel', x, G - heelUp); set('lbigtoe', x - 50, G - toeUp); set('lsmalltoe', x - 45, G - toeUp);
    set('lank', x - 5, G - heelUp - 16); set('lknee', x - 20, G - heelUp - 16 - 0.43 * PX); set('lhip', x - 30, G - heelUp - 16 - 0.88 * PX);
    for (const n of ['heel', 'bigtoe', 'smalltoe']) set('r' + n, x + 60, G - 120);
    set('rank', x + 60, G - 136); set('rknee', x + 40, G - 220); set('rhip', x - 20, G - 196 - 0.88 * PX);
    fast.push(f);
  }
  return { fast, accurate: fast.map(() => null) };
}

test('a touchdown called two frames early moves to the frame the foot is down', () => {
  const r = refineTouchdowns(scene(), { penTD: 98, penTO: 115, TD: 130, TO: 138 }, { height: 180 });
  assert.equal(r.events.penTD, 100, JSON.stringify(r));
});

test('a touchdown already right stays', () => {
  const r = refineTouchdowns(scene(), { penTD: 100, penTO: 115, TD: 130, TO: 138 }, { height: 180 });
  assert.equal(r.events.penTD, 100, JSON.stringify(r));
});
