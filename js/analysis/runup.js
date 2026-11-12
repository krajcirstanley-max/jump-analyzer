// What a run-up of N steps should give, and how the norms move with it (Stanley, 2026-11-12:
// "koľko by si mal skočiť z 50 % rozbehu, 75 % … a či sa biomechanika nemení podľa rýchlosti").
// Every jump counts as a maximal effort (Stanley: "dávať stále naplno").
//
// Source: Béres, Csende, Lees & Tihanyi 2014, Kinesiology 46(1):88-96. Eight men (PB 6.42-8.04 m),
// maximal jumps from 6, 8, 10 and 12 strides, then a competition from their full 18.5 strides.
// Vault: "Jump Video Analyzer - speed and distance research", short run-ups section.
//  - distance: 80.5 / 85.5 / 87.8 / 90.0 % of the competition distance at 6 / 8 / 10 / 12;
//    14 and 16 are read off their individual curves (92-97 %), so they are estimates.
//  - touchdown speed 7.09 / 7.52 / 7.88 / 8.21 m/s against ~8.9 predicted for the full run-up.
//  - what moves with speed: take-off angle 27.9 -> 26.2°, knee at touchdown 150 -> 159°, speed lost
//    on the board 10.2 -> 15.4 % (elite full run-up ~16 %). Bridgett & Linthorne 2006 agree on the
//    angle. What stays: vertical take-off speed, leg angle at touchdown, board contact.
// The elite norms in metrics.js are full run-up norms; for a short run-up the speed-dependent ones
// are moved by these tables so a normal short-run-up jump isn't coached as a fault.

export const FULL = 18;   // Stanley: "nikdy nechodíme viac ako 18 krokov"

const T = {
  dist: { 6: 0.805, 8: 0.855, 10: 0.878, 12: 0.90, 14: 0.93, 16: 0.965, 18: 1 },
  speed: { 6: 0.80, 8: 0.845, 10: 0.885, 12: 0.92, 14: 0.95, 16: 0.975, 18: 1 },
  angle: { 6: 3, 8: 3, 10: 2, 12: 1.5, 14: 1, 16: 0.5, 18: 0 },        // degrees added
  knee: { 6: -10, 8: -4, 10: -4, 12: -2, 14: -1, 16: -0.5, 18: 0 },   // degrees added
  loss: { 6: 0.63, 8: 0.80, 10: 0.95, 12: 0.96, 14: 1, 16: 1, 18: 1 }, // share of the full-run-up loss
};

// Linear between the even step counts; under 6 is read as 6 (no data shorter), over 18 as 18.
function at(table, n) {
  const x = Math.max(6, Math.min(FULL, n));
  const lo = Math.max(6, Math.floor(x / 2) * 2), hi = Math.min(FULL, lo + 2);
  if (lo === hi || table[lo] === undefined) return table[lo] ?? table[FULL];
  return table[lo] + ((table[hi] - table[lo]) * (x - lo)) / (hi - lo);
}

export const distanceFraction = n => at(T.dist, n);
export const speedFraction = n => at(T.speed, n);

// The distance a full-effort jump from n steps should reach, from the athlete's full run-up PB.
// The band is the study's spread (about -4 % to +3 % around the mean). null without a PB, or under
// 6 steps where there is no data.
export function expectedDistance(n, pb) {
  if (!(n >= 6) || !(pb > 0)) return null;
  const f = distanceFraction(n);
  return { steps: n, pct: f, mid: pb * f, lo: pb * (f - 0.04), hi: pb * Math.min(1, f + 0.03), pb };
}

// The full run-up distance a short-run-up jump points to (best / fraction).
export const fullFrom = (n, d) => (n >= 6 && d > 0 ? d / distanceFraction(n) : null);

const scale = (band, k) => [band[0] * k, band[1] * k].sort((a, b) => a - b);
const shift = (band, d) => [band[0] + d, band[1] + d];

// The norm for one metric at n steps, or the full-run-up norm unchanged. pb: the athlete's full
// run-up PB, for the distance.
export function runupNorm(key, band, n, { pb = null } = {}) {
  if (!(n > 0) || n >= FULL) return band;
  switch (key) {
    case 'takeoffAngle': return shift(band, at(T.angle, n));
    case 'kneeTD': return shift(band, at(T.knee, n));
    case 'speedLossTO': case 'velocityLoss': case 'speedLoss':
      return scale(band, at(T.loss, n) * (key === 'speedLossTO' ? 1 : speedFraction(n)));
    case 'speedTD': case 'speedLast': case 'speedTO': return scale(band, speedFraction(n));
    case 'estDistance': {
      const e = expectedDistance(n, pb);
      return e ? [e.lo, e.hi] : scale(band, distanceFraction(n));
    }
    default: return band;
  }
}

// Metrics (before scoring) with the speed-dependent norms moved to n steps.
export function adjustForRunup(metrics, n, opts = {}) {
  if (!(n > 0) || n >= FULL) return metrics;
  return metrics.map(m => {
    const norm = runupNorm(m.key, m.norm, n, opts);
    if (norm === m.norm) return m;
    const status = m.status === 'hidden' ? 'hidden' : m.value < norm[0] ? 'low' : m.value > norm[1] ? 'high' : 'ok';
    return { ...m, norm, status, fullNorm: m.norm, runup: n };
  });
}

// The step count the analysis judges by: the athlete's confirmed one, else a count with the start
// in view. A partial count (start not seen) is not used: it would make the run-up look shorter.
export const judgedSteps = (confirmed, sc) => confirmed ?? (sc?.seen ? sc.count : null);

// One athlete's run-ups against distance, for the Progres table. records: saved attempts.
// The distance is the tape when the athlete wrote it in, else the app's own from the video.
export function runupTable(records, pb) {
  const rows = new Map();
  for (const r of records) {
    const n = judgedSteps(r.runup ?? null, r.jump?.stepCount);
    const d = attemptDistance(r);
    if (!(n > 0) || d == null) continue;
    const row = rows.get(n) ?? { steps: n, jumps: 0, best: 0, sum: 0, taped: 0 };
    row.jumps++; row.sum += d; row.best = Math.max(row.best, d); if (r.measured != null) row.taped++;
    rows.set(n, row);
  }
  const list = [...rows.values()].sort((a, b) => a.steps - b.steps).map(r => ({
    ...r, mean: r.sum / r.jumps, pctPb: pb > 0 ? r.best / pb : null, expectedPct: r.steps >= 6 ? distanceFraction(r.steps) : null,
    full: fullFrom(r.steps, r.best),
  }));
  const fulls = list.map(r => r.full).filter(Number.isFinite);
  return { rows: list, full: fulls.length ? fulls.reduce((a, b) => a + b, 0) / fulls.length : null, from: fulls.length };
}

// Tape first, then the video: toe to the first mark in the sand, else the estimate from take-off.
export function attemptDistance(r) {
  if (r.measured > 0) return r.measured;
  const toe = r.jump?.speed?.jumpFromToe;
  if (toe > 0) return toe;
  const est = r.metrics?.estDistance;
  return est && est.s !== 'hidden' && est.v > 0 ? est.v : null;
}
