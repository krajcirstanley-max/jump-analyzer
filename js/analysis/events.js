// Foot contacts and the long-jump key frames, from the cleaned keypoint track.
// A foot is on the ground when it sits on the ground line (lowest foot level nearby)
// and has stopped moving vertically. Touchdown is refined to the foot's deceleration
// peak (Handsaker 2016); the jump is the last contact before a long flight.
import { P, has, torsoLength, footLow, centreOfMass, angle3, subFrame, mid } from './kinematics.js';

export const DEFAULTS = {
  groundTol: 0.12,   // foot within this many torso lengths of the ground line
  maxVy: 2.0,        // and moving vertically slower than this many torso lengths per second
  minContact: 0.04,  // s: shorter "contacts" are noise
  envWindow: 0.15,   // s: half-width of the window that defines the local ground line
  jumpFlight: 0.3,   // s: a flight at least this long is the jump
  slideFrac: 0.35,   // planted foot slides back faster than this share of running speed
  minAccel: 1.0,     // vertical refinement only counts a clear acceleration peak
  jumpRise: 0.6,     // torso lengths the centre of mass rises after the takeoff contact
  riseWindow: 0.35,  // s: window after a contact in which that rise is measured
  landFall: 2.0,     // torso lengths/s: feet must be falling at least this fast before landing
};

// Per-foot series over the analysed range: lowest foot point y and torso scale.
function footSeries(track, first, last) {
  const n = last - first + 1;
  const y = { l: new Float64Array(n).fill(NaN), r: new Float64Array(n).fill(NaN) };
  const torso = new Float64Array(n).fill(NaN);
  for (let i = first; i <= last; i++) {
    const kp = track[i];
    if (!kp || !has(kp, 'lsho', 'rsho', 'lhip', 'rhip')) continue;
    torso[i - first] = torsoLength(kp);
    for (const s of ['l', 'r']) { const p = footLow(kp, s); if (p) y[s][i - first] = p[1]; }
  }
  return { y, torso };
}

const deriv = (y, fps) => y.map((v, i) => (i === 0 || i === y.length - 1 ? NaN : ((y[i + 1] - y[i - 1]) * fps) / 2));

// Light smoothing (centred moving average) for derivative signals.
function smoothSeries(y, half) {
  return y.map((_, i) => {
    let s = 0, n = 0;
    for (let j = i - half; j <= i + half; j++) if (j >= 0 && j < y.length && !Number.isNaN(y[j])) { s += y[j]; n++; }
    return n ? s / n : NaN;
  });
}

// Stance from horizontal motion: a planted foot is still in the world, so relative to
// the hips it slides backwards at running speed while the swinging foot moves forwards.
// This survives the camera tilting during the pan, which breaks purely vertical tests.
// Touchdown/toe-off are then refined with the vertical signal where it is clear:
// touchdown = the foot's fall stopping (upward-acceleration peak, Handsaker 2016),
// toe-off = the toe's upward-acceleration peak as it leaves the ground.
export function detectContacts(track, first, last, fps, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const n = last - first + 1;
  const at = (i, name, c) => { const kp = track[i + first]; return kp && has(kp, name) ? P(kp, name)[c] : NaN; };
  const torso = Float64Array.from({ length: n }, (_, i) => {
    const kp = track[i + first];
    return kp && has(kp, 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(kp) : NaN;
  });
  const hipX = Float64Array.from({ length: n }, (_, i) => (at(i, 'lhip', 0) + at(i, 'rhip', 0)) / 2);
  const sig = {};
  for (const s of ['l', 'r']) {
    const fx = Float64Array.from({ length: n }, (_, i) => (at(i, s + 'heel', 0) + at(i, s + 'bigtoe', 0)) / 2);
    const rel = smoothSeries(Float64Array.from(fx, (v, i) => v - hipX[i]), 1);
    const relV = deriv(rel, fps).map((v, i) => v / torso[i]);
    const low = Float64Array.from({ length: n }, (_, i) => Math.max(at(i, s + 'heel', 1), at(i, s + 'bigtoe', 1)));
    const toe = smoothSeries(Float64Array.from({ length: n }, (_, i) => at(i, s + 'bigtoe', 1)), 1);
    const lowS = smoothSeries(low, 1);
    sig[s] = { relV, low, ayLow: deriv(deriv(lowS, fps), fps), ayToe: deriv(deriv(toe, fps), fps) };
  }
  // Direction of travel: the nose points the way the athlete runs (side view). Fallback
  // when the face gives no clear answer: the lower (planted) foot slides opposite to it.
  const face = [];
  for (let i = 0; i < n; i++) {
    const kp = track[i + first];
    if (kp && has(kp, 'nose', 'lear', 'rear')) face.push((P(kp, 'nose')[0] - (P(kp, 'lear')[0] + P(kp, 'rear')[0]) / 2) / torso[i]);
  }
  face.sort((a, b) => a - b);
  const faceMed = face.length ? face[face.length >> 1] : 0;
  const votes = [];
  for (let i = 0; i < n; i++) {
    const s = sig.l.low[i] > sig.r.low[i] ? 'l' : 'r';
    if (!Number.isNaN(sig[s].relV[i])) votes.push(Math.sign(sig[s].relV[i]));
  }
  const dir = Math.abs(faceMed) > 0.05 ? Math.sign(faceMed) : -Math.sign(votes.reduce((a, b) => a + b, 0)) || 1;
  // Running speed scale: typical backward slide of the planted foot (torso lengths/s).
  const slides = [];
  for (const s of ['l', 'r']) sig[s].relV.forEach(v => { if (-v * dir > 0) slides.push(-v * dir); });
  slides.sort((a, b) => a - b);
  const vRun = slides[Math.floor(slides.length * 0.8)] || 1;
  const sideOn = vRun > 3; // head-on footage shows little horizontal slide

  const contacts = [];
  for (const s of ['l', 'r']) {
    const { relV, ayLow, ayToe } = sig[s];
    const other = s === 'l' ? 'r' : 'l';
    const on = i => -relV[i] * dir > o.slideFrac * vRun && !(-sig[other].relV[i] * dir > -relV[i] * dir);
    let i = 0;
    while (i < n) {
      if (!sideOn || !on(i)) { i++; continue; }
      let j = i;
      while (j + 1 < n && on(j + 1)) j++;
      if ((j - i + 1) / fps >= o.minContact) {
        const peak = (ay, lo, hi) => {
          let k = -1, best = -o.minAccel * vRun * fps * torso[Math.min(n - 1, Math.max(0, i))] / 10;
          for (let t = Math.max(1, lo); t <= Math.min(n - 2, hi); t++) if (ay[t] < best) { best = ay[t]; k = t; }
          return k;
        };
        // The slide starts while the foot is still in the air (it swings back before it
        // lands), so touchdown is searched well inside the window: on IMG_2674 the slide
        // began at 703 but the foot only met its shadow at 713-714 (checked at high zoom).
        const reach = Math.max(4, Math.round(0.5 * (j - i)));
        const tdV = peak(ayLow, i - 3, i + reach);
        const toV = peak(ayToe, j - 5, j + 3);
        const td = tdV >= 0 ? tdV : i;
        let to = toV >= 0 ? toV - 1 : j;
        // A toe peak before the touchdown is noise, not a contact of 0 ms (IMG_4676 before the
        // foot-collapse fix: 543-542 on the board); the slide's own end stands instead.
        if (to <= td) to = Math.max(j, td + 1);
        // The trailing leg keeps sliding back after toe-off, so the slide can outlast the
        // contact (IMG_4596: slide to 1019, toe up at 1013). The toe rising well clear of its own
        // level earlier in the stance ends the contact; this only ever shortens it. Within one
        // contact the camera barely tilts, so a local vertical test holds here. The margin is
        // wide because the toe rolls forward through push-off: 0.06 torso cut IMG_2674 by 6 frames.
        const toeY = k => at(k, s + 'bigtoe', 1);
        const base = [];
        for (let k = td + 2; k <= td + Math.floor((to - td) / 2); k++) if (Number.isFinite(toeY(k))) base.push(toeY(k));
        if (base.length >= 3) {
          base.sort((a, b) => a - b);
          const level = base[base.length >> 1], clear = 0.15 * torso[Math.max(0, Math.min(n - 1, td))];
          for (let k = td + Math.ceil(o.minContact * fps); k <= to; k++) {
            if (toeY(k) < level - clear) { to = Math.max(td + 1, k - 1); break; }
          }
        }
        contacts.push({
          foot: s, td: td + first, to: to + first,
          tdAgree: tdV >= 0 && Math.abs(tdV - i) <= 2, toAgree: toV >= 0 && Math.abs(toV - 1 - j) <= 2,
          tdSlide: i + first, toSlide: j + first,
        });
      }
      i = j + 1;
    }
  }
  if (!sideOn) return detectContactsVertical(track, first, last, fps, opts);
  contacts.sort((a, b) => a.td - b.td);
  return contacts.map(c => ({ ...c, dir, contactTime: (c.to - c.td + 1) / fps }));
}

// Fallback for head-on footage: ground line + vertical stillness.
export function detectContactsVertical(track, first, last, fps, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { y, torso } = footSeries(track, first, last);
  const n = last - first + 1;
  const W = Math.max(2, Math.round(o.envWindow * fps));
  const env = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) {
      if (!Number.isNaN(y.l[j])) m = Math.max(m, y.l[j]);
      if (!Number.isNaN(y.r[j])) m = Math.max(m, y.r[j]);
    }
    env[i] = m === -Infinity ? NaN : m;
  }
  const contacts = [];
  for (const s of ['l', 'r']) {
    const vy = deriv(y[s], fps), ay = deriv(vy, fps);
    const on = i => {
      const t = torso[i];
      return !Number.isNaN(y[s][i]) && y[s][i] >= env[i] - o.groundTol * t && Math.abs(vy[i]) < o.maxVy * t;
    };
    let i = 0;
    while (i < n) {
      if (!on(i)) { i++; continue; }
      let j = i;
      while (j + 1 < n && on(j + 1)) j++;
      if ((j - i + 1) / fps >= o.minContact) {
        // Touchdown: strongest upward acceleration (the foot's fall being stopped) near the start.
        let td = i, best = Infinity;
        for (let k = Math.max(1, i - 3); k <= Math.min(j, i + 2); k++) if (ay[k] < best) { best = ay[k]; td = k; }
        contacts.push({ foot: s, td: td + first, to: j + first, tdSub: subFrame(ay, td) + first });
      }
      i = j + 1;
    }
  }
  contacts.sort((a, b) => a.td - b.td);
  // Overlapping same-foot runs split by a 1-frame dropout: merge.
  const merged = [];
  for (const c of contacts) {
    const prev = merged.findLast(m => m.foot === c.foot);
    if (prev && c.td - prev.to <= 2) prev.to = Math.max(prev.to, c.to);
    else merged.push({ ...c });
  }
  return merged.map(c => ({ ...c, contactTime: (c.to - c.td + 1) / fps }));
}

// Key frames named from the video itself (on the server, by Claude looking at the frames)
// replace the detected contacts around the jump. Each forced contact takes its foot from the
// detected contact it overlaps most, else from the lower ankle. Detected "contacts" after
// toe-off are leg swing in the air and are dropped. e: { td3, penTD, penTO, TD, TO, landing }.
export function withEvents(track, contacts, e, fps) {
  if (e?.TD == null || e?.TO == null) return contacts;
  const dir = contacts[0]?.dir ?? 1;
  const overlap = (td, to) => {
    let best = null, most = -1;
    for (const c of contacts) { const o = Math.min(c.to, to) - Math.max(c.td, td); if (o > most) { most = o; best = c; } }
    return most >= 0 ? best : null;
  };
  const lower = i => { const kp = track[i]; return kp && has(kp, 'lank', 'rank') ? (P(kp, 'lank')[1] > P(kp, 'rank')[1] ? 'l' : 'r') : null; };
  const foot = overlap(e.TD, e.TO)?.foot ?? lower(Math.round((e.TD + e.TO) / 2)) ?? 'l';
  const other = foot === 'l' ? 'r' : 'l';
  const make = (f, td, to, tag) => ({ foot: f, td, to, dir, contactTime: (to - td + 1) / fps, forced: tag });
  const forced = [];
  // The third-last contact's toe-off isn't asked for; the detected contact supplies it.
  const t3 = e.td3 != null ? contacts.find(c => Math.abs(c.td - e.td3) <= 4) : null;
  if (t3) forced.push(make(foot, e.td3, t3.to, 'td3'));
  if (e.penTD != null && e.penTO != null) forced.push(make(other, e.penTD, e.penTO, 'pen'));
  forced.push(make(foot, e.TD, e.TO, 'TO'));
  const start = forced[0].td;
  return [...contacts.filter(c => c.to < start - 1), ...forced];
}

// Labels the key frames of the jump. The takeoff is the first contact after which the
// centre of mass rises well above running height (approach steps barely move it);
// "contacts" while the body is airborne are leg swing, not ground, and are dropped.
// Landing is the feet's sharp stop in the sand after the peak of the flight.
export function keyFrames(track, contacts, fps, sex = 'male', opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const N = track.length;
  const com = Array.from({ length: N }, (_, i) => (track[i] ? centreOfMass(track[i], sex) : null));
  const torso = i => (track[i] && has(track[i], 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(track[i]) : NaN);
  const comY = i => com[i]?.[1] ?? NaN;

  // Rise of the centre of mass after a contact, in torso lengths (image y points down).
  // Measured only up to the next contact, so a step before the jump isn't credited
  // with the jump's rise.
  const rise = (c, k) => {
    const next = contacts.slice(k + 1).find(d => d.td > c.to);
    const end = Math.min(N - 1, c.to + Math.round(o.riseWindow * fps), next ? next.td : Infinity);
    let top = Infinity;
    for (let i = c.to + 1; i <= end; i++) if (comY(i) < top) top = comY(i);
    return (comY(c.td) - top) / torso(c.td);
  };
  const ti = o.events ? contacts.findIndex(c => c.forced === 'TO') : contacts.findIndex((c, k) => rise(c, k) >= o.jumpRise);
  if (ti < 0) return { error: 'No takeoff found: the body never rises like a jump.', contacts };
  const takeoff = contacts[ti];
  const approach = contacts.slice(0, ti).filter(c => c.to < takeoff.td);
  const pen = approach.at(-1), third = approach.at(-2);
  const s = takeoff.foot;

  // Max knee flexion of the takeoff leg during the takeoff contact.
  const knee = [];
  for (let i = takeoff.td; i <= takeoff.to; i++) {
    const kp = track[i];
    knee.push(kp && has(kp, s + 'hip', s + 'knee', s + 'ank') ? angle3(P(kp, s + 'hip'), P(kp, s + 'knee'), P(kp, s + 'ank')) : NaN);
  }
  // The free leg crossing the stance knee can make the knee point jump for a frame (IMG_4596:
  // 86° at 1006 between 130° and 141°). A frame more than 10° off the median of its five
  // neighbours is such a jump and can't be the minimum; the others compete as measured.
  const med5 = knee.map((_, k) => {
    const w = knee.slice(Math.max(0, k - 2), k + 3).filter(Number.isFinite).sort((a, b) => a - b);
    return w.length ? w[w.length >> 1] : NaN;
  });
  const real = knee.map((v, k) => (Math.abs(v - med5[k]) <= 10 ? v : NaN));
  let kmin = 0;
  real.forEach((v, k) => { if (v < real[kmin] || Number.isNaN(real[kmin])) kmin = k; });

  // Apex: highest centre of mass in the flight.
  // Before a known landing: after it the athlete gets up, and with the phone tilting the centre
  // of mass can then look higher than in the flight (IMG_4594: "apex" 577, landing 512).
  const searchEnd = Math.min(N - 1, takeoff.to + Math.round(1.2 * fps), o.events?.landing != null ? o.events.landing - 1 : Infinity);
  let apex = null;
  for (let i = takeoff.to + 1; i <= searchEnd; i++) if (!Number.isNaN(comY(i)) && (apex == null || comY(i) < comY(apex))) apex = i;

  // Landing: after the apex, the lowest foot point is falling and then stops sharply
  // (largest upward-acceleration peak of the falling foot) - heels hitting the sand.
  let landing = o.events?.landing ?? null;
  if (landing == null && apex != null) {
    const low = i => { const kp = track[i]; if (!kp) return NaN; const a = footLow(kp, 'l'), b = footLow(kp, 'r'); return Math.max(a?.[1] ?? -Infinity, b?.[1] ?? -Infinity); };
    const ys = [];
    for (let i = apex; i <= Math.min(N - 1, apex + Math.round(0.8 * fps)); i++) ys.push(low(i));
    const v = ys.map((_, k) => (k === 0 || k === ys.length - 1 ? NaN : ((ys[k + 1] - ys[k - 1]) * fps) / 2));
    let best = 0;
    // Not before the centre of mass is back down to its takeoff height: earlier, the feet
    // "stop" when the athlete tucks them up in the air (IMG_4596: 1065 instead of ~1100).
    let back = 0;
    while (back < ys.length && !(comY(apex + back) >= comY(takeoff.to))) back++;
    for (let k = Math.max(2, back); k < ys.length - 2; k++) {
      const stop = v[k - 2] - v[k + 2]; // downward speed lost over 4 frames
      if (v[k - 2] > o.landFall * torso(apex + k) && stop > best) { best = stop; landing = apex + k; }
    }
  }

  // Lowest centre of mass over the last two contacts (penultimate lowering).
  let lowCom = null;
  if (pen) for (let i = pen.td; i <= takeoff.to; i++) if (!Number.isNaN(comY(i)) && (lowCom == null || comY(i) > comY(lowCom))) lowCom = i;

  const kf = [
    third && { id: 'td3', label: '3rd-last touchdown', frame: third.td },
    pen && { id: 'penTD', label: 'Penultimate touchdown', frame: pen.td },
    pen && { id: 'penTO', label: 'Penultimate toe-off', frame: pen.to },
    { id: 'TD', label: 'Takeoff touchdown', frame: takeoff.td },
    { id: 'maxFlex', label: 'Max knee flexion', frame: takeoff.td + kmin, sub: takeoff.td + subFrame(knee, kmin) },
    { id: 'TO', label: 'Toe-off', frame: takeoff.to },
    apex != null && { id: 'apex', label: 'Peak height', frame: apex },
    landing != null && { id: 'land', label: 'Landing', frame: landing },
  ].filter(Boolean);
  return { takeoff, pen, third, approach, landing, apex, lowCom, takeoffFoot: s, keyFrames: kf, contacts, com };
}

export { mid };
