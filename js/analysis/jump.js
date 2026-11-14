// The jump analysis as data: no DOM, importable in Node, so phone and server cannot disagree.
// Shape: docs/v1-contract.md.
import { detectContacts, keyFrames, withEvents } from './events.js';
import { countSteps } from './stepcount.js';
import { adjustForRunup, judgedSteps, expectedDistance } from './runup.js';
import { measure, flightMetrics, scoreMetric, viewYaw, scaleReason, NORMS } from './metrics.js';
import { flightAnalysis } from './flight.js';
import { groundAnalysis } from './ground.js';
import { refineTouchdowns } from './refine.js';
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
const NO_LANDING = new Set(['landingReach', 'kneeLand', 'hipLand', 'estDistance', 'flight']);

function buildPhases(ev, metrics, score, last, runThrough = false) {
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
      ...(runThrough && p.id === 'landing' ? { note: 'Prebeh: dopad na nohu a beh cez piesok, dopad sa nehodnotí.' } : {}),
    };
  });
}

// The flight with every metre replaced by the runway's. Angles and the apex timing are image
// ratios and stay. The instant speeds at touchdown are left out: the flight into the board is
// only 7-11 frames and read 0.3-0.5 m/s apart between methods on our clips.
function withGround(f, g) {
  return {
    ...f, ground: g, scaleSource: 'board', scaleOk: true, scaleWhy: null,
    vxTO: g.vxTO, speedLast: g.speedLast, speedLoss: g.speedLoss, speedLossTO: g.speedLossPct,
    vxTD: NaN, velocityLoss: NaN,
    // the two lowerings on the leg as measured against the board, same instants as above
    ...lowerings(g, f),
    // Vertical speed comes from the time to the apex (g x t, no scale), so with the runway's
    // horizontal speed the angle no longer depends on the gravity fit.
    // The fit's own gate (3 cm) is for a gravity scale; here it only has to place the apex, and a
    // far, panning phone leaves a few cm of wobble on the arc (IMG_4677: 3.0 cm, apex at 0.24 s of
    // 0.68 s seen, angle hidden for no good reason). 5 cm with the apex well inside the arc.
    ...((f.apexOk || (f.fitRmsM < 0.05 && f.tUp > 0.05 && f.tUp < f.fitSeconds - 0.08)) && Number.isFinite(f.vyTO)
      ? { takeoffAngle: (Math.atan2(f.vyTO, g.vxTO) * 180) / Math.PI, angleOk: true, apexOk: true } : {}),
    takeoffSpeed: Math.hypot(g.vxTO, f.vyTO),
    takeoffDist: g.takeoffDist, flightDistance: g.vxTO * g.flightTime, landingReach: g.landingReach, estDistance: g.jump,
  };
}

// What the side-view chart draws: the measured centre of mass up to toe-off, the planted toes,
// the take-off line and the sand, and the flight to the landing from the take-off speeds
// (horizontal from the runway, vertical from the time to the apex) - drawn dashed, as a model.
function profileData(f, ev) {
  const g = f?.ground;
  if (!g || !g.series?.length) return null;
  const hTO = g.series.at(-1).h;
  const T = Number.isFinite(g.flightTime) ? g.flightTime : null;
  const flight = T && Number.isFinite(f.vyTO) && Number.isFinite(g.vxTO)
    ? { xTO: g.comXTO, hTO, vx: g.vxTO, vy: f.vyTO, T } : null;
  return {
    series: g.series.map(p => ({ t: +p.t.toFixed(4), x: +p.x.toFixed(3), h: +p.h.toFixed(3) })),
    toes: g.steps.map(st => { const c = g.series.find(p => p.i === st.td); return { id: st.id, x: st.toeX, com: c ? { x: +c.x.toFixed(3), h: +c.h.toFixed(3) } : null }; }),
    lineX: g.boardM, landX: g.landX, jump: g.jump, flight, toeTO: g.toeTO,
    parts: [g.takeoffDist, g.vxTO * g.flightTime, g.landingReach].every(Number.isFinite) ? { takeoff: g.takeoffDist, flight: g.vxTO * g.flightTime, landing: g.landingReach } : null,
    timeline: g.steps.map(st => ({ id: st.id, contactMs: st.contactMs, flightMs: st.flightMs ?? null })),
  };
}

// Metrics built from other metrics and the runway's contacts (research 2026-11-10: what the World
// Athletics and Berlin reports carry that we could read). Hidden when what they rest on is hidden.
function derivedMetrics(base, ev, f, fps, sex, height) {
  const by = Object.fromEntries(base.map(m => [m.key, m]));
  const g = sex === 'female' ? 'f' : 'm', out = [];
  const add = (key, value, frame, { hiddenBy = [], estimate = true, reason = null } = {}) => {
    if (value == null || !Number.isFinite(value)) return;
    const n = NORMS[key], [lo, hi] = n[g];
    const hid = hiddenBy.find(m => !m || m.status === 'hidden');
    const status = hid !== undefined ? 'hidden' : value < lo ? 'low' : value > hi ? 'high' : 'ok';
    out.push({ key, label: n.label, unit: n.unit, value, norm: [lo, hi], status, frame, good: n.good, estimate, reason: status === 'hidden' ? reason ?? hid?.reason ?? 'kamera nie je dosť zboku' : null });
  };
  const tdm = by.kneeTD, mn = by.kneeMin;
  if (tdm && mn && mn.frame > ev.takeoff.td) add('kneeVel', Math.abs(mn.value - tdm.value) / ((mn.frame - ev.takeoff.td) / fps), mn.frame, { hiddenBy: [tdm, mn] });
  if (by.trunkTD && by.trunkTO) add('trunkRotBoard', by.trunkTO.value - by.trunkTD.value, ev.takeoff.to, { hiddenBy: [by.trunkTD, by.trunkTO] });
  const st = Object.fromEntries((f?.ground?.steps ?? []).map(s => [s.id, s]));
  if (st.take) add('touchdownDist', st.take.tdDist, ev.takeoff.td);
  if (st.take && height) add('toHeight', (st.take.com.to * 100 / height) * 100, ev.takeoff.to);
  if (st.third?.length && st.pen?.length) add('stepChange', ((st.pen.length - st.third.length) / st.third.length) * 100, ev.pen?.td ?? null);
  return out;
}

function lowerings(g, f) {
  const by = Object.fromEntries((g.steps ?? []).map(s => [s.id, s]));
  const out = {};
  const pen = by.pen, third = by.third, take = by.take;
  if (third && pen && Number.isFinite(third.com.td - pen.com.td)) { out.hipDrop = (third.com.td - pen.com.td) * 100; out.hipDropFrame = pen.td; }
  if (pen && take && Number.isFinite(pen.com.to - take.com.low)) { out.comDropBoard = (pen.com.to - take.com.low) * 100; out.comDropBoardFrame = take.com.lowFrame; }
  return out;
}

const pct = k => `${k > 1 ? '+' : '−'}${Math.abs((k - 1) * 100).toFixed(1).replace('.', ',')} %`;
function tapeNote(t) {
  if (!t) return '';
  const m = v => `${v.toFixed(2).replace('.', ',')} m`, where = t.from === 'toe' ? 'od špičky' : 'od dosky';
  if (t.applied) return ` Mierku spresnilo pásmo: ${pct(t.k)} (video ${m(t.video)} ${where}, pásmo ${m(t.tape)}). Dĺžky krokov, rýchlosti aj výšky sú prepočítané.`;
  if (t.tooFar) return ` Pásmo sa od videa líši o ${pct(t.k)}, čo je viac, než môže byť chyba mierky. Skôr je zle prečítaná stopa v piesku alebo dopad, preto nič neprepočítavam.`;
  return '';
}

// How far to trust the speed card, from the fit itself.
function speedCard(flight, by, ev, track) {
  const last = by.speedLast ?? null, takeoff = by.speedTO ?? null, loss = by.speedLoss ?? null;
  // A percentage is a ratio of two speeds: the gravity scale cancels, so a short arc doesn't hurt it.
  const lossPct = flight && !flight.error && flight.angleOk && Number.isFinite(flight.speedLast) && flight.speedLast > 0
    ? ((flight.speedLast - flight.vxTO) / flight.speedLast) * 100 : null;
  if (!flight || flight.error) return { last, takeoff, loss, lossPct, sure: 'nízka', note: 'Z videa sa nedala určiť mierka.' };
  if (flight.scaleSource === 'board') {
    const g = flight.ground, cm = v => Math.round(v * 100);
    // Far past the line is a short run-up from a spot nearer the sand (Stanley: 8-10 steps take
    // off about 1 m from the sand on purpose), not a foul, so it is not mentioned at all.
    const toLine = !Number.isFinite(g.toeToLine) || g.toeToLine < -0.3 ? ''
      : g.toeToLine >= 0 ? `Odraz ${cm(g.toeToLine)} cm pred čiarou dosky.` : `Prešľap o ${cm(-g.toeToLine)} cm.`;
    const diff = Math.round(Math.abs(g.legRatio - 1) * 100);
    const sp = g.splits ?? {}, fine = v => (Number.isFinite(v) && v > 0.7 && v < 2.5 ? v : null);
    const cones = sp.coneScale ? ` Mierku spresnili Freelap kužele (10 m medzi nimi): ${sp.coneScale > 1 ? '+' : '−'}${Math.abs(Math.round((sp.coneScale - 1) * 100))} % oproti samotnej doske.` : '';
    const splitNote = fine(sp.s1to11) ? ' Čas 1–11 m je z videa tak, ako ho meria Freelap: ťažisko 80 cm pred kužeľmi na 0,2 a 10,2 m. Proti Freelapu raz overené: 1,07 s z videa, 1,10 s Freelap.'
      : Number.isFinite(sp.withheld) ? ` Čas 1–11 m neukazujem: z kužeľov vyšlo ${sp.withheld.toFixed(2).replace('.', ',')} s, čo nesedí s rýchlosťou rozbehu pri doske. Kužele sú na to v zábere príliš ďaleko.` : '';
    return { last, takeoff, loss, lossPct: Number.isFinite(g.speedLossPct) ? g.speedLossPct : null, sure: g.sure, board: true,
      jumpFromToe: Number.isFinite(g.jump) && ev.landing != null ? g.jump : null,
      split1to11: fine(sp.s1to11), split11to21: fine(sp.s11to21), cones: !!sp.coneScale,
      tapeFix: g.tapeFix ?? null, toeToLine: Number.isFinite(g.toeToLine) ? g.toeToLine : null,
      note: `Metre z dosky (čiara odrazu ${String(g.boardM).replace('.', ',')} m od piesku).${cones}${tapeNote(g.tapeFix)} Kontrola s dĺžkou nohy: rozdiel ${diff} %. Rýchlosti asi ±0,2 m/s, dĺžka skoku asi ±0,2 m.${splitNote}${toLine ? ` ${toLine}` : ''}` };
  }
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


// The tape measure as a check on the video's metres (Stanley, 2026-11-14: "keď zmením dĺžku …
// vie nejak dopočítať … spresniť keď vidí rozdiel v realite?"). Every metre in groundAnalysis
// scales with one number, so the ratio tape / video moves all of them: step lengths, speeds, the
// take-off distance and the heights. Times and angles stay. A gap over 8 % is more than a scale
// error can be (the board scale is about ±3 %, ground.js); the landing mark or the landing frame
// was read wrong, and scaling everything by it would spread that error, so it is only reported.
export const TAPE_MAX = 0.08;
export function tapeFix(g, tape, from) {
  if (!(tape > 0) || !Number.isFinite(g.jump)) return null;
  // Stanley's group always measures from the take-off toe (2026-11-14: "vždy meriame od špičky").
  const ref = from ?? 'toe';
  const video = ref === 'toe' || !Number.isFinite(g.toeToLine) ? g.jump : g.jump - g.toeToLine;
  if (!(video > 0)) return null;
  const k = tape / video, off = Math.abs(k - 1);
  return { tape, video: +video.toFixed(3), from: ref, k: +k.toFixed(4), applied: off >= 0.005 && off <= TAPE_MAX, tooFar: off > TAPE_MAX };
}

// ts: the clip's real frame timestamps, used when the result doesn't carry a frame rate.
// height: the athlete's height in cm (centre-of-mass lowering in cm); optional.
// pb: the athlete's full run-up PB in metres; runup: the run-up steps the athlete confirmed. With a
// run-up shorter than the full one the speed-dependent norms move to it (runup.js).
// tape: the distance the athlete measured; tapeFrom: 'board' (from the take-off line, the default)
// or 'toe' (from the take-off toe). See tapeFix.
export function analyzeJump(result, sex, ts, { height = null, pb = null, runup = null, tape = null, tapeFrom = null } = {}) {
  const clean = result.clean, smooth = result.smooth;
  if (!clean || !smooth) return { error: 'Chýba vyčistený záznam pohybu.' };
  const fps = result.fps ?? (ts ? (ts.length - 1) / (ts.at(-1) - ts[0]) : NaN);
  if (!(fps > 0)) return { error: 'Neznáma snímková frekvencia.' };
  // Key frames Claude named on the server win over the ones detected from the pose track.
  // Their touchdowns are then moved to the first frame the foot is really down (raw track).
  const named0 = result.events?.TD != null && result.events?.TO != null ? result.events : null;
  const refined = named0 ? refineTouchdowns(result, named0, { height }) : null;
  const named = refined ? refined.events : null;
  const contacts = withEvents(clean, detectContacts(clean, result.first, result.last, fps), named, fps);
  const ev = keyFrames(clean, contacts, fps, sex, { events: named });
  if (ev.error) return { ...ev, error: 'V zázname sa nenašiel odraz.' };
  ev.keyFrames = ev.keyFrames.map(k => ({ ...k, label: KF_LABELS[k.id] ?? k.label }));
  const dir = contacts[0]?.dir ?? 1;
  const times = ts ?? Array.from({ length: clean.length }, (_, i) => i / fps);
  const air = flightAnalysis(smooth, ev, times, sex, dir, height);
  // Metres from the runway when the server found it; the gravity scale is only the fallback.
  let ground = result.ground && !air.error ? groundAnalysis(result.ground, smooth, ev, times, sex, height) : null;
  const fix = ground && !ground.error ? tapeFix(ground, tape, tapeFrom) : null;
  if (fix?.applied) ground = groundAnalysis(result.ground, smooth, ev, times, sex, height, fix.k);
  if (fix && ground && !ground.error) ground.tapeFix = fix;
  const flight = ground && !ground.error ? withGround(air, ground) : air;
  // A run-through (pop-up, named by Claude on the server) lands on one foot and runs out: no
  // landing to measure, and the flight ends early, so flight time and the distance estimate go too.
  const runThrough = result.events?.kind === 'runthrough';
  const base = [...measure(sharpen(clean, fps), ev, fps, sex, dir, clean), ...flightMetrics(flight, ev, sex)];
  // Run-up step count from the start to the board (stepcount.js); seen=false when the clip
  // begins mid run-up and the number is only what the video shows.
  const stepCount = countSteps(clean, { td: ev.takeoff.td, foot: ev.takeoffFoot, fps, first: result.first ?? 0 });
  const steps = judgedSteps(runup, stepCount);
  const metrics = adjustForRunup([...base, ...derivedMetrics(base, ev, flight, fps, sex, height)], steps, { pb })
    .filter(m => !(runThrough && NO_LANDING.has(m.key))).map(finish);
  const score = techniqueScore(metrics);
  const by = Object.fromEntries(metrics.map(m => [m.key, m]));
  const last = result.last ?? clean.length - 1;
  return {
    ...ev, dir, fps, flight, metrics, score, eventsSource: named ? 'claude' : 'pose', kind: runThrough ? 'runthrough' : 'jump',
    coach: coaching(metrics, sex),
    phases: buildPhases(ev, metrics, score, last, runThrough),
    speed: speedCard(flight, by, ev, smooth),
    // The last three contacts in metres and milliseconds, only when the runway gave the scale.
    steps: flight?.ground?.steps ?? null, stepsHeightCm: height ?? null,
    stepCount,
    // The run-up the norms were judged at, and the distance a full effort from it should reach.
    runupJudged: steps, expected: steps ? expectedDistance(steps, pb) : null,
    profile: profileData(flight, ev),
    lowering: flight?.scaleSource === 'board' ? { intoPen: flight.hipDrop, intoBoard: flight.comDropBoard } : null,
    replay: {
      from: Math.max(result.first ?? 0, ev.takeoff.td - Math.round(fps)),
      to: ev.landing != null ? Math.min(last, ev.landing + Math.round(fps / 2)) : last,
    },
  };
}
