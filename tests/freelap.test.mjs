import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hexBytes, decodeAdvertisement, rep, buildAdvertisement } from '../js/freelap/frame.js';

// Stanley's own captures (nRF Connect on an iPhone, 2026-11-13), bytes after the company ID, with
// the times MyFreelap showed for the same runs. Every one matched to the hundredth.
const REAL = [
  { hex: '58 00 4244 1D10 24BF0400 24BF0400 F3DA0400 000DA1D23011 E5C60400 00000000', chip: 'BD-4125', legs: [1.94, 5.01], lap: 6.95 },
  { hex: '58 00 4241 A620 E3901300 E3901300 ACAB1300 000DA1D23311 D9991300 00000000', chip: 'BA-8358', legs: [2.24, 4.46], lap: 6.70 },
  { hex: '58 00 4241 A620 1E1A1200 1E1A1200 83291200 000DA1D23311 00000000', chip: 'BA-8358', legs: [3.85], lap: 3.85 },
  // flag 08: the two start fields differ, the time counts from the second
  { hex: '58 08 4241 A620 00060E00 08FE0E00 63521000 000DA1D23111 00000000', chip: 'BA-8358', legs: [85.09], lap: 85.09 },
];

for (const r of REAL) {
  test(`freelap real capture: ${r.chip} ${r.lap} s`, () => {
    for (const hex of [r.hex, `0x6303 ${r.hex}`]) {           // with and without the company ID
      const ad = decodeAdvertisement(hexBytes(hex));
      assert.equal(ad.chip, r.chip);
      const out = rep(ad);
      assert.deepEqual(out.legs, r.legs);
      assert.equal(out.lap, r.lap);
    }
  });
}

test('freelap: a built frame reads back the same', () => {
  const t = s => Math.round(s * 1024);
  const ad = decodeAdvertisement(buildAdvertisement({ prefix: 'BD', chipId: 4125, offset: 50000, fromLap: 50000, block: 50000 + t(2.21), laps: [50000 + t(1.10)] }));
  assert.deepEqual(rep(ad).legs, [1.10, 1.11]);
});

test('freelap: strangers are ignored', () => {
  assert.equal(decodeAdvertisement(hexBytes('4c00 0215 aabb')), null);   // an Apple beacon
  assert.equal(decodeAdvertisement(hexBytes('6303 41 00')), null);       // Freelap, not a chip frame
});

test('numbers in the intermediate bytes that are not times give the lap alone (2026-11-15)', async () => {
  const { rep, cleanLegs } = await import('../js/freelap/frame.js');
  // BA-8358 on 2026-11-15: lap 3,58 read as 1867777,16 + -1868514 + 740,42
  const ad = { chip: 'BA-8358', flag: 0, offset: 1, fromLap: 757495, block: 761161, laps: [0x720BC59B, 2971] };
  const r = rep(ad);
  assert.equal(r.lap, 3.58);
  assert.deepEqual(r.legs, [3.58]);
  // a real intermediate still splits the run
  assert.deepEqual(rep({ ...ad, laps: [757495 + 1126] }).legs, [1.1, 2.48]);
  assert.deepEqual(cleanLegs({ lap: 3.58, legs: [1867777.16, -1868514, 740.42] }).legs, [3.58]);
  assert.deepEqual(cleanLegs({ lap: 2.05, legs: [1.01, 1.04] }).legs, [1.01, 1.04]);
});

test('two intermediates (30 m): 3-byte crossings, the first 10 m as on the three runs of 2026-11-15', () => {
  // Miška 13:23, lap 3,42: bytes 24-31 as received, its second crossing set where a 30 m run puts it
  const t = s => Math.round(s * 1024);
  const from = 3184245, fin = 3187742;
  const ad = decodeAdvertisement(buildAdvertisement({ prefix: 'BD', chipId: 4125, offset: from, fromLap: from, block: fin, laps: [from + t(1.15), from + t(2.30)] }));
  const r = rep(ad);
  assert.deepEqual(r.legs, [1.15, 1.15, 1.12]);
  assert.equal(r.lap, 3.42);
  // the frame as it came in: 0f 9b 30 | 87 a3 30 | 00 00 -> first crossing 1,15 s
  const raw = hexBytes('58 00 4244 1D10 75963000 75963000 1EA43000 000DA1D23311 0F9B30 87A330 0000');
  const a2 = decodeAdvertisement(raw);
  assert.equal(Math.round((a2.laps[0] - a2.fromLap) / 10.24) / 100, 1.15);
  // a crossing on the far side of a 24-bit wrap of the chip's clock
  const w = 0x1000000 - t(0.5);
  const ad3 = decodeAdvertisement(buildAdvertisement({ prefix: 'BA', chipId: 8358, offset: w, fromLap: w, block: w + t(2.1), laps: [w + t(1.0)] }));
  assert.deepEqual(rep(ad3).legs, [1, 1.1]);
});

test('a third crossing cut off by the end of the frame marks the run, so its distance is not guessed', async () => {
  const { runMetres } = await import('../js/analysis/sprint.js');
  const t = s => Math.round(s * 1024), from = 500000;
  const fr = buildAdvertisement({ prefix: 'BD', chipId: 4125, offset: from, fromLap: from, block: from + t(4.4), laps: [from + t(1.1), from + t(2.2), from + t(3.3)] });
  const r = rep(decodeAdvertisement(fr.subarray(0, 34)));   // 32 bytes after the company ID, as received
  assert.equal(r.cut, true);
  assert.deepEqual(r.legs, [1.1, 1.1, 2.2]);
  assert.equal(runMetres(r), null);
  assert.equal(rep(decodeAdvertisement(buildAdvertisement({ prefix: 'BD', chipId: 4125, offset: from, fromLap: from, block: from + t(3.3), laps: [from + t(1.1), from + t(2.2)] }))).cut, undefined);
});

// Stanley's nRF Connect captures, 2026-11-15 15:46 and 15:49 (BA-8358), whole frames as iOS gives
// them (49 and 51 bytes after the company ID): 3-byte crossings, three and four legs.
test('real 30 m and 40 m frames: 3-byte crossings, legs that add up to the lap', () => {
  const r3 = rep(decodeAdvertisement(hexBytes('5800 4241 A620 837F 2600 837F 2600 0AA6 2600 000D A1D2 3311 CB88 2658 9426 0000 0000 0000 0000 0000 0000 0000 0000 0000 00')));
  assert.equal(r3.lap, 9.63);
  assert.deepEqual(r3.legs, [2.32, 2.89, 4.42]);
  const r4 = rep(decodeAdvertisement(hexBytes('5800 4241 A620 37C5 2900 37C5 2900 61EA 2900 000D A1D2 3111 47CB 2997 D629 65E1 2900 0000 0000 0000 0000 0000 0000 0000 0000 00')));
  assert.equal(r4.lap, 9.29);
  assert.deepEqual(r4.legs, [1.52, 2.82, 2.7, 2.25]);   // crossings 1,52 · 4,34 · 7,04 · 9,29
  assert.equal(r4.cut, undefined);
  assert.equal(Math.round(r4.legs.reduce((a, b) => a + b, 0) * 100) / 100, r4.lap);
  // an empty frame (chip idle) is no run
  const idle = decodeAdvertisement(hexBytes('5800 0000 0000 0000 0000 0000 0000 0000 0000 0000 A1D2 3111'));
  assert.ok(!idle || !(rep(idle).lap > 0));
});
