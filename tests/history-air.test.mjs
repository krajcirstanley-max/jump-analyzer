// The History row shows the time in the air without opening the jump (2026-11-23).
import test from 'node:test';
import assert from 'node:assert/strict';
import { airLabel } from '../js/history.js';

test('history row: flight in seconds, from the record or its stored jump; a run-through says so', () => {
  assert.equal(airLabel({ metrics: { flight: { v: 723, s: 'low' } } }), 'let 0,72 s');
  assert.equal(airLabel({ metrics: {}, jump: { metrics: [{ key: 'flight', value: 655 }] } }), 'let 0,66 s');
  assert.equal(airLabel({ metrics: { flight: { v: 500 } }, jump: { kind: 'runthrough' } }), 'výbeh');
  assert.equal(airLabel({ metrics: {} }), '');
});
