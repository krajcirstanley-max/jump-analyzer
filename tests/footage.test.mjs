// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as mb from '../vendor/mediabunny.min.mjs';
import { inspectClip, summarizePackets, verdictFor, VERDICT } from '../js/footage.js';

const fixture = async name => new File([await readFile(new URL(`./fixtures/${name}`, import.meta.url))], name);

test('true 240 fps HEVC original passes the gate', async () => {
  const r = await inspectClip(await fixture('true240_hevc.mov'), mb);
  assert.equal(r.codec, 'hevc');
  assert.equal(r.timing.frames, 720);
  assert.ok(Math.abs(r.timing.fpsFromGap - 240) < 1, `fps ${r.timing.fpsFromGap}`);
  assert.ok(Math.abs(r.timing.duration - 3) < 0.01);
  assert.equal(r.verdict, VERDICT.OK_240);
});

test('240 fps H.264 copy still passes (codec alone does not decide)', async () => {
  const r = await inspectClip(await fixture('true240_h264.mp4'), mb);
  assert.equal(r.codec, 'avc');
  assert.equal(r.verdict, VERDICT.OK_240);
});

test('120 fps clip is flagged as 120, not 240', async () => {
  const r = await inspectClip(await fixture('true120_hevc.mov'), mb);
  assert.ok(Math.abs(r.timing.fpsFromGap - 120) < 1);
  assert.equal(r.verdict, VERDICT.HFR_120);
});

test('baked 30 fps slow-motion render is rejected', async () => {
  const r = await inspectClip(await fixture('baked30_h264.mp4'), mb);
  assert.ok(Math.abs(r.timing.fpsFromGap - 30) < 0.5);
  assert.ok(r.timing.duration > 20, 'render is time-stretched');
  assert.equal(r.verdict, VERDICT.RENDERED);
});

test('summarizePackets detects reordering, irregular gaps and GOP', () => {
  const g = 1 / 240;
  const pk = [0, 2, 1, 3, 4, 5].map((i, k) => ({ ts: i * g, dur: g, key: k === 0 || k === 4, seq: k }));
  pk.push({ ts: 9 * g, dur: g, key: false, seq: 6 }); // a 4-frame hole
  const s = summarizePackets(pk);
  assert.equal(s.hasReordering, true);
  assert.equal(s.irregularGaps, 1);
  assert.equal(s.keyframes, 2);
  assert.equal(s.maxGop, 4);
  assert.ok(Math.abs(s.fpsFromGap - 240) < 1e-6);
});

test('verdict thresholds', () => {
  assert.equal(verdictFor(239.02), VERDICT.OK_240);
  assert.equal(verdictFor(119.9), VERDICT.HFR_120);
  assert.equal(verdictFor(59.94), VERDICT.RENDERED);
  assert.equal(verdictFor(30), VERDICT.RENDERED);
});
