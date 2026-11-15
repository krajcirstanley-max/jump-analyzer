// Advice under a sprint (js/analysis/sprint-advice.js): how it looks, how it should, one external cue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprintAdvice, SPRINT_CUES } from '../js/analysis/sprint-advice.js';
import { stepLooks } from '../js/analysis/sprint.js';

const leg = (time, stepLength, freq) => ({ time, speed: 10 / time, stepLength, freq, steps: 4 });
const steps = (k, contact) => Array.from({ length: 4 }, (_, i) => ({ foot: i % 2 ? 'l' : 'r', leg: k, contact, flight: 0.12, step: contact + 0.12 }));
const fly = (L, extra = {}) => ({ kind: 'fly', distance: 20, legs: L.map(l => l.time), legStats: L, steps: [...steps(0, 0.1), ...steps(1, 0.1)], freq: 4.5, contact: 0.1, flight: 0.12, sides: { l: { n: 4, contact: 0.1, flight: 0.12 }, r: { n: 4, contact: 0.1, flight: 0.12 } }, ...extra });

test('shorter steps at a quicker rate in the slower 10 at top speed: hit down, not push back', () => {
  const a = fly([leg(1.01, 2.25, 4.39), leg(1.04, 2.08, 4.62)], { looks: { all: { aheadCm: 36 }, legs: [{ aheadCm: 31 }, { aheadCm: 39 }] } });
  const adv = sprintAdvice(a);
  assert.equal(adv.fix.cue, SPRINT_CUES.bag.cue);
  assert.equal(SPRINT_CUES.bag.phase, 'maxv');
  assert.ok(!/dozadu/.test(adv.fix.should), 'no push-back at top speed: the force there is vertical');
  assert.match(adv.fix.looks, /2\. desiatke nohy točia rýchlejšie \(4,62 kroku\/s\) a krok je kratší \(2,08 m\), chodidlo dopadá 39 cm pred bokmi \(v 1\. desiatke 31 cm\)/);
  assert.match(adv.fix.should, /Ako v 1\. desiatke: krok 2,25 m z úderu dole do zeme pod bokmi/);
  assert.match(adv.take, /Letmých 20 m za 2,05 s/);
  assert.ok(!/vysoké koleno|toč nohami/.test(JSON.stringify(adv)), 'no joint cues');
});

test('a longer contact in the slower 10: hot sand', () => {
  const a = fly([leg(1.0, 2.2, 4.55), leg(1.04, 2.18, 4.4)]);
  a.steps = [...steps(0, 0.098), ...steps(1, 0.112)];
  assert.equal(sprintAdvice(a).fix.cue, SPRINT_CUES.hot.cue);
});

test('an even run: no fix, said so; left and right noted only when they differ', () => {
  const a = fly([leg(1.02, 2.2, 4.45), leg(1.03, 2.19, 4.43)]);
  const adv = sprintAdvice(a);
  assert.equal(adv.fix, null);
  assert.match(adv.strength, /Ľavá a pravá rovnako/);
  a.sides.r.flight = 0.14;
  const adv2 = sprintAdvice(a, { others: [{ flightLR: 0.02 }, { flightLR: 0.018 }] });
  assert.match(adv2.then[0].title, /Po pravej letíš o 0,02 s dlhšie/);
  assert.match(adv2.then[0].body, /2 predošlých behoch/);
});

test('a standing start slower than the best 0-10 m: the first steps push back', () => {
  const a = { kind: 'accel', distance: 20, legs: [1.99, 1.3], legStats: [{ time: 1.99, speed: 5, steps: 7.5, stepLength: 1.33 }, { time: 1.3, speed: 7.7, steps: 5.3, stepLength: 1.88 }], steps: steps(0, 0.15), contactFrom: 0.19, contactTo: 0.13, sides: {} };
  const adv = sprintAdvice(a, { bestFirst10: 1.94 });
  assert.equal(adv.fix.cue, SPRINT_CUES.push.cue);
  assert.match(adv.fix.looks, /0–10 m za 1,99 s, tvoj najlepší je 1,94 s/);
  assert.match(adv.strength, /Kontakt sa skracuje/);
});

test('the foot against the hips is read only from the side', () => {
  // keypoints: 21 x (x, y, score); a side-on stance: foot from about 60 px ahead of the hips to 60 behind
  const kp = (hipX, footX) => { const k = new Float32Array(63).fill(NaN); const set = (i, x, y) => { k[i * 3] = x; k[i * 3 + 1] = y; k[i * 3 + 2] = 1; };
    set(3, hipX + 5, 100); set(4, hipX + 8, 100); set(9, hipX, 200); set(10, hipX + 3, 200); set(11, hipX + 20, 260); set(12, hipX - 10, 255); set(13, footX, 330); set(14, hipX - 40, 300);
    set(15, footX - 8, 332); set(17, footX + 12, 332); set(16, hipX - 48, 302); set(18, hipX - 30, 302); return k; };
  const side = stepLooks(kp(100, 160), kp(100, 40), 10, 22, null);   // 120 px sweep on a 100 px torso
  assert.ok(side && side.aheadShare > 0.42 && side.aheadShare < 0.55, JSON.stringify(side));
  const front = stepLooks(kp(100, 104), kp(100, 98), 10, 22, null);   // the foot barely moves across: seen from the front
  assert.equal(front, null);
});

const accel = (looks, extra = {}) => ({ kind: 'accel', distance: 20, legs: [1.95, 1.3], legStats: [{ time: 1.95, speed: 5.1, steps: 7.5, stepLength: 1.33 }, { time: 1.3, speed: 7.7, steps: 5.3, stepLength: 1.88 }], steps: steps(0, 0.15), contactFrom: 0.19, contactTo: 0.17, sides: {}, looks, ...extra });

test('a standing start stepping out in front of the knee: push back, said from the shin', () => {
  const adv = sprintAdvice(accel({ legs: [{ n: 4, shin: 7.6, trunk: 38 }, { n: 3, shin: 4, trunk: 22 }] }));
  assert.equal(adv.fix.cue, SPRINT_CUES.push.cue);
  assert.match(adv.fix.looks, /chodidlo dopadá pred kolenom: holeň je pri dopade 8° dozadu/);
});

test('upright already in the first 10 m: rise like a plane taking off (transition)', () => {
  const adv = sprintAdvice(accel({ legs: [{ n: 4, shin: -6, trunk: 19 }, { n: 3, shin: 2, trunk: 12 }] }), { bestFirst10: 1.9 });
  assert.equal(adv.fix.cue, SPRINT_CUES.plane.cue);
  assert.match(adv.fix.looks, /^0–10 m za 1,95 s, tvoj najlepší je 1,90 s\. V 0–10 m je telo už skoro vzpriamené: trup 19° v predklone, v 10–20 m 12°\.$/);
});

test('a gradual rise is the strong point; without side views the advice falls back to the times', () => {
  const adv = sprintAdvice(accel({ legs: [{ n: 4, shin: -8, trunk: 41 }, { n: 3, shin: 1, trunk: 24 }] }));
  assert.equal(adv.fix, null);
  assert.match(adv.strength, /Postupné vzpriamenie: trup 41° v 0–10 m, 24° v 10–20 m/);
  const blind = sprintAdvice(accel(null), { bestFirst10: 1.9 });
  assert.equal(blind.fix.cue, SPRINT_CUES.push.cue);
  assert.match(blind.fix.looks, /^0–10 m za 1,95 s, tvoj najlepší je 1,90 s\. Na 10 m 7,5 kroku\.$/);
});

test('every cue is an image or an outside target, never a joint', () => {
  for (const c of Object.values(SPRINT_CUES)) assert.ok(!/koleno|kolená|členok|bok|nohami|stehno/.test(c.cue), c.cue);
});

