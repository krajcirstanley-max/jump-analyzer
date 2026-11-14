// "Ideal" pose at a key frame: the athlete's own skeleton, with the angles that fall outside the
// elite norm moved to the middle of that norm. Same segment lengths, same stance foot on the
// ground, so the difference on screen is only what the norms say should change (Stanley,
// 2026-11-12, after a "you / ideal" replay he saw: "ideal ako vyzerá").
//
// Board touchdown first. Its norms fix the stance leg and the trunk (metrics.js, WA17/WA18,
// Bridgett & Linthorne, Nemtsev): knee angle, leg angle (hip-ankle line against the ground) and
// trunk from vertical. The body lean (centre of mass to heel) follows from those and is reported,
// not set. Nothing without a published norm is changed: the swing leg and the arms ride along
// with the hip and the trunk.
import { P, has, mid, dist, angle3, centreOfMass, sharpen } from './kinematics.js';
import { NORMS, viewYaw, MAX_YAW } from './metrics.js';
import { JI } from '../pose/models.js';

const deg = r => (r * 180) / Math.PI, rad = d => (d * Math.PI) / 180;
const UPPER = ['nose', 'lear', 'rear', 'lsho', 'rsho', 'lelb', 'relb', 'lwri', 'rwri'];
const LEG = ['knee', 'ank', 'heel', 'bigtoe', 'smalltoe'];

const legAngle = (kp, s, dir) => { const h = P(kp, s + 'hip'), a = P(kp, s + 'ank'); return deg(Math.atan2(a[1] - h[1], (a[0] - h[0]) * dir)); };
const trunkAngle = (kp, dir) => {
  const s = mid(P(kp, 'lsho'), P(kp, 'rsho')), h = mid(P(kp, 'lhip'), P(kp, 'rhip'));
  return deg(Math.atan2((s[0] - h[0]) * dir, h[1] - s[1]));
};
const lean = (kp, s, dir, sex) => {
  const c = centreOfMass(kp, sex), f = P(kp, s + 'heel');
  return c && has(kp, s + 'heel') ? deg(Math.atan2((c[0] - f[0]) * dir, f[1] - c[1])) : NaN;
};

// kp: keypoints at the board touchdown (the track the numbers come from). s: stance side 'l'/'r'.
// Returns { kp, items } or null when the view is too far off side-on or points are missing.
// items: [{ key, label, you, ideal, band, set }] where set = the angle was moved.
export function idealTouchdown(kp, { s, dir, sex = 'male', bandOf = null }) {
  if (!kp || !has(kp, s + 'hip', s + 'knee', s + 'ank', 'lsho', 'rsho', 'lhip', 'rhip')) return null;
  if (!(viewYaw(kp) <= MAX_YAW)) return null;
  const g = sex === 'female' ? 'f' : 'm';
  const BD = bandOf ?? (k => NORMS[k][g]);
  const pick = (key, v) => { const [lo, hi] = BD(key); return { band: [lo, hi], ideal: v < lo || v > hi ? (lo + hi) / 2 : v, set: v < lo || v > hi }; };

  const H0 = P(kp, s + 'hip'), K0 = P(kp, s + 'knee'), A = P(kp, s + 'ank');
  const L1 = dist(H0, K0), L2 = dist(K0, A);
  const knee0 = angle3(H0, K0, A), leg0 = legAngle(kp, s, dir), trunk0 = trunkAngle(kp, dir);
  const kn = pick('kneeTD', knee0), lg = pick('legTD', leg0), tr = pick('trunkTD', trunk0);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const side = Math.sign(cross(H0, A, K0)) || 1;
  const free = s === 'l' ? 'r' : 'l';

  const build = (kneeT, legT, trunkT) => {
    // Stance leg: hip from the ankle along the leg angle at the hip-ankle distance the knee angle
    // gives; the knee on the same side of that line as the athlete's own.
    const d = Math.sqrt(L1 * L1 + L2 * L2 - 2 * L1 * L2 * Math.cos(rad(kneeT)));
    const H1 = [A[0] - dir * d * Math.cos(rad(legT)), A[1] - d * Math.sin(rad(legT))];
    const ex = [(A[0] - H1[0]) / d, (A[1] - H1[1]) / d], along = (L1 * L1 - L2 * L2 + d * d) / (2 * d);
    const up = Math.sqrt(Math.max(0, L1 * L1 - along * along)), base = [H1[0] + along * ex[0], H1[1] + along * ex[1]];
    const cand = [-1, 1].map(sg => [base[0] - sg * up * ex[1], base[1] + sg * up * ex[0]]);
    const K1 = cand.find(k => Math.sign(cross(H1, A, k)) === side) ?? cand[0];
    const out = Float32Array.from(kp);
    const set = (n, p) => { out[JI[n] * 3] = p[0]; out[JI[n] * 3 + 1] = p[1]; };
    const dx = H1[0] - H0[0], dy = H1[1] - H0[1];
    // the rest of the body rides with the hip
    for (const n of [free + 'hip', ...LEG.map(p => free + p), ...UPPER]) { out[JI[n] * 3] += dx; out[JI[n] * 3 + 1] += dy; }
    set(s + 'hip', H1); set(s + 'knee', K1);
    // Trunk: everything above the hips turns about the hip centre to the trunk angle.
    const hp = mid(P(out, 'lhip'), P(out, 'rhip')), sh = mid(P(out, 'lsho'), P(out, 'rsho'));
    const v = [sh[0] - hp[0], sh[1] - hp[1]], len = Math.hypot(...v);
    const want = [len * dir * Math.sin(rad(trunkT)), -len * Math.cos(rad(trunkT))];
    const rho = Math.atan2(want[1], want[0]) - Math.atan2(v[1], v[0]), c = Math.cos(rho), sn = Math.sin(rho);
    for (const n of UPPER) { const p = P(out, n), x = p[0] - hp[0], y = p[1] - hp[1]; set(n, [hp[0] + c * x - sn * y, hp[1] + sn * x + c * y]); }
    return out;
  };

  // The body lean (centre of mass behind the heel) has its own norm, and it is the usual fault on
  // our clips (IMG_4676: -19 to -23 against -36 to -26, "too far over the foot"). It has no joint
  // of its own: it follows from the leg angle and the trunk. When it is outside its norm, those two
  // are moved within their own norms, as little as gets the lean to the middle of its band.
  const [ilo, ihi] = BD('inclTD'), imid = (ilo + ihi) / 2;
  let legT = lg.ideal, trunkT = tr.ideal, out = build(kn.ideal, legT, trunkT);
  const l0 = lean(kp, s, dir, sex);
  let l1 = lean(out, s, dir, sex);
  if (Number.isFinite(l1) && (l1 < ilo || l1 > ihi)) {
    const [a0, a1] = BD('legTD'), [b0, b1] = BD('trunkTD');
    let best = null;
    for (let la = a0; la <= a1 + 1e-9; la += 0.5) for (let ta = b0; ta <= b1 + 1e-9; ta += 0.5) {
      const l = lean(build(kn.ideal, la, ta), s, dir, sex);
      if (!Number.isFinite(l)) continue;
      const cost = Math.abs(l - imid) + 0.3 * (Math.abs(la - lg.ideal) + Math.abs(ta - tr.ideal));
      if (!best || cost < best.cost) best = { la, ta, cost };
    }
    if (best) { legT = best.la; trunkT = best.ta; out = build(kn.ideal, legT, trunkT); l1 = lean(out, s, dir, sex); }
  }
  lg.ideal = legT; lg.set = Math.abs(legT - leg0) >= 0.5;
  tr.ideal = trunkT; tr.set = Math.abs(trunkT - trunk0) >= 0.5;

  const items = [
    { key: 'kneeTD', label: 'koleno', you: knee0, ...kn },
    { key: 'legTD', label: 'uhol nohy', you: leg0, ...lg },
    { key: 'trunkTD', label: 'trup', you: trunk0, ...tr },
  ];
  if (Number.isFinite(l0) && Number.isFinite(l1)) items.push({ key: 'inclTD', label: 'náklon tela', you: l0, ideal: l1, band: BD('inclTD'), set: Math.abs(l1 - l0) >= 0.5, derived: true });
  return { kp: out, items };
}

// ---------- the other phases (2026-11-14: "ten ideál by mal byť na každom, čo viem kliknúť") ----------
// Same idea as the touchdown: the athlete's own skeleton, only the angles outside a published
// norm moved to the nearest edge of it, the foot on the ground staying where it is. Changing
// one angle moves the others (Stanley: "keď zmeníš jednu vec v skoku, zmenia sa aj ostatné"),
// so the derived ones (hip, lean) are solved for, not set: the smallest change of the free
// parameters that brings every norm in.
const ALL = Object.keys(JI);
const cp = kp => Float32Array.from(kp);
const put = (o, n, p) => { o[JI[n] * 3] = p[0]; o[JI[n] * 3 + 1] = p[1]; };
const shift = (o, names, dx, dy) => { for (const n of names) { o[JI[n] * 3] += dx; o[JI[n] * 3 + 1] += dy; } };
const turn = (o, names, c, rho) => {
  const C = Math.cos(rho), S = Math.sin(rho);
  for (const n of names) { const p = P(o, n), x = p[0] - c[0], y = p[1] - c[1]; put(o, n, [c[0] + C * x - S * y, c[1] + S * x + C * y]); }
};
const kneeOf = (o, s) => angle3(P(o, s + 'hip'), P(o, s + 'knee'), P(o, s + 'ank'));
const hipOf = (o, s, dir) => {
  const sh = P(o, s + 'sho'), h = P(o, s + 'hip'), k = P(o, s + 'knee'), a = angle3(sh, h, k);
  const cr = (sh[0] - h[0]) * (k[1] - h[1]) - (sh[1] - h[1]) * (k[0] - h[0]);
  return cr * dir < 0 ? 360 - a : a;
};
const driveOf = (o, s, dir) => { const h = P(o, s + 'hip'), k = P(o, s + 'knee'); return deg(Math.atan2((k[0] - h[0]) * dir, k[1] - h[1])); };
const inclOf = (o, s, dir, sex, point) => { const c = centreOfMass(o, sex), f = P(o, s + point); return c ? deg(Math.atan2((c[0] - f[0]) * dir, f[1] - c[1])) : NaN; };
const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
const outside = (v, [lo, hi]) => (!Number.isFinite(v) ? 0 : v < lo ? lo - v : v > hi ? v - hi : 0);
// Turns a joint chain about a centre until fn(o) reads the target: a 1° scan over ±90°, then a
// fine one around the best. Robust where the angle is not linear in the turn.
function solveTurn(o, names, centre, fn, target) {
  const v0 = fn(o);
  if (!Number.isFinite(v0) || Math.abs(v0 - target) < 0.05) return o;
  const c = typeof centre === 'function' ? centre(o) : centre;
  const at = d => { const t = cp(o); turn(t, names, c, rad(d)); return t; };
  const err = d => { const e = fn(at(d)) - target; return Number.isFinite(e) ? Math.abs(e) : Infinity; };
  // An unsigned angle (the knee) reads the same target on both sides of straight: the smaller turn
  // wins, or a 10° bend became a 64° flip of the thigh through the straight leg.
  const cost = d => err(d) + 0.02 * Math.abs(d);
  let bd = 0, be = cost(0);
  for (let d = -90; d <= 90; d += 1) { const e = cost(d); if (e < be) { be = e; bd = d; } }
  for (let d = bd - 1; d <= bd + 1 + 1e-9; d += 0.05) { const e = cost(d); if (e < be) { be = e; bd = d; } }
  return bd === 0 ? o : at(bd);
}
// Stance knee to a target with the foot fixed: the hip turns about the knee, the rest of the body rides with the hip.
function setKnee(o, s, target) {
  const free = s === 'l' ? 'r' : 'l', H0 = P(o, s + 'hip');
  const t = solveTurn(o, [s + 'hip'], P(o, s + 'knee'), q => kneeOf(q, s), target);
  const H1 = P(t, s + 'hip');
  shift(t, [free + 'hip', ...LEG.map(n => free + n), ...UPPER], H1[0] - H0[0], H1[1] - H0[1]);
  return t;
}
const hipCentre = o => mid(P(o, 'lhip'), P(o, 'rhip'));
const setTrunk = (o, dir, target) => solveTurn(o, UPPER, hipCentre, q => trunkAngle(q, dir), target);
const setHip = (o, s, dir, target) => solveTurn(o, UPPER, hipCentre, q => hipOf(q, s, dir), target);
const setDrive = (o, free, dir, target) => solveTurn(o, LEG.map(n => free + n), P(o, free + 'hip'), q => driveOf(q, free, dir), target);

const item = (key, label, you, ideal, band, derived = false) => ({ key, label, you, ideal, band, set: Math.abs(ideal - you) >= 0.5, ...(derived ? { derived } : {}) });

// Toe-off: knee, trunk and free-thigh drive have their own norms; the hip angle and the lean over
// the toe follow from the stance leg's slope, so the whole body is turned about the toe (and the
// knee nudged inside its band) until those two are in as well.
export function idealToeoff(kp, { s, dir, sex = 'male', bandOf = null }) {
  const free = s === 'l' ? 'r' : 'l', g = sex === 'female' ? 'f' : 'm';
  if (!kp || !has(kp, s + 'hip', s + 'knee', s + 'ank', s + 'bigtoe', s + 'sho', 'lsho', 'rsho', 'lhip', 'rhip')) return null;
  if (!(viewYaw(kp) <= MAX_YAW)) return null;
  const B = bandOf ?? (k => NORMS[k][g]);
  const k0 = kneeOf(kp, s), t0 = trunkAngle(kp, dir), h0 = hipOf(kp, s, dir), i0 = inclOf(kp, s, dir, sex, 'bigtoe');
  const hasFree = has(kp, free + 'hip', free + 'knee');
  const f0 = hasFree ? driveOf(kp, free, dir) : NaN;
  const kT = clampTo(k0, B('kneeTO')), tT = clampTo(t0, B('trunkTO')), fT = hasFree ? clampTo(f0, B('kneeDrive')) : NaN;
  const toe = P(kp, s + 'bigtoe'), body = ALL.filter(n => n !== s + 'bigtoe');
  const build = (a, k) => {
    let o = setKnee(cp(kp), s, k);
    turn(o, body, toe, rad(a) * dir);
    o = setTrunk(o, dir, tT);
    if (hasFree) o = setDrive(o, free, dir, fT);
    return o;
  };
  let best = null;
  const [klo, khi] = B('kneeTO');
  const ks = [kT, ...[2, 4, 6, 8, 10, 12, 14].flatMap(d => [kT - d, kT + d])].filter(k => k >= klo - 1e-9 && k <= khi + 1e-9);
  for (let a = -12; a <= 12; a += 1) for (const k of ks) {
    const o = build(a, k);
    const cost = 3 * (outside(hipOf(o, s, dir), B('hipTO')) + outside(inclOf(o, s, dir, sex, 'bigtoe'), B('inclTO'))) + 0.15 * Math.abs(a) + 0.1 * Math.abs(k - kT);
    if (!best || cost < best.cost) best = { a, k, cost };
  }
  // refine around the coarse optimum
  if (best.cost > 1e-9) for (let a = best.a - 1; a <= best.a + 1 + 1e-9; a += 0.25) for (let k = Math.max(klo, best.k - 2); k <= Math.min(khi, best.k + 2) + 1e-9; k += 0.5) {
    const o = build(a, k);
    const cost = 3 * (outside(hipOf(o, s, dir), B('hipTO')) + outside(inclOf(o, s, dir, sex, 'bigtoe'), B('inclTO'))) + 0.15 * Math.abs(a) + 0.1 * Math.abs(k - kT);
    if (cost < best.cost) best = { a, k, cost };
  }
  const out = build(best.a, best.k);
  const items = [
    item('kneeTO', 'koleno', k0, kneeOf(out, s), B('kneeTO')),
    item('hipTO', 'bedro', h0, hipOf(out, s, dir), B('hipTO')),
    item('trunkTO', 'trup', t0, trunkAngle(out, dir), B('trunkTO')),
  ];
  if (hasFree) items.push(item('kneeDrive', 'švih kolena', f0, driveOf(out, free, dir), B('kneeDrive')));
  const i1 = inclOf(out, s, dir, sex, 'bigtoe');
  if (Number.isFinite(i0) && Number.isFinite(i1)) items.push(item('inclTO', 'náklon tela', i0, i1, B('inclTO'), true));
  return { kp: out, items };
}

// One stance-knee angle with the foot fixed (deepest bend on the board, the penultimate).
function idealKnee(kp, { s, key, label, target, band }) {
  if (!kp || !has(kp, s + 'hip', s + 'knee', s + 'ank', 'lsho', 'rsho', 'lhip', 'rhip') || !(viewYaw(kp) <= MAX_YAW)) return null;
  const k0 = kneeOf(kp, s);
  const out = setKnee(cp(kp), s, target(k0));
  return { kp: out, items: [item(key, label, k0, kneeOf(out, s), band)] };
}

// Landing: knee and hip of the leg that reaches the sand first. The flight path is already set
// at this point, so the trunk stays where it is and the legs move: the shanks open about the
// knees (a longer reach), then both legs turn about the hips. Both legs together, as they land.
const DIST = ['ank', 'heel', 'bigtoe', 'smalltoe'];
function openKnees(o, s, target) {
  const other = s === 'l' ? 'r' : 'l';
  const k0 = kneeOf(o, s);
  const t = solveTurn(o, DIST.map(n => s + n), P(o, s + 'knee'), q => kneeOf(q, s), target);
  // the same turn for the other shank, found by its own angle change
  const dk = kneeOf(t, s) - k0;
  return has(o, other + 'hip', other + 'knee', other + 'ank') ? solveTurn(t, DIST.map(n => other + n), P(t, other + 'knee'), q => kneeOf(q, other), kneeOf(o, other) + dk) : t;
}
// The landing leg turns about its own hip to the target; the other leg by the same angle about its hip.
function legsAboutHips(o, s, dir, target) {
  const other = s === 'l' ? 'r' : 'l', leg = f => ['knee', ...DIST].map(n => f + n);
  const t = solveTurn(o, leg(s), P(o, s + 'hip'), q => hipOf(q, s, dir), target);
  const ang = q => { const h = P(q, s + 'hip'), k = P(q, s + 'knee'); return Math.atan2(k[1] - h[1], k[0] - h[0]); };
  if (has(o, other + 'hip', other + 'knee')) turn(t, leg(other), P(t, other + 'hip'), ang(t) - ang(o));
  return t;
}
export function idealLanding(kp, { s, dir, sex = 'male', bandOf = null }) {
  const g = sex === 'female' ? 'f' : 'm';
  if (!kp || !has(kp, s + 'hip', s + 'knee', s + 'ank', s + 'sho', 'lsho', 'rsho', 'lhip', 'rhip') || !(viewYaw(kp) <= MAX_YAW)) return null;
  const k0 = kneeOf(kp, s), h0 = hipOf(kp, s, dir);
  const B = bandOf ?? (k => NORMS[k][g]);
  let out = openKnees(cp(kp), s, clampTo(k0, B('kneeLand')));
  out = legsAboutHips(out, s, dir, clampTo(h0, B('hipLand')));
  return { kp: out, items: [item('kneeLand', 'koleno', k0, kneeOf(out, s), B('kneeLand')), item('hipLand', 'bedro', h0, hipOf(out, s, dir), B('hipLand'))] };
}

// Every phase frame with a norm-based ideal, from the same track as the numbers. Each entry:
// { frame, phase, kp, you, items, changed }. Phases without a published pose norm (the flight)
// have none.
export function idealsFor(jump, result, sex = 'male') {
  const T = jump?.takeoff;
  if (!T || !result?.clean) return [];
  // Built on the track the skeleton overlay draws (smooth), so every joint the ideal leaves alone
  // sits exactly on the athlete's own: on the sharpened track the arms came out elsewhere and the
  // landing ghost showed "one arm one way, the other another" (Stanley, 2026-11-14). What is out of
  // norm is decided by the numbers on the cards (sharpened track): each band is shifted by the gap
  // between the card's value and the same angle on the drawn skeleton, and the legend speaks in the
  // card's values.
  const track = result.smooth ?? sharpen(result.clean, jump.fps), s = jump.takeoffFoot, dir = jump.dir, g = sex === 'female' ? 'f' : 'm';
  const by = Object.fromEntries((jump.metrics ?? []).map(m => [m.key, m]));
  const kf = id => (jump.keyFrames ?? []).find(k => k.id === id)?.frame;
  const free = s === 'l' ? 'r' : 'l';
  const read = (kp, key, ls) => ({
    kneeTD: () => kneeOf(kp, s), legTD: () => legAngle(kp, s, dir), trunkTD: () => trunkAngle(kp, dir), inclTD: () => lean(kp, s, dir, sex),
    kneeMin: () => kneeOf(kp, s), kneeTO: () => kneeOf(kp, s), hipTO: () => hipOf(kp, s, dir), trunkTO: () => trunkAngle(kp, dir),
    kneeDrive: () => driveOf(kp, free, dir), inclTO: () => inclOf(kp, s, dir, sex, 'bigtoe'),
    kneeLand: () => kneeOf(kp, ls), hipLand: () => hipOf(kp, ls, dir),
  }[key]?.() ?? NaN);
  const out = [];
  const add = (phase, frame, name, build, ls = s) => {
    const kp = track[frame];
    if (frame == null || !kp) return;
    const off = key => { const m = by[key]; if (!m || m.frame !== frame || !Number.isFinite(m.value)) return 0; const d = read(kp, key, ls); return Number.isFinite(d) ? m.value - d : 0; };
    const bandOf = key => NORMS[key][g].map(v => v - off(key));
    const id = build(kp, bandOf);
    if (!id) return;
    const items = id.items.map(it => { const o = off(it.key); return { ...it, you: it.you + o, ideal: it.ideal + o, band: it.band ? NORMS[it.key]?.[g] ?? it.band : null }; });
    out.push({ ...id, items, phase, name, frame, you: kp, changed: items.some(it => it.set) });
  };
  // penultimate: the deepest knee bend there, against the bend one step earlier (penKnee)
  const pk = by.penKnee, pen = jump.pen;
  if (pk && pk.status !== 'hidden' && pen) {
    const foot = pen.foot ?? free;
    add('pen', pk.frame, 'Predposledný krok', kp => idealKnee(kp, { s: foot, key: 'penKnee', label: 'koleno v predposlednom', band: null,
      target: k => k + (pk.value - clampTo(pk.value, NORMS.penKnee[g])) }));
  }
  add('plant', T.td, 'Dotyk na doske', (kp, bandOf) => idealTouchdown(kp, { s, dir, sex, bandOf }));
  const mf = kf('maxFlex');
  if (mf != null && by.kneeMin?.status !== 'hidden') add('plant', mf, 'Najväčší ohyb na doske', (kp, bandOf) => idealKnee(kp, { s, key: 'kneeMin', label: 'najväčší ohyb kolena', band: NORMS.kneeMin[g], target: k => clampTo(k, bandOf('kneeMin')) }));
  add('toeoff', T.to, 'Odraz', (kp, bandOf) => idealToeoff(kp, { s, dir, sex, bandOf }));
  if (jump.landing != null && track[jump.landing]) {
    const ld = track[jump.landing], ls = has(ld, 'lank', 'rank') ? (P(ld, 'lank')[1] > P(ld, 'rank')[1] ? 'l' : 'r') : s;
    add('landing', jump.landing, 'Dopad', (kp, bandOf) => idealLanding(kp, { s: ls, dir, sex, bandOf }), ls);
  }
  return out;
}

// The board touchdown alone (kept for older callers and tests).
export function idealFor(jump, result, sex = 'male') {
  return idealsFor(jump, result, sex).find(x => x.frame === jump?.takeoff?.td) ?? null;
}
