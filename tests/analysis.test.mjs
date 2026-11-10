import { test } from 'node:test';
import assert from 'node:assert/strict';
import { J, JI } from '../js/pose/models.js';
import { detectContacts, keyFrames } from '../js/analysis/events.js';
import { measure, viewYaw } from '../js/analysis/metrics.js';
import { angle3, centreOfMass } from '../js/analysis/kinematics.js';

const K = J.length, FPS = 120, PX = 200; // 200 px per metre

// Synthetic side-on long jumper running to the right, camera following (hips stay
// near the centre of the image, the ground slides left). Known ground truth:
// four approach contacts, a takeoff contact, a flight, a landing.
function jumper({ panRight = 9, tilt = 0, penDrop = 0 } = {}) {
  const v = 9.5 / FPS;                       // m per frame
  const plan = [];                            // [foot, td, to]
  let t = 20;
  const steps = [[0.12, 0.13], [0.12, 0.13], [0.12, 0.12], [0.13, 0.075], [0.14, null]];
  steps.forEach(([c, f], k) => {
    const td = t, to = t + Math.round(c * FPS) - 1;
    plan.push([k % 2 ? 'r' : 'l', td, to]);
    t = to + 1 + (f == null ? 0 : Math.round(f * FPS));
  });
  const [, TD, TO] = plan.at(-1);
  const flightEnd = TO + Math.round(0.8 * FPS), N = flightEnd + 30;
  const frames = [];
  for (let i = 0; i < N; i++) {
    const hipX = i * v;                       // world metres
    let hipH = 0.95;
    if (penDrop) { // hips lower through the penultimate stance, easing in and out over 6 frames
      const [, a, b] = plan.at(-2);
      hipH -= penDrop * Math.min(1, Math.max(0, Math.min(i - a + 6, b + 6 - i) / 6));
    }
    if (i > TO) { const s = (i - TO) / FPS; hipH = Math.max(0.55, 0.95 + 3.3 * s - 4.905 * s * s); }
    const stance = plan.find(([, a, b]) => i >= a && i <= b);
    // Planted 0.35 m ahead of the hip at touchdown; between contacts the foot travels
    // on a smooth arc, landing with downward speed and leaving with upward speed.
    const plantX = c => c[1] * v + 0.35;
    const foot = (side) => {
      if (stance && stance[0] === side) return [plantX(stance), 0];
      const prev = [...plan].reverse().find(([f, , b]) => f === side && b < i);
      const next = plan.find(([f, a]) => f === side && a > i);
      if (prev && next) {
        // Like real footage (IMG_2674): the foot travels forward at about hip speed until
        // it strikes, then stops within a frame or two - no easing to a stop.
        const u = (i - prev[2]) / (next[1] - prev[2]);
        const x0 = plantX(prev), x1 = plantX(next);
        return [x0 + (x1 - x0) * u, 0.3 * Math.sin(Math.PI * u)];
      }
      if (prev) { // after its last contact: swings through faster than the hips into the flight
        const s = (i - prev[2]) / FPS, x0 = plantX(prev);
        return [x0 + 14 * s, Math.min(hipH - 0.6, 2.5 * s)];
      }
      const dur = 30, u = Math.max(0, 1 - (next[1] - i) / dur); // first swing, arriving at its first contact
      return [plantX(next) - 1.2 * (1 - u), 0.3 * Math.sin(Math.PI * u)];
    };
    const f = new Float32Array(K * 3);
    const cam = hipX * PX - 540 + (i * panRight) * 0; // camera follows the hips exactly
    const toImg = (x, h) => [x * PX - cam, 1200 - h * PX - tilt * i];
    const set = (name, x, h) => { const [X, Y] = toImg(x, h); f[JI[name] * 3] = X; f[JI[name] * 3 + 1] = Y; f[JI[name] * 3 + 2] = 1; };
    for (const s of ['l', 'r']) {
      const [fx, fh] = foot(s);
      const hx = hipX, hh = hipH;
      let kx = (hx + fx) / 2 + 0.08, kh = (hh + fh) / 2 + 0.05;
      if (penDrop && stance && stance[0] === s) { // a rigid 0.45 + 0.45 m leg, so lowering bends the knee
        const ax = fx, ah = fh + 0.08, d = Math.hypot(hx - ax, hh - ah), off = Math.sqrt(Math.max(0, 0.45 ** 2 - (d / 2) ** 2));
        kx = (hx + ax) / 2 + off * (hh - ah) / d; kh = (hh + ah) / 2 + off * (ax - hx) / d;
      }
      set(s + 'hip', hx + (s === 'l' ? 0.01 : -0.01), hh);
      set(s + 'knee', kx, kh); set(s + 'ank', fx, fh + 0.08);
      set(s + 'heel', fx - 0.06, fh + 0.02); set(s + 'bigtoe', fx + 0.17, fh); set(s + 'smalltoe', fx + 0.15, fh);
      set(s + 'sho', hx + 0.03, hh + 0.5); set(s + 'elb', hx, hh + 0.25); set(s + 'wri', hx + 0.1, hh + 0.1);
      set(s + 'ear', hx + 0.05, hh + 0.72);
    }
    set('nose', hipX + 0.12, hipH + 0.7);
    frames.push(f);
  }
  return { frames, plan, TD, TO, N };
}

test('finds every contact and labels the last steps, takeoff and flight', () => {
  const { frames, plan, TD, TO, N } = jumper();
  const contacts = detectContacts(frames, 0, N - 1, FPS);
  const ev = keyFrames(frames, contacts, FPS);
  assert.ok(!ev.error, ev.error);
  assert.ok(Math.abs(ev.takeoff.td - TD) <= 1, `takeoff TD ${ev.takeoff.td} vs ${TD}`);
  assert.ok(Math.abs(ev.takeoff.to - TO) <= 1, `takeoff TO ${ev.takeoff.to} vs ${TO}`);
  const [, ptd, pto] = plan.at(-2);
  assert.ok(Math.abs(ev.pen.td - ptd) <= 1 && Math.abs(ev.pen.to - pto) <= 1, `pen ${ev.pen.td}-${ev.pen.to} vs ${ptd}-${pto}`);
  const apex = ev.keyFrames.find(k => k.id === 'apex').frame;
  assert.ok(Math.abs(apex - (TO + Math.round((3.3 / 9.81) * FPS))) <= 3, `apex ${apex}`);
});

test('a camera that drifts vertically does not break the detection', () => {
  const { frames, TD, TO, N } = jumper({ tilt: 0.8 });
  const ev = keyFrames(frames, detectContacts(frames, 0, N - 1, FPS), FPS);
  assert.ok(Math.abs(ev.takeoff.td - TD) <= 1 && Math.abs(ev.takeoff.to - TO) <= 1);
});

test('angle definitions on known geometry', () => {
  // Knee bent to 90 degrees.
  assert.ok(Math.abs(angle3([0, 0], [0, 10], [10, 10]) - 90) < 1e-9);
  // Leg planted 60 degrees to the ground in front of the hip, running right.
  const kp = new Float32Array(K * 3).fill(1);
  const set = (n, x, y) => { kp[JI[n] * 3] = x; kp[JI[n] * 3 + 1] = y; kp[JI[n] * 3 + 2] = 1; };
  for (const s of ['l', 'r']) { set(s + 'sho', 500, 500); set(s + 'hip', 500 + (s === 'l' ? 2 : -2), 800); }
  set('lknee', 550, 950); set('lank', 500 + 400 * Math.cos(Math.PI / 3), 800 + 400 * Math.sin(Math.PI / 3));
  set('rknee', 480, 950); set('rank', 470, 1100);
  for (const s of ['l', 'r']) { set(s + 'heel', kp[JI[s + 'ank'] * 3] - 10, kp[JI[s + 'ank'] * 3 + 1] + 10); set(s + 'bigtoe', kp[JI[s + 'ank'] * 3] + 40, kp[JI[s + 'ank'] * 3 + 1] + 15); }
  for (const s of ['l', 'r']) { set(s + 'elb', 500, 650); set(s + 'wri', 520, 750); set(s + 'ear', 505, 400); }
  set('nose', 520, 410);
  assert.ok(viewYaw(kp) < 5, 'side-on');
  assert.ok(centreOfMass(kp));
  const ev = { takeoff: { td: 0, to: 0 }, takeoffFoot: 'l', keyFrames: [] };
  const m = measure([kp], ev, FPS, 'male', 1);
  const leg = m.find(x => x.key === 'legTD');
  assert.ok(Math.abs(leg.value - 60) < 0.5, `leg ${leg.value}`);
  assert.ok(Math.abs(m.find(x => x.key === 'trunkTD').value) < 0.5);
});

test('angles are withheld when filmed head-on, timing is not', () => {
  const kp = new Float32Array(K * 3);
  const set = (n, x, y) => { kp[JI[n] * 3] = x; kp[JI[n] * 3 + 1] = y; kp[JI[n] * 3 + 2] = 1; };
  set('lsho', 600, 500); set('rsho', 400, 500); set('lhip', 605, 800); set('rhip', 395, 800);
  for (const s of ['l', 'r']) { const x = s === 'l' ? 605 : 395; set(s + 'knee', x, 950); set(s + 'ank', x, 1100); set(s + 'heel', x, 1110); set(s + 'bigtoe', x, 1120); set(s + 'elb', x, 650); set(s + 'wri', x, 750); set(s + 'ear', x - 20, 400); }
  set('nose', 500, 410);
  assert.ok(viewYaw(kp) > 60, 'head-on');
  const ev = { takeoff: { td: 0, to: 17 }, takeoffFoot: 'l', keyFrames: [] };
  const m = measure(Array(18).fill(kp), ev, FPS, 'male', 1);
  assert.equal(m.find(x => x.key === 'kneeTD').status, 'hidden');
  assert.notEqual(m.find(x => x.key === 'contactTO').status, 'hidden');
});

import { fitParabola, flightAnalysis } from '../js/analysis/flight.js';
import { flightMetrics } from '../js/analysis/metrics.js';
import { techniqueScore, metricScore } from '../js/analysis/coach.js';

test('parabola fit recovers gravity', () => {
  const t = Array.from({ length: 80 }, (_, i) => i / 120);
  const y = t.map(s => 500 - 3.3 * 200 * s + 0.5 * 9.81 * 200 * s * s);
  const f = fitParabola(t, y);
  assert.ok(Math.abs((2 * f.a) / 9.81 - 200) < 0.01 && f.rms < 1e-6);
});

test('speeds, takeoff angle and scale from a panning camera (synthetic jumper)', () => {
  const { frames, N } = jumper({ tilt: 0 });
  const contacts = detectContacts(frames, 0, N - 1, FPS);
  const ev = keyFrames(frames, contacts, FPS);
  const ts = frames.map((_, i) => i / FPS);
  const f = flightAnalysis(frames, ev, ts, 'male', contacts[0].dir);
  assert.ok(!f.error, f.error);
  assert.ok(Math.abs(f.pxPerM / 200 - 1) < 0.03, `scale ${f.pxPerM}`);
  assert.ok(Math.abs(f.vyTO - 3.3) < 0.2, `vy ${f.vyTO}`);
  // Truth: the synthetic body's own centre of mass in world coordinates (the camera
  // follows the hips, so world x = image x + i·v·PX), not the hip speed - during the
  // contact the planted leg lags, so the whole body moves slower than the hips.
  const v = 9.5 / FPS, T = ev.takeoff;
  const worldX = i => centreOfMass(frames[i])[0] + i * v * PX;
  const vxTrue = ((worldX(T.to - 1) - worldX(T.to - 4)) / 3) * FPS / PX;
  assert.ok(Math.abs(f.vxTO / vxTrue - 1) < 0.03, `vx ${f.vxTO} vs ${vxTrue}`); // scale is good to ~3%
  const angleTrue = Math.atan2(3.3, vxTrue) * 180 / Math.PI;
  assert.ok(Math.abs(f.takeoffAngle - angleTrue) < 1.5, `angle ${f.takeoffAngle} vs ${angleTrue}`);
});

test('score is 100 inside the norms and falls off outside', () => {
  assert.equal(metricScore({ value: 120, norm: [110, 130] }), 100);
  assert.ok(metricScore({ value: 150, norm: [110, 130] }) < 60);
  const s = techniqueScore([{ key: 'contactTO', value: 120, norm: [110, 130], status: 'ok' }]);
  assert.equal(Math.round(s.score), 100);
});

import { existsSync, readFileSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { NORMS, scoreMetric } from '../js/analysis/metrics.js';
import { PHASES } from '../js/analysis/coach.js';

const hipsOnly = (kp, set) => {
  for (const s of ['l', 'r']) { set(s + 'hip', 500 + (s === 'l' ? 2 : -2), 800); set(s + 'sho', 500, 500); set(s + 'ank', 500, 1100); set(s + 'knee', 505, 950); set(s + 'heel', 490, 1110); set(s + 'bigtoe', 540, 1115); set(s + 'elb', 500, 650); set(s + 'wri', 520, 750); set(s + 'ear', 505, 400); }
  set('nose', 520, 410);
  return kp;
};
const frame = () => { const kp = new Float32Array(K * 3); const set = (n, x, y) => { kp[JI[n] * 3] = x; kp[JI[n] * 3 + 1] = y; kp[JI[n] * 3 + 2] = 1; }; return [hipsOnly(kp, set), set]; };

test('kneeDrive: free thigh measured forward of hanging straight down', () => {
  const [kp, set] = frame();
  set('rknee', 498 + 150, 800 + 50); // 150 forward, 50 down: 71.6 degrees
  const ev = { takeoff: { td: 0, to: 0 }, takeoffFoot: 'l', keyFrames: [] };
  const m = measure([kp], ev, FPS, 'male', 1).find(x => x.key === 'kneeDrive');
  assert.ok(Math.abs(m.value - 71.57) < 0.5, `kneeDrive ${m.value}`);
  // Running left, the same thigh pointing left is the forward one.
  const [kl, setL] = frame();
  setL('rknee', 498 - 150, 800 + 50);
  const left = measure([kl], ev, FPS, 'male', -1).find(x => x.key === 'kneeDrive');
  assert.ok(Math.abs(left.value - 71.57) < 0.5, `running left ${left.value}`);
});

test('trunkStability: net trunk rotation to the apex; only the trunk counts', () => {
  const track = Array.from({ length: 20 }, () => frame()[0]);
  const lean = (kp, d) => { const r = Math.tan(d * Math.PI / 180) * 300; for (const s of ['l', 'r']) kp[JI[s + 'sho'] * 3] = 500 + r; };
  for (let i = 12; i < 20; i++) lean(track[i], 8);
  // Swinging legs between the two ends (hitch-kick) must not matter.
  for (let i = 3; i < 12; i++) { track[i][JI.rknee * 3] = 500 + i * 30; track[i][JI.lknee * 3] = 500 - i * 30; }
  const ev = { takeoff: { td: 0, to: 2 }, apex: 15, takeoffFoot: 'l', keyFrames: [] };
  const m = measure(track, ev, FPS, 'male', 1).find(x => x.key === 'trunkStability');
  assert.ok(Math.abs(m.value - 8) < 0.5, `trunk ${m.value}`);
  assert.equal(m.frame, 15);
});

test('hip drop, last-stride speed and peak height on a jumper with known truth', () => {
  const ts = jumper({}).frames.map((_, i) => i / FPS);
  const flightOf = penDrop => {
    const { frames, N } = jumper({ penDrop });
    const contacts = detectContacts(frames, 0, N - 1, FPS);
    const ev = keyFrames(frames, contacts, FPS);
    assert.ok(!ev.error, ev.error);
    return { f: flightAnalysis(frames, ev, ts, 'male', contacts[0].dir), ev, frames };
  };
  const { f, ev } = flightOf(0.06);
  assert.ok(f.scaleOk);
  assert.ok(Math.abs(f.hipDrop - 6) < 1, `hipDrop ${f.hipDrop} cm`);
  assert.ok(Math.abs(flightOf(0).f.hipDrop) < 1, 'no lowering reads as none');
  assert.ok(Math.abs(f.peakHeight - (3.3 * 3.3 / (2 * 9.81)) * 100) < 6, `peak ${f.peakHeight}`);
  assert.equal(f.hipDropFrame >= ev.pen.td && f.hipDropFrame <= ev.pen.to, true);
  // Truth as in the takeoff test: the synthetic body's own world CoM, not the hip speed.
  const { frames: pf } = jumper({ penDrop: 0.06 }), v = 9.5 / FPS, P_ = ev.pen;
  const wx = i => centreOfMass(pf[i])[0] + i * v * PX;
  const vTrue = ((wx(P_.to - 2) - wx(P_.td + 2)) / (P_.to - P_.td - 4)) * FPS / PX;
  assert.ok(Math.abs(f.speedLast / vTrue - 1) < 0.03, `speedLast ${f.speedLast} vs ${vTrue}`);
  assert.ok(Math.abs(f.zoomPen - 1) < 0.02, `a camera at constant distance needs no rescale, got ${f.zoomPen}`);
});

test('a metre metric is hidden with a reason when the scale fails', () => {
  const { frames, N } = jumper({ penDrop: 0.06 });
  const contacts = detectContacts(frames, 0, N - 1, FPS);
  const ev = keyFrames(frames, contacts, FPS);
  const f = { ...flightAnalysis(frames, ev, frames.map((_, i) => i / FPS), 'male', contacts[0].dir), scaleOk: false };
  const rows = flightMetrics(f, ev, 'female');
  for (const k of ['hipDrop', 'speedLast', 'speedTO', 'speedLoss']) {
    const m = rows.find(x => x.key === k);
    assert.equal(m.status, 'hidden', k);
    assert.ok(m.reason, k);
  }
  assert.notEqual(rows.find(x => x.key === 'takeoffAngle').status, 'hidden');
  // Rise and vertical speed come from the time to the apex, so a failed scale doesn't hide them...
  for (const k of ['peakHeight', 'vyTO']) assert.notEqual(rows.find(x => x.key === k).status, 'hidden', k);
  // ...but an apex too close to the end of the seen arc does.
  const late = flightMetrics({ ...f, apexOk: false }, ev, 'female').find(x => x.key === 'peakHeight');
  assert.equal(late.status, 'hidden');
  assert.match(late.reason, /vrchol/);
});

test('rise to the apex is g·t²/2 from the time to the apex, whatever the scale', () => {
  const { frames, N } = jumper({});
  const contacts = detectContacts(frames, 0, N - 1, FPS);
  const ev = keyFrames(frames, contacts, FPS);
  const f = flightAnalysis(frames, ev, frames.map((_, i) => i / FPS), 'male', contacts[0].dir);
  assert.ok(f.apexOk);
  assert.ok(Math.abs(f.peakHeight / (100 * 9.81 * f.tUp ** 2 / 2) - 1) < 1e-9);
});

test('norms have Slovak labels and the phases match the contract', () => {
  assert.deepEqual(PHASES.map(p => [p.id, p.weight]), [['pen', 0.2], ['plant', 0.35], ['toeoff', 0.25], ['flight', 0.05], ['landing', 0.15]]);
  for (const k of ['hipDrop', 'peakHeight', 'trunkStability', 'kneeDrive', 'speedLast', 'speedTO']) assert.ok(NORMS[k], k);
  for (const p of PHASES) for (const k of p.keys) assert.ok(NORMS[k], `${p.id}: ${k}`);
  for (const n of Object.values(NORMS)) assert.ok(!/\b(Knee|Takeoff|Flight|Speed|Hip|Trunk|Landing|Leg)\b/.test(n.label), n.label);
});

test('a miss in metres is not forgiven because the unit is small', () => {
  assert.ok(scoreMetric({ value: 7.0, norm: [7.8, 8.6], unit: 'm' }) < 60);
  assert.ok(metricScore({ value: 7.0, norm: [7.8, 8.6] }) > 90, 'the old floor of 10 units forgave it');
  assert.equal(scoreMetric({ value: 8.0, norm: [7.8, 8.6], unit: 'm' }), 100);
});

const real = (name, sex) => {
  const file = new URL(`./fixtures/_real_${name}_pose.json`, import.meta.url);
  if (!existsSync(file)) return null;
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const fix = a => a.map(k => (k ? Float64Array.from(k, v => (v == null ? NaN : v)) : null));
  r.clean = fix(r.clean); r.smooth = fix(r.smooth);
  return analyzeJump(r, sex, r.fps ? undefined : r.clean.map((_, i) => i / 120));
};
const frames = j => Object.fromEntries(j.keyFrames.map(k => [k.id, k.frame]));
const by = j => Object.fromEntries(j.metrics.map(m => [m.key, m]));
const hasReal = n => existsSync(new URL(`./fixtures/_real_${n}_pose.json`, import.meta.url));

test('IMG_2674 (landing visible): key frames, plausible numbers, full result shape', { skip: !hasReal('IMG_2674') }, () => {
  const j = real('IMG_2674', 'male'), m = by(j);
  assert.deepEqual(frames(j), { td3: 678, penTD: 714, penTO: 727, TD: 735, maxFlex: 744, TO: 752, apex: 785, land: 838 });
  assert.ok(j.flight.scaleOk);
  assert.ok(m.speedLast.value > 7 && m.speedLast.value < 10.5, `last ${m.speedLast.value}`);
  assert.ok(m.speedTO.value > 6 && m.speedTO.value < m.speedLast.value, `TO ${m.speedTO.value}`);
  assert.ok(m.peakHeight.value > 25 && m.peakHeight.value < 70, `peak ${m.peakHeight.value}`);
  assert.ok(m.hipDrop.value > -5 && m.hipDrop.value < 15, `drop ${m.hipDrop.value}`);
  assert.ok(m.kneeDrive.value > 50 && m.kneeDrive.value < 100, `drive ${m.kneeDrive.value}`);
  assert.ok(Math.abs(m.trunkStability.value) < 40, `trunk ${m.trunkStability.value}`);
  assert.equal(j.speed.last.key, 'speedLast');
  assert.ok(j.speed.lossPct > 0 && j.speed.lossPct < 30);
  assert.ok(['vysoká', 'stredná', 'nízka'].includes(j.speed.sure) && j.speed.note);
  assert.deepEqual(j.replay, { from: 735 - 120, to: Math.min(880, 838 + 60) });
  // Phases are consecutive and cover from the 3rd-last step to the landing.
  assert.deepEqual(j.phases.map(p => p.id), ['pen', 'plant', 'toeoff', 'flight', 'landing']);
  j.phases.forEach((p, i) => { if (i) assert.equal(p.from, j.phases[i - 1].to + 1, p.id); });
  for (const x of j.metrics) {
    if (x.status === 'hidden') { assert.equal(x.score, null); continue; }
    assert.ok(x.score >= 0 && x.score <= 100, x.key);
    assert.ok(x.target >= x.norm[0] && x.target <= x.norm[1], x.key);
    if (x.status === 'ok') assert.equal(x.target, x.value, x.key);
  }
});

test('IMG_4390 (landing hidden, 0.27 s of flight): metres stay hidden, angles do not', { skip: !hasReal('IMG_4390') }, () => {
  const j = real('IMG_4390', 'female'), m = by(j);
  assert.deepEqual(frames(j), { td3: 421, penTD: 454, penTO: 469, TD: 483, maxFlex: 490, TO: 497, apex: 530 });
  for (const k of ['hipDrop', 'peakHeight', 'speedLast', 'speedTO', 'speedLoss']) assert.equal(m[k].status, 'hidden', k);
  assert.notEqual(m.kneeDrive.status, 'hidden');
  assert.notEqual(m.trunkStability.status, 'hidden');
  assert.equal(j.speed.sure, 'nízka');
  assert.equal(j.replay.to, 536);
  assert.equal(j.phases.find(p => p.id === 'landing').score, null);
});

test('coaching is passed through untouched', { skip: !hasReal('IMG_2674') }, () => {
  const j = real('IMG_2674', 'male');
  assert.ok(Array.isArray(j.coach.fixes) && 'take' in j.coach);
});

test('a run-through (pop-up) keeps the approach and takeoff but has no landing to judge', { skip: !hasReal('IMG_2674') }, () => {
  const file = new URL('./fixtures/_real_IMG_2674_pose.json', import.meta.url);
  const r = JSON.parse(readFileSync(file, 'utf8'));
  const fix = a => a.map(k => (k ? Float64Array.from(k, v => (v == null ? NaN : v)) : null));
  r.clean = fix(r.clean); r.smooth = fix(r.smooth);
  const ts = r.clean.map((_, i) => i / 120);
  const events = { td3: 678, penTD: 714, penTO: 727, TD: 735, TO: 752, landing: 838 };
  const full = analyzeJump({ ...r, events: { ...events, kind: 'jump' } }, 'male', ts);
  const run = analyzeJump({ ...r, events: { ...events, kind: 'runthrough' } }, 'male', ts);
  assert.equal(run.kind, 'runthrough');
  for (const k of ['landingReach', 'kneeLand', 'hipLand', 'estDistance', 'flight']) assert.ok(!by(run)[k], k);
  const land = run.phases.find(p => p.id === 'landing');
  assert.equal(land.score, null);
  assert.match(land.note, /Prebeh/);
  // Everything up to the flight is measured exactly as in the full jump.
  for (const k of ['contactTO', 'kneeTD', 'kneeTO', 'takeoffAngle', 'penKnee']) assert.equal(by(run)[k]?.value, by(full)[k]?.value, k);
  assert.ok(Number.isFinite(run.score.score));
});
