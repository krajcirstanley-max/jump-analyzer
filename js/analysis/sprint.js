// Sprint analysis, in two halves.
//  - sprintFromMotion (server): what the video alone shows. Contacts, flights, step times, and
//    for a standing start the moment the athlete moves. Contacts come from each toe's motion
//    relative to the track beside it (server/sprint.mjs), measured in % of the athlete's height
//    per 1/120 s so the thresholds hold whatever the zoom or frame rate.
//  - analyzeSprint (phone): the same steps with the Freelap run filmed, which gives metres. Freelap
//    legs are always exactly 10 m (Stanley, 2026-11-13).
// Checked by hand on IMG_3479 (Stanley, 20 m fly) and IMG_3480 (Miška, 20 m accel), 2026-11-13.

export const SPRINT = {
  planted: 0.55,  // %h per 1/120 s: the toe's vertical motion relative to the track while it is down (0.45 split a GPU-pose contact on 0.46-0.47)
  plantedX: 4,    // the same sideways, loose: only to reject a swinging foot (5-10 %h) when its height pauses; the track match is noisier along the pan
  minContact: 4,  // frames at 120 fps (0.033 s): shorter is a match glitch, not a contact
  longContact: 0.24, // s: a foot down this long is the set position or the push, not a running step
  toFirstStep: 0.35, // s from the Touch Pro release to the first step's touchdown (IMG_3480: 1150 -> 1192)
  d0: 0.5,        // m: the chip behind the start line in the set position (barely matters: ±0.2 m moves steps <0.05 m)
};

// How fast each athlete's acceleration curve approaches its top (mono-exponential tau, s), from
// their 30 m and 40 m Freelap runs on 2026-10-18 (S 1.40/1.52, M 1.54/1.68). A 20 m run has two
// splits, too few to fit it. (A first fit on a grid capped at 9.47 m/s gave Stanley 1.16-1.22:
// wrong, his top speed sat on the cap.)
export const TAU = { stanley: 1.46, miska: 1.61 };
const TAU_DEFAULT = 1.4;

const r3 = x => (x == null || !Number.isFinite(x) ? null : +x.toFixed(3));
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);

// ---------- Video half ----------
function planted(motion, foot, fps, o) {
  const k = 120 / fps, out = [];
  for (const m of motion) {
    if (!m || !m.g || !m[foot]) { out.push(null); continue; }
    const vx = ((m[foot][0] - m.g[0]) / m.h) * 100 * k, vy = ((m[foot][1] - m.g[1]) / m.h) * 100 * k;
    const score = m[foot][2] ?? 1;
    // under a pixel a frame is match noise: a far runner gets 0.8 px (2026-11-15)
    const lim = o.floorPx ? Math.max(o.planted, (o.floorPx / m.h) * 100 * k) : o.planted;
    out.push({ f: m.f, vx, vy, score, down: Math.abs(vy) <= lim && Math.abs(vx) <= o.plantedX });
  }
  return out;
}

// Runs of a planted toe. Up to three frames out of line between planted ones are a match glitch,
// not a lift, when they move little or matched badly: a lift rises fast and keeps rising (on the
// GPU's pose, IMG_3480 step 11 split into 1497-1500 and 1501-1507 without this).
export function footContacts(motion, foot, ts, fps, o = SPRINT) {
  const p = planted(motion, foot, fps, o), runs = [];
  const minLen = Math.max(3, Math.round((o.minContact * fps) / 120));
  const maxGap = Math.max(1, Math.round((3 * fps) / 120));
  const glitch = q => q && (Math.abs(q.vy) <= 2.5 * o.planted || q.score < 0.6);
  let a = null, last = null;
  const close = () => { if (a != null && last - a + 1 >= minLen) runs.push([a, last]); a = null; };
  for (let i = 0; i < p.length; i++) {
    const q = p[i];
    if (q?.down) { if (a == null) a = i; last = i; continue; }
    if (a != null) {
      let j = i; while (j < p.length && j - last <= maxGap && !p[j]?.down && glitch(p[j])) j++;
      if (j < p.length && j - last <= maxGap && p[j]?.down) { i = j - 1; continue; } // bridged
      close();
    }
  }
  close();
  // A run of motions a..b means the toe stood still from frame a to frame b+1: it landed between
  // a-1 and a, and left between b+1 and b+2. Edges sit half a frame out.
  return runs.map(([i, j]) => {
    const fa = p[i].f, fb = p[j].f + 1, half = 0.5 / fps;
    return { foot, a: fa, b: fb, td: ts[fa] - ts[0] - half, to: (ts[fb] ?? ts[fb - 1] + 1 / fps) - ts[0] + half };
  });
}

// A standing start: the set position and the push hold a foot down a long time (Miška's push
// 0.26 s, her first step 0.21 s). The first step is the first contact after the last long one,
// and the Touch Pro releases about 0.35 s before it lands (IMG_3480: hand off ~1150, first
// touchdown 1192). The hips can't time it: far away at the start, the pose jitters more than the
// set position moves, and it drops out at the instant of the start.
export function startOf(contacts, o = SPRINT) {
  const list = [...contacts].sort((x, y) => x.td - y.td);
  // a long contact counts only before running has begun: three alternating steps of a running
  // stride before it mean it is a misread stance in the run, not the set position
  let run = 0, ended = Infinity;
  for (let i = 1; i < list.length; i++) {
    const st = list[i].td - list[i - 1].td;
    run = list[i].foot !== list[i - 1].foot && st >= 0.17 && st <= 0.35 && list[i - 1].to - list[i - 1].td < o.longContact ? run + 1 : 0;
    if (run >= 3) { ended = list[i - 3].td; break; }
  }
  const long = list.filter(c => c.to - c.td >= o.longContact && c.td < ended);
  if (!long.length) return null;
  const last = long.at(-1);
  const first = list.find(c => c.td >= last.to - 0.05 && c !== last && c.to - c.td < o.longContact);
  if (!first || list.filter(c => c.td >= first.td).length < 4) return null;
  return { firstStep: first.td, release: +(first.td - o.toFirstStep).toFixed(3), estimated: true };
}

// Steps: contacts of both feet in time order, alternating, from the first step on.
export function stepsOf(contacts, start) {
  const list = contacts.filter(c => !start || c.td >= start.firstStep - 1e-6).sort((x, y) => x.td - y.td);
  const out = [];
  for (const c of list) {
    const prev = out.at(-1);
    if (prev && c.td < prev.to) { if (c.to - c.td > prev.to - prev.td) out[out.length - 1] = c; continue; } // overlap: keep the longer
    if (prev && prev.foot === c.foot) { if (c.to - c.td > prev.to - prev.td) out[out.length - 1] = c; continue; }
    out.push(c);
  }
  return out.map((c, i) => {
    const next = out[i + 1];
    return { foot: c.foot, td: r3(c.td), to: r3(c.to), frames: [c.a, c.b], contact: r3(c.to - c.td),
      flight: next ? r3(next.td - c.to) : null, step: next ? r3(next.td - c.td) : null };
  });
}

// Contacts from the foot's speed against the track, with a threshold that holds near and far
// (Stanley, 2026-11-15: "všetko je zreteľné, máme zlý algoritmus"). The fixed 0.55 %h per frame
// above is under one pixel when the runner is 70-130 px tall, so far contacts fell apart into
// pieces and most steps were lost; yet the foot's speed shows every stance as a clear trough
// (13:15 clip: troughs every 24-28 frames from far away to the pass). A stance is a stretch where
// the smoothed speed (median of 5) stays under T, its edges where the speed has climbed a share
// `edge` of the way from the trough's floor to T.
// Bumped when the contact rule changes, so the phone knows which analyses to run again.
export const SPRINT_ALGO = 2;
export const STANCE = { T: 2.0, edge: 0.45, minLen: 5, wide: 3.2 };
function footSpeed(motion, foot, fps) {
  const k = 120 / fps;
  const raw = motion.map(m => (m && m.g && m[foot] && (m[foot][2] ?? 1) >= 0.6 && m.h ? Math.hypot(m[foot][0] - m.g[0], m[foot][1] - m.g[1]) / m.h * 100 * k : null));
  const w = Math.max(2, Math.round((2 * fps) / 120));
  return raw.map((_, i) => { const v = raw.slice(Math.max(0, i - w), i + w + 1).filter(x => x != null); return v.length >= 3 ? median(v) : null; });
}
export function footStances(motion, foot, ts, fps, { T = STANCE.T, edge = STANCE.edge, minLen = STANCE.minLen, from = 0, to = Infinity } = {}) {
  const m = footSpeed(motion, foot, fps), out = [];
  const precise = footContacts(motion, foot, ts, fps, { ...SPRINT, floorPx: 0.6 });
  const minN = Math.max(3, Math.round((minLen * fps) / 120));
  for (let i = Math.max(0, from); i < Math.min(m.length, to); i++) {
    if (m[i] == null || m[i] > T) continue;
    let a = i; while (i < m.length && m[i] != null && m[i] <= T) i++;
    const b = i - 1;
    let k = a; for (let j = a; j <= b; j++) if (m[j] < m[k]) k = j;
    const E = m[k] + edge * (T - m[k]);
    let x = k; while (x - 1 >= a && m[x - 1] <= E) x--;
    let y = k; while (y + 1 <= b && m[y + 1] <= E) y++;
    if (y - x + 1 < minN || !motion[x] || !motion[y]) continue;
    // The edges, where the foot is big enough to read them: the hand-checked rule (vertical
    // speed under 0.55 %h, or under 0.8 px where that is less than a pixel) inside the trough.
    // only when it is the stance and not a piece of it (a far foot's rule breaks into bits)
    let r = refineEdges(precise, motion, x, y);
    if (r && r.b - r.a < 0.7 * (motion[y].f + 1 - motion[x].f)) r = null;
    const fa = r ? r.a : motion[x].f, fb = r ? r.b : motion[y].f + 1, half = 0.5 / fps;
    out.push({ foot, a: fa, b: fb, floor: m[k], td: ts[fa] - ts[0] - half, to: (ts[fb] ?? ts[fb - 1] + 1 / fps) - ts[0] + half });
  }
  return out;
}

// The edges of a stance found by its trough: the hand-checked rule's contact (vertical speed under
// 0.55 %h, 0.8 px when that is less) that overlaps it most, else the trough's own edges.
function refineEdges(precise, motion, x, y) {
  const fx = motion[x].f, fy = motion[y].f + 1;
  let best = null, ov = 0;
  for (const c of precise) {
    const o = Math.min(fy, c.b) - Math.max(fx, c.a);
    if (o > ov) { ov = o; best = c; }
  }
  return best;
}

// A gap of two steps or more hides stances the first pass missed: look for them there with a
// looser T, both feet, keeping the ones that fit the stride (alternating, at least 0.7 of a step
// from their neighbours), the clearest first.
function fillGaps(contacts, motion, ts, fps) {
  let list = [...contacts].sort((x, y) => x.td - y.td);
  const gaps = list.slice(1).map((c, i) => c.td - list[i].td).filter(g => g > 0.15 && g < 0.4);
  const T0 = gaps.length >= 3 ? median(gaps) : null;
  if (!T0) return list;
  const idx = f => motion.findIndex(m => m && m.f >= f);
  const add = [];
  for (let i = 0; i + 1 < list.length; i++) {
    const c = list[i], n = list[i + 1];
    if (n.td - c.td < 1.6 * T0 || n.td - c.td > 6 * T0) continue;
    const cand = ['l', 'r'].flatMap(f => footStances(motion, f, ts, fps, { T: STANCE.wide, from: idx(c.b), to: idx(n.a) }))
      .filter(x => x.td > c.to && x.to < n.td).sort((x, y) => x.floor - y.floor);
    const seq = [c, n];
    for (const x of cand) {
      const k = seq.findIndex(q => q.td > x.td), p = seq[k - 1], q = seq[k];
      if (x.td - p.td < 0.7 * T0 || q.td - x.td < 0.7 * T0 || x.foot === p.foot || x.foot === q.foot && q !== n) continue;
      seq.splice(k, 0, x);
    }
    add.push(...seq.slice(1, -1));
  }
  return [...list, ...add].sort((x, y) => x.td - y.td);
}

export function sprintFromMotion({ motion, ts, fps, o = SPRINT }) {
  if (!motion?.some(m => m?.g)) return { error: 'Vo videu sa nedala sledovať dráha vedľa bežca.' };
  const contacts = fillGaps(['l', 'r'].flatMap(s => footStances(motion, s, ts, fps)), motion, ts, fps);
  const start = startOf(contacts, o);
  const steps = stepsOf(contacts, start);
  if (steps.length < 3) return { error: 'Vo videu som nenašiel dosť krokov. V zábere musia byť celé chodidlá aspoň počas štyroch krokov.' };
  return { start, steps, modeGuess: start ? 'accel' : 'fly', algo: SPRINT_ALGO };
}

// Steps a runner can make, and only those (2026-11-15, ten clips from a hand-held pan: the runner
// small and from behind gave contacts of 0.04 s, flights of 0.008 s, the same foot twice and
// missed steps with 0.5-1.1 s "flights"; coming towards the camera or close, the steps were clean).
// A step counts when its contact, its flight to the next touchdown and the step time are all in a
// sprinter's range and the next touchdown is the other foot. Kept: runs of at least three such
// steps in a row, the step time changing by under a quarter from one to the next. The first steps
// of a standing start are longer on the ground and shorter in the air.
// What a sprinter's step can be, for checking a result against reality: frequency per second, and
// length as a share of body height at speed (Bolt 2.44 m at 1.95 m = 1.25; 1.32 leaves room). At
// Stanley's 1.86 m a fly step tops out near 2.45 m, so 3.7 /s with 2.70 m is a misread.
export const SANE = { freq: [3.6, 5.6], length: [0.85, 1.32], height: 1.8 };
export const STEP_RANGE = { contact: [0.07, 0.25], flight: [0.05, 0.22], step: [0.17, 0.33], startContact: 0.32, startStep: 0.42, startFlight: 0.02, jump: 0.25, minRun: 3 };
export function cleanSteps(steps, { accel = false, o = STEP_RANGE } = {}) {
  const contactOk = (s, i) => s && s.contact >= o.contact[0] && s.contact <= (accel && i < 3 ? o.startContact : o.contact[1]);
  const ok = (s, i) => {
    const early = accel && i < 3, next = steps[i + 1];
    if (!contactOk(s, i)) return false;
    // the step ends on the next touchdown: a glitch there (0.05 s "contact") makes the step wrong too
    if (next && !contactOk(next, i + 1)) return false;
    if (s.step == null) return false;
    if (!(s.step >= o.step[0] && s.step <= (early ? o.startStep : o.step[1]))) return false;
    if (!(s.flight >= (early ? o.startFlight : o.flight[0]) && s.flight <= o.flight[1])) return false;
    return !next || next.foot !== s.foot;
  };
  const runs = [];
  let cur = [];
  steps.forEach((s, i) => {
    const prev = cur.at(-1);
    if (ok(s, i) && (!prev || Math.abs(s.step - prev.step) <= o.jump * prev.step)) { cur.push(s); return; }
    if (cur.length) runs.push(cur);
    cur = ok(s, i) ? [s] : [];
  });
  if (cur.length) runs.push(cur);
  // seg: which unbroken run of steps a step belongs to; a gap between two is never one step
  return runs.filter(r => r.length >= o.minRun).flatMap((r, seg) => r.map(x => ({ ...x, seg })));
}

// Metres a Freelap run covered: 10 per leg. A run that kept its lap alone (its splits were not
// real) is 10 m only when the lap could be one; else the distance is not known.
export const runMetres = run => (run?.legs?.length > 1 || (run?.legs?.length === 1 && run.lap <= 2.2) ? run.legs.length * 10 : null);

// ---------- Freelap half (phone) ----------
// The Freelap run filmed: heard during the clip (the phone gets it as the chip crosses the last
// cone), nearest to the clip's end. Only the athlete's own runs when known.
export function pairRun(runs, video, who = null) {
  if (!video?.recordedAt) return null;
  const a = video.recordedAt - 2000, b = video.recordedAt + (video.duration ?? 0) * 1000 + 8000;
  const end = video.recordedAt + (video.duration ?? 0) * 1000;
  return runs.filter(r => r.at >= a && r.at <= b && (!who || !r.who || r.who === who) && r.legs?.length)
    .sort((x, y) => Math.abs(x.at - end) - Math.abs(y.at - end))[0] ?? null;
}

// A standing start makes the first 10 m far slower than the next; a fly keeps them close.
// A type set by hand on the Freelap list wins (Stanley 2026-11-14): a long-jump run-up ('rozbeh')
// looks like a fly from its splits alone, so only he can say it was one.
export const modeOfRun = run => (['accel', 'fly', 'rozbeh'].includes(run?.type) ? run.type
  : run?.legs?.length >= 2 && run.legs[0] > 1.35 * run.legs[1] ? 'accel' : 'fly');

// Mono-exponential speed from a standing start: v = vmax (1 - e^(-t/tau)), the usual sprint
// model. t counts from a virtual onset r seconds before the Touch Pro release; the chip starts d0
// behind the line.
const X = (t, v, tau) => (t > 0 ? v * (t - tau * (1 - Math.exp(-t / tau))) : 0);
export const speedAt = (t, fit) => fit.vmax * (1 - Math.exp(-Math.max(0, t + fit.r) / fit.tau));
export const posAt = (t, fit) => X(t + fit.r, fit.vmax, fit.tau) - fit.d0;

// Least squares on the split times (Gauss-Newton). With two splits tau stays at the athlete's own
// value; with three or more it is fitted too.
export function fitAccel(legs, { tau = TAU_DEFAULT, d0 = SPRINT.d0 } = {}) {
  const cum = legs.map((_, i) => legs.slice(0, i + 1).reduce((s, x) => s + x, 0));
  const free = legs.length >= 3;
  let p = [9, 0.3, tau]; // vmax, r, tau
  const tAt = (x, q) => { // time since release when the chip reaches x metres
    let lo = -q[1], hi = 20;
    for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (X(m + q[1], q[0], q[2]) - d0 < x) lo = m; else hi = m; }
    return lo;
  };
  const res = q => cum.map((c, i) => tAt(10 * (i + 1), q) - c);
  const idx = free ? [0, 1, 2] : [0, 1];
  for (let it = 0; it < 60; it++) {
    const r0 = res(p);
    const J = idx.map(j => { const q = [...p]; q[j] += 1e-4; return res(q).map((v, i) => (v - r0[i]) / 1e-4); });
    // normal equations (J^T J) dp = -J^T r, tiny damping
    const n = idx.length, A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => J[a].reduce((s, v, i) => s + v * J[b][i], 0) + (a === b ? 1e-6 : 0)));
    const g = idx.map((_, a) => -J[a].reduce((s, v, i) => s + v * r0[i], 0));
    for (let c = 0; c < n; c++) { const piv = A[c][c] || 1e-9; for (let rr = 0; rr < n; rr++) if (rr !== c) { const f = A[rr][c] / piv; for (let k = 0; k < n; k++) A[rr][k] -= f * A[c][k]; g[rr] -= f * g[c]; } }
    idx.forEach((j, a) => { p[j] += Math.max(-1, Math.min(1, g[a] / (A[a][a] || 1e-9))); });
    p[0] = Math.max(4, Math.min(13, p[0])); p[1] = Math.max(0, Math.min(1.2, p[1])); p[2] = Math.max(0.5, Math.min(3, p[2]));
  }
  const rms = Math.sqrt(mean(res(p).map(v => v * v)));
  return { vmax: p[0], r: p[1], tau: p[2], d0, rms, fittedTau: free };
}

// Steps in one leg window [a, b] (clip seconds): fractional, by how much of each step falls in it.
// The first step out of the start (release to first touchdown) counts as a step too.
function stepsIn(steps, a, b) {
  let n = 0;
  for (const s of steps) if (s.step) { const lo = Math.max(a, s.td), hi = Math.min(b, s.td + s.step); if (hi > lo) n += (hi - lo) / s.step; }
  return n;
}

// The steady stretch of a fly: the longest run of steps within 15 % of the typical step, then its
// last steps, as many as the timed distance takes (the runner slows only after the finish).
function flyZone(full, lap) {
  const t = median(full.map(s => s.step));
  let best = [], cur = [];
  for (const s of full) { if (Math.abs(s.step - t) <= 0.15 * t) { cur.push(s); if (cur.length > best.length) best = cur; } else cur = []; }
  const n = lap ? Math.max(4, Math.round(lap / t)) : 8;
  return best.slice(-n);
}

const sidesOf = steps => {
  const side = foot => {
    const m = steps.filter(s => s.foot === foot);
    return { n: m.length, contact: r3(mean(m.map(s => s.contact))), flight: r3(mean(m.filter(s => s.flight != null).map(s => s.flight))) };
  };
  return { l: side('l'), r: side('r') };
};

// Everything the result screens show. video = the server's result, run = the Freelap run (or null).
export function analyzeSprint(video, run, { mode = null, who = null, height = null } = {}) {
  const hM = (height ?? SANE.height * 100) / 100;
  const saneLen = len => len >= SANE.length[0] * hM && len <= SANE.length[1] * hM;
  const k0 = mode ?? (run ? modeOfRun(run) : video.modeGuess);
  const kind = k0 === 'rozbeh' ? 'fly' : k0;   // a run-up is analysed like a fly: steady steps at the end
  const raw = video.steps.filter(s => s.contact != null);
  const all = cleanSteps(raw, { accel: kind === 'accel' && !!video.start });
  const legs = runMetres(run) ? run.legs : [];
  const out = { kind, distance: legs.length ? legs.length * 10 : null, legs, who, dropped: raw.length - all.length };
  if (all.length < 3) return { ...out, steps: [], tooFew: true, legStats: legs.map(l => ({ time: l, speed: r3(10 / l), stepLength: null })), sides: sidesOf([]) };

  if (kind === 'fly') {
    // Top speed: the steps are even, so one frequency for the run, touchdown to touchdown.
    // Filmed in the app: the phone heard the run finish at a known second of the clip, so the timed
    // stretch is exactly the steps before it. Otherwise the steady steps before the slow-down.
    const full = all.filter(s => s.step), fin = video.finishAt, lap = legs.length ? run.lap : null;
    const bySeg = list => Object.values(Object.groupBy(list, s => s.seg)).sort((x, y) => y.length - x.length)[0] ?? [];
    const timed = bySeg(fin != null && lap ? full.filter(s => s.td >= fin - lap - 0.05 && s.td + s.step <= fin + 0.12) : []);
    const zone = timed.length >= 3 ? timed : flyZone(bySeg(full), lap);
    out.zoneFrom = timed.length >= 3 ? 'freelap' : 'steps';
    const span = zone.length ? zone.at(-1).td + zone.at(-1).step - zone[0].td : NaN;
    // Metres only where they are measured (Stanley, 2026-11-15: "nech to je reálne, nie 3,7 frekvencia
    // a 2,70 krok"): a step's length is the speed of the Freelap 10 m it lies inside times its own
    // time, and only when the phone heard the finish, so the steps in that 10 m are known. Steps seen
    // outside the timed metres give frequency and contacts, never a length.
    const lap0 = fin != null && lap ? fin - lap : null;
    const windows = lap0 == null ? [] : legs.map((l, i) => { const a = lap0 + legs.slice(0, i).reduce((x, y) => x + y, 0); return { a, b: a + l, v: 10 / l }; });
    const legOf = s => windows.findIndex(w => s.td >= w.a - 0.02 && s.td + s.step <= w.b + 0.02);
    // An uploaded clip (no finish heard): a fly's steps are even, so the run's own speed is used.
    const vRun = legs.length && !windows.length ? (10 * legs.length) / lap : null;
    out.steps = zone.map(s => { const k = legOf(s); const v = k >= 0 ? windows[k].v : vRun; return { ...s, freq: r3(1 / s.step), leg: k >= 0 ? k : null, length: v ? r3(v * s.step) : null }; });
    out.freq = r3(zone.length / span);
    out.contact = r3(mean(zone.map(s => s.contact)));
    out.flight = r3(mean(zone.map(s => s.flight)));
    out.stepTime = r3(span / zone.length);
    out.sides = sidesOf(zone);
    // Per 10 m: its own steps' frequency, and the step length that speed and frequency give. A value
    // outside what a sprinter can do means the steps were misread: shown as not measured.
    out.legStats = legs.map((l, k) => {
      const mine = windows.length ? out.steps.filter(s => s.leg === k) : out.steps;
      const f = mine.length >= 2 ? mine.length / mine.reduce((x, s) => x + s.step, 0) : null;
      const len = f ? 10 / l / f : null;
      const real = f && f >= SANE.freq[0] && f <= SANE.freq[1] && saneLen(len);
      return { time: l, speed: r3(10 / l), freq: real ? r3(f) : null, stepLength: real ? r3(len) : null, steps: mine.length };
    });
    // a step whose 10 m came out unreal is not shown with a length either
    for (const s of out.steps) if (s.length != null && (!saneLen(s.length) || (s.leg != null && out.legStats[s.leg]?.stepLength == null) || (s.leg == null && !out.legStats.some(x => x.stepLength != null)))) s.length = null;
    out.measured = out.steps.some(s => s.length != null);
    out.perLeg = windows.length > 0;   // each 10 m has its own steps (else one frequency for the run)
    return out;
  }

  // Acceleration: timer zero is the hand leaving the Touch Pro, about 0.35 s before the first step.
  // When the phone heard the finish (filmed in the app), the Freelap clock gives it too; both are
  // kept so the run-arrival latency can be measured.
  out.steps = all.map(s => ({ ...s }));
  const zero = video.start?.release;
  if (video.finishAt != null && run?.lap) out.zeroFromFinish = r3(video.finishAt - run.lap);
  if (legs.length && zero != null) {
    const fit = fitAccel(legs, { tau: TAU[who] ?? TAU_DEFAULT });
    out.fit = { vmax: r3(fit.vmax), tau: r3(fit.tau), r: r3(fit.r), rms: r3(fit.rms) };
    let edge = zero;
    const full = all.filter(s => s.step);
    out.legStats = legs.map(l => {
      const a = edge, b = edge + l; edge = b;
      const n = stepsIn([{ td: zero, step: full[0].td - zero }, ...full], a, b);
      // counted steps, and a length only when it is one a runner can make (a standing start's first
      // 10 m has short steps: from 0.5 of body height)
      const len = n ? 10 / n : null;
      return { time: l, speed: r3(10 / l), steps: +n.toFixed(1), stepLength: len && len >= 0.5 * hM && len <= SANE.length[1] * hM ? r3(len) : null, end: r3(b) };
    });
    out.steps = out.steps.map(s => {
      if (s.step == null) return s;
      const t1 = s.td - zero, t2 = s.td + s.step - zero, len = posAt(t2, fit) - posAt(t1, fit);
      return { ...s, modelLength: r3(len), modelSpeed: r3(len / s.step), freq: r3(1 / s.step), at: r3(posAt((t1 + t2) / 2, fit)) };
    });
    // Only the steps inside the timed distance, up to the one that crosses its end.
    const endT = out.legStats.at(-1).end;
    out.steps = out.steps.filter(s => s.td < endT && s.step != null);
    out.steps.forEach(s => { s.leg = out.legStats.findIndex(l => s.td < l.end); });
    const tAtX = x => { let lo = 0, hi = 15; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (posAt(m, fit) < x) lo = m; else hi = m; } return lo; };
    out.curve = [2, 5, 10, 15, 20, 30, 40].filter(x => x <= out.distance).map(x => ({ x, v: r3(speedAt(tAtX(x), fit)) }));
  }
  out.steps = out.steps.map(s => (s.freq == null && s.step ? { ...s, freq: r3(1 / s.step) } : s));
  const st = out.steps, withStep = st.filter(s => s.step);
  out.freqFrom = r3(1 / withStep[0]?.step); out.freqTo = r3(1 / median(withStep.slice(-3).map(s => s.step)));
  out.contactFrom = r3(median(st.slice(1, 3).map(s => s.contact))); out.contactTo = r3(median(st.slice(-3).map(s => s.contact)));
  out.flightFrom = r3(median(st.slice(0, 3).filter(s => s.flight != null).map(s => s.flight)));
  out.flightTo = r3(median(st.filter(s => s.flight != null).slice(-3).map(s => s.flight)));
  out.sides = sidesOf(st.slice(1)); // the first step out of the start is no running step
  return out;
}

// The athlete's acceleration profile from their own Freelap runs: standing starts of 30 m or
// more (three splits fit the curve without help). F0 = vmax/tau in N/kg, Pmax = F0 vmax / 4.
export function profileFromRuns(runs, who) {
  const mine = runs.filter(r => (!who || r.who === who) && r.legs?.length >= 2);
  const fly = mine.filter(r => modeOfRun(r) === 'fly').map(r => 10 / Math.min(...r.legs));
  const accel = mine.filter(r => r.legs.length >= 3 && modeOfRun(r) === 'accel').sort((a, b) => a.lap / a.legs.length - b.lap / b.legs.length)[0];
  if (!accel) return null;
  const fit = fitAccel(accel.legs);
  const F0 = fit.vmax / fit.tau, flyBest = fly.length ? Math.max(...fly) : null;
  return { run: { at: accel.at, legs: accel.legs }, vmax: r3(fit.vmax), tau: r3(fit.tau), F0: +F0.toFixed(1), Pmax: +((F0 * fit.vmax) / 4).toFixed(1),
    flyBest: r3(flyBest), pctOfFly: flyBest ? Math.round((100 * fit.vmax) / flyBest) : null, rms: r3(fit.rms) };
}
