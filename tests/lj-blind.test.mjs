// Every run-up contact and the landing of every long jump with a stored server answer and a video,
// read blind (2026-11-21) on crops that follow the foot, without the app's frames. lj-blind.json:
// contacts clip -> [foot, TD, TO] ("a/b" either frame, "<f"/">f" outside the frames shown, "?"
// unreadable), landing clip -> first frame in the sand. The answers are gitignored (tests/real).
// Hand rows are matched to the app's contacts by foot and the nearest frame (within 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fromWire } from '../js/cloud.js';
import { analyzeJump } from '../js/analysis/jump.js';

const R = new URL('./real/', import.meta.url);
const H = JSON.parse(readFileSync(new URL('./lj-blind.json', import.meta.url)));
const have = existsSync(new URL('bench/history/', R)) && existsSync(new URL('lj19/', R));
const parse = v => (!v || v === '?' || v[0] === '<' || v[0] === '>' ? null : (p => ({ lo: Math.min(...p), hi: Math.max(...p) }))(v.split('/').map(Number)));

test('blind hand reads: run-up contacts and sand landings of every long jump', { skip: !have }, () => {
  const hist = readdirSync(new URL('bench/history/', R)).sort();
  const ans = id => { const n = id.slice(4), h = hist.filter(f => f.startsWith(n + '-')).at(-1); return h ? new URL(`bench/history/${h}`, R) : new URL(`lj19/${id}.json`, R); };
  const E = { td: [], to: [], land: [] };
  for (const clip of new Set([...Object.keys(H.contacts), ...Object.keys(H.landing)])) {
    if (!existsSync(ans(clip))) continue;
    const r = fromWire(JSON.parse(readFileSync(ans(clip))).result), miska = r.who?.id === 'miska';
    const j = analyzeJump(r, miska ? 'female' : 'male', r.ts, { height: miska ? 171 : 186 });
    if (j.error) continue;
    for (const [foot, tdS, toS] of H.contacts[clip] ?? []) for (const [k, s] of [['td', tdS], ['to', toS]]) {
      const w = parse(s); if (!w) continue; const mid = (w.lo + w.hi) / 2;
      const c = (j.contacts ?? []).filter(x => x.foot === foot).sort((a, b) => Math.abs(a[k] - mid) - Math.abs(b[k] - mid))[0];
      if (c && Math.abs(c[k] - mid) <= 8) E[k].push(c[k] < w.lo ? c[k] - w.lo : c[k] > w.hi ? c[k] - w.hi : 0);
    }
    const lw = parse(H.landing[clip]);
    if (lw && Number.isInteger(j.landing) && r.events?.kind !== 'runthrough') E.land.push(j.landing < lw.lo ? j.landing - lw.lo : j.landing > lw.hi ? j.landing - lw.hi : 0);
  }
  const rate = a => a.filter(x => Math.abs(x) <= 1).length / a.length, mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  // 2026-11-21: TD 98 % within a frame; TO 86 % (was 76 %, -0.6 frame early before approachToeOffs);
  // real jumps' landings 14 of 15 within a frame (run-throughs have no landing to show)
  assert.ok(rate(E.td) >= 0.95, `TD ${rate(E.td)}`);
  assert.ok(rate(E.to) >= 0.83, `TO ${rate(E.to)}`);
  assert.ok(Math.abs(mean(E.to)) <= 0.25, `TO bias ${mean(E.to)}`);
  assert.ok(rate(E.land) >= 0.85, `landing ${rate(E.land)} of ${E.land.length}`);
});
