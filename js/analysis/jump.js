// The jump analysis as data: no DOM, importable in Node, so phone and server cannot disagree.
// Shape: docs/v1-contract.md.
import { detectContacts, keyFrames, withEvents, approachToeOffs } from './events.js';
import { countSteps } from './stepcount.js';
import { adjustForRunup, judgedSteps, expectedDistance } from './runup.js';
import { measure, flightMetrics, scoreMetric, viewYaw, scaleReason, NORMS } from './metrics.js';
import { flightAnalysis } from './flight.js';
import { groundAnalysis } from './ground.js';
import { refineTouchdowns, refineClaudeEdges } from './refine.js';
import { sharpen, has, P, torsoLength, centreOfMass, dropParts } from './kinematics.js';
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
const NO_LANDING = new Set(['landingReach', 'kneeLand', 'hipLand', 'estDistance', 'flight', 'legsOut']);

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
      keyFrames: PHASE_KF[p.id].map(id => kf[id]).filter(Boolean).map(k => ({ id: k.id, label: k.label, frame: k.frame, ...(k.hand ? { hand: true } : {}) })),
      metrics: p.keys.map(k => by[k]).filter(Boolean),
      ...(runThrough && p.id === 'landing' ? { note: 'Prebeh: dopad na nohu a beh cez piesok, dopad sa nehodnotí.' } : {}),
    };
  });
}

// The flight with every metre replaced by the runway's. Angles and the apex timing are image
// ratios and stay. The instant speeds at touchdown are left out: the flight into the board is
// only 7-11 frames and read 0.3-0.5 m/s apart between methods on our clips.
function withGround(f, g, hLand = NaN) {
  // Vertical speed at toe-off from the time in the air: the centre of mass leaves the board at the
  // runway's height and meets the sand at hLand, so vy = (hLand - hTO + g·T²/2) / T. Frame-exact
  // contacts make T good to 0.02 s, and 0.1 m of height moves the angle by about 1°. The time to the
  // fitted apex wandered on a following phone (2026-11-20, IMG_5162: apex 0.15 s into a 0.68 s
  // flight, vy 1.2 m/s, 7.9°, and the advice to jump higher); across 11 runway clips it read 7.9-19.7°
  // where the flight time reads 14.3-21.9°, inside the 15-24° of measured long jumps.
  const hTO = g.series?.at(-1)?.h, Tf = g.flightTime;
  const vyTime = Number.isFinite(hLand) && hLand > 0.2 && hLand < 1.3 && hTO > 0.6 && Tf > 0.3
    ? (hLand - hTO + 9.81 * Tf * Tf / 2) / Tf : NaN;
  const timed = vyTime > 0.5 && vyTime < 4.5;
  const vy = timed ? vyTime : f.vyTO;
  return {
    ...f, ground: g, scaleSource: 'board', scaleOk: true, scaleWhy: null, fitWhy: f.scaleWhy,
    vxTO: g.vxTO, speedLast: g.speedLast, speedLoss: g.speedLoss, speedLossTO: g.speedLossPct,
    approach: g.approach ?? NaN, speedKeep: g.approach > 0 ? (g.speedLast / g.approach - 1) * 100 : NaN,
    vxTD: NaN, velocityLoss: NaN,
    // the two lowerings stay flightAnalysis's (leg angles x real lengths, its instants and unsure flags)
    // Vertical speed comes from the time to the apex (g x t, no scale), so with the runway's
    // horizontal speed the angle no longer depends on the gravity fit.
    // The fit's own gate (3 cm) is for a gravity scale; here it only has to place the apex, and a
    // far, panning phone leaves a few cm of wobble on the arc (IMG_4677: 3.0 cm, apex at 0.24 s of
    // 0.68 s seen, angle hidden for no good reason). 5 cm with the apex well inside the arc.
    ...(timed
      ? { vyTO: vy, vyTOtime: vyTime, peakHeight: (vy * vy) / (2 * 9.81) * 100, takeoffAngle: (Math.atan2(vy, g.vxTO) * 180) / Math.PI, angleOk: true, apexOk: true }
      : (f.apexOk || (f.fitRmsM >= 0 && f.fitRmsM < 0.05 && f.fitSeconds >= 0.3 && f.tUp > 0.05 && f.tUp < f.fitSeconds - 0.08)) && Number.isFinite(f.vyTO)
      ? { takeoffAngle: (Math.atan2(f.vyTO, g.vxTO) * 180) / Math.PI, angleOk: true, apexOk: true } : {}),
    takeoffSpeed: Math.hypot(g.vxTO, vy),
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

// Every foot contact from the run-up to the board, then the flight to the landing: the "Zem,
// vzduch, let" card, rows the athlete taps to check them on the video (Stanley, 2026-11-14: "ako pri
// šprinte, nech to viem overiť"). The last three contacts take the runway-refined frames.
function timelineOf(contacts, ev, ground, landing, apex, fps) {
  const T = ev.takeoff;
  // under 0.07 s is a flicker of the tracking (a run-up contact is 0.09-0.14 s), not a step
  let cs = contacts.filter(c => c.td < T.td - 2 && c.to >= c.td && (c.to - c.td + 1) / fps >= 0.07).sort((a, b) => a.td - b.td);
  const clean = [];
  for (const c of cs) {
    const p = clean.at(-1);
    if (p && (c.td <= p.to || c.foot === p.foot)) { if (c.to - c.td > p.to - p.td) clean[clean.length - 1] = c; continue; }
    clean.push(c);
  }
  const rows = clean.map(c => ({ td: c.td, to: c.to, foot: c.foot, id: null }));
  rows.push({ td: T.td, to: T.to, foot: ev.takeoffFoot, id: 'take' });
  for (const st of ground?.steps ?? []) {
    const r = rows.find(x => Math.abs(x.td - st.td) <= 4);
    if (r) Object.assign(r, { td: st.td, to: st.to, id: st.id });
  }
  rows.forEach((r, i) => {
    r.contact = (r.to - r.td + 1) / fps;
    const next = rows[i + 1];
    r.air = next ? (next.td - r.to - 1) / fps : landing != null ? (landing - r.to - 1) / fps : null;
  });
  // Early run-up rows the tracking split or merged (Miška IMG_4594: 0.125 s down, 0.033 s up, then
  // 0.300 s down) are dropped rather than shown as steps: under 0.05 s in the air or over 0.25 s on
  // the ground is not a running step. The last three contacts are the runway-refined ones and stay.
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.id) continue;
    if ((r.air != null && r.air < 0.05) || r.contact > 0.25) { rows.splice(i, 1); }
  }
  rows.forEach((r, i) => { const next = rows[i + 1]; if (next && !r.id) r.air = (next.td - r.to - 1) / fps; });
  // a dropped row in the middle would make the previous row's flight swallow a whole step
  for (let i = rows.length - 2; i >= 0; i--) if (!rows[i].id && rows[i].air > 0.3) rows.splice(0, i + 1), (i = 0);
  return { rows, apex: apex != null ? (apex - T.to) / fps : null, landing: landing != null ? (landing - T.to) / fps : null, landingFrame: landing ?? null };
}

// The penultimate's deepest knee bend as its own key frame: its ghost (ideal.js) is drawn there.
function withPenFlex(phases, pk) {
  if (!pk || pk.frame == null) return phases;
  return phases.map(p => (p.id !== 'pen' || p.keyFrames.some(k => k.frame === pk.frame) ? p
    : { ...p, keyFrames: [...p.keyFrames, { id: 'penFlex', label: 'Najväčší ohyb predposledného', frame: pk.frame }].sort((a, b) => a.frame - b.frame) }));
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


const pct = k => `${k > 1 ? '+' : '−'}${Math.abs((k - 1) * 100).toFixed(1).replace('.', ',')} %`;
function tapeNote(t) {
  if (!t) return '';
  const m = v => `${v.toFixed(2).replace('.', ',')} m`, where = t.from === 'toe' ? 'od špičky' : 'od dosky';
  if (t.applied) return ` Pásmo spresnilo rýchlosť v lete o ${pct(t.kFlight)} (video ${m(t.video)} ${where}, pásmo ${m(t.tape)}): nad pieskom nie sú čiary dráhy a video tam meria menej presne. Rozbeh a kroky ostávajú, tie sedia s kužeľmi.`;
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
      split1to11: fine(sp.s1to11), split11to21: fine(sp.s11to21), split6to11: sp.s6to11 ?? null, split1to6: sp.s1to6 ?? null, cones: !!sp.coneScale,
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
  // the whole gap goes into the flight part (vx × flight time)
  const flightPart = g.vxTO * g.flightTime, kFlight = flightPart > 0 ? 1 + (tape - video) / flightPart : NaN;
  return { tape, video: +video.toFixed(3), from: ref, k: +k.toFixed(4), kFlight: +kFlight.toFixed(4), applied: off >= 0.005 && off <= TAPE_MAX && Number.isFinite(kFlight), tooFar: off > TAPE_MAX };
}

// ts: the clip's real frame timestamps, used when the result doesn't carry a frame rate.
// height: the athlete's height in cm (centre-of-mass lowering in cm); optional.
// pb: the athlete's full run-up PB in metres; runup: the run-up steps the athlete confirmed. With a
// run-up shorter than the full one the speed-dependent norms move to it (runup.js).
// tape: the distance the athlete measured; tapeFrom: 'board' (from the take-off line, the default)
// or 'toe' (from the take-off toe). See tapeFix.
// split: the athlete's own Freelap 1-11 m time. Berlin 2009 (photocells 11/6/1 m and video on
// the same jumps): last-stride speed / 11-1 m mean speed = 0.998 ± 0.010 men, 0.998 ± 0.015 women,
// so 10 / split is the speed into the board. Without a tape it corrects the video's metres like
// the tape does; with a tape (which already set the metres) it replaces the last-step speed.
// edges: contact frames the athlete set by hand on the replay ("Dotyk je tu", 2026-11-15), any of
// { penTD, penTO, TD, TO }. They win over the pose track and over the server's names, and are not
// moved by the touchdown refinement: at 120 fps neither the detectors nor a zoomed look settle a
// touchdown to one frame every time (16 edges checked by hand on four clips), so the person decides.
export const EDGE_KEYS = ['penTD', 'penTO', 'TD', 'TO'];
export function cleanEdges(e) {
  const out = {};
  for (const k of EDGE_KEYS) if (Number.isInteger(e?.[k])) out[k] = e[k];
  return Object.keys(out).length ? out : null;
}
// The pose track's foot contacts alone, for the server when no jump came out of them.
export function poseContacts(result) {
  const fps = result.fps ?? (result.ts ? (result.ts.length - 1) / (result.ts.at(-1) - result.ts[0]) : NaN);
  return result.clean && fps > 0 ? detectContacts(result.clean, result.first, result.last, fps) : [];
}
// preGround: the server's pass before the runway is measured; the horizontal-speed floor waits for it.
// trustTakeoff: the take-off the server named stands even when the flight's speeds look wrong
// (Rozbeh only, 2026-11-19: a run-up has no flight to measure; Miška's IMG_4655 read vx −11 m/s
// from its short arc and lost a clear take-off). Skok never passes it.
export function analyzeJump(result, sex, ts, { height = null, pb = null, runup = null, tape = null, tapeFrom = null, split = null, edges = null, preGround = false, trustTakeoff = false } = {}) {
  const clean = result.clean, smooth = result.smooth;
  if (!clean || !smooth) return { error: 'Chýba vyčistený záznam pohybu.' };
  const fps = result.fps ?? (ts ? (ts.length - 1) / (ts.at(-1) - ts[0]) : NaN);
  if (!(fps > 0)) return { error: 'Neznáma snímková frekvencia.' };
  // Key frames Claude named on the server win over the ones detected from the pose track.
  // Their touchdowns are then moved to the first frame the foot is really down (raw track).
  let named0 = result.events?.TD != null && result.events?.TO != null ? result.events : null;
  // A run-through saved before 2026-11-19 lost its early sand frame on the server (under 0.3 s after
  // the board, IMG_1083); the frame Claude saw is still in the answer, so a stored jump analyses too.
  const sand = result.locate?.seen?.sand;
  if (named0?.kind === 'runthrough' && named0.landing == null && Number.isInteger(sand) && (sand - named0.TO) / fps >= 0.1 && (sand - named0.TO) / fps <= 1.3) named0 = { ...named0, landing: sand };
  // Edges Claude read itself (no pose contact there) first get both ends from the raw foot.
  // Those keep their new frames; refineTouchdowns' narrower search would nudge them again.
  const claudeFixed = named0 ? refineClaudeEdges(result, named0, result.locate?.edges, { height }) : null;
  const refined = claudeFixed ? refineTouchdowns(result, claudeFixed.events, { height }) : null;
  if (refined) for (const k of claudeFixed.done) refined.events[k] = claudeFixed.events[k];
  // On a take-off plank the foot lands above the runway, and the raw track's "really down" comes a
  // frame or two late (IMG_5166, 2026-11-20: 986 named, 987 refined, 985 by hand): the named board
  // touchdown stands there.
  if (refined && result.ground?.lineM != null && Number.isInteger(claudeFixed.events.TD)) refined.events.TD = claudeFixed.events.TD;
  const named = refined ? refined.events : null;
  const detected = detectContacts(clean, result.first, result.last, fps);
  let contacts = withEvents(clean, detected, named, fps);
  let ev = keyFrames(clean, contacts, fps, sex, { events: named, height, runup: trustTakeoff });
  if (ev.error) return { ...ev, error: 'V zázname sa nenašiel odraz.' };
  // The penultimate touchdown comes out one frame late on 4 of 4 clips checked by eye on zoomed feet
  // (2026-11-15: 4594 389/388, 4676 521/520, 4677 675/674, 4390 454/453), from the server's names
  // and from the pose track alike; toe-offs matched. So it moves one frame earlier, when the step
  // before still ends before it. Hand-set frames below replace it as they are.
  if (ev.pen && ev.pen.td - 1 > (ev.third?.to ?? -Infinity)) {
    ev.pen.td -= 1;
    ev.keyFrames = ev.keyFrames.map(k => (k.id === 'penTD' ? { ...k, frame: ev.pen.td } : k));
  }
  // A touchdown read while the foot is still in the air (2026-11-19, IMG_2432: the phone panned at
  // the speed of the swinging foot, so the foot stood still in the picture 80 px above the runway and
  // the penultimate contact began 10 frames early, 0.225 s for about 0.15, by eye 505). At a true
  // touchdown the foot is 0.07-0.15 torso above the level it holds in the contact's second half (the
  // heel lands above where the toe later stands: 2432, 2433, 1084 by eye); the miss started at 0.36.
  // So only a foot more than 0.16 torso up moves the touchdown, to the first frame within it, then on
  // while the foot still falls more than 0.025 torso a frame. A move under 3 frames is not made: the
  // frame-level edges stay with the rules above.
  for (const [k, id] of [['pen', 'penTD'], ['takeoff', 'TD']]) {
    const c = ev[k], f = c?.foot ?? (k === 'takeoff' ? ev.takeoffFoot : null);
    if (!c || !f) continue;
    const low = i => { const kp = clean[i]; if (!kp) return NaN; const ys = [f + 'heel', f + 'bigtoe'].filter(n => has(kp, n)).map(n => P(kp, n)[1]); return ys.length ? Math.max(...ys) : NaN; };
    const mid = Math.round((c.td + c.to) / 2);
    const lv = []; for (let i = mid; i <= c.to; i++) if (Number.isFinite(low(i))) lv.push(low(i));
    lv.sort((a, b) => a - b);
    const t = clean[mid] && has(clean[mid], 'lsho', 'rsho', 'lhip', 'rhip') ? torsoLength(clean[mid]) : NaN;
    if (lv.length < 3 || !(t > 0)) continue;
    const level = lv[lv.length >> 1];
    let td = c.td; while (td < mid && !(low(td) >= level - 0.16 * t)) td++;
    if (td > c.td) while (td + 1 < mid && low(td + 1) - low(td) > 0.025 * t) td++;
    if (td - c.td >= 3 && td < c.to) { c.td = td; ev.keyFrames = ev.keyFrames.map(x => (x.id === id ? { ...x, frame: td } : x)); }
  }
  // Frames set by hand: the jump's own key frames with those replaced, run through the same path
  // as the server's names. Kept only when they stay in order (pen touchdown < pen toe-off < board
  // touchdown < toe-off) and the jump is still found.
  const hand = cleanEdges(edges);
  let handUsed = null;
  if (hand) {
    const base = { td3: named?.td3 ?? ev.third?.td ?? null, penTD: ev.pen?.td ?? named?.penTD ?? null, penTO: named?.penTO ?? ev.pen?.to ?? null,
      TD: named?.TD ?? ev.takeoff.td, TO: named?.TO ?? ev.takeoff.to, ...(named?.landing != null ? { landing: named.landing } : {}), ...(result.events?.kind ? { kind: result.events.kind } : {}) };
    const e = { ...base, ...hand };
    const order = [e.penTD, e.penTO, e.TD, e.TO].filter(v => v != null);
    if (order.every((v, k) => k === 0 || v > order[k - 1]) && e.TO > e.TD) {
      const c2 = withEvents(clean, detected, e, fps), ev2 = keyFrames(clean, c2, fps, sex, { events: e, height });
      if (!ev2.error) { contacts = c2; ev = ev2; handUsed = hand; }
    }
  }
  ev.keyFrames = ev.keyFrames.map(k => ({ ...k, label: KF_LABELS[k.id] ?? k.label, ...(handUsed?.[k.id] != null ? { hand: true } : {}) }));
  contacts = approachToeOffs(contacts, [ev.pen, ev.takeoff], fps);
  if (ev.contacts) ev.contacts = approachToeOffs(ev.contacts, [ev.pen, ev.takeoff], fps);
  if (ev.third) { const t = contacts.find(c => c.foot === ev.third.foot && c.td === ev.third.td); if (t && t.to !== ev.third.to) ev.third = { ...ev.third, to: t.to, contactTime: t.contactTime }; }
  const dir = contacts[0]?.dir ?? 1;
  const times = ts ?? Array.from({ length: clean.length }, (_, i) => i / fps);
  const air = flightAnalysis(smooth, ev, times, sex, dir, height);
  // No take-off at all (2026-11-16, IMG_4866: a sprint filmed in the jump mode was read as a jump
  // with the body going down and backwards at "toe-off", vy -0.73, vx -1.18 m/s). Every real jump so
  // far leaves the board at vy 2.0-2.5 and vx 6.6-8.3 m/s, so these floors sit far below any jump.
  // The server's first pass runs before the runway is measured: there the horizontal floor waits,
  // or a clip whose speed only the runway can set right never gets the runway measured. Without a
  // runway at all a panning phone can turn the speed around (Miška's 240 fps pop-up from the track,
  // 2026-11-16: vx −10,5): that clip says why it can't be measured instead of showing nonsense.
  // Metres from the runway when the server found it; the gravity scale is only the fallback.
  const ground = result.ground && !air.error ? groundAnalysis(result.ground, smooth, ev, times, sex, height) : null;
  // With the runway measured its speed is the horizontal one checked: a pop-up's low arc gives the
  // gravity scale nothing to hold (2026-11-19, Miška's run-through IMG_1084: vx −49 m/s from the arc,
  // the runway measured fine, the jump refused as "no take-off").
  const vxSeen = ground && !ground.error && Number.isFinite(ground.vxTO) ? ground.vxTO : air.vxTO;
  // A run-through's arc is too short and low to read the vertical speed from (2026-11-19, two server
  // runs of Miška's IMG_1084: vy 0.59 and −0.19 m/s), so only the horizontal floor holds there.
  const popUp = result.events?.kind === 'runthrough';
  // a run-up's own pick stands too (events.js runup rule): a run-through's pop-up has no arc to judge
  const keepTakeoff = trustTakeoff;
  if (!keepTakeoff && !air.error && Number.isFinite(air.vyTO) && Number.isFinite(vxSeen) && ((!popUp && air.vyTO < 0.5) || (!(preGround && !result.ground) && vxSeen < 2.5))) {
    if (air.vyTO >= 0.5 && !result.ground) return { error: 'Skok sa nedá zmerať: v zábere chýba doska alebo čiary dráhy.', noTakeoff: { vx: vxSeen, vy: air.vyTO } };
    return { error: 'V zázname sa nenašiel odraz.', noTakeoff: { vx: vxSeen, vy: air.vyTO } };
  }
  // Where the video's metres can be wrong (2026-11-14, IMG_4677): not on the runway, where the
  // Freelap cones came out exactly 10.0 m apart on the board's scale, but in the air over the sand,
  // where there are no lines and the camera's homography is extrapolated. So the tape corrects only
  // the flight part (horizontal speed in the air), and the 1-11 m time never rescales anything.
  const fix = ground && !ground.error ? tapeFix(ground, tape, tapeFrom) : null;
  if (fix && ground && !ground.error) {
    ground.tapeFix = fix;
    if (fix.applied) {
      const vx0 = ground.vxTO;
      ground.vxTO = vx0 * fix.kFlight;
      ground.jump = ground.takeoffDist + ground.vxTO * ground.flightTime + ground.landingReach;
      ground.speedLoss = ground.vxTO - ground.speedLast;
      ground.speedLossPct = ((ground.vxTO - ground.speedLast) / ground.speedLast) * 100;
      const take = ground.steps?.find(st => st.id === 'take'); if (take) take.speed = ground.vxTO;
    }
  }
  // Approach speed over 1-11 m: the athlete's typed Freelap time, else the video's own time between
  // the cones. It is its own measure, not the last step: IMG_4677 averaged 9.30 m/s over 1-11 m and
  // then ran its last two steps at 8.47 and 8.83, a slowdown into the board (Berlin 2009 finalists:
  // last stride / 11-1 m mean 0.998, so the speed is held).
  const sUse = split > 0.8 && split < 2.5 ? split : ground && !ground.error ? ground.splits?.s1to11 ?? null : null;
  if (sUse && ground && !ground.error) { ground.approach = 10 / sUse; ground.approachFrom = split ? 'freelap' : 'cones'; }
  // Gravity-scale clip (no board): a typed Freelap time still gives the approach and the hold.
  const airOnly = sUse && !(ground && !ground.error) ? { ...air, approach: 10 / sUse, speedKeep: air.speedLast > 0 ? (air.speedLast * sUse / 10 - 1) * 100 : NaN } : air;
  // The centre of mass above the sand at the landing frame, in metres: feet on the sand, the body's
  // size there against the board's scale (the athlete is further from the phone by then).
  const hLand = (() => {
    const L = ev.landing, kp = L != null ? smooth[L] : null, k0 = smooth[ev.takeoff.to];
    if (!kp || !k0 || !(ground?.pxPerM > 0) || !has(kp, 'lsho', 'rsho', 'lhip', 'rhip') || !has(k0, 'lsho', 'rsho', 'lhip', 'rhip')) return NaN;
    const c = centreOfMass(kp, sex), feet = ['lheel', 'rheel', 'lbigtoe', 'rbigtoe'].filter(k => has(kp, k)).map(k => P(kp, k)[1]);
    return c && feet.length ? (Math.max(...feet) - c[1]) / (ground.pxPerM * torsoLength(kp) / torsoLength(k0)) : NaN;
  })();
  const flight = ground && !ground.error ? withGround(air, ground, hLand) : airOnly;
  // Faster than any human jump (2026-11-17, a rerun of the sprint IMG_4866: the server named a
  // "take-off" mid-stride and it read vy 7.0, 66 m/s, a 5.8 m apex). Every checked jump leaves the
  // board at vy 1.6-2.7 and 6.6-8.6 m/s, so 4.5 and 13 sit far above any jump.
  // The horizontal ceiling holds for the runway's speed, or the arc of a full jump. A pop-up's short
  // arc gives no speed to trust (2026-11-19, IMG_1083: 14.5 m/s from the arc, refused before the
  // server's first pass could measure the runway); its metres stay hidden by the scale checks.
  const vxTrusted = (ground && !ground.error) || !(popUp || (preGround && !result.ground));
  if (!keepTakeoff && !flight.error && ((flight.angleOk || flight.apexOk) && flight.vyTO > 4.5 || (vxTrusted && flight.vxTO > 13))) {
    return { error: 'V zázname sa nenašiel odraz.', noTakeoff: { vx: flight.vxTO, vy: flight.vyTO } };
  }
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
    ...ev, dir, fps, flight, metrics, score, eventsSource: handUsed ? 'hand' : named ? 'claude' : 'pose', edgesUsed: handUsed, kind: runThrough ? 'runthrough' : 'jump',
    coach: coaching(metrics, sex),
    phases: withPenFlex(buildPhases(ev, metrics, score, last, runThrough), by.penKnee),
    speed: speedCard(flight, by, ev, smooth),
    // The last three contacts in metres and milliseconds, only when the runway gave the scale.
    steps: flight?.ground?.steps ?? null, stepsHeightCm: height ?? null,
    stepCount,
    // The run-up the norms were judged at, and the distance a full effort from it should reach.
    runupJudged: steps, expected: steps ? expectedDistance(steps, pb) : null,
    profile: profileData(flight, ev),
    timeline: timelineOf(contacts, ev, flight?.ground, runThrough ? null : ev.landing, ev.apex, fps),
    lowering: null, // cm of lowering not shown: see metrics.js (2026-11-23)
    replay: {
      from: Math.max(result.first ?? 0, ev.takeoff.td - Math.round(fps)),
      to: ev.landing != null ? Math.min(last, ev.landing + Math.round(fps / 2)) : last,
    },
  };
}
