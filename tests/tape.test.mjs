// The tape measure as a correction of the video's metres (jump.js tapeFix).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tapeFix, TAPE_MAX } from '../js/analysis/jump.js';

test('from the board: the video distance is toe-to-mark minus the toe-to-line gap', () => {
  const f = tapeFix({ jump: 6.49, toeToLine: 0.16 }, 6.50, 'board');
  assert.equal(f.from, 'board');
  assert.ok(Math.abs(f.video - 6.33) < 1e-9);
  assert.ok(Math.abs(f.k - 6.50 / 6.33) < 1e-4);
  assert.equal(f.applied, true);
});

test('from the toe: the video distance is toe-to-mark', () => {
  const f = tapeFix({ jump: 6.49, toeToLine: 0.16 }, 6.85, 'toe');
  assert.equal(f.video, 6.49);
  assert.equal(f.applied, true);
});

test('far past the line defaults to the toe (short run-up, no board)', () => {
  assert.equal(tapeFix({ jump: 5.2, toeToLine: -0.9 }, 5.3).from, 'toe');
  assert.equal(tapeFix({ jump: 5.2, toeToLine: 0.1 }, 5.3).from, 'board');
});

test('a gap beyond a scale error is reported, not applied; a tiny one changes nothing', () => {
  const far = tapeFix({ jump: 6.0, toeToLine: 0 }, 6.0 * (1 + TAPE_MAX + 0.02));
  assert.equal(far.applied, false);
  assert.equal(far.tooFar, true);
  const tiny = tapeFix({ jump: 6.0, toeToLine: 0 }, 6.01);
  assert.equal(tiny.applied, false);
  assert.equal(tiny.tooFar, false);
});

test('no tape or no video distance: no correction', () => {
  assert.equal(tapeFix({ jump: 6.0, toeToLine: 0 }, null), null);
  assert.equal(tapeFix({ jump: NaN, toeToLine: 0 }, 6.2), null);
});
