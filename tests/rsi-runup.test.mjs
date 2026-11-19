// A long jump picked under RSI by mistake (2026-11-19, Stanley: "dal som tam omylom skoky a začalo
// to analyzovať ako opakované odrazy"). The run-up steps take turns on one foot each and the hips
// travel metres; no drop jump, hop or CMJ does that. Pose dumped on the server (gitignored
// tests/real/rsi19/, and the RSI sets of 17-18 Nov for the clips that must still pass).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { rsiAnalysis, runningSteps } from '../js/analysis/rsi.js';
import { fromWire } from '../js/cloud.js';

const real = new URL('./real/', import.meta.url);
const run = f => {
  const d = JSON.parse(readFileSync(f));
  const cam = d.camera && d.camera.moved >= 1.5 ? d.camera : null;
  return rsiAnalysis(fromWire(d.wire), d.ts, { cam });
};
const lj = new URL('rsi19/rsi1795086931110.json', real);

test('a long jump under RSI is refused, not read as hops', { skip: !existsSync(lj) }, () => {
  const r = run(lj);
  assert.ok(r.running, `read as ${r.kind}`);
  assert.match(r.error, /skok do diaľky/);
});

test('no RSI clip of 17-18 Nov reads as a run-up', () => {
  let n = 0;
  for (const set of ['rsi17', 'rsi18e', 'rsi18f', 'rsi18g']) {
    const dir = new URL(`${set}/`, real);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'named.json')) {
      const r = run(new URL(f, dir)); n++;
      assert.ok(!r.running, `${set}/${f} refused as a run-up`);
    }
  }
  if (!n) return;   // data not on this machine
  assert.ok(n >= 40);
});

test('running steps: feet taking turns, one foot each', () => {
  const ev = s => s.split(' ').map(feet => ({ feet }));
  assert.equal(runningSteps(ev('lr r l r l r l')), 6);
  assert.equal(runningSteps(ev('lr r r r r')), 1);       // hops on one leg
  assert.equal(runningSteps(ev('lr lr lr lr')), 0);      // hurdle hops, drop jumps
  assert.equal(runningSteps(ev('r l lr r l')), 2);
});
