import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createListener, freelapBytes, readRep, nativeBle } from '../js/freelap/listen.js';

// Scan results as the iPhone plugin delivers them: company ID in decimal, the rest as spaced hex.
// The bytes are Stanley's real captures from 2026-11-13 (tests/freelap.test.mjs).
const ios = hex => ({ device: { deviceId: 'x', name: 'FreeLap BGM' }, rssi: -60, manufacturerData: { 867: hex.replace(/\s/g, '').replace(/../g, '$& ').toLowerCase() } });
const MISKA = ios('58 00 4244 1D10 24BF0400 24BF0400 F3DA0400 000DA1D23011 E5C60400 00000000');
const STANLEY = ios('58 00 4241 A620 1E1A1200 1E1A1200 83291200 000DA1D23311 00000000');
const APPLE = { manufacturerData: { 76: '02 15 aa bb' } };

function fakeBle() {
  const calls = [];
  let cb = null;
  return {
    calls,
    emit: r => cb?.(r),
    initialize: async () => calls.push('init'),
    start: async o => calls.push(['start', o]),
    stop: async () => calls.push('stop'),
    onResult: async f => { cb = f; return { remove() {} }; },
  };
}

test('freelap listen: iOS manufacturer data reads as the chip frame', () => {
  const r = readRep(freelapBytes(MISKA), 1);
  assert.equal(r.chip, 'BD-4125');
  assert.equal(r.who, 'miska');
  assert.equal(r.lap, 6.95);
  assert.deepEqual(r.legs, [1.94, 5.01]);
  assert.equal(freelapBytes(APPLE), null);
});

test('freelap listen: Start takes runs in once each, Stop takes nothing', async () => {
  const ble = fakeBle(), reps = [], states = [];
  let packets = 0;
  const l = createListener(ble, { rep: r => reps.push(r), packet: n => { packets = n; }, state: s => states.push(s) });

  ble.emit(MISKA);                       // before Start: ignored
  assert.equal(reps.length, 0);

  await l.start();
  assert.equal(l.state, 'on');
  assert.deepEqual(ble.calls, ['init', ['start', { allowDuplicates: true }]]);
  for (let i = 0; i < 20; i++) ble.emit(MISKA);   // the chip repeats ~8 times a second
  ble.emit(APPLE);
  ble.emit(STANLEY);
  assert.deepEqual(reps.map(r => [r.who, r.lap]), [['miska', 6.95], ['stanley', 3.85]]);
  assert.equal(packets, 21);

  await l.stop();
  assert.equal(l.state, 'off');
  ble.emit(ios('58 00 4241 A620 E3901300 E3901300 ACAB1300 000DA1D23311 D9991300 00000000'));
  assert.equal(reps.length, 2);          // after Stop: nothing

  await l.start();                       // a second Start doesn't initialise again
  assert.deepEqual(ble.calls.filter(c => c === 'init'), ['init']);
  ble.emit(MISKA);                       // already kept
  assert.equal(reps.length, 2);
  assert.deepEqual(states, ['starting', 'on', 'off', 'starting', 'on']);
});

test('freelap listen: a run kept before is not added again', async () => {
  const ble = fakeBle(), reps = [];
  const key = readRep(freelapBytes(MISKA)).key;
  const l = createListener(ble, { rep: r => reps.push(r) }, new Set([key]));
  await l.start();
  ble.emit(MISKA);
  assert.equal(reps.length, 0);
});

test('freelap listen: Bluetooth off is reported, not thrown', async () => {
  const ble = { ...fakeBle(), initialize: async () => { throw new Error('Bluetooth not enabled'); } };
  let err = null;
  const l = createListener(ble, { state: (s, e) => { err = e; } });
  await l.start();
  assert.equal(l.state, 'off');
  assert.equal(err, 'Bluetooth not enabled');
});

test('freelap listen: Bluetooth switched off stops Start', async () => {
  const ble = { ...fakeBle(), isEnabled: async () => false };
  let err = null;
  const l = createListener(ble, { state: (s, e) => { err = e; } });
  await l.start();
  assert.equal(l.state, 'off');
  assert.equal(err, 'BLE powered off');
});

test('freelap listen: no Bluetooth outside the iPhone app', async () => {
  assert.equal(nativeBle(undefined), null);
  assert.equal(nativeBle({ isNativePlatform: () => false }), null);
  const l = createListener(null);
  assert.equal(l.state, 'none');
  await l.start();
  assert.equal(l.state, 'none');
});
