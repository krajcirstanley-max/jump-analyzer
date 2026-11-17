// The app against the hand-checked frames of every local clip (tests/truth.json, tools/bench.mjs).
// Runs on the latest server results kept locally; skipped where the clips aren't on this machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bench = fileURLToPath(new URL('../tools/bench.mjs', import.meta.url));
test('every clip within the gate: contacts ±2 frames, landings ±3, no jump in a sprint', { skip: !existsSync(new URL('./real/bench/', import.meta.url)) }, () => {
  const r = spawnSync(process.execPath, [bench], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout.split('\n').filter(l => /FAIL|ERROR|WRONG|server:/.test(l)).join('\n'));
});
