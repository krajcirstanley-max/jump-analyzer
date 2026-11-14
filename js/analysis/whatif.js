// "O koľko ďalej": what fixing each fault of THIS jump is worth, with the norm as the target.
// Rules Stanley set on 2026-11-14:
// - no "realistic per season" limits: the target is the norm on the card (he may not have gone
//   flat out, or it is technique that one cue fixes);
// - "ako na to" is the cue only, never an exercise;
// - one thing at a time: ranked by what each fault costs in this jump, the first one is the pick;
// - one change moves the others: every fault lists what else moves and what that is worth in cm
//   ("z toho"), and the total for the change is their sum; different changes are never summed;
// - numbers, not guesses ("žiadne asi vyššie"): an effect is listed only when it can be put in cm;
// - a range only when it is narrow (he: "5-25 je priveľa").
// Coefficients and their sources: vault "Jump Video Analyzer - speed and distance research",
// What-if levers + verification 2026-11-14. They live in COEF so a correction is one line.
import { coaching, FAULT_INFO } from './coach.js';

const G = 9.81;
const rad = d => (d * Math.PI) / 180;

// Verified against the primary sources on 2026-11-14 (vault research note, "Verification"):
export const COEF = {
  // share of an approach-speed gain still there at toe-off: Béres 2014 Table 1, eight men of
  // Stanley's build on short run-ups, vx TD 7.09-8.21 → TO 6.41-7.07 m/s, least squares 0.585;
  // Bridgett & Linthorne 2006 (elite, 10.4 m/s) imply 0.70. Not the 6-8 cm per 0.1 m/s slope:
  // that has a 0.84 s flight built in; his own flight time is used instead.
  transfer: [0.55, 0.70],
  // take-off speed against take-off angle, Linthorne, Guzman & Bridgett 2005 eq. 4, Table III,
  // athlete 1 (1.88 m, 92 jumps, best-determined fit): v = (vmax - vmin) / (1 + (θ/θinf)^a) + vmin
  lin: { vmax: 9.9, vmin: 3.9, a: 6.8, inf: 30.2 },
  // a steeper take-off also shortens the take-off and landing distances: Table V C2 0.0053 and
  // D2 0.0020 per degree, times body height
  linDist: 0.0053 + 0.0020,
  // the spread of athlete 1's fitted parameters: interquartile 21-27 cm on 24 for IMG_4677
  linBand: [0.875, 1.125],
  // board contact, cm per ms at the same approach speed. Men: Czech n=45 regression, 2.4 ± 3.0 cm
  // per 10 ms (not significant). Women: Nemtsev 2016, 16.3 cm per 10 ms (n=21, overfit).
  contactCmPerMs: { m: [0.24, 0.24], f: [1.63, 1.63] },
  // board contact shortens by 0.6 % per +0.1 m/s of approach speed (contact ∝ v^-0.6)
  contactPerSpeed: 0.06,
  // take-off angle falls 1.5° per +1 m/s approach (Béres 2014), velocity lost rises 4.6 points per m/s
  anglePerSpeed: -1.5, lossPerSpeed: 4.6,
  // penultimate contact: cm per ms at the same speed (Czech n=45)
  penContactCmPerMs: [0.4, 0.55],
  // take-off CoM height norm as a share of body height (toHeight): Linthorne 2005 Table II,
  // 63.8 / 69.4 / 62.9 % for three men at 21-23.5°
  toHeightLo: 0.62,
  // a higher CoM from extending at the same lean also starts 1.0-1.9 cm further forward
  comForward: [0, 0.019],
};

const linV = th => { const { vmax, vmin, a, inf } = COEF.lin; return (vmax - vmin) / (1 + (th / inf) ** a) + vmin; };
const flightTime = (vy, drop) => (vy + Math.sqrt(Math.max(0, vy * vy + 2 * G * drop))) / G;
const band = (f, [a, b]) => { const x = f(a), y = f(b); return [Math.min(x, y), Math.max(x, y)]; };
const add = (...bs) => bs.reduce((s, b) => [s[0] + b[0], s[1] + b[1]], [0, 0]);
const mid = b => (b ? (b[0] + b[1]) / 2 : -Infinity);
const fx = (n, d) => Number(n).toFixed(d).replace('.', ',').replace('-', '−');
const sgn = (n, d) => `${n > 0 ? '+' : ''}${fx(n, d)}`;

// One entry per fault: { id, title, take, metricKey, label, now, target, unit, cue, effects, total,
// basis } where effects: [{ label, value, cm: [lo, hi] | null, kind: 'up' | 'down' | 'same' }].
// total is in metres; null when nothing could be put in cm. height: the athlete's height in cm.
export function whatIf(jump, sex = 'male', { height = null } = {}) {
  if (!jump || jump.error) return null;
  const g2 = sex === 'female' ? 'f' : 'm';
  const metrics = jump.metrics ?? [];
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const fl = jump.flight ?? {}, gr = fl.ground ?? {};
  const vx = fl.vxTO, vy = fl.vyTO, T = gr.flightTime;
  const drop = Number.isFinite(T) && Number.isFinite(vy) ? ((G * T - vy) ** 2 - vy * vy) / (2 * G) : NaN;
  const physics = Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(T) && drop > -0.2;
  const contactTO = by.contactTO?.value;
  const ranked = coaching(metrics, sex, { all: true }).ranked ?? [];

  const items = ranked.map(({ id, m, cue }) => {
    const info = FAULT_INFO[id] ?? {};
    const target = m.status === 'high' ? m.norm[1] : m.norm[0];
    const miss = Math.abs(m.value - target);
    const it = { id, title: info.title ?? m.label, take: info.take ?? null, metricKey: m.key, label: m.label, now: m.value, target, unit: m.unit, cue, effects: [], total: null, basis: null };
    const E = (label, value, cm, kind) => it.effects.push({ label, value, cm, kind: kind ?? (cm && mid(cm) < 0 ? 'down' : cm ? 'up' : 'same') });

    if (id === 'speedLow' && physics) {
      const dvx = band(t => t * miss, COEF.transfer);
      E('Vodorovná rýchlosť pri odraze', `${sgn(mid(dvx), 2)} m/s`, dvx.map(v => v * T));
      if (Number.isFinite(contactTO)) {
        const dms = contactTO * COEF.contactPerSpeed * miss;   // 0.6 % per 0.1 m/s
        E('Kontakt na doske', `−${fx(dms, 0)} ms`, COEF.contactCmPerMs[g2].map(c => (c * dms) / 100));
      }
      E('Uhol odrazu', `${sgn(COEF.anglePerSpeed * miss, 1)}°`, null, 'same');
      E('Strata rýchlosti na doske', `${sgn(COEF.lossPerSpeed * miss, 0)} %`, null, 'same');
      it.basis = 'fyzika';
    } else if (id === 'flat' && physics) {
      // His take-off speed moved along the measured speed-angle curve to the target angle.
      const th0 = (Math.atan2(vy, vx) * 180) / Math.PI, v0 = Math.hypot(vx, vy);
      const v1 = (v0 * linV(target)) / linV(th0), vx1 = v1 * Math.cos(rad(target)), vy1 = v1 * Math.sin(rad(target));
      const T1 = flightTime(vy1, drop), [b0, b1] = COEF.linBand, one = d => [d, d];
      const h = Number.isFinite(height) ? height / 100 : sex === 'female' ? 1.68 : 1.80;
      const parts = [vx * (T1 - T), (vx1 - vx) * T1, -h * COEF.linDist * (target - th0)];
      E('Zvislá rýchlosť', `${sgn(vy1 - vy, 2)} m/s · let ${sgn(T1 - T, 2)} s`, one(parts[0]));
      E('Vodorovná rýchlosť pri odraze', `${sgn(vx1 - vx, 2)} m/s`, one(parts[1]));
      E('Kratšia vzdialenosť pri odraze a doskoku', `strmší odraz o ${fx(target - th0, 1)}°`, one(parts[2]));
      // the band belongs to the net result (the fit's spread moves all three parts together)
      const net = parts.reduce((x, y) => x + y, 0);
      it.fixedTotal = [net * b0, net * b1].sort((p, q) => p - q);
      it.basis = 'fyzika';
    } else if (id === 'hipDropHigh' && physics) {
      // The deep sit keeps the whole board phase low: the take-off CoM rises by the extra drop,
      // up to the take-off height norm, and a flight from a higher CoM is longer.
      const tH = by.toHeight;
      const room = Number.isFinite(height) && tH && Number.isFinite(tH.value) ? Math.max(0, COEF.toHeightLo - tH.value / 100) * (height / 100) : Infinity;
      const dh = Math.min(miss / 100, room);
      if (dh > 0.002) {
        const T1 = flightTime(vy, drop + dh), now = tH?.value;
        E('Ťažisko pri odraze', `vyššie o ${fx(dh * 100, 1)} cm${Number.isFinite(now) ? ` (teraz ${fx(now, 0)} % výšky, norma ${fx(COEF.toHeightLo * 100, 0)} %)` : ''}`,
          COEF.comForward.map(f => vx * (T1 - T) + f));
        it.note = 'Časť tejto výšky príde aj so strmším odrazom, preto sa tieto dve zmeny nesčítavajú.';
      }
      // Speed lost through the penultimate in THIS jump (third-last step → last step), regained.
      const st = Object.fromEntries((gr.steps ?? []).map(s => [s.id, s]));
      const v3 = st.third?.speed, v2 = st.pen?.speed;
      if (Number.isFinite(v3) && Number.isFinite(v2)) {
        const lost = v3 - v2;
        if (lost > 0.02) E('Rýchlosť do dosky', `+${fx(lost, 2)} m/s (teraz ${fx(v3, 2)} → ${fx(v2, 2)})`, band(t => t * lost * T, COEF.transfer));
        else E('Rýchlosť do dosky', `bez straty v tomto skoku: ${fx(v3, 2)} → ${fx(v2, 2)} m/s`, [0, 0], 'same');
      }
      it.basis = 'fyzika';
    } else if (id === 'sitting' && m.key === 'contactPen') {
      // Czech men: −4.7 ± 4.7 cm per 10 ms at the same speed, not significant.
      E('Kratší predposledný kontakt', `−${fx(miss, 0)} ms`, COEF.penContactCmPerMs.map(c => (c * miss) / 100));
      it.basis = 'štúdie';
    } else if (id === 'longContact' && m.key === 'contactTO') {
      E('Menej brzdenia na doske', `−${fx(miss, 0)} ms`, COEF.contactCmPerMs[g2].map(c => (c * miss) / 100));
      it.basis = 'štúdie';
    } else if (id === 'landing' && m.key === 'landingReach') {
      E('Dosah nôh pri doskoku', `+${fx(miss * 100, 0)} cm`, [miss, miss]);
      it.basis = 'fyzika';
    }
    const counted = it.effects.filter(e => e.cm && e.kind !== 'same');
    it.total = it.fixedTotal ?? (counted.length ? add(...counted.map(e => e.cm)) : null);
    delete it.fixedTotal;
    return it;
  });

  // Ranked by what each fault costs in this jump; faults without a number go last, in the
  // coaching order (stable sort). The first one is the one thing to work on now.
  items.sort((a, b) => mid(b.total) - mid(a.total));
  const pick = items[0]?.id ?? null;
  const tot = items.filter(x => x.total).map(x => x.total);
  const together = tot.length >= 2 ? [tot[0][0] + tot[1][0] / 3, tot[0][1] + tot[1][1] / 3] : null;
  return { items, pick, together };
}
