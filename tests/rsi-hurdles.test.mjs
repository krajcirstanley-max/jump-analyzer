// Hurdle hops (18 clips, 2026-08-21 to 2026-11-16, both athletes, phones that pan and follow): every
// touchdown and toe-off read blind from the video on 2026-11-24 (rsi-hurdles.json; "a/b" either
// frame, a stop is one contact from landing to the next take-off). The pose dumps are local
// (tests/real/hurdles/out, gitignored). The server's steps after the pose are replayed, with the
// no-box re-read the server does when Claude names hurdle hops. Each hand edge is matched to the
// app's nearest edge of its kind; further than 8 frames counts as missed.
// 2026-11-24 before the fixes: 60 of 188 edges missed (the deep rebound's sinking toe, contacts
// dropped as 'in the air' while the phone panned, the stand cut in two); after: 26, then 18 (stops with a
// re-set step joined, a dipping foot point before a landing dropped, late touchdowns searched back). Half
// of the 18 are standing take-offs before the first hurdle, which show no contact time anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';
import { applyH, invertH } from '../js/analysis/homography.js';

const HAND = JSON.parse(readFileSync(new URL('./rsi-hurdles.json', import.meta.url)));
const OUT = new URL('./real/hurdles/out/', import.meta.url);
const have = existsSync(new URL('IMG_4964.json', OUT));

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
  assert.ok(n >= 180, `${n} hand edges`);
  assert.ok(missed <= 18, `missed ${missed} of ${n}`);
  // the orange hall clips are soft: two blind readers differed by 2 frames on the same touchdowns
  // 2026-11-24: 0.89 and 0.90; the rest are standing take-offs read 3-6 frames early and late last landings
  assert.ok(within(off.TD) >= 0.88 && within(off.TO) >= 0.88, `within 2 frames TD ${within(off.TD)} TO ${within(off.TO)}`);
});
