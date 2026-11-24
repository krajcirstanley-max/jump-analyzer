// Pogo and single-leg hops (2026-08-12 to 2026-09-17 and one of May, both athletes, hand-held phones that
// follow; 8 of the 20 are single-leg hops): every touchdown and toe-off read blind on 2026-11-24
// (rsi-pogo.json). Replayed like rsi-hurdles.test.mjs. 2026-11-24: 25 of 392 edges missed, mostly the
// standing take-off and the first rebound; the walk-off last landing is found since then.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';
import { applyH, invertH } from '../js/analysis/homography.js';

const HAND = JSON.parse(readFileSync(new URL('./rsi-pogo.json', import.meta.url)));
const OUT = new URL('./real/pogo/out/', import.meta.url);
const have = existsSync(new URL('IMG_1688.json', OUT));

function fixMotion(motion, cam) {
  const keys = Object.keys(cam?.h ?? {}).map(Number).sort((a, b) => a - b);
  for (const m of motion) {
    if (!m || m.g) continue;
    const a = keys.findLast(k => k <= m.f), b = keys.find(k => k > m.f), p = m.l?.slice(3, 5) ?? m.r?.slice(3, 5);
    if (!cam) m.g = [0, 0];
    else if (a != null && b != null && p) { const q = applyH(invertH(cam.h[a]), p), pa = applyH(cam.h[a], q), pb = applyH(cam.h[b], q); m.g = [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)]; }
  }
  return motion;
}
function replay(file, who) {
  const d = JSON.parse(readFileSync(file)), fem = who === 'woman', sex = fem ? 'female' : 'male', height = fem ? 171 : 186;
  const camera = d.camera, cam = camera && camera.moved >= 1.5 ? camera : null;
  const edges = r => (!r.error && !phoneFollows(camera, r.events, d.meta.W, d.meta.H) && d.motion ? pixelEdges(r, fixMotion(JSON.parse(readFileSync(file)).motion, cam), d.meta.fps) : r);
  let r = edges(rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam }));
  if (!r.error && (r.events ?? []).some(e => e.onBox)) { const again = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam, noBox: true }); if (!again.error) r = edges(again); }
  return { r, fps: d.meta.fps };
}
const parse = v => (v == null || v === '?' ? null : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(String(v).split('/').map(Number)));

test('hurdle hops: blind hand reads of every touchdown and toe-off', { skip: !have }, () => {
  const off = { TD: [], TO: [] }; let missed = 0, n = 0;
  for (const [clip, h] of Object.entries(HAND)) {
    const { r, fps } = replay(new URL(`${clip}.json`, OUT), h.who);
    const app = { TD: [], TO: [] };
    for (const j of r.jumps ?? []) { app.TD.push(j.td, j.to + 1 + Math.round(j.flightMs * fps / 1000)); app.TO.push(j.to); }
    for (const s of r.standing ?? []) { app.TO.push(s.to); app.TD.push(s.to + 1 + Math.round(s.flightMs * fps / 1000)); }
    for (const c of h.contacts) for (const k of ['TD', 'TO']) {
      const w = parse(c[k]); if (!w) continue; n++;
      const d = app[k].map(a => (a < w.lo ? a - w.lo : a > w.hi ? a - w.hi : 0)).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
      if (d == null || Math.abs(d) > 8) missed++; else off[k].push(d);
    }
  }
  const within = a => a.filter(x => Math.abs(x) <= 2).length / a.length;
  assert.ok(n >= 380, `${n} hand edges`);
  assert.ok(missed <= 25, `missed ${missed} of ${n}`);
  // the orange hall clips are soft: two blind readers differed by 2 frames on the same touchdowns
  // 2026-11-24: TD 0.91, TO 0.73 within 2 frames. Pogo toe-offs are gradual (the heel lifts 3-8 frames
  // before the toe) and the phones were hand-held and following: TO spread +-7 frames both ways, bias +0.6.
  assert.ok(within(off.TD) >= 0.9 && within(off.TO) >= 0.72, `within 2 frames TD ${within(off.TD)} TO ${within(off.TO)}`);
});
