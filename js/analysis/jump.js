// The jump analysis as data: no DOM, importable in Node, so phone and server cannot disagree.
// Shape: docs/v1-contract.md.
import { detectContacts, keyFrames, withEvents } from './events.js';
import { measure, flightMetrics, scoreMetric, viewYaw, scaleReason } from './metrics.js';
import { flightAnalysis } from './flight.js';
import { sharpen } from './kinematics.js';
import { techniqueScore, coaching, PHASES } from './coach.js';

const KF_LABELS = {
  td3: 'Tretí krok od konca', penTD: 'Dotyk predposledného', penTO: 'Odlepenie predposledného',
  TD: 'Dotyk na doske', maxFlex: 'Najväčší ohyb kolena', TO: 'Odraz', apex: 'Vrchol letu', land: 'Dopad',
};
const PHASE_KF = { pen: ['td3', 'penTD', 'penTO'], plant: ['TD', 'maxFlex'], toeoff: ['TO'], flight: ['apex'], landing: ['land'] };

const viewYawAt = (track, i) => (track[i] ? viewYaw(track[i]) : NaN);

// value → target, per-metric score; hidden metrics have neither.
function finish(m) {
  const hidden = m.status === 'hidden', [lo, hi] = m.norm;
  return {
    ...m, reason: m.reason ?? null, estimate: m.estimate ?? false,
    score: hidden ? null : scoreMetric(m),
    target: hidden ? null : Math.min(hi, Math.max(lo, m.value)),
  };
}

// Consecutive frame ranges for the timeline bands. With the landing hidden the flight runs to
// the end of the clip and the landing phase is the single last frame.
function buildPhases(ev, metrics, score, last) {
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const kf = Object.fromEntries(ev.keyFrames.map(k => [k.id, k]));
  const T = ev.takeoff, flex = kf.maxFlex?.frame ?? T.td, land = ev.landing ?? last;
  const start = kf.td3?.frame ?? kf.penTD?.frame ?? Math.max(0, T.td - 1);
  const range = {
    pen: [start, T.td - 1, kf.penTD?.frame ?? start],
    plant: [T.td, flex, T.td],
    toeoff: [flex + 1, T.to, T.to],
    flight: [T.to + 1, land - 1, ev.apex ?? T.to + 1],
    landing: [land, ev.landing != null ? Math.min(last, land + 15) : last, land],
  };
  return PHASES.map(p => {
    const [from, to, frame] = range[p.id];
    return {
      id: p.id, label: p.label, weight: p.weight,
      score: score.phases.find(s => s.id === p.id)?.score ?? null,
      from, to, frame,
      keyFrames: PHASE_KF[p.id].map(id => kf[id]).filter(Boolean).map(k => ({ id: k.id, label: k.label, frame: k.frame })),
      metrics: p.keys.map(k => by[k]).filter(Boolean),
    };
  });
}

// How far to trust the speed card, from the fit itself.
function speedCard(flight, by, ev, track) {
  const last = by.speedLast ?? null, takeoff = by.speedTO ?? null, loss = by.speedLoss ?? null;
  // A percentage is a ratio of two speeds: the gravity scale cancels, so a short arc doesn't hurt it.
  const lossPct = flight && !flight.error && flight.angleOk && Number.isFinite(flight.speedLast) && flight.speedLast > 0
    ? ((flight.speedLast - flight.vxTO) / flight.speedLast) * 100 : null;
  if (!flight || flight.error) return { last, takeoff, loss, lossPct, sure: 'nízka', note: 'Z videa sa nedala určiť mierka.' };
  const yaw = ev.pen ? viewYawAt(track, ev.pen.td) : NaN;
  if (!flight.scaleOk) {
    const why = scaleReason(flight);
    return { last, takeoff, loss, lossPct, sure: 'nízka', note: `${why[0].toUpperCase()}${why.slice(1)}.${lossPct != null ? ' Percentá sú orientačné.' : ''}` };
  }
  const cleanFit = flight.fitRmsM < 0.015 && flight.fitSeconds >= 0.5 && flight.torsoM >= 0.45 && flight.torsoM <= 0.58;
  const oblique = Number.isFinite(yaw) && yaw > 15;
  // The body shrinking or growing in flight means the athlete moved away from or towards the
  // phone, and one scale for the whole arc is then only an average (IMG_2674: 33% smaller).
  const depth = Number.isFinite(flight.depth) && Math.abs(flight.depth - 1) > 0.15;
  if (cleanFit && !oblique && !depth) return { last, takeoff, loss, lossPct, sure: 'vysoká', note: 'Mierka z letu sedí a kamera je zboku.' };
  const why = [
    oblique && `kamera je pri predposlednom kroku asi ${yaw.toFixed(0)}° šikmo, takže skutočná rýchlosť môže byť o niečo vyššia`,
    depth && `v lete sa ${flight.depth < 1 ? 'vzďaľuješ od kamery' : 'približuješ ku kamere'} (telo sa zmení o ${Math.round(Math.abs(1 - flight.depth) * 100)} %), takže mierka je len priemerná`,
  ].filter(Boolean).join('; ') || 'mierka z letu je len približná';
  return { last, takeoff, loss, lossPct, sure: 'stredná', note: `Odhad z videa: ${why}.` };
}


// ts: the clip's real frame timestamps, used when the result doesn't carry a frame rate.
export function analyzeJump(result, sex, ts) {
  const clean = result.clean, smooth = result.smooth;
  if (!clean || !smooth) return { error: 'Chýba vyčistený záznam pohybu.' };
  const fps = result.fps ?? (ts ? (ts.length - 1) / (ts.at(-1) - ts[0]) : NaN);
  if (!(fps > 0)) return { error: 'Neznáma snímková frekvencia.' };
  // Key frames Claude named on the server win over the ones detected from the pose track.
  const named = result.events?.TD != null && result.events?.TO != null ? result.events : null;
  const contacts = withEvents(clean, detectContacts(clean, result.first, result.last, fps), named, fps);
  const ev = keyFrames(clean, contacts, fps, sex, { events: named });
  if (ev.error) return { ...ev, error: 'V zázname sa nenašiel odraz.' };
  ev.keyFrames = ev.keyFrames.map(k => ({ ...k, label: KF_LABELS[k.id] ?? k.label }));
  const dir = contacts[0]?.dir ?? 1;
  const times = ts ?? Array.from({ length: clean.length }, (_, i) => i / fps);
  const flight = flightAnalysis(smooth, ev, times, sex, dir);
  const metrics = [...measure(sharpen(clean, fps), ev, fps, sex, dir, clean), ...flightMetrics(flight, ev, sex)].map(finish);
  const score = techniqueScore(metrics);
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const last = result.last ?? clean.length - 1;
  return {
    ...ev, dir, fps, flight, metrics, score, eventsSource: named ? 'claude' : 'pose',
    coach: coaching(metrics, sex),
    phases: buildPhases(ev, metrics, score, last),
    speed: speedCard(flight, by, ev, smooth),
    replay: {
      from: Math.max(result.first ?? 0, ev.takeoff.td - Math.round(fps)),
      to: ev.landing != null ? Math.min(last, ev.landing + Math.round(fps / 2)) : last,
    },
  };
}
