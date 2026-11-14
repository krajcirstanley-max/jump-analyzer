// "O koľko ďalej": what fixing each fault of THIS jump is worth, with the norm as the target, what
// else moves with it, and the cue for it (Stanley, 2026-11-14). Rules he set the same day:
// - no "realistic per season" limits: the athlete may not have gone flat out, or it may be pure
//   technique that one cue fixes, so the target is the norm on the card, nothing less;
// - "ako na to" is the cue only, never an exercise;
// - one thing at a time: the faults are ranked and one is recommended; the next video may pick
//   another;
// - one change moves the others ("keď zmeníš jednu vec, zmenia sa aj ostatné"): couplings are
//   applied, and gains are never summed.
// Sources and couplings: vault "Jump Video Analyzer - speed and distance research", What-if levers
// (Linthorne 2005, Bridgett & Linthorne 2006, Béres 2014, Czech men n=45 regression, Nemtsev 2016).
import { coaching, FAULT_INFO } from './coach.js';

const G = 9.81;
const rad = d => (d * Math.PI) / 180;

// Horizontal take-off speed lost per +1 m/s of vertical speed bought, at a given angle: it grows
// as the angle rises (Linthorne 2005, athlete 1, measured curve: 16-18° 0.4-0.9, 20° 1.6, 22° 3.2,
// which is why the optimum sits near 21°). Piecewise linear through those points.
const K_PTS = [[14, 0.3], [16, 0.45], [18, 0.9], [20, 1.6], [22, 3.2], [26, 5]];
function vxCostPerVy(angle) {
  if (angle <= K_PTS[0][0]) return K_PTS[0][1];
  for (let i = 1; i < K_PTS.length; i++) {
    const [a0, k0] = K_PTS[i - 1], [a1, k1] = K_PTS[i];
    if (angle <= a1) return k0 + ((angle - a0) / (a1 - a0)) * (k1 - k0);
  }
  return K_PTS.at(-1)[1];
}
// Walks the take-off from its angle to the target in small steps, each paying the horizontal
// speed that angle costs; f scales the cost for the band (0.6 / 1.4).
function steer(vx, vy, target, f) {
  let a = (Math.atan2(vy, vx) * 180) / Math.PI;
  for (let i = 0; i < 400 && a < target - 1e-6; i++) {
    const next = Math.min(target, a + 0.1), k = f * vxCostPerVy((a + next) / 2), t = Math.tan(rad(next));
    const vy1 = (t * (vx + k * vy)) / (1 + k * t);
    vx -= k * (vy1 - vy); vy = vy1; a = next;
  }
  return { vx1: vx, vy1: vy };
}

// Flight time from the take-off vertical speed and the drop from take-off to landing height.
const flightTime = (vy, drop) => (vy + Math.sqrt(Math.max(0, vy * vy + 2 * G * drop))) / G;

// One entry per fault the coaching found: { id, title, metricKey, now, target, unit, gain: [lo, hi]
// in metres or null, basis: 'fyzika' | 'štúdie', moves: text, cue }.
// preferKey: the metric the coaching on screen leads with (server text), so the pick agrees with it.
export function whatIf(jump, sex = 'male', { preferKey = null } = {}) {
  if (!jump || jump.error) return null;
  const metrics = jump.metrics ?? [];
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const fl = jump.flight ?? {}, g = fl.ground ?? {};
  const vx = fl.vxTO, vy = fl.vyTO;
  const T = Number.isFinite(g.flightTime) ? g.flightTime : NaN;
  const drop = Number.isFinite(T) && Number.isFinite(vy) ? ((G * T - vy) ** 2 - vy * vy) / (2 * G) : NaN;
  const physics = Number.isFinite(vx) && Number.isFinite(vy) && Number.isFinite(T) && drop > -0.2;
  const edge = (m, side) => (side === 'high' ? m.norm[1] : m.norm[0]);
  const ranked = coaching(metrics, sex, { all: true }).ranked ?? [];

  const items = ranked.map(({ id, m, cue }) => {
    const info = FAULT_INFO[id] ?? {};
    const side = m.status;
    const target = edge(m, side);
    const out = { id, title: info.title ?? m.label, metricKey: m.key, label: m.label, now: m.value, target, unit: m.unit, gain: null, basis: null, moves: null, cue };
    const miss = Math.abs(m.value - target);

    if (id === 'flat' && physics) {
      // vy' and vx' that give the target angle, with vx' = vx - k(vy' - vy).
      const at = f => { const { vx1, vy1 } = steer(vx, vy, target, f); const T1 = flightTime(vy1, drop); return { vx1, vy1, T1, d: vx1 * T1 - vx * T }; };
      const a = at(1.4), b = at(0.6);
      out.gain = [Math.min(a.d, b.d), Math.max(a.d, b.d)];
      out.basis = 'fyzika';
      const dv = [vx - b.vx1, vx - a.vx1].map(v => v.toFixed(1).replace('.', ',')).join(' až ');
      out.moves = `Zvislá rýchlosť +${(b.vy1 - vy).toFixed(1).replace('.', ',')} m/s, vodorovná −${dv} m/s, let dlhší o ${(((a.T1 + b.T1) / 2 - T) * 100).toFixed(0)} stotín.`;
    } else if (id === 'speedLow') {
      // 70-80 % of the approach gain reaches the take-off (Bridgett & Linthorne 2006; Béres 2014).
      const dvx = [0.7 * miss, 0.8 * miss];
      out.gain = physics ? dvx.map(v => v * T) : [0.6 * miss, 0.8 * miss];
      out.basis = physics ? 'fyzika' : 'štúdie';
      out.moves = 'Uhol odrazu trochu klesne, strata rýchlosti na doske trochu narastie, zvislá rýchlosť ostane.';
    } else if (id === 'hipDropHigh') {
      out.gain = [0.05, 0.10];
      out.basis = 'štúdie';
      out.moves = 'Udržíš rýchlosť a kontakty sa skrátia. Zvislá rýchlosť môže trochu klesnúť.';
    } else if (id === 'sitting' && m.key === 'contactPen') {
      // Czech men: 10 ms longer penultimate contact at the same speed costs 4.7 cm.
      out.gain = [0.6 * 0.0047 * miss, 1.4 * 0.0047 * miss];
      out.basis = 'štúdie';
      out.moves = 'Rýchlosť do dosky stúpne a kontakt na doske sa skráti.';
    } else if (id === 'longContact' && m.key === 'contactTO') {
      // 2.4 cm (Czech men) to 16 cm (Nemtsev, women) per 10 ms at the same speed.
      out.gain = [0.0024 * miss, 0.016 * miss];
      out.basis = 'štúdie';
      out.moves = 'Menej brzdenia na doske. Zvislá rýchlosť sa udrží, len ak na to je sila.';
    } else if (id === 'landing' && m.key === 'landingReach') {
      out.gain = [miss, miss];
      out.basis = 'fyzika';
      out.moves = 'Nič iné sa nemení, je to čistý dosah nôh.';
    }
    return out;
  });

  // The one thing: the coaching's first fix (it carries the cue; its order follows the takeoff →
  // approach → vertical → speed priority and the cost), so the card and "Hlavná vec" agree.
  const lead = preferKey ? items.findIndex(x => x.metricKey === preferKey) : -1;
  if (lead > 0) items.unshift(items.splice(lead, 1)[0]);
  const pick = items[0]?.id ?? null;
  const g2 = items.filter(x => x.gain).map(x => x.gain).sort((a, b) => b[1] - a[1]);
  const together = g2.length >= 2 ? [g2[0][0] + g2[1][0] / 3, g2[0][1] + g2[1][1] / 3] : null;
  return { items, pick, together };
}
