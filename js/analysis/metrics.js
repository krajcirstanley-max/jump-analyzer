// Measurements at the key frames, using World Athletics report conventions
// (London 2017 / Birmingham 2018 biomechanics reports) unless noted, with norms.
// Angles need a side-on view; each is withheld when the camera looks too far along
// the runway at that moment. Timing works from any view.
import { P, has, mid, dist, angle3, torsoLength, centreOfMass } from './kinematics.js';

const deg = r => (r * 180) / Math.PI;

// Norms: [men, women], elite finals, re-checked against the primary PDFs on 2026-11-10 (vault:
// "Jump Video Analyzer - norm sources"). WA17 = World Athletics London 2017 reports, WA18 =
// Birmingham 2018 indoor (Tucker, Bissas et al.), n = 12-15 per sex; PAN = Panoutsakopoulos 2017;
// NEM = Nemtsev 2016 (sub-elite: men 6.94 m, women 5.50 m). WA counts a "step" as contact + flight,
// so its "last step contact" is the penultimate stance, not the board.
// `good` gives the direction that is better, if any.
export const NORMS = {
  // 2009 World Final 127 ± 4 ms men, 125 ± 9 ms women (Panoutsakopoulos 2017 Table 1, p.86); Berlin
  // 2009 take-off duration 0.11-0.13 s both sexes. Nothing supports a women's floor under 110 (audit 2026-11-24).
  contactTO: { label: 'Kontakt na doske', unit: 'ms', m: [110, 135], f: [110, 134], good: 'low' },
  // WA17 0.122 (0.120-0.130) men, 0.113 (0.095-0.135) women; WA18 men up to 0.144; PAN 109/117.
  // WA18 Fig. 6 men 0.104-0.144 (Tentoglou 0.144).
  contactPen: { label: 'Kontakt predposledného kroku', unit: 'ms', m: [104, 144], f: [95, 135], good: 'low' },
  // WA17/WA18/PAN means 70-76 ms both sexes, finalists 56-92 (women down to 40).
  flightToBoard: { label: 'Let do dosky', unit: 'ms', m: [56, 92], f: [45, 90] },
  // Panoutsakopoulos, Papaiakovou, Katsikas & Kollias 2010 (New Studies in Athletics 25:1, 55-68;
  // 2006 European Cup, 8 men, 7.00-8.05 m, 3D-DLT, Table 5): centre of mass 3rd-last toe-off to
  // penultimate touchdown -0.07 ± 0.02 m (-0.05 to -0.10); penultimate support +0.01; penultimate
  // toe-off to board touchdown -0.03 ± 0.02; ~9 cm in all, 'as also reported in the 2007 World
  // Championship'. No women's figure anywhere (Hay & Nohara 1990, Shimizu & Ae: men too): shown to
  // women against the men's band, not graded. The app reads the supports at the pose with the centre
  // of mass over the ankle (flight.js), ~1-2 cm off the study's instants.
  hipDrop: { label: 'Zníženie ťažiska do predposledného', unit: 'cm', m: [5, 10], f: [5, 10], info: ['f'], ref: { f: 'Muži (Panoutsakopoulos 2010)' }, why: { f: 'pre ženy niet údajov' } },
  // Penultimate touchdown to board touchdown, Panoutsakopoulos et al. 2010 Table 5 (penultimate support
  // + its last flight), per athlete -1 to +4 cm, mean 1.6. Replaced WA's penultimate toe-off to the lowest
  // point on the board (1-8) on 2026-11-23: a toe-off can't be read on a phone. No women's figure.
  comDropBoard: { label: 'Zníženie ťažiska do dosky', unit: 'cm', m: [-1, 4], f: [-1, 4], info: ['f'], ref: { f: 'Muži (Panoutsakopoulos 2010)' }, why: { f: 'pre ženy niet údajov' } },
  // Take-off speed against the mean speed from the penultimate touchdown to the board touchdown, %.
  // That is Berlin 2009's "loss at take-off" (men 12-22 %, women 13-19 %), not WA's touchdown-to-
  // take-off loss; the earlier WA-derived band (-17 to -3) was the wrong reference (2026-11-10).
  speedLossTO: { label: 'Strata rýchlosti na odraze', unit: '%', m: [-22, -12], f: [-19, -13] },
  // Heel ahead of the centre of mass at board touchdown (runway scale). Nemtsev 2016 sub-elite,
  // mean ± 1 SD: men 0.44 ± 0.06 m (6.94 m jumps), women 0.39 ± 0.05 m (5.50 m). No elite figure found.
  // Not graded (audit 2026-11-24): sub-elite only, and the same geometry as inclTD, so it scored twice.
  touchdownDist: { label: 'Došľap pred ťažiskom', unit: 'm', m: [0.38, 0.50], f: [0.34, 0.44], info: true, ref: 'Nemtsev 2016, nie elita', why: 'to isté ako náklon tela pri dotyku' },
  // Knee range of motion over the time from touchdown to the deepest bend, as a speed. WA17 range:
  // men 143-764 °/s (mean 536), women 238-682 (mean 465). Phone at 120 fps: about ±20 %. Not graded:
  // it is the knee's bend over the braking time, both read at the deepest bend the free leg hides.
  kneeVel: { label: 'Rýchlosť ohybu kolena na doske', unit: '°/s', m: [143, 764], f: [238, 682], info: true, why: 'najväčší ohyb kolena zakrýva švihová noha' },
  // Trunk at toe-off minus trunk at touchdown: forward rotation on the board. Berlin 2009 finalists:
  // men 6-13°, women 1-15°. WA18 per athlete (TO − TD) men −3.5 to +16.3 (mean 4.7), women 2.0-19.4
  // (mean 6.4): 9 of 15 WA18 men sit under Berlin's band. Two finalist sources disagree: not graded.
  trunkRotBoard: { label: 'Rotácia trupu na doske', unit: '°', m: [6, 13], f: [1, 15], info: true, ref: 'Berlín 2009', why: 'MS 2018 dáva iné čísla ako Berlín' },
  // Centre of mass at toe-off as % of standing height. Linthorne 2005 Table II: 63-69 %, but only 3 men
  // in training, and the app reads it at toe-off, which the phone gets 7-12 cm wrong: no grade, no band.
  // 2026-11-25: Shimizu 2018, 29 elite men 67.8 ± 2.1 %; women about 61-65 % (Campos 2013 8 finalists, PAN 2021 4).
  // Still not graded: the phone reads the toe-off instant 7-12 cm off.
  toHeight: { label: 'Výška ťažiska pri odraze', unit: '%', m: [65.7, 69.9], f: [60, 66], good: 'high', info: true, ref: { m: 'Shimizu 2018, 29 mužov', f: 'Campos 2013, PAN 2021' }, why: 'odraz špičky sa z mobilu nedá zmerať presne' },
  // Last step (penultimate to board, toe to toe) against the one before, %. WA17 men -9 % (-19 to
  // -1), women -10 %; WA18 women -12 % (-27 to -5); WA17 women −20 to +3; Berlin men 77-102 %, women
  // 80-98 % of the step before. Our earlier step is far from the board: ±0.15 m (7 % of a step), so not graded.
  stepChange: { label: 'Skrátenie posledného kroku', unit: '%', m: [-23, 2], f: [-27, 3], info: true, why: 'krok pred predposledným sa meria s chybou ±15 cm' },
  // Stanley's idea (2026-11-10): the lowering shows as a deeper bend of the stance knee in the
  // penultimate than in the step before. An angle, so no scale and no perspective. It agreed
  // in direction with hipDrop on all five clips (+5/+8° Stanley, 0/+1/-7° Miška). PROVISIONAL
  // band, engineering judgement: no published elite value for the difference.
  // NOT SHOWN since 2026-11-23 (no finalist or study band).
  penKnee: { label: 'Ohyb kolena v predposlednom navyše', unit: '°', m: [3, 15], f: [3, 15] },
  // WA17 men 165.5-179.9, WA18 160.1-172.2; women WA17 155.8-177.5, WA18 160.0-174.5. NEM sub-elite
  // 167 ± 4.5 / 165.5 ± 4.6.
  kneeTD: { label: 'Koleno pri dotyku', unit: '°', m: [160, 180], f: [156, 178], good: 'high' },
  // Hip to ankle vs ground: NEM 57.7 ± 3.0 / 59.6 ± 2.8 (sub-elite, n = 26 / 21; Bridgett & Linthorne is one
  // man). PAN's 66° is centre of mass to ankle, a different line. No finalist figure for hip-ankle.
  legTD: { label: 'Uhol nohy pri dotyku', unit: '°', m: [55, 61], f: [57, 62], ref: 'Nemtsev 2016 (nie elita)' },
  // Centre of mass to the HEEL from vertical: Graham-Smith & Lees 2005 32.2 ± 2.2, Barros 2007
  // 27.0 ± 3.9 (20-31). WA's -35 to -37 means use an unstated foot point and read ~8° more.
  // Heel-based data centre on −28 (Berlin 2009 CM-heel 25.6 / 26.4, Lees 1992 28.6 ± 3.2, Barros 27.0):
  // the old −36..−26 sat ~3° too far back (verification 2026-11-14).
  // 2026-11-24: Berlin 2009 finalists' CM-heel only (men 22-30, women 21-29); the −33 edge came from
  // Graham-Smith & Lees' UK nationals. WA measures to the foot tip (Table 1), hence its −35 to −37.
  inclTD: { label: 'Náklon tela pri dotyku', unit: '°', m: [-30, -22], f: [-29, -21] },
  // WA18: men -5.6 (-16.3 to +0.7), women -7.4 (-18.5 to -1.6); 0 = upright, negative = back.
  trunkTD: { label: 'Trup pri dotyku', unit: '°', m: [-16, 1], f: [-19, -2] },
  // WA17/WA18 men 120.5-158.7, women 123.6-150.6; NEM 136.8 / 137.2. Not graded since 2026-11-24: at the
  // deepest bend the free leg covers the stance knee (hand 121 vs app 130, 131 vs 139).
  kneeMin: { label: 'Najväčší ohyb kolena', unit: '°', m: [120, 159], f: [124, 151], good: 'high', info: true, why: 'najväčší ohyb kolena zakrýva švihová noha' },
  // WA17/WA18 range of motion, finalists' min-max: men 10.7-49.2, women 18.9-43.4 (true IQR 24.8-37.8 /
  // 23.8-32.9). No 'good': ROM vs distance r = −0.04. Not graded: read at the hidden deepest bend.
  flexion: { label: 'Poddajnosť kolena na doske', unit: '°', m: [11, 49], f: [19, 43], info: true, why: 'najväčší ohyb kolena zakrýva švihová noha' },
  // Computed per finalist from WA17/WA18 (knee range of motion ÷ the mean knee speed from touchdown to the
  // deepest bend, Table 1's definition): men 35-80 ms, women 40-100. Not graded: the deepest bend is hidden.
  // 2026-11-25: measured directly in Campos et al. 2013 (NSA 28:115, 2008 World Indoor finals, 8 + 8, 3D 125 Hz,
  // per athlete): men 45 ± 6 (40-56) / 77 ± 4 (72-80) ms, women 52 ± 6 (40-56) / 65 ± 7 (56-72).
  braking: { label: 'Dotyk → najväčší ohyb', unit: 'ms', m: [40, 56], f: [40, 56], info: true, ref: 'Campos 2013, finalisti HMS', why: 'najväčší ohyb kolena zakrýva švihová noha' },
  // Board contact minus braking; no finalist source reports it (Wei 2026 only, 100 Hz national men).
  propulsion: { label: 'Najväčší ohyb → odraz', unit: 'ms', m: [72, 80], f: [56, 72], info: true, ref: 'Campos 2013, finalisti HMS', why: 'najväčší ohyb kolena zakrýva švihová noha' },
  // Only Wei 2026 (11 Chinese men, 8.0-8.2 m, 2D 100 Hz): 172.8 ± 6.4. No women's value, no finalist value.
  // 2026-11-25: three sources for men - Shimizu 2018 (Tsukuba thesis, JAAF data: 9 world-class 163.8 ± 4.4,
  // 10 Japanese elite 171.6 ± 2.6), Wei 2026 172.8 ± 6.4: the envelope of mean ± SD, 160-178. Women: only
  // Panoutsakopoulos et al. 2021 (4 European indoor finalists, 2D 300 fps) 171.2 ± 4.7: shown, not graded.
  kneeTO: { label: 'Koleno pri odraze', unit: '°', m: [160, 178], f: [166, 176], info: ['f'], ref: { m: 'Shimizu 2018, Wei 2026', f: 'Panoutsakopoulos 2021, 4 finalistky' }, why: { f: 'len 4 finalistky v jedinej štúdii' } },
  // Only Wei 2026: 195.4 ± 8.5, convention not stated; ours (same-side shoulder-hip-knee) moves it up to 11°.
  hipTO: { label: 'Vystretie bedra pri odraze', unit: '°', m: [185, 205], f: [185, 205], good: 'high', info: true, noRef: true, why: 'jediná štúdia a nevieme, ako uhol merali' },
  // WA17/WA18 men 13.5-22.7, women 12.6-23.7; measured to the toe, the contact at toe-off.
  inclTO: { label: 'Náklon tela pri odraze', unit: '°', m: [13.5, 23], f: [12.5, 24] },
  // WA18 men -9.4 to +10.4, women -8.3 to +7.3; WA17 Table 8 (converted) men −10.4 to +7.3, women −13.2 to +5.7.
  trunkTO: { label: 'Trup pri odraze', unit: '°', m: [-10, 10], f: [-13, 7] },
  // WA17/WA18 swing thigh vs horizontal: men -33.1 to -5.4, women -28.4 to +11.8.
  // Shown as kneeDrive (the same line re-expressed); graded there only. No 'good': r = −0.05 with distance.
  thighTO: { label: 'Stehno švihovej nohy pri odraze', unit: '°', m: [-33, -5], f: [-28, 12], info: true, why: 'to isté ako švih kolena' },
  // The thighTO band re-expressed: 0° thigh hanging, 90° horizontal, read at toe-off.
  kneeDrive: { label: 'Švih kolena pri odraze', unit: '°', m: [57, 85], f: [62, 102] },
  // No study reports a measured elite flight time (WA, Berlin, Linthorne searched, 2026-11-24). Derived from
  // the finalists' vertical take-off speed with a 0.4-0.6 m drop to landing: men ~0.76-0.98 s, women ~0.61-0.89.
  flight: { label: 'Čas letu', unit: 'ms', m: [760, 980], f: [610, 890], good: 'high', info: true, ref: 'Odvodené z rýchlostí finalistov', why: 'žiadna štúdia let finalistov nemerala' },
  // PROVISIONAL band, engineering judgement: no published elite value found. Definition from Hay
  // 1986 and Herzog 1986: takeoff leaves forward angular momentum, the limbs absorb it so the trunk
  // holds its orientation. Hence trunk only (limbs excluded) and net change up to the apex, so
  // hitch-kick swinging and the landing pike do not count against the athlete.
  // Positive = forward. Looser backward because that literature only warns about forward rotation.
  trunkStability: { label: 'Stabilita trupu v lete', unit: '°', m: [-20, 10], f: [-20, 10], info: true, noRef: true, why: 'pre let niet publikovanej normy' },
  // From flight.js (gravity scale + planted-toe anchor). Estimates: see accuracy notes.
  // WA17/WA18/PAN men 19.4-26.3, Berlin 18.9-27.9; women WA18 16.1-26.6 (Lesueur 16.1), Berlin 17.6-24.5.
  takeoffAngle: { label: 'Uhol odrazu', unit: '°', m: [19, 28], f: [16, 27] },
  speedTD: { label: 'Rýchlosť pri dotyku', unit: 'm/s', m: [9.5, 10.8], f: [8.4, 9.6], good: 'high' },
  // WA17/WA18 men -0.53 to -2.80, women -0.83 to -2.37.
  velocityLoss: { label: 'Strata rýchlosti na doske', unit: 'm/s', m: [-2.8, -0.5], f: [-2.4, -0.8] },
  // WA17/WA18 men 3.22-4.20, Berlin 3.14-4.23; women WA18 Table 6 2.31-3.68 (Lesueur, Sagnia), Berlin 2.64-3.42.
  vyTO: { label: 'Zvislá rýchlosť pri odraze', unit: 'm/s', m: [3.1, 4.2], f: [2.3, 3.7], good: 'high' },
  // WA 2017 Fig. 7-8, "last step" mean horizontal CM velocity (penultimate contact + flight into board).
  // Berlin 2009 last stride (video, the same method as ours: its ratio to the 11-1 m photocell mean
  // is 0.998, and ours matched Freelap on IMG_4677). Was WA17 (9.36-10.0 / 8.36-9.20), whose CoM
  // method reads ~7 % low (verification 2026-11-14).
  // 2026-11-14 research (no published norm for either; rules built from physics and Jin 2024):
  // the legs go forward only after the flight apex (Schmolinsky via Marchetti; an early pike speeds
  // the forward rotation, ~5 cm per 0.1 s early, derived) — ms from the apex, negative = before it;
  legsOut: { label: 'Nohy dopredu po vrchole letu', unit: 'ms', m: [0, 470], f: [0, 430], info: true, noRef: true, why: 'pásmo je odvodené, nie zo štúdie' },
  // the free thigh is braked late in the contact (Jin et al. 2024, Heliyon 10:e31015: later braking
  // 7.48 vs 7.26 m): degrees it has already fallen from its peak by toe-off when that peak came
  // more than 20 ms early.
  // Jin reports WHEN the swing leg brakes, not degrees dropped: the 0-5° and the 20 ms rule are ours.
  freeDrop: { label: 'Pokles švihového stehna pred odrazom', unit: '°', m: [0, 5], f: [0, 5], info: true, noRef: true, why: 'jediná malá štúdia a bez čísla v stupňoch' },
  // 1-11 m approach speed (Freelap or the video's cones) and how much of it reaches the board.
  // Berlin 2009: the 11-1 m photocell mean ≈ the last stride (ratio 0.998 ± 0.010, 0.98-1.01).
  speedApproach: { label: 'Rýchlosť 1–11 m', unit: 'm/s', m: [10.17, 10.78], f: [9.07, 9.59], good: 'high' },
  // Berlin men's last stride vs photocell, analysed jumps −2.0 to +0.9 % (n = 7). Not graded: our two
  // inputs carry 2-5 % each (video cones 2.4 % fast on IMG_4677, board-scale last step 3-7 % short).
  speedKeep: { label: 'Rýchlosť do dosky oproti 1–11 m', unit: '%', m: [-2, 2], f: [-2, 2], info: true, why: 'chyba merania je väčšia ako pásmo' },
  speedLast: { label: 'Rýchlosť z predposledného do odrazu', unit: 'm/s', m: [10.17, 10.78], f: [9.07, 9.59], good: 'high' },
  // WA 2017 Table 7, horizontal CM velocity at take-off.
  speedTO: { label: 'Rýchlosť pri odraze', unit: 'm/s', m: [7.82, 9.56], f: [7.2, 8.98], good: 'high' },
  // Berlin 2009 "loss at take-off" in m/s (men 1.25-2.30, women 1.22-1.75): the same last-stride level as our
  // speedLast. WA17's last step reads ~0.7 m/s lower, so its −1.66 to −0.25 clashed with speedLossTO.
  speedLoss: { label: 'Strata rýchlosti', unit: 'm/s', m: [-2.3, -1.25], f: [-1.75, -1.22] },
  // v²/2g of the finalists' vertical take-off speed (WA18 men 3.22-4.20, women 2.31-3.68 m/s).
  peakHeight: { label: 'Výška letu', unit: 'cm', m: [53, 90], f: [27, 69], good: 'high', ref: 'Odvodené zo zvislej rýchlosti finalistov' },
  // Heel ahead of the centre of mass at first sand contact, WA18 Table 9 (the only report with
  // landing data): men 0.67 ± 0.09, women 0.59 ± 0.09 m.
  landingReach: { label: 'Dosah pri dopade', unit: 'm', m: [0.55, 0.75], f: [0.50, 0.70], good: 'high' },
  // An outcome, not technique; no source for a band. Finalists' effective distances WA17/18: men 7.54-8.65, women 6.13-7.24.
  estDistance: { label: 'Odhad dĺžky od odrazu', unit: 'm', m: [7.54, 8.65], f: [6.13, 7.24], good: 'high', info: true, ref: 'Efektívne dĺžky finalistov MS 2017/2018', why: 'je to výsledok, nie technika' },
  // WA18 at first sand contact: knee men 131 ± 12, women 134 ± 15; hip men 95 ± 18 (IQR 83-108),
  // women 90 ± 16 (IQR 79-101), hip definition not stated. In those rows a more open hip went with
  // a longer reach (r = +0.4, not significant), so a deep fold is not the better landing.
  kneeLand: { label: 'Koleno pri dopade', unit: '°', m: [119, 143], f: [118, 149] },
  hipLand: { label: 'Bedro pri dopade', unit: '°', m: [83, 108], f: [79, 101] },
};

// 100 inside the norm, falling linearly to 0 at one norm-width outside it. The width has a floor per
// unit at about what the video can resolve, so a narrow norm doesn't punish a miss the camera can't
// see (one frame at 120 fps is 8 ms; joint angles carry a few degrees of noise). Until 2026-11-13
// the fall ran over two widths with a 10-unit floor, and a 10 cm over-lowering against a 2-6 cm
// norm still scored 78 (Stanley: "skóre celkovo je príliš prívetivé").
const SPAN_FLOOR = { '°': 6, ms: 15, cm: 3, '%': 4, m: 0.3, 'm/s': 0.5, '°/s': 100 };
// A value past the band on its good side (a shorter contact, a faster approach) is not a miss
// (audit 2026-11-24: an 11.0 m/s approach lost points against 10.17-10.78).
export function scoreMetric(m) {
  const [lo, hi] = m.norm;
  const span = Math.max(hi - lo, SPAN_FLOOR[m.unit] ?? 6);
  const miss = m.value < lo ? (m.good === 'low' ? 0 : lo - m.value) : m.value > hi ? (m.good === 'high' ? 0 : m.value - hi) : 0;
  return Math.max(0, 100 * (1 - miss / span));
}
export function bandStatus(value, [lo, hi], good) {
  return value < lo ? (good === 'low' ? 'ok' : 'low') : value > hi ? (good === 'high' ? 'ok' : 'high') : 'ok';
}

// Shown but not graded (status 'info', no score, no cue): no finalist or adequate published band, a band
// two finalist sources disagree on, the same quantity graded elsewhere, or a reading the phone can't make
// to the band's width (audit 2026-11-24). `info` is true or the sexes it holds for; `ref` names a source
// that is not the finalists; `noRef` shows no band at all; `why` says in a few words why it isn't graded.
const bySex = (v, g) => (v && typeof v === 'object' && !Array.isArray(v) ? v[g] : v);
export function infoFor(key, g) {
  const i = NORMS[key]?.info;
  return i === true || (Array.isArray(i) && i.includes(g));
}
export function normMeta(key, g) {
  const n = NORMS[key] ?? {}, info = infoFor(key, g);
  return { ref: bySex(n.ref, g) ?? null, why: info ? bySex(n.why, g) ?? null : null, noRef: info && !!n.noRef };
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

// A lowering split into where it comes from (cm, positive = lower): shank, thigh, foot, trunk.
// The two frames a lowering is read between, for the buttons under its row.
const framed = (r, frames) => (r && frames && r.status !== 'hidden' ? { ...r, frames } : r);
const withParts = (r, parts) => (r && parts && Object.values(parts).every(Number.isFinite) ? { ...r, parts } : r);

// Measurements from flightAnalysis(); withheld when the gravity scale check fails, except the
// rise and vertical speed, which need only the apex in view.
export function flightMetrics(f, ev, sex = 'male') {
  if (!f) return [];
  const g = sex === 'female' ? 'f' : 'm';
  const row = (key, value, frame) => {
    if (value == null || !Number.isFinite(value)) return null;
    const n = NORMS[key], [lo, hi] = n[g];
    const fromApex = key === 'peakHeight' || key === 'vyTO';
    // With the runway's metres the scale is fine, but the rise and vertical speed still come from
    // the flight's arc: when that arc doesn't fit (IMG_4951 before its landing was fixed: 2.5°,
    // vy 0.53, apex 1 cm) they go hidden with the angle. The reason is the arc's, not the scale's.
    const board = f.scaleSource === 'board';
    const raisedBox = key === 'comDropBoard' && f.ground?.raised;
    // From a take-off plank the distance is not shown yet: two server runs of IMG_5166 (2026-11-20)
    // read 6.78 and 7.18 m, the speeds on the body's scale within 0.5 %. Shown once a tape agrees.
    const plankDist = (key === 'estDistance' || key === 'flightDistance') && f.ground?.onPlank;
    // Speeds and metres need the runway: from the flight's arc alone they came 4-15 % off the runway
    // on eight clips that have both (2026-11-19: 6.5 vs 7.7, 7.8 vs 6.9 m/s), and 4.9 m/s for
    // Stanley's IMG_2432 when its runway failed. A typed Freelap time is its own measure and stays.
    // The angle too: its horizontal speed is the same arc speed, and a phone that follows the jumper
    // shrinks it (2026-11-20, IMG_5166 from a raised plank: 2.7 m/s, 46°; IMG_5169 31°).
    const noRunway = !board && !fromApex && key !== 'speedApproach' && !SCALE_FREE.has(key);
    // Lowering in cm comes from the leg's angles and real segment lengths (heightAboveFoot). Hidden for
    // an hour on 2026-11-23 while image-scale versions gave 1-10 cm on IMG_5166; restored when the joints
    // were checked on its frames: the angles hold, only the image scale didn't.
    const usable = !raisedBox && !plankDist && !noRunway && (SCALE_FREE.has(key) || (key === 'takeoffAngle' ? f.angleOk && !(f.fitSeconds < 0.3) : fromApex ? f.apexOk || (!board && f.scaleOk) : f.scaleOk));
    const status = !usable ? 'hidden' : value < lo ? 'low' : value > hi ? 'high' : 'ok';
    const arc = board ? { ...f, scaleWhy: f.fitWhy } : f;
    const why = plankDist ? 'z debničky sa dĺžka skoku zatiaľ nemeria dosť presne (±0,2 m); rýchlosť a kroky áno'
      : noRunway ? 'na videu sa nezmerala dráha (doska a čiary), a rýchlosť len z letu by mohla byť mimo až o 15 %'
      : raisedBox ? 'odraz z debničky: ťažisko sa meria od chodidla na debničke, zníženie by vyšlo o výšku debničky väčšie'
      : key === 'takeoffAngle' || fromApex ? (f.angleOk ? 'vrchol letu nie je na videu' : scaleReason(arc)) : scaleReason(f);
    return { key, label: n.label, unit: n.unit, value, norm: [lo, hi], status, frame, good: n.good, estimate: true, reason: usable ? null : why };
  };
  return [
    row('takeoffAngle', f.takeoffAngle, ev.takeoff.to),
    row('speedTD', f.vxTD, ev.takeoff.td),
    row('velocityLoss', f.velocityLoss, ev.takeoff.to),
    row('vyTO', f.vyTO, ev.takeoff.to),
    row('speedLast', f.speedLast, ev.pen?.td ?? null),
    row('speedApproach', f.approach, ev.pen?.td ?? null),
    row('speedKeep', f.speedKeep, ev.pen?.td ?? null),
    row('speedTO', f.vxTO, ev.takeoff.to),
    row('speedLoss', f.speedLoss, ev.takeoff.to),
    framed(withParts(row('hipDrop', f.hipDrop, f.hipDropFrame), f.hipDropParts), f.hipDropFrames),
    framed(withParts(row('comDropBoard', f.comDropBoard, f.comDropBoardFrame), f.comDropBoardParts), f.comDropBoardFrames),
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
    // penKnee (extra knee bend in the penultimate) is not shown since 2026-11-23: its band had no
    // finalist or study behind it. Only metrics with a published norm are graded.
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
  // The free thigh's peak inside the contact and how far it has fallen by toe-off.
  {
    let peak = null;
    for (let i = T.td; i <= T.to; i++) {
      const k = track[i];
      if (!k || !has(k, free + 'hip', free + 'knee')) continue;
      const v = thighDrive(k, free, dir);
      if (!peak || v > peak.v) peak = { v, i };
    }
    const kTO = track[T.to];
    if (peak && kTO && has(kTO, free + 'hip', free + 'knee')) {
      const early = ms(T.to - peak.i), drop = peak.v - thighDrive(kTO, free, dir);
      add('freeDrop', early > 20 ? Math.max(0, drop) : 0, T.to, true);
      const m = out.at(-1); if (m?.key === 'freeDrop') m.peakMs = early;
    }
  }
  // Legs forward for the landing: the first frame after toe-off with both ankles half a leg ahead of
  // the hips and both knees at 150° or more, against the flight apex.
  if (ev.apex != null && landing != null) {
    let out1 = null;
    for (let i = T.to + 1; i < landing && out1 == null; i++) {
      const k = track[i];
      if (!k || !has(k, 'lhip', 'rhip', 'lknee', 'rknee', 'lank', 'rank')) continue;
      const leg = f => dist(P(k, f + 'hip'), P(k, f + 'knee')) + dist(P(k, f + 'knee'), P(k, f + 'ank'));
      const ahead = f => (P(k, f + 'ank')[0] - P(k, f + 'hip')[0]) * dir >= 0.5 * leg(f);
      if (ahead('l') && ahead('r') && knee(k, 'l') >= 150 && knee(k, 'r') >= 150) out1 = i;
    }
    if (out1 != null) add('legsOut', ms(out1 - ev.apex), out1, true);
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
