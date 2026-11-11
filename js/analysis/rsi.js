// Reactive strength from a front-view clip: drop jumps (both legs or one), repeated hops and
// pogo, countermovement jumps. A foot is on the ground while its lowest keypoint sits on a
// level it holds still; everything else is air. Contact time and flight time come straight
// from the frames, so the only error is the frame edge (±1 frame at each end).
//
// Jump height from flight time: h = g t² / 8 (take-off and landing at the same height).
// RSI (drop jump, hops) = jump height / contact time, in m/s.
import { JI } from '../pose/models.js';

const G = 9.81;
const K = Object.keys(JI).length;
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const at = (kp, n) => (kp && kp[JI[n] * 3 + 2] > 0.3 ? [kp[JI[n] * 3], kp[JI[n] * 3 + 1]] : null);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Raw keypoints, the heavy model where it ran: the 12 Hz cleaning that suits angles would smear
// the touchdown and toe-off by a frame or two, and here the edges are the measurement.
function rawTrack(result) {
  const n = result.fast?.length ?? 0, out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = result.accurate?.[i] ?? result.fast?.[i] ?? null;
  return out;
}

// Lowest point of a foot in the image (largest y): toes or ankle. From the front the heel is
// hidden behind the forefoot and its keypoint is a guess, so it does not count.
function footLow(kp, s) {
  const pts = ['bigtoe', 'smalltoe', 'ank'].map(n => at(kp, s + n)).filter(Boolean);
  return pts.length ? Math.max(...pts.map(p => p[1])) : NaN;
}
const med3 = y => y.map((v, i) => median([y[i - 1], v, y[i + 1]]));

// Pixels per metre at the athlete from the leg (thigh + shank = 0.491 x height, Winter).
function scaleAt(track, sex, height) {
  const legM = (0.491 * (height ?? (sex === 'female' ? 168 : 180))) / 100;
  const legs = [];
  for (const kp of track) for (const s of ['l', 'r']) {
    const h = at(kp, s + 'hip'), k = at(kp, s + 'knee'), a = at(kp, s + 'ank');
    if (h && k && a) legs.push(dist(h, k) + dist(k, a));
  }
  return median(legs) / legM;
}

// Frames where one foot is planted: low and still for at least `minF` frames, grouped into
// runs. Each run keeps its own level: from the front the athlete moves towards or away from the
// phone between contacts, so the floor is not one image row.
function footRuns(y, fps, pxM, { stillMs = 0.35, tolM = 0.02, minMs = 25 } = {}) {
  const n = y.length, v = y.map((_, i) => ((y[i + 1] ?? NaN) - (y[i - 1] ?? NaN)) * fps / 2);
  const still = v.map(x => Math.abs(x) < stillMs * pxM); // px/s: under 0.35 m/s
  const runs = [];
  let i = 0;
  while (i < n) {
    if (!still[i] || !Number.isFinite(y[i])) { i++; continue; }
    let j = i; while (j + 1 < n && still[j + 1] && Number.isFinite(y[j + 1])) j++;
    // the level is the run's median; grow the run to every neighbouring frame within 2 cm of it
    const level = median(y.slice(i, j + 1));
    let a = i, b = j;
    const near = v => Math.abs(v - level) <= tolM * pxM; // off the level either way is not this contact
    while (a - 1 >= 0 && near(y[a - 1])) a--;
    while (b + 1 < n && near(y[b + 1])) b++;
    // the band also catches the frames just before touchdown and just after toe-off, when the foot
    // is within 2 cm of the ground but still moving: trim edge frames whose foot moves faster than
    // 1.2 m/s over the next two frames (a landing or take-off foot moves at 2-3 m/s)
    const step = Math.max(0.004, 1.2 / fps) * pxM;
    const moving = (p, q, r) => Math.max(q - p, (r - p) / 2) > step; // one frame, or two averaged
    while (a + 2 <= b && moving(y[a], y[a + 1], y[a + 2])) a++;
    while (b - 2 >= a && moving(y[b], y[b - 1], y[b - 2])) b--;
    // at the top of a flight the foot also hangs still for a moment; there it is lower (larger y)
    // on both sides, while a foot on the ground is higher on both sides (or the clip ends)
    const k = Math.max(3, Math.round(fps / 30)), below = j2 => Number.isFinite(y[j2]) && y[j2] > level + tolM * pxM;
    const apex = a - k >= 0 && b + k < n && below(a - k) && below(b + k);
    if (!apex && (b - a + 1) / fps * 1000 >= minMs) runs.push({ td: a, to: b, level });
    i = b + 1;
  }
  // runs that touch or overlap after growing are one contact
  const merged = [];
  for (const r of runs) { const p = merged.at(-1); if (p && r.td <= p.to + 1) { p.to = Math.max(p.to, r.to); p.level = Math.max(p.level, r.level); } else merged.push({ ...r }); }
  return merged;
}

// result: the pose result (wire shape after fromWire), ts: frame times in s.
export function rsiAnalysis(result, ts, { sex = 'male', height = null, boxCm = null } = {}) {
  const track = rawTrack(result);
  if (!track.length) return { error: 'Vo videu som nenašiel športovca.' };
  const fps = (ts.length - 1) / (ts.at(-1) - ts[0]);
  const pxM = scaleAt(track, sex, height);
  if (!(pxM > 0)) return { error: 'Na videu nevidno celé nohy.' };
  const feet = { l: med3(track.map(kp => footLow(kp, 'l'))), r: med3(track.map(kp => footLow(kp, 'r'))) };
  const runs = { l: footRuns(feet.l, fps, pxM), r: footRuns(feet.r, fps, pxM) };

  // Ground contacts of the body: any foot down. Each keeps which feet were down and its level.
  const n = track.length, down = new Array(n).fill(null);
  for (const s of ['l', 'r']) for (const r of runs[s]) for (let i = r.td; i <= r.to; i++) (down[i] ??= {})[s] = r.level;
  // A foot held still more than 5 cm above the other one is the free leg of a single-leg contact.
  for (const d of down) if (d && d.l != null && d.r != null) { const lo = Math.max(d.l, d.r); for (const s of ['l', 'r']) if (d[s] < lo - 0.05 * pxM) delete d[s]; }
  const contacts = [];
  for (let i = 0; i < n; i++) {
    if (!down[i]) continue;
    let j = i; while (j + 1 < n && down[j + 1]) j++;
    const lv = [], used = new Set();
    for (let k = i; k <= j; k++) for (const [s, l] of Object.entries(down[k])) { used.add(s); lv.push(l); }
    contacts.push({ td: i, to: j, level: Math.max(...lv), feet: [...used].sort().join('') });
    i = j;
  }
  if (!contacts.length) return { error: 'Na videu som nenašiel žiadny dotyk so zemou.' };

  // The floor is the lowest level (largest y) used by contacts; a level well above it is a box.
  const floor = Math.max(...contacts.map(c => c.level));
  for (const c of contacts) {
    c.onBox = floor - c.level > 0.12 * pxM;               // more than 12 cm above the floor
    c.ms = ((c.to - c.td + 1) / fps) * 1000;
  }
  // Flights between contacts, and what each contact did: reactive (air before and after, short),
  // a standing start or finish, a drop from the box.
  const events = contacts.map((c, k) => {
    const prev = contacts[k - 1], next = contacts[k + 1];
    const flightBefore = prev ? ((c.td - prev.to - 1) / fps) * 1000 : null;
    const flightAfter = next ? ((next.td - c.to - 1) / fps) * 1000 : null;
    return { ...c, flightBefore, flightAfter };
  });
  const reactive = events.filter(e => !e.onBox && e.flightBefore > 60 && e.flightAfter > 60 && e.ms < 600);
  // Hip height (image) at a frame: landing on bent knees or ankles shows as a lower hip at the
  // touchdown after the flight than at the toe-off, and it inflates the flight time.
  const hipY = i => { const a = at(track[i], 'lhip'), b = at(track[i], 'rhip'); return a && b ? (a[1] + b[1]) / 2 : NaN; };
  const jumps = reactive.map(e => {
    const t = e.flightAfter / 1000, h = (G * t * t) / 8;
    const next = contacts[contacts.indexOf(contacts.find(c => c.td === e.td)) + 1];
    const sink = next ? (hipY(next.td) - hipY(e.to)) / pxM : NaN; // m, + = lower at landing
    return {
      td: e.td, to: e.to, feet: e.feet, contactMs: e.ms, flightMs: e.flightAfter, heightCm: h * 100,
      rsi: h / (e.ms / 1000), // m/s: jump height / contact time (Flanagan & Comyns)
      ri: e.flightAfter / e.ms, // flight / contact, no unit: what My Jump and the UKA tests report
      slow: e.ms > 250,        // past the fast stretch-shortening line
      landingFlexed: sink > 0.03,
      // the flight into this contact: from the box for the first contact of a drop jump
      dropFrom: events[events.indexOf(e) - 1]?.onBox ? 'box' : 'floor',
    };
  });
  // Jumps from a standing start (CMJ, squat jump): long ground contact then a flight.
  const standing = events.filter(e => !e.onBox && e.ms >= 600 && e.flightAfter > 120).map(e => {
    const t = e.flightAfter / 1000;
    return { td: e.td, to: e.to, feet: e.feet, flightMs: e.flightAfter, heightCm: ((G * t * t) / 8) * 100 };
  });

  // What the pattern looks like, before Claude names it.
  // standing on something 10-100 cm high at the start; more than that is the athlete moving
  // towards or away from the phone, not a box
  const firstUp = events[0]?.onBox && events[0].ms > 300 ? ((floor - events[0].level) / pxM) * 100 : null;
  const startsOnBox = firstUp != null && firstUp >= 10 && firstUp <= 100;
  const boxEstCm = startsOnBox ? firstUp : null;
  const singleLeg = jumps.length && jumps.every(j => j.feet.length === 1);
  const kind = startsOnBox && jumps.length ? (singleLeg ? 'drop_jump_single' : 'drop_jump')
    : jumps.length >= 3 ? 'repeated_hops'
    : standing.length ? 'cmj' : jumps.length ? 'hops' : 'unknown';
  const best = jumps.reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);
  // Repeated jumps: the mean of the best five (10/5 test, Comyns 2017); the first contacts are
  // usually the longest, so they rarely make it in.
  const top5 = jumps.length >= 5 ? [...jumps].sort((a, b) => b.rsi - a.rsi).slice(0, 5) : null;
  const best5 = top5 && { rsi: top5.reduce((a, j) => a + j.rsi, 0) / 5, ri: top5.reduce((a, j) => a + j.ri, 0) / 5, contactMs: top5.reduce((a, j) => a + j.contactMs, 0) / 5 };
  return {
    mode: 'rsi', fps, pxM, kind, singleLeg: !!singleLeg, leg: singleLeg ? jumps[0].feet : 'lr',
    boxEstCm, boxCm, jumps, standing, best, best5,
    events: events.map(e => ({ td: e.td, to: e.to, feet: e.feet, onBox: e.onBox, ms: Math.round(e.ms), flightAfter: e.flightAfter == null ? null : Math.round(e.flightAfter) })),
    // ±1 frame at each edge of a contact, ±1 at each edge of a flight. Research 2026-11-11: RSI
    // about ±4-6 % at 240 fps and ±7-12 % at 120 fps (frame quantisation plus pose error).
    edgeMs: 1000 / fps, rsiErrPct: fps >= 200 ? [4, 6] : [7, 12],
  };
}
