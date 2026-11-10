// Measurements at the key frames, using World Athletics report conventions
// (London 2017 / Birmingham 2018 biomechanics reports) unless noted, with norms.
// Angles need a side-on view; each is withheld when the camera looks too far along
// the runway at that moment. Timing works from any view.
import { P, has, mid, angle3, torsoLength, centreOfMass } from './kinematics.js';

const deg = r => (r * 180) / Math.PI;

// Norms: [men, women], elite finals, re-checked against the primary PDFs on 2026-11-10 (vault:
// "Jump Video Analyzer - norm sources"). WA17 = World Athletics London 2017 reports, WA18 =
// Birmingham 2018 indoor (Tucker, Bissas et al.), n = 12-15 per sex; PAN = Panoutsakopoulos 2017;
// NEM = Nemtsev 2016 (sub-elite: men 6.94 m, women 5.50 m). WA counts a "step" as contact + flight,
// so its "last step contact" is the penultimate stance, not the board.
// `good` gives the direction that is better, if any.
export const NORMS = {
  // Upper edge: 2009 World Final 127 ± 8 ms men, 125 ± 9 ms women (Panoutsakopoulos 2017, vault doc 24).
  contactTO: { label: 'Kontakt na doske', unit: 'ms', m: [110, 135], f: [105, 134], good: 'low' },
  // WA17 0.122 (0.120-0.130) men, 0.113 (0.095-0.135) women; WA18 men up to 0.144; PAN 109/117.
  contactPen: { label: 'Kontakt predposledného kroku', unit: 'ms', m: [100, 135], f: [95, 135], good: 'low' },
  // WA17/WA18/PAN means 70-76 ms both sexes, finalists 56-92 (women down to 40).
  flightToBoard: { label: 'Let do dosky', unit: 'ms', m: [56, 92], f: [45, 90] },
  // Centre of mass above the foot on the ground, 3rd-last touchdown minus penultimate touchdown
  // (cm on the athlete's leg; with the runway found, the leg as measured against the board).
  // Shimizu & Ae (ISBS, 6 university men, PB 7.06): 3 cm lower at penultimate touchdown, 6 ± 2 at
  // board touchdown. Published lowering is 1-9 cm against a ~3 cm measurement error (Lees 1993).
  hipDrop: { label: 'Zníženie ťažiska do predposledného', unit: 'cm', m: [2, 6], f: [2, 6] },
  // WA's interval: penultimate toe-off to the lowest centre of mass on the board. WA17 men 1-6,
  // WA18 men 2-8 (mean 3); WA17 women 1-6, WA18 women 1-9 (mean 3-4).
  comDropBoard: { label: 'Zníženie ťažiska do dosky', unit: 'cm', m: [1, 8], f: [1, 9] },
  // Take-off vs last-step speed, %: WA17 per-athlete losses (-1.66 to -0.25 m/s men, -1.48 to
  // -0.12 women) over their last-step speeds.
  speedLossTO: { label: 'Strata rýchlosti na odraze', unit: '%', m: [-17, -3], f: [-17, -1] },
  // Stanley's idea (2026-11-10): the lowering shows as a deeper bend of the stance knee in the
  // penultimate than in the step before. An angle, so no scale and no perspective. It agreed
  // in direction with hipDrop on all five clips (+5/+8° Stanley, 0/+1/-7° Miška). PROVISIONAL
  // band, engineering judgement: no published elite value for the difference.
  penKnee: { label: 'Ohyb kolena v predposlednom navyše', unit: '°', m: [3, 15], f: [3, 15] },
  // WA17 men 165.5-179.9, WA18 160.1-172.2; women WA17 155.8-177.5, WA18 160.0-174.5. NEM sub-elite
  // 167 ± 4.5 / 165.5 ± 4.6.
  kneeTD: { label: 'Koleno pri dotyku', unit: '°', m: [160, 178], f: [158, 177], good: 'high' },
  // Hip to ankle vs ground: Bridgett & Linthorne 61 ± 3 (one 8.30 m man), NEM 57.7 ± 3.0 / 59.6 ± 2.8.
  // PAN's 66° (old band) is centre of mass to ankle, a different line.
  legTD: { label: 'Uhol nohy pri dotyku', unit: '°', m: [55, 65], f: [56, 64] },
  // Centre of mass to the HEEL from vertical: Graham-Smith & Lees 2005 32.2 ± 2.2, Barros 2007
  // 27.0 ± 3.9 (20-31). WA's -35 to -37 means use an unstated foot point and read ~8° more.
  inclTD: { label: 'Náklon tela pri dotyku', unit: '°', m: [-36, -26], f: [-36, -26] },
  // WA18: men -5.6 (-16.3 to +0.7), women -7.4 (-18.5 to -1.6); 0 = upright, negative = back.
  trunkTD: { label: 'Trup pri dotyku', unit: '°', m: [-10, 1], f: [-10, -1] },
  // WA17/WA18 men 120.5-158.7, women 123.6-150.6; NEM 136.8 / 137.2.
  kneeMin: { label: 'Najväčší ohyb kolena', unit: '°', m: [120, 152], f: [124, 151], good: 'high' },
  // WA17/WA18 range of motion men 10.7-49.2 (IQR-ish 19-42), women 18.9-43.4.
  flexion: { label: 'Poddajnosť kolena na doske', unit: '°', m: [19, 42], f: [19, 40], good: 'low' },
  // Not reported directly; derived per athlete from WA tables (median 55-72 ms) and Wei 2026
  // 54 ± 9 / 56 ± 9. Propulsion: Wei 56 ± 8 / 60 ± 10, and board contact minus braking.
  braking: { label: 'Dotyk → najväčší ohyb', unit: 'ms', m: [40, 75], f: [40, 70] },
  propulsion: { label: 'Najväčší ohyb → odraz', unit: 'ms', m: [45, 75], f: [45, 75] },
  // Only Wei 2026 (8.0-8.2 m men): 172.8 ± 6.4. No women's value found.
  kneeTO: { label: 'Koleno pri odraze', unit: '°', m: [166, 180], f: [166, 180] },
  // Only Wei 2026: 195.4 ± 8.5, convention not stated. Ours: same-side shoulder-hip-knee.
  hipTO: { label: 'Vystretie bedra pri odraze', unit: '°', m: [185, 205], f: [185, 205], good: 'high' },
  // WA17/WA18 men 13.5-22.7, women 12.6-23.7; measured to the toe, the contact at toe-off.
  inclTO: { label: 'Náklon tela pri odraze', unit: '°', m: [13, 24], f: [13, 24] },
  // WA18 men -9.4 to +10.4, women -8.3 to +7.3.
  trunkTO: { label: 'Trup pri odraze', unit: '°', m: [-9, 10], f: [-8, 7] },
  // WA17/WA18 swing thigh vs horizontal: men -33.1 to -5.4, women -28.4 to +11.8.
  thighTO: { label: 'Stehno švihovej nohy pri odraze', unit: '°', m: [-33, -5], f: [-28, 12], good: 'high' },
  // The thighTO band re-expressed: 0° thigh hanging, 90° horizontal, read at toe-off.
  kneeDrive: { label: 'Švih kolena pri odraze', unit: '°', m: [57, 85], f: [62, 100], good: 'high' },
  flight: { label: 'Čas letu', unit: 'ms', m: [800, 950], f: [700, 850], good: 'high' },
  // PROVISIONAL band, engineering judgement: no published elite value found. Definition from Hay
  // 1986 and Herzog 1986: takeoff leaves forward angular momentum, the limbs absorb it so the trunk
  // holds its orientation. Hence trunk only (limbs excluded) and net change up to the apex, so
  // hitch-kick swinging and the landing pike do not count against the athlete.
  // Positive = forward. Looser backward because that literature only warns about forward rotation.
  trunkStability: { label: 'Stabilita trupu v lete', unit: '°', m: [-20, 10], f: [-20, 10] },
  // From flight.js (gravity scale + planted-toe anchor). Estimates: see accuracy notes.
  // WA17/WA18/PAN men 19.4-26.3, women 18.4-26.6; NEM sub-elite 22.8 / 21.3.
  takeoffAngle: { label: 'Uhol odrazu', unit: '°', m: [19, 27], f: [18, 27] },
  speedTD: { label: 'Rýchlosť pri dotyku', unit: 'm/s', m: [9.5, 10.8], f: [8.4, 9.6], good: 'high' },
  // WA17/WA18 men -0.53 to -2.80, women -0.83 to -2.37.
  velocityLoss: { label: 'Strata rýchlosti na doske', unit: 'm/s', m: [-2.8, -0.5], f: [-2.4, -0.8] },
  // WA17/WA18 men 3.22-4.20, women 2.51-3.46 (three 2017 finalists under 2.8).
  vyTO: { label: 'Zvislá rýchlosť pri odraze', unit: 'm/s', m: [3.2, 4.2], f: [2.5, 3.5], good: 'high' },
  // WA 2017 Fig. 7-8, "last step" mean horizontal CM velocity (penultimate contact + flight into board).
  speedLast: { label: 'Rýchlosť v poslednom kroku', unit: 'm/s', m: [9.36, 10.0], f: [8.36, 9.2], good: 'high' },
  // WA 2017 Table 7, horizontal CM velocity at take-off.
  speedTO: { label: 'Rýchlosť pri odraze', unit: 'm/s', m: [7.82, 9.56], f: [7.2, 8.98], good: 'high' },
  // WA 2017, take-off velocity minus last-step velocity, per athlete (range of the finalists).
  speedLoss: { label: 'Strata rýchlosti', unit: 'm/s', m: [-1.66, -0.25], f: [-1.48, -0.12] },
  // v²/2g of vertical takeoff velocity. WA17 men (3.85) is the high outlier; WA18, Linthorne and
  // Seo put men at 0.55-0.80 m. Women WA17 2.51-3.46 m/s.
  peakHeight: { label: 'Výška letu', unit: 'cm', m: [55, 80], f: [32, 61], good: 'high' },
  // Heel ahead of the centre of mass at first sand contact, WA18 Table 9 (the only report with
  // landing data): men 0.67 ± 0.09, women 0.59 ± 0.09 m.
  landingReach: { label: 'Dosah pri dopade', unit: 'm', m: [0.55, 0.75], f: [0.50, 0.70], good: 'high' },
  estDistance: { label: 'Odhad dĺžky od odrazu', unit: 'm', m: [7.8, 8.6], f: [6.4, 7.2], good: 'high' },
  // WA18 at first sand contact: knee men 131 ± 12, women 134 ± 15; hip men 95 ± 18 (IQR 83-108),
  // women 90 ± 16 (IQR 79-101), hip definition not stated. In those rows a more open hip went with
  // a longer reach (r = +0.4, not significant), so a deep fold is not the better landing.
  kneeLand: { label: 'Koleno pri dopade', unit: '°', m: [119, 143], f: [118, 149] },
  hipLand: { label: 'Bedro pri dopade', unit: '°', m: [83, 108], f: [79, 101] },
};

// Same falloff as coach.js metricScore, but the minimum span follows the unit: 10 "units" is
// fine for degrees and ms, and would make any miss in metres or m/s score about 100.
const MIN_SPAN = { m: 0.4, 'm/s': 1 };
export function scoreMetric(m) {
  const [lo, hi] = m.norm;
  const span = Math.max(hi - lo, MIN_SPAN[m.unit] ?? 10);
  const miss = m.value < lo ? lo - m.value : m.value > hi ? m.value - hi : 0;
  return Math.max(0, 100 * (1 - miss / (2 * span)));
}

// How far the view is from side-on (0 = perfectly side-on, 90 = along the runway),
// from how wide the hips look relative to the torso. A hip width of ~0.7 torso
// lengths is what a square-on view shows.
export function viewYaw(kp) {
  if (!has(kp, 'lhip', 'rhip', 'lsho', 'rsho')) return NaN;
  const w = Math.abs(P(kp, 'lhip')[0] - P(kp, 'rhip')[0]) / torsoLength(kp);
  return deg(Math.asin(Math.min(1, w / 0.7)));
}

// Signed angles in the direction of travel (dir = +1 running right, -1 left).
// Trunk: hip→shoulder from vertical, + = leaning forward (WA 2018 convention).
const trunkAngle = (kp, dir) => {
  const s = mid(P(kp, 'lsho'), P(kp, 'rsho')), h = mid(P(kp, 'lhip'), P(kp, 'rhip'));
  return deg(Math.atan2((s[0] - h[0]) * dir, h[1] - s[1]));
};
// Body inclination: centre of mass relative to the contact foot from vertical,
// negative when the centre of mass is behind the foot (WA).
// The foot point is where the foot meets the ground at that instant: the heel at touchdown, the
// toe at toe-off. The ankle read 2-3° short of the heel and 9-11° short of the toe on our clips.
const inclination = (kp, foot, dir, sex, point = 'ank') => {
  const c = centreOfMass(kp, sex), f = P(kp, foot + point);
  return c ? deg(Math.atan2((c[0] - f[0]) * dir, f[1] - c[1])) : NaN;
};
// Leg angle: hip→ankle of the stance leg against the ground, in front (Bridgett & Linthorne).
const legAngle = (kp, s, dir) => {
  const h = P(kp, s + 'hip'), a = P(kp, s + 'ank');
  return deg(Math.atan2(a[1] - h[1], (a[0] - h[0]) * dir));
};
// Free-leg thigh from horizontal, negative below horizontal (WA).
const thighAngle = (kp, s) => {
  const h = P(kp, s + 'hip'), k = P(kp, s + 'knee');
  return deg(Math.atan2(h[1] - k[1], Math.abs(k[0] - h[0])));
};
// Free thigh forward of hanging straight down: 0 hanging, 90 horizontal, negative behind the hip.
const thighDrive = (kp, s, dir) => {
  const h = P(kp, s + 'hip'), k = P(kp, s + 'knee');
  return deg(Math.atan2((k[0] - h[0]) * dir, k[1] - h[1]));
};
const knee = (kp, s) => angle3(P(kp, s + 'hip'), P(kp, s + 'knee'), P(kp, s + 'ank'));
// Hip angle shoulder-hip-knee, over 180 when the thigh is behind the trunk line.
const hipAngle = (kp, s, dir) => {
  const sh = P(kp, s + 'sho'), h = P(kp, s + 'hip'), k = P(kp, s + 'knee');
  const a = angle3(sh, h, k);
  const cross = (sh[0] - h[0]) * (k[1] - h[1]) - (sh[1] - h[1]) * (k[0] - h[0]);
  return cross * dir < 0 ? 360 - a : a;
};

// The leg that reaches the sand first: the lower ankle at the landing frame.
export function landingLeg(kp, fallback) {
  if (!has(kp, 'lank', 'rank')) return fallback;
  return P(kp, 'lank')[1] > P(kp, 'rank')[1] ? 'l' : 'r';
}

export const MAX_YAW = 30; // degrees off side-on beyond which angles are withheld

// Measured without the flight's metre scale: centimetres from the leg length, losses as ratios.
const SCALE_FREE = new Set(['hipDrop', 'comDropBoard', 'speedLossTO']);

// Why metres from the flight are withheld, in the athlete's words.
export function scaleReason(f) {
  if (f?.scaleWhy === 'depth') return `v lete sa vzďaľuješ od kamery (telo sa na videu zmenší o ${Math.round(Math.abs(1 - f.depth) * 100)} %), takže mierka v metroch nesedí; natoč skok zboku z väčšej diaľky`;
  if (f?.scaleWhy === 'fit') return 'let na videu nesedí s pádom pod gravitáciou, pravdepodobne pre pohyb kamery, takže mierka v metroch nesedí';
  if (f?.scaleWhy === 'torso') return 'mierka z letu nesedí s veľkosťou tela';
  return `z letu je vidno len ${(f?.fitSeconds ?? 0).toFixed(2).replace('.', ',')} s, na mierku v metroch to nestačí`;
}

// Measurements from flightAnalysis(); withheld when the gravity scale check fails, except the
// rise and vertical speed, which need only the apex in view.
export function flightMetrics(f, ev, sex = 'male') {
  if (!f || f.error) return [];
  const g = sex === 'female' ? 'f' : 'm';
  const row = (key, value, frame) => {
    if (value == null || !Number.isFinite(value)) return null;
    const n = NORMS[key], [lo, hi] = n[g];
    const fromApex = key === 'peakHeight' || key === 'vyTO';
    const usable = SCALE_FREE.has(key) || (key === 'takeoffAngle' ? f.angleOk : fromApex ? f.apexOk || f.scaleOk : f.scaleOk);
    const status = !usable ? 'hidden' : value < lo ? 'low' : value > hi ? 'high' : 'ok';
    const why = fromApex ? (f.angleOk ? 'vrchol letu nie je na videu' : scaleReason(f)) : scaleReason(f);
    return { key, label: n.label, unit: n.unit, value, norm: [lo, hi], status, frame, good: n.good, estimate: true, reason: usable ? null : why };
  };
  return [
    row('takeoffAngle', f.takeoffAngle, ev.takeoff.to),
    row('speedTD', f.vxTD, ev.takeoff.td),
    row('velocityLoss', f.velocityLoss, ev.takeoff.to),
    row('vyTO', f.vyTO, ev.takeoff.to),
    row('speedLast', f.speedLast, ev.pen?.td ?? null),
    row('speedTO', f.vxTO, ev.takeoff.to),
    row('speedLoss', f.speedLoss, ev.takeoff.to),
    row('hipDrop', f.hipDrop, f.hipDropFrame),
    row('comDropBoard', f.comDropBoard, f.comDropBoardFrame),
    row('speedLossTO', f.speedLossTO, ev.takeoff.to),
    row('peakHeight', f.peakHeight, ev.apex),
    row('landingReach', f.landingReach, ev.landing),
    row('estDistance', f.estDistance, ev.landing),
  ].filter(Boolean);
}

// ev: output of keyFrames(); track: smoothed keypoints per frame.
// Deepest stance-knee bend in a contact { td, to, foot }, skipping one-frame jumps of the knee
// point (the free leg crossing it): a frame more than 10° off its five-frame median.
function deepestKnee(track, c) {
  const v = [];
  for (let i = c.td; i <= c.to; i++) {
    const kp = track[i];
    v.push(kp && has(kp, c.foot + 'hip', c.foot + 'knee', c.foot + 'ank') ? knee(kp, c.foot) : NaN);
  }
  let best = null;
  v.forEach((x, k) => {
    const w = v.slice(Math.max(0, k - 2), k + 3).filter(Number.isFinite).sort((p, q) => p - q);
    if (!w.length || !(Math.abs(x - w[w.length >> 1]) <= 10)) return;
    if (!best || x < best.angle) best = { angle: x, frame: c.td + k };
  });
  return best;
}

// raw: the unsmoothed track, for the angles a smoothing fit would smear (knee bends).
export function measure(track, ev, fps, sex = 'male', dir = 1, raw = track) {
  const g = sex === 'female' ? 'f' : 'm';
  const out = [];
  const add = (key, value, frame, needsSideOn, estimate = false) => {
    if (value == null || Number.isNaN(value)) return;
    const n = NORMS[key];
    const yaw = frame != null && track[frame] ? viewYaw(track[frame]) : NaN;
    const hidden = needsSideOn && !(yaw <= MAX_YAW);
    const [lo, hi] = n[g];
    const status = hidden ? 'hidden' : value < lo ? 'low' : value > hi ? 'high' : 'ok';
    out.push({ key, label: n.label, unit: n.unit, value, norm: [lo, hi], status, frame, yaw, good: n.good, estimate });
  };
  const ms = frames => (frames / fps) * 1000;
  const { takeoff: T, pen, landing, takeoffFoot: s } = ev;
  const free = s === 'l' ? 'r' : 'l';
  const kf = id => ev.keyFrames.find(k => k.id === id);

  add('contactTO', ms(T.to - T.td + 1), null, false);
  if (pen) {
    add('contactPen', ms(pen.to - pen.td + 1), null, false);
    add('flightToBoard', ms(T.td - pen.to - 1), null, false);
    if (ev.third) {
      const a = deepestKnee(raw, ev.third), b = deepestKnee(raw, pen);
      if (a && b) add('penKnee', a.angle - b.angle, b.frame, true);
    }
  }
  const td = track[T.td], to = track[T.to], mk = kf('maxFlex');
  if (td && has(td, s + 'hip', s + 'knee', s + 'ank')) {
    add('kneeTD', knee(td, s), T.td, true);
    add('legTD', legAngle(td, s, dir), T.td, true);
    add('inclTD', inclination(td, s, dir, sex, 'heel'), T.td, true);
    add('trunkTD', trunkAngle(td, dir), T.td, true);
  }
  if (mk && track[mk.frame]) {
    // Median of the unsmoothed angle over five frames: when the free leg crosses the stance
    // knee its point can jump for a frame, and the smoothing fit would spread that jump to
    // the neighbours (IMG_4596: 111° smoothed against 130° measured either side).
    const around = [-2, -1, 0, 1, 2].map(d => raw[mk.frame + d]).filter(k => k && has(k, s + 'hip', s + 'knee', s + 'ank')).map(k => knee(k, s)).sort((a, b) => a - b);
    const kmin = around.length ? around[around.length >> 1] : knee(track[mk.frame], s);
    // The free leg passes in front of the stance knee here, so the knee point is partly
    // inferred. Rebuilding it from hip-ankle reach failed: the thigh's image length swings
    // 10-20% through the contact as it turns, which put the angle off by up to 22°.
    add('kneeMin', kmin, mk.frame, true, true);
    if (td) add('flexion', knee(td, s) - kmin, mk.frame, true, true);
    add('braking', ms(mk.sub - T.td), null, false);
    add('propulsion', ms(T.to + 1 - mk.sub), null, false);
  }
  if (to && has(to, s + 'hip', s + 'knee', s + 'ank')) {
    add('kneeTO', knee(to, s), T.to, true);
    if (has(to, s + 'sho')) add('hipTO', hipAngle(to, s, dir), T.to, true);
    add('inclTO', inclination(to, s, dir, sex, 'bigtoe'), T.to, true);
    add('trunkTO', trunkAngle(to, dir), T.to, true);
    if (has(to, free + 'hip', free + 'knee')) {
      add('thighTO', thighAngle(to, free), T.to, true);
      add('kneeDrive', thighDrive(to, free, dir), T.to, true);
    }
  }
  // Net trunk rotation from toe-off to the apex, positive forward, averaged over 5 frames at each end.
  if (ev.apex != null) {
    const trunkMean = c => {
      const v = [-2, -1, 0, 1, 2].map(d => track[c + d]).filter(k => k && has(k, 'lsho', 'rsho', 'lhip', 'rhip')).map(k => trunkAngle(k, dir));
      return v.length >= 3 ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
    };
    add('trunkStability', trunkMean(ev.apex) - trunkMean(T.to), ev.apex, true);
  }
  if (landing != null) {
    add('flight', ms(landing - T.to - 1), null, false);
    const ld = track[landing], ls = landingLeg(ld, s);
    if (ld && has(ld, ls + 'hip', ls + 'knee', ls + 'ank')) {
      add('kneeLand', knee(ld, ls), landing, true);
      if (has(ld, ls + 'sho')) add('hipLand', hipAngle(ld, ls, dir), landing, true);
    }
  }
  return out;
}
