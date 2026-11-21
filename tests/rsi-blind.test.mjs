// Every contact of every RSI clip with a video, read blind (2026-11-21): for each jump the app
// reports, the first frame a shoe touches (TD), the last frame a shoe touches (TO) and the first
// frame a shoe touches after the flight (LAND), on fixed crops of both feet without the app's
// frames. rsi-blind.json: clip -> jump index -> {TD, TO, LAND}; "a/b" either frame, "<f"/">f"
// outside the frames shown, "?" unreadable. The pose dumps are gitignored (tests/real); the 17 Nov
// clips are checked on every stored server run of them, since the pose moves between runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { rsiAnalysis, pixelEdges, phoneFollows } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';
import { applyH, invertH } from '../js/analysis/homography.js';

const R = new URL('./real/', import.meta.url);
const HAND = JSON.parse(readFileSync(new URL('./rsi-blind.json', import.meta.url)));
const RUNS17 = ['rsi18e', 'rsi18d', 'rsi18c', 'rsi17', 'rsi17_run1'].filter(s => existsSync(new URL(`${s}/named.json`, R)));
const named = s => (existsSync(new URL(`${s}/named.json`, R)) ? JSON.parse(readFileSync(new URL(`${s}/named.json`, R))) : {});
const have = RUNS17.length && ['rsi18f', 'rsi18g', 'rsi21'].every(s => existsSync(new URL(`${s}/`, R)));

// the steps of server/rsi.mjs analyzeRsiClip after the pose, as in rsi-gym.test.mjs
function replay(file, who, box) {
  const d = JSON.parse(readFileSync(file)), fem = who === 'miska', sex = fem ? 'female' : 'male', height = fem ? 171 : 186;
  const camera = d.camera, cam = camera && camera.moved >= 1.5 ? camera : null;
  let r = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam });
  if (r.error) return { r, fps: d.meta.fps };
  let motion = null;
  if (!phoneFollows(camera, r.events, d.meta.W, d.meta.H) && d.motion) {
    motion = d.motion;
    const keys = Object.keys(cam?.h ?? {}).map(Number).sort((a, b) => a - b);
    for (const m of motion) {
      if (!m || m.g) continue;
      const a = keys.findLast(k => k <= m.f), b = keys.find(k => k > m.f), p = m.l?.slice(3, 5) ?? m.r?.slice(3, 5);
      if (!cam) m.g = [0, 0];
      else if (a != null && b != null && p) { const q = applyH(invertH(cam.h[a]), p), pa = applyH(cam.h[a], q), pb = applyH(cam.h[b], q); m.g = [(pb[0] - pa[0]) / (b - a), (pb[1] - pa[1]) / (b - a)]; }
    }
    r = pixelEdges(r, motion, d.meta.fps);
  }
  if (box === false && (r.events ?? []).some(e => e.onBox)) {
    const again = rsiAnalysis(fromWire(d.wire), d.ts, { sex, height, cam, noBox: true });
    if (!again.error) r = motion ? pixelEdges(again, motion, d.meta.fps) : again;
  }
  return { r, fps: d.meta.fps };
}
const parse = v => (v === '?' ? null : v[0] === '<' || v[0] === '>' ? null : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(v.split('/').map(Number)));

function tally(set17) {
  const N = Object.assign({}, named('rsi17'), named(set17), named('rsi18f'), named('rsi18g'));
  const files = {};
  for (const s of ['rsi18f', 'rsi18g', 'rsi21']) for (const f of readdirSync(new URL(`${s}/`, R)).filter(x => /^rsi\d+\.json$/.test(x))) files[f.slice(3, -5)] = new URL(`${s}/${f}`, R);
  for (const f of readdirSync(new URL(`${set17}/`, R)).filter(x => /^rsi\d+\.json$/.test(x))) { const id = f.slice(3, -5); if (!existsSync(new URL(`rsi21/rsi${id}.json`, R))) files[id] = new URL(`${set17}/${f}`, R); }
  const T = { TD: [], TO: [], LAND: [] };
  for (const [clip, jumps] of Object.entries(HAND)) {
    if (!files[clip]) continue;
    const { r, fps } = replay(files[clip], N[clip]?.who?.id, N[clip]?.named?.box);
    const ev = [...(r.jumps ?? []).map(j => ({ td: j.td, to: j.to, land: j.to + 1 + Math.round((j.flightMs * fps) / 1000) })),
      ...(r.standing ?? []).map(s => ({ to: s.to, land: s.to + 1 + Math.round((s.flightMs * fps) / 1000) }))];
    for (const [k, h] of Object.entries(jumps)) {
      const e = ev[+k]; if (!e) continue;
      const k120 = Math.min(1, 120 / fps);   // a 240 fps clip is held to 120 fps time; 60 fps to its own frame
      for (const [kind, app] of [['TD', e.td], ['TO', e.to], ['LAND', e.land]]) {
        const w = h[kind] && parse(h[kind]); if (!w || app == null) continue;
        T[kind].push((app < w.lo ? app - w.lo : app > w.hi ? app - w.hi : 0) * k120); if (process.env.DBG && Math.abs(T[kind].at(-1)) > 1) console.log(set17, clip, k, kind, app, h[kind]);
      }
    }
  }
  return T;
}

test('blind hand reads: RSI touchdowns, toe-offs and landings on every stored pose run', { skip: !have }, () => {
  const rate = a => a.filter(x => Math.abs(x) <= 1.01).length / a.length, mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  // 2026-11-21 (toe-off from the first foot up past half its peak rise, the toe still just before,
  // edges rounded): TD 39/42, TO 44/46, LAND 44/46 within a frame on all five runs; the old rule
  // (first foot past half its median rise, floored) had TO 38/46 with the toe-off 0.5-0.7 frame early.
  for (const set of RUNS17) {
    const T = tally(set);
    assert.ok(rate(T.TD) >= 0.9, `${set} TD ${rate(T.TD)}`);
    assert.ok(rate(T.TO) >= 0.93, `${set} TO ${rate(T.TO)}`);
    assert.ok(rate(T.LAND) >= 0.93, `${set} LAND ${rate(T.LAND)}`);
    for (const k of ['TD', 'TO', 'LAND']) assert.ok(Math.abs(mean(T[k])) <= 0.35, `${set} ${k} bias ${mean(T[k])}`);
  }
});
