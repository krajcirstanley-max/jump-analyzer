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
