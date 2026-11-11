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
export function idealTouchdown(kp, { s, dir, sex = 'male' }) {
  if (!kp || !has(kp, s + 'hip', s + 'knee', s + 'ank', 'lsho', 'rsho', 'lhip', 'rhip')) return null;
  if (!(viewYaw(kp) <= MAX_YAW)) return null;
  const g = sex === 'female' ? 'f' : 'm';
  const pick = (key, v) => { const [lo, hi] = NORMS[key][g]; return { band: [lo, hi], ideal: v < lo || v > hi ? (lo + hi) / 2 : v, set: v < lo || v > hi }; };

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
  const [ilo, ihi] = NORMS.inclTD[g], imid = (ilo + ihi) / 2;
  let legT = lg.ideal, trunkT = tr.ideal, out = build(kn.ideal, legT, trunkT);
  const l0 = lean(kp, s, dir, sex);
  let l1 = lean(out, s, dir, sex);
  if (Number.isFinite(l1) && (l1 < ilo || l1 > ihi)) {
    const [a0, a1] = NORMS.legTD[g], [b0, b1] = NORMS.trunkTD[g];
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
  if (Number.isFinite(l0) && Number.isFinite(l1)) items.push({ key: 'inclTD', label: 'náklon tela', you: l0, ideal: l1, band: NORMS.inclTD[g], set: Math.abs(l1 - l0) >= 0.5, derived: true });
  return { kp: out, items };
}

// The ideal for a jump: board touchdown, from the same track as the numbers. null when it can't
// be built (view too far off side-on, points missing).
export function idealFor(jump, result, sex = 'male') {
  const T = jump?.takeoff;
  if (!T || !result?.clean) return null;
  const kp = sharpen(result.clean, jump.fps)[T.td];
  const id = idealTouchdown(kp, { s: jump.takeoffFoot, dir: jump.dir, sex });
  return id && { ...id, frame: T.td, side: jump.takeoffFoot, dir: jump.dir, changed: id.items.some(it => it.set) };
}
