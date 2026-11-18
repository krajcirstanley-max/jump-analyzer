// Reactive strength from a front-view clip: drop jumps (both legs or one), repeated hops and
// pogo, countermovement jumps. A foot is on the ground while its lowest keypoint sits on a
// level it holds still; everything else is air. Contact time and flight time come straight
// from the frames, so the only error is the frame edge (±1 frame at each end).
//
// Jump height from flight time: h = g t² / 8 (take-off and landing at the same height).
// RSI (drop jump, hops) = jump height / contact time, in m/s.
import { JI } from '../pose/models.js';
import { applyH, invertH } from './homography.js';

const G = 9.81;
const K = Object.keys(JI).length;
const median = a => { const s = a.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const at = (kp, n) => (kp && kp[JI[n] * 3 + 2] > 0.3 ? [kp[JI[n] * 3], kp[JI[n] * 3 + 1]] : null);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Raw keypoints, the heavy model where it ran: the 12 Hz cleaning that suits angles would smear
// the touchdown and toe-off by a frame or two, and here the edges are the measurement.
//
// cam: { h: { [frame]: H } } from the camera tracker, H mapping reference-frame pixels to frame
// i. A hand-held phone shakes: every keypoint is moved back into the reference frame, so a
// planted foot stays on one image row however the phone moves. Frames between tracked ones get
// an interpolated H (the tracker may sample every 2nd-4th frame); outside the tracked span the
// nearest one is held.
function camLookup(cam, n) {
  const keys = Object.keys(cam?.h ?? {}).map(Number).sort((a, b) => a - b);
  if (keys.length < 2) return null;
  const inv = new Array(n).fill(null);
  let k = 0;
  for (let i = 0; i < n; i++) {
    while (k + 1 < keys.length && keys[k + 1] <= i) k++;
    const a = keys[k], b = keys[Math.min(k + 1, keys.length - 1)];
    const w = i <= a ? 0 : i >= b ? 1 : (i - a) / (b - a);
    const h = cam.h[a].map((v, j) => v * (1 - w) + cam.h[b][j] * w);
    inv[i] = invertH(h.map(v => v / h[8]));
  }
  return inv;
}
export function rawTrack(result, cam) {
  const n = result.fast?.length ?? 0, out = new Array(n);
  const inv = camLookup(cam, n);
  for (let i = 0; i < n; i++) {
    const kp = result.accurate?.[i] ?? result.fast?.[i] ?? null;
    if (!kp || !inv) { out[i] = kp; continue; }
    const m = Float32Array.from(kp);
    for (let j = 0; j < m.length; j += 3) if (Number.isFinite(m[j])) { const [x, y] = applyH(inv[i], [m[j], m[j + 1]]); m[j] = x; m[j + 1] = y; }
    out[i] = m;
  }
  return out;
}

// Lowest point of a foot in the image (largest y): toes or ankle. From the front the heel is
// hidden behind the forefoot and its keypoint is a guess, so it does not count.
export function footLow(kp, s) {
  const pts = ['bigtoe', 'smalltoe', 'ank'].map(n => at(kp, s + n)).filter(Boolean);
  return pts.length ? Math.max(...pts.map(p => p[1])) : NaN;
}
const med3 = y => y.map((v, i) => median([y[i - 1], v, y[i + 1]]));
// Five frames, not three: the toe point of a close-up, followed foot on the box jumps 30-60 px for
// one or two frames at a time (1794929272459, fifth server run: 144-146, 150-151), and a three-frame
// median let that break the stand into a "rebound". A median keeps a touchdown's steady fall.
const med5 = y => y.map((v, i) => median([y[i - 2], y[i - 1], v, y[i + 1], y[i + 2]]));

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
const PX = 5;   // px: the pose's own jitter on a planted toe (IMG_2213: 4.5 lost a hop, 5 and 6 read all 11)
// minMs 60: a pose glitch of one foot for 2-3 frames in mid-flight split a hurdle hop in two and
// showed a 0,025 s "contact" with RSI 1,96 (Stanley's hurdle hops, 2026-11-16, frames 800-802).
function footRuns(y, fps, pxM, { stillMs = 0.35, tolM = 0.02, minMs = 60 } = {}) {
  const n = y.length, v = y.map((_, i) => ((y[i + 1] ?? NaN) - (y[i - 1] ?? NaN)) * fps / 2);
  // A far athlete is small in the picture (IMG_2213, hops over cones filmed from the side: 141 px
  // per metre), and there 2 cm is under 3 px while a planted toe's keypoint wanders 5 px. The bands
  // never go under the pose's own jitter: PX px for the level, the same over two frames for 'still'.
  const tol = Math.max(tolM * pxM, PX);
  const still = v.map(x => Math.abs(x) < Math.max(stillMs * pxM, PX * fps / 2)); // px/s: under 0.35 m/s
  const runs = [];
  let i = 0;
  while (i < n) {
    if (!still[i] || !Number.isFinite(y[i])) { i++; continue; }
    let j = i; while (j + 1 < n && still[j + 1] && Number.isFinite(y[j + 1])) j++;
    // the level is the run's median; grow the run to every neighbouring frame within 2 cm of it
    const level = median(y.slice(i, j + 1));
    let a = i, b = j;
    const near = v => Math.abs(v - level) <= tol; // off the level either way is not this contact
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
    const k = Math.max(3, Math.round(fps / 30)), below = j2 => Number.isFinite(y[j2]) && y[j2] > level + tol;
    const apex = a - k >= 0 && b + k < n && below(a - k) && below(b + k);
    // A foot never rises from under the floor into a contact: lower just before the run means it
    // was still on its way up. And a short run whose level keeps sinking is the slow fall after
    // the top, not a planted foot. Both took a CMJ with the feet drawn up for two contacts in
    // mid-air and lost the jump (2026-11-14, 240 fps, hand-held: 764-806 and 824-851).
    const risingInto = a - k >= 0 && below(a - k);
    const q = Math.max(2, Math.round((b - a + 1) / 4));
    const sinking = (b - a + 1) / fps < 0.3 && median(y.slice(b - q + 1, b + 1)) - median(y.slice(a, a + q)) > Math.max(0.025 * pxM, 1.25 * PX);
    // and at least 3 frames: at 60 fps a 2-frame "contact" of the other foot just before the landing
    // (IMG_2213, 381-382) split the hop and lost it; a real contact is 80 ms or more
    if (!apex && !risingInto && !sinking && (b - a + 1) / fps * 1000 >= minMs && b - a + 1 >= 3) runs.push({ td: a, to: b, level });
    i = Math.max(i + 1, b + 1);   // always forward: a run grown back and trimmed can end before i
  }
  // runs that touch or overlap after growing are one contact
  const merged = [];
  // ...unless the foot went down a level: stepping off a box onto the floor is two contacts
  for (const r of runs) { const p = merged.at(-1); if (p && r.td <= p.to + 1 && Math.abs(r.level - p.level) <= 0.08 * pxM) { p.to = Math.max(p.to, r.to); p.level = Math.max(p.level, r.level); } else merged.push({ ...r }); }
  return merged;
}

// result: the pose result (wire shape after fromWire), ts: frame times in s.
// noBox: the drill has no box (Claude saw none): a long first contact is never "on the box".
export function rsiAnalysis(result, ts, { sex = 'male', height = null, boxCm = null, cam = null, noBox = false } = {}) {
  const track = rawTrack(result, cam);
  if (!track.length) return { error: 'Vo videu som nenašiel športovca.' };
  const fps = (ts.length - 1) / (ts.at(-1) - ts[0]);
  const pxM = scaleAt(track, sex, height);
  if (!(pxM > 0)) return { error: 'Appka na videu nenašla nohy na meranie. Je to chyba rozboru.' };
  const feet = { l: med5(track.map(kp => footLow(kp, 'l'))), r: med5(track.map(kp => footLow(kp, 'r'))) };
  const runs = { l: footRuns(feet.l, fps, pxM), r: footRuns(feet.r, fps, pxM) };

  // Ground contacts of the body: any foot down. Each keeps which feet were down and its level.
  const n = track.length, down = new Array(n).fill(null);
  for (const s of ['l', 'r']) for (const r of runs[s]) for (let i = r.td; i <= r.to; i++) (down[i] ??= {})[s] = r.level;
  // A foot held still more than 12 cm above the other one is the free leg of a single-leg
  // contact. (5 cm took one of two planted feet for a free leg from the front, IMG_3521: the foot
  // nearer the phone sits lower in the picture.)
  for (const d of down) if (d && d.l != null && d.r != null) { const lo = Math.max(d.l, d.r); for (const s of ['l', 'r']) if (d[s] < lo - 0.12 * pxM) delete d[s]; }
  // A foot landing a box-height lower than the contact so far starts a new contact: stepping off
  // a box on one leg, the other foot is still on the box when the first lands on the floor
  // (IMG_4186, Miška single-leg off a ~15 cm box, 2026-11-13: the floor contact had been merged
  // into the standing on the box). The foot still up on the box is not part of the new contact.
  const STEP = 0.08 * pxM; // 8 cm
  const lowest = d => Math.max(...Object.values(d));
  const contacts = [];
  for (let i = 0; i < n; i++) {
    if (!down[i]) continue;
    let j = i, lvl = lowest(down[i]);
    while (j + 1 < n && down[j + 1] && lowest(down[j + 1]) <= lvl + STEP) { lvl = Math.max(lvl, lowest(down[j + 1])); j++; }
    const lv = [], used = new Set();
    // a foot counts for the contact within the free-leg line (12 cm), not the 8 cm step: filmed a
    // little from the side the foot nearer the phone sits lower (IMG_3519, 2026-11-18: both feet down,
    // 9 cm apart in the picture, read as a single-leg drop jump)
    for (let k = i; k <= j; k++) for (const [s, l] of Object.entries(down[k])) if (l >= lvl - 0.12 * pxM) { used.add(s); lv.push(l); }
    contacts.push({ td: i, to: j, level: Math.max(...lv), feet: [...used].sort().join('') });
    i = j;
  }
  // A sliver under 60 ms that runs straight into a lower contact is the same landing: one foot sat
  // a few cm higher in the picture and came down two frames before the other (1794929272459,
  // server run of 2026-11-18: left foot 236-237, both on the floor from 238, by eye 239). Split, the
  // drop jump read as nothing, or as one leg. Its foot joins the contact; the touchdown stays.
  for (let k = contacts.length - 2; k >= 0; k--) {
    const a = contacts[k], b = contacts[k + 1];
    if ((a.to - a.td + 1) / fps < 0.06 && b.td <= a.to + 1 && b.level > a.level + STEP && (b.to - b.td + 1) > (a.to - a.td + 1)) {
      b.feet = [...new Set((a.feet + b.feet).split(''))].sort().join('');
      contacts.splice(k, 1);
    }
  }
  // A flight lifts the feet. Standing still on the box, filmed close with only the legs in the
  // picture and the phone moving, the foot points wander and the stillness rule broke the stand into
  // pieces with "flights" of 0.06-0.39 s between them, during which the lowest foot never rose
  // (2026-11-17, Stanley 17:17: a 0.03 RSI "rebound" on the box). Pieces at one level with the feet
  // under 2.5 cm off it all the way between them are one contact. Even a 0.15 s hop lifts them 3 cm.
  const lowY = i => Math.max(feet.l[i], feet.r[i]);
  for (let k = contacts.length - 2; k >= 0; k--) {
    const a = contacts[k], b = contacts[k + 1];
    if (Math.abs(a.level - b.level) > STEP || b.td - a.to < 2) continue;
    let lift = 0, known = true;
    for (let i = a.to + 1; i < b.td; i++) { const y = lowY(i); if (!Number.isFinite(y)) { known = false; break; } lift = Math.max(lift, Math.max(a.level, b.level) - y); }
    if (known && lift < 0.025 * pxM) { a.to = b.to; a.level = Math.max(a.level, b.level); a.feet = [...new Set((a.feet + b.feet).split(''))].sort().join(''); contacts.splice(k + 1, 1); }
  }
  // A short "contact" well above the ground on both sides of it is the foot hanging in the air
  // (a CMJ with the feet drawn up, 2026-11-14): nobody lands 10 cm up and jumps back down in
  // under 0.3 s. A box is stood on longer, and is not higher than the contact before it.
  // Later, not next: two such pieces in a row kept each other (2026-11-18, rsi.mp4: the rebound took
  // the feet out of the top of the picture and the pose sat on someone behind the box, 177-199 and
  // 206-214 some 30 cm "up", the landing on the floor at 217; the flight read 0.33 s for 0.66 s).
  for (let again = true; again;) {
    again = false;
    for (let k = contacts.length - 2; k >= 1; k--) {
      const c = contacts[k], up = 0.10 * pxM, later = Math.max(...contacts.slice(k + 1).map(x => x.level));
      if ((c.to - c.td + 1) / fps < 0.3 && c.level < contacts[k - 1].level - up && c.level < later - up) { contacts.splice(k, 1); again = true; }
    }
  }
  // The same at the top of the last flight, when the clip ends before a landing run is long enough
  // to count (Miška 15:01, 114112: the feet paused at the apex 184-196, the landing is at 227 of 228).
  { const k = contacts.length - 1, c = contacts[k], up = 0.10 * pxM;
    if (k >= 1 && (c.to - c.td + 1) / fps < 0.3 && c.level < contacts[k - 1].level - up) contacts.splice(k, 1); }
  // A landing in the last few frames: after a rebound off the box, the feet go up and come back to
  // the floor before the clip ends, too briefly for the stillness rule (60 ms).
  {
    const c = contacts.at(-1), p = contacts.at(-2);
    const before = p ? (c.td - p.to - 1) / fps : 0;
    if (c && p && before >= 0.06 && before <= 0.23 && (c.to - c.td + 1) / fps < 0.6 && c.to < n - 1) {
      // In the phone-motion-corrected picture a hand-held phone shifts the floor by a few cm over the
      // flight (114112: rebound level 852 px, the feet on the floor at 921-932), so the level only says
      // the feet are low again; the touchdown is where their fall stops: the first frame that drops
      // under half of the three frames before it.
      let up = false, land = null;
      for (let i = c.to + 1; i < n; i++) {
        const y = lowY(i);
        if (!Number.isFinite(y)) continue;
        if (y < c.level - 0.05 * pxM) { up = true; continue; }
        if (!up || i < 4) continue;
        const v = [1, 2, 3].map(q => lowY(i - q) - lowY(i - q - 1)), fall = median(v), now = y - lowY(i - 1);
        if (fall > PX / 2 && now < 0.5 * fall) { land = i; break; }
      }
      if (land != null && (land - c.to - 1) / fps >= 0.3) contacts.push({ td: land, to: n - 1, level: c.level, feet: c.feet, atEnd: true });
    }
  }
  if (!contacts.length) return { error: 'Na videu som nenašiel žiadny dotyk so zemou.' };
  // The run grows to every frame within 2 cm of its level, and filmed close (only the legs, the
  // phone moving with the athlete) that took in the last frames of the fall: touchdowns 3-4 frames
  // before the shoe was down (2026-11-17, 932274606: 212 for 216, 929272459: 236 for 239). After a
  // flight the contact starts where the fall stops: the first frame whose drop is under half of the
  // three before it. (With a still phone the toe edges set the frames later anyway: refineEdges.)
  for (let k = 1; k < contacts.length; k++) {
    const c = contacts[k], p = contacts[k - 1];
    if (c.td - p.to < 6 || c.to - c.td < 6) continue;
    for (let i = c.td, moved = 0; moved < 6 && i < c.to - 3; i++, moved++) {
      const fall = median([1, 2, 3].map(q => lowY(i - q + 1) - lowY(i - q)));
      const now = lowY(i + 1) - lowY(i);
      if (!(fall > PX / 2) || !(now >= 0.5 * fall)) { c.td = i; break; }
      c.td = i + 1;
    }
  }

  // A sliver of one or two frames at the very start, right before the next contact, is the first
  // frame of the clip read apart from the stand (2026-11-18, 1794925090410 on a second server run:
  // 0-0 and 1-356, and the stand on the box no longer counted as one): it joins the stand.
  if (contacts.length > 1 && contacts[0].td === 0 && contacts[0].to - contacts[0].td < 2 && contacts[1].td - contacts[0].to <= 2) { contacts[1].td = 0; contacts.shift(); }
  // The floor is the lowest level (largest y) used by contacts; a level well above it is a box.
  const floor = Math.max(...contacts.map(c => c.level));
  // On the box: standing there (300 ms or more) at the start, with the next contact a step lower.
  // Not "highest level in the clip": from the front a landing nearer the phone sits lower in the
  // picture, and the real floor contact then looked like a box (IMG_4186, IMG_3521).
  contacts.forEach(c => { c.ms = ((c.to - c.td + 1) / fps) * 1000; });
  // Between leaving a stand and the next contact, the lower foot never rose more than 5 cm above
  // the stand (known on most frames between). Off a box it only goes down to the floor; a jump
  // from the floor with 0.35 s in the air lifts both feet g t^2 / 8 = 15 cm. The feet, not the hips:
  // filmed close (only the legs), the hips are out of the picture (1794929272459).
  const lowAt = i => Math.max(feet.l[i], feet.r[i]);
  const riseOf = (c, b) => {
    const ys = []; for (let i = c.to + 1; i < b; i++) ys.push(lowAt(i));
    const known = ys.filter(Number.isFinite);
    return !ys.length || known.length < 0.7 * ys.length ? NaN : (c.level - Math.min(...known)) / pxM;
  };
  const feetOnlyFall = (c, b) => riseOf(c, b) <= 0.05;
  // a gap of T s in the stand was a hop only if the feet rose at least half of what that much time
  // in the air takes (g T^2 / 8): a phone drifting while the athlete stands moved the feet 5 cm
  // in 0.68 s (1794932274606), a hop that long lifts them 56 cm
  const hopIn = (c, d) => { const T = gap(c, d) / 1000, r0 = riseOf(c, d.td); return T >= 0.06 && Number.isFinite(r0) && r0 > Math.max(0.05, (0.5 * 9.81 * T * T) / 8); };

  const gap = (a, b) => ((b.td - a.to - 1) / fps) * 1000;
  contacts.forEach((c, k) => {
    const next = contacts[k + 1], after = contacts[k + 2];
    // A clip that starts with the athlete already standing still counts what it shows of the stand.
    // Pieces with under 0.1 s between them are one stand: nobody jumps or steps off a box and back
    // in that time (2026-11-18, 1794929272459 on a second server run: the stand came as 0-92,
    // 101-130, 133-183, 187-209 and the last piece, 192 ms, was not a stand).
    let g0 = k;
    while (g0 > 0 && gap(contacts[g0 - 1], contacts[g0]) < 100) g0--;
    const groupMs = ((c.to - contacts[g0].td + 1) / fps) * 1000;
    const stood = c.ms >= 300 || groupMs >= 300 || (g0 === 0 && contacts[0].td <= 2 && groupMs >= 150);
    const level = !noBox && stood && !!next && next.level - c.level > STEP;
    // Off a box by the timing alone: a stand, a short drop (stepping off 30 cm takes 0.13-0.15 s
    // here, a jump from the floor is 0.35 s or more in the air), then a rebound with a real flight
    // after it. A CMJ has no flight before its take-off. From a low phone the box top and the floor
    // in front of it sit at nearly the same height in the picture, and Claude, seeing only legs,
    // said "no box" (2026-11-17: Stanley's 15:17 drop jump came out as a pogo, Miška's 15:01 as a CMJ).
    // Off a higher box the fall is longer (free fall from 50 cm is 0.32 s; Miška's 50 cm stand to
    // floor was 0.23 s, 2026-11-18), as long as a jump from the floor (0.35 s or more in the air) is
    // told apart: off a box the feet only go down, from the floor they rise first.
    const fall = !!next && gap(c, next);
    const byFlight = stood && !!next && !!after && fall >= 60 && (fall <= 230 || (fall <= 450 && feetOnlyFall(c, next.td))) && next.ms < 600 && gap(next, after) >= 300;
    // The stand may come in pieces (close-up of the legs, a phone that moves): by the timing it
    // still counts when every piece before it is at the same level, so the athlete never left the box.
    const sameStand = contacts.slice(0, k).every(p => Math.abs(p.level - c.level) <= 1.5 * STEP);
    // The last piece of a stand on the box, with no flight before it and nearer the box than the
    // floor below (Miška 2026-11-18, 50 cm, phone tilting down: 187-843 standing, 844-861 the right
    // foot alone before stepping off, read as a rebound of RSI 0,13): still on the box.
    const p = contacts[k - 1];
    const piece = !!p?.onBox && c.td - p.to <= 2 && !!next && next.level - c.level > STEP && c.level - p.level < 0.5 * (next.level - p.level);
    c.onBox = piece || (level && (k === 0 || contacts[k - 1].onBox)) || (byFlight && (k === 0 || contacts[k - 1].onBox || sameStand));
    c.byFlight = c.onBox && byFlight;
    if (c.byFlight) for (let q = 0; q < k; q++) { contacts[q].onBox = true; contacts[q].byFlight = true; }
  });
  // The drop jump as a sequence of phases (2026-11-18, research in the vault): a stand from the
  // start of the clip with no hop in it, a fall of 0.06-0.45 s in which the lower foot only goes
  // down, a contact of 0.08-0.6 s, and a flight of 0.3 s or more. Everything before the fall is the
  // stand on the box, however the pose cut it into pieces or the moving phone shifted its level
  // (1794932274606 on a second server run: 0-52, 134-185, 186-199 at levels 749, 777, 885).
  if (!noBox && !contacts.some(c => c.onBox)) {
    for (let r = 1; r < contacts.length - 1; r++) {
      const R = contacts[r], before = contacts[r - 1], after = contacts[r + 1];
      const span = ((before.to - contacts[0].td + 1) / fps) * 1000, drop = gap(before, R);
      if (span < 300 || drop < 60 || drop > 450 || R.ms < 80 || R.ms > 600 || gap(R, after) < 300) continue;
      if (!feetOnlyFall(before, R.td)) continue;
      let hop = false;
      for (let q = 1; q < r; q++) if (hopIn(contacts[q - 1], contacts[q])) hop = true;
      if (hop) break;
      for (let q = 0; q < r; q++) { contacts[q].onBox = true; contacts[q].byFlight = true; }
      break;
    }
  }
  // Stepping off, the leading foot hangs still in front of the box for a moment before the drop
  // (Miška 2026-11-17 15:02, frames 230-252, one foot, then 0.14 s "in the air" and both feet
  // land): no contact, the drop goes on to the next one. A real single-leg landing off the box
  // (IMG_4186) jumps up after it, it is not followed by a two-foot landing a moment later.
  for (let k = 1; k < contacts.length - 1; k++) {
    const p = contacts[k - 1], c = contacts[k], nx = contacts[k + 1];
    if (p.onBox && c.td - p.to <= 2 && c.feet.length === 1 && nx.feet.length === 2 && gap(c, nx) < 200) { contacts.splice(k, 1); k--; }
  }
  // Flights between contacts, and what each contact did: reactive (air before and after, short),
  // a standing start or finish, a drop from the box.
  const events = contacts.map((c, k) => {
    const prev = contacts[k - 1], next = contacts[k + 1];
    const flightBefore = prev ? ((c.td - prev.to - 1) / fps) * 1000 : null;
    const flightAfter = next ? ((next.td - c.to - 1) / fps) * 1000 : null;
    return { ...c, flightBefore, flightAfter };
  });
  // Air before, or straight off the box (stepping down one foot at a time leaves no flight).
  const reactive = events.filter((e, k) => !e.onBox && (e.flightBefore > 60 || events[k - 1]?.onBox) && e.flightAfter > 60 && e.ms < 600);
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
  // the longest piece of the stand at the start: a phone tilting down while the athlete stands
  // cuts it into pieces, the first one short (Miška 2026-11-18: 0-19, 29-173, 187-843)
  const lead = events.slice(0, Math.max(1, events.findIndex(e => !e.onBox))).filter(e => e.onBox);
  const stand = lead.reduce((b, e) => (!b || e.ms > b.ms ? e : b), null);
  const firstUp = stand && stand.ms > 300 ? ((floor - stand.level) / pxM) * 100 : null;
  const levelBox = firstUp != null && firstUp >= 10 && firstUp <= 100;
  const startsOnBox = levelBox || !!events[0]?.byFlight;
  const boxEstCm = levelBox ? firstUp : null;
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

// Contact edges from the toe against the floor (server/sprint.mjs measureMotion + sprint.js
// footContacts): a foot is down only while its toe stands still relative to the floor beside it.
// The level-and-stillness rule above counted the frames just before touchdown and after toe-off
// as ground: IMG_3521 read 283 ms on the ground and 617 ms in the air where Stanley counted
// 240 / 640 (2026-11-14), the same mistake the sprint had (0.16 s by eye, 0.10 s by toe motion).
// toe: [{ foot, a, b }] with a the first and b the last frame on the ground.
// land: touchdown frames only (touchdowns below): landing on bent legs the toe keeps moving after
// it lands, so a still-run rule misses it.
// Edges move at most 8 frames: a toe that stood still on the box and then on the floor must not
// pull the floor contact back to the start of the clip (IMG_4186).
// Contact edges from the pixels of the shoes (2026-11-18, after the research in the vault note
// "Jump Video Analyzer - exact timing, speed and playback research"). motion: per frame the toe
// patch's motion to the next frame against the floor beside it (server/sprint.mjs). A falling foot
// moves 15-25 px a frame and stops at once on the floor; a leaving toe goes from still to the
// rising speed. Each edge is the sub-frame moment the toe's speed crosses a share of that speed,
// interpolated between the two frames around it: touchdown where the second foot falls under 40 %
// of its falling speed (first frame on the floor: the next whole frame), toe-off where the first
// foot rises past 50 % of its rising speed (last frame on the floor: the whole frame before). The
// same rule over 30-50 % (touchdown) and 40-60 % (toe-off) keeps all 24 touchdowns and landings and
// all 14 toe-offs of the hand-checked set within one frame, on two server runs whose pose differed
// by up to two frames. A phone that follows the athlete smears the stop over 2-3 frames: there the
// pose's own edges stand.
const PX_TD = 0.4, PX_TO = 0.5;
function vyOf(motion) {
  const by = new Map();
  for (const m of motion ?? []) if (m?.g) by.set(m.f, { l: m.l ? m.l[1] - m.g[1] : NaN, r: m.r ? m.r[1] - m.g[1] : NaN });
  return f => by.get(f) ?? { l: NaN, r: NaN };
}
const med4 = a => { const b = a.filter(Number.isFinite).sort((p, q) => p - q); return b.length >= 2 ? b[b.length >> 1] : NaN; };
function stopAt(v, foot, c) {        // sub-frame time a falling toe stops, searched around frame c
  for (let f = c - 6; f <= c + 5; f++) {
    const fall = med4([v(f - 5)[foot], v(f - 4)[foot], v(f - 3)[foot], v(f - 2)[foot]]);
    if (!(fall > 3)) continue;
    const a = v(f - 1)[foot], b = v(f)[foot], th = PX_TD * fall;
    if (a >= th && b < th) return f - 1 + (a - th) / (a - b);
  }
  return NaN;
}
function leaveAt(v, foot, c) {       // sub-frame time a toe leaves the floor, searched around frame c
  for (let f = c - 4; f <= c + 6; f++) {
    const rise = med4([v(f + 2)[foot], v(f + 3)[foot], v(f + 4)[foot]]);
    if (!(rise < -3)) continue;
    const a = v(f - 1)[foot], b = v(f)[foot], th = PX_TO * rise;
    if (a > th && b <= th) return f - 1 + (a - th) / (a - b);
  }
  return NaN;
}
export function pixelEdges(r, motion, fps) {
  if (!r?.events?.length || !motion?.length) return r;
  const v = vyOf(motion), G0 = 9.81;
  const fin = x => x.filter(Number.isFinite);
  const events = r.events.map(e => {
    if (e.onBox) return { ...e };
    const tTD = Math.max(...fin([stopAt(v, 'l', e.td), stopAt(v, 'r', e.td)]));
    const tTO = Math.min(...fin([leaveAt(v, 'l', e.to), leaveAt(v, 'r', e.to)]));
    const td = Number.isFinite(tTD) ? Math.ceil(tTD) : e.td, to = Number.isFinite(tTO) ? Math.floor(tTO) : e.to;
    return { ...e, td, to: to > td ? to : e.to, edges: Number.isFinite(tTD) || Number.isFinite(tTO) ? 'pixels' : 'pose' };
  });
  const jumps = r.jumps.map(j => {
    const k = r.events.findIndex(e => e.td === j.td), e = events[k], next = events[k + 1];
    if (!e || !next || e.onBox) return j;
    const contactMs = ((e.to - e.td + 1) / fps) * 1000, flightMs = ((next.td - e.to - 1) / fps) * 1000;
    if (!(contactMs > 40 && flightMs > 60)) return j;
    const t = flightMs / 1000, h = (G0 * t * t) / 8;
    return { ...j, raw: { td: j.td, to: j.to, contactMs: j.contactMs, flightMs: j.flightMs }, td: e.td, to: e.to,
      contactMs, flightMs, heightCm: h * 100, rsi: h / (contactMs / 1000), ri: flightMs / contactMs, slow: contactMs > 250, edges: 'pixels' };
  });
  const standing = (r.standing ?? []).map(st => {
    const k = r.events.findIndex(e => e.td === st.td), e = events[k], next = events[k + 1];
    if (!e || !next) return st;
    const flightMs = ((next.td - e.to - 1) / fps) * 1000;
    if (!(flightMs > 100)) return st;
    const t = flightMs / 1000;
    return { ...st, raw: { to: st.to, flightMs: st.flightMs }, to: e.to, flightMs, heightCm: ((G0 * t * t) / 8) * 100, edges: 'pixels' };
  });
  const best = jumps.reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);
  const top5 = jumps.length >= 5 ? [...jumps].sort((a, b) => b.rsi - a.rsi).slice(0, 5) : null;
  const best5 = top5 && { rsi: top5.reduce((a, j) => a + j.rsi, 0) / 5, ri: top5.reduce((a, j) => a + j.ri, 0) / 5, contactMs: top5.reduce((a, j) => a + j.contactMs, 0) / 5 };
  return { ...r, jumps, standing, best, best5, events: events.map(e => ({ ...e, ms: Math.round(((e.to - e.td + 1) / fps) * 1000) })) };
}

export function refineEdges(r, toe, fps, land = toe) {
  if (!r?.events?.length || !toe?.length) return r;
  const G0 = 9.81, W = 8;
  const edge = (e, list) => {
    // toe runs that overlap the contact itself: a toe hanging still in the air a few frames before
    // or after it (Miška 2026-11-18: falling 872-881, rising 918-926 around 887-911) is no contact
    const near = list.filter(c => c.b >= e.td && c.a <= e.to);
    if (!near.length) return null;
    return { td: Math.max(e.td - W, Math.min(...near.map(c => c.a))), to: Math.min(e.to + W, Math.max(...near.map(c => c.b))) };
  };
  const events = r.events.map((e, k) => {
    if (e.onBox) return { ...e };
    // Against the frames by hand (13 drop jumps, 2026-11-17/18, still phone): the toe stops one
    // frame after the shoe is down (6 of 7), and the pose's contact holds one frame past the
    // toe-off; the toe-off is the pose's minus one averaged with the toe's (every one within a frame).
    const full = edge(e, toe);
    const out = { ...e, ...(full ? { td: Math.max(e.td, full.td - 1), to: Math.floor((e.to - 1 + full.to) / 2) } : {}) };
    // The landing after a rebound: its touchdown frame, from the foot that jumped when one did
    // (Miška's free leg swung down at 366, her right foot landed at 368).
    const jumped = r.jumps.find(j => j.td === r.events[k - 1]?.td) ?? (r.standing ?? []).find(j => j.td === r.events[k - 1]?.td);
    if (jumped) {
      const first = edge(e, land.filter(c => jumped.feet.length > 1 || c.foot === jumped.feet));
      if (first) out.td = first.td;
    }
    // Straight off the box with no flight between, the toe stood still on the box and then on the
    // floor: the level step found the touchdown (IMG_4186: 288), the toe can't move it earlier.
    const prev = r.events[k - 1];
    if (prev?.onBox && prev.to >= e.td - 1) out.td = Math.max(out.td, e.td);
    return out;
  });
  const jumps = r.jumps.map(j => {
    const k = r.events.findIndex(e => e.td === j.td), e = events[k], next = events[k + 1];
    if (!e || !next || e.onBox) return j;
    const contactMs = ((e.to - e.td + 1) / fps) * 1000, flightMs = ((next.td - e.to - 1) / fps) * 1000;
    if (!(contactMs > 40 && flightMs > 60)) return j;
    const t = flightMs / 1000, h = (G0 * t * t) / 8;
    return { ...j, raw: { td: j.td, to: j.to, contactMs: j.contactMs, flightMs: j.flightMs }, td: e.td, to: e.to,
      contactMs, flightMs, heightCm: h * 100, rsi: h / (contactMs / 1000), ri: flightMs / contactMs, slow: contactMs > 250, edges: 'toe' };
  });
  // Vertical jumps from standing: the toe-off and the landing the same way, so the flight (and
  // with it the height) has no hover frames in it either.
  const standing = (r.standing ?? []).map(st => {
    const k = r.events.findIndex(e => e.td === st.td), e = events[k], next = events[k + 1];
    if (!e || !next) return st;
    const flightMs = ((next.td - e.to - 1) / fps) * 1000;
    if (!(flightMs > 100)) return st;
    const t = flightMs / 1000;
    return { ...st, raw: { to: st.to, flightMs: st.flightMs }, to: e.to, flightMs, heightCm: ((G0 * t * t) / 8) * 100, edges: 'toe' };
  });
  const best = jumps.reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);
  const top5 = jumps.length >= 5 ? [...jumps].sort((a, b) => b.rsi - a.rsi).slice(0, 5) : null;
  const best5 = top5 && { rsi: top5.reduce((a, j) => a + j.rsi, 0) / 5, ri: top5.reduce((a, j) => a + j.ri, 0) / 5, contactMs: top5.reduce((a, j) => a + j.contactMs, 0) / 5 };
  return { ...r, jumps, standing, best, best5, events: events.map(e => ({ ...e, ms: Math.round(((e.to - e.td + 1) / fps) * 1000) })) };
}

// Touchdowns from the toe against the floor: the first frame where a toe that was coming down
// (over 0.4 %h per 1/120 s for two frames) stops (0.2 or less). Landing on bent legs the toe
// keeps creeping afterwards, so how long it then stays still says nothing (IMG_3521 landed at 202
// on one server run and "208" on the next with a still-run rule).
export function touchdowns(motion, foot, fps) {
  const k = 120 / fps, vy = motion.map(m => (m?.g && m[foot] ? ((m[foot][1] - m.g[1]) / m.h) * 100 * k : null));
  const out = [];
  for (let i = 2; i < motion.length; i++) {
    if (vy[i] != null && vy[i] <= 0.2 && vy[i - 1] > 0.4 && vy[i - 2] > 0.4) out.push({ foot, a: motion[i].f, b: motion[i].f });
  }
  return out;
}

// The stretches an RSI clip needs frame by frame, from contacts found on a coarse pose (every 4th
// frame, the rest filled in): each contact on the floor with `pad` frames either side; the first
// from `before` frames ahead (the fall off the box decides it is a drop jump); the last on to
// tailS after it, where the landing must be (a landing in the clip's last frames was missed on
// the coarse pose, IMG Miška 1794924114112). Checked on the 2026-11-17/18 hand set, two server
// runs, with 3-6 frame steps, before 24-48 and pad 16-28: every edge as on the full pose.
// The first also from `pad` frames before the stand on the box ends: a fall longer than `before`
// (1794929272459 on the 2026-11-18 server run: off the box at 209, on the floor at 238) left the
// stand's end on the coarse pose, and the stand broke up into a 2-frame contact before the real one.
export function denseWindows(events, fps, { before = 40, pad = 24, tailS = 0.8 } = {}) {
  const all = events ?? [], floor = all.filter(e => !e.onBox);
  return floor.map((e, k) => {
    const box = k === 0 ? all.filter(x => x.onBox && x.to < e.td).at(-1) : null;
    const a = k === 0 ? Math.min(e.td - before, box ? box.to - pad : Infinity) : e.td - pad;
    return [a, k === floor.length - 1 ? e.to + Math.round(tailS * fps) : e.to + pad];
  });
}
// The contacts on the floor whose edges (16 frames either side, as the pixel reading uses) are not
// all on posed frames: the stretch to add before the numbers can stand.
export function unposedAround(events, posedAt, first, last, pad = 16) {
  const out = [];
  for (const e of events ?? []) {
    if (e.onBox) continue;
    const a = Math.max(first, e.td - pad), b = Math.min(last, e.to + pad);
    for (let i = a; i <= b; i++) if (!posedAt(i)) { out.push([a, b]); break; }
  }
  return out;
}

// Whether the shoe pixels can be trusted for the edges, from the phone's motion where it matters:
// within each floor contact (16 frames either side). A phone swinging after the athlete (IMG_2213
// hops, the frame moving 16-22 % of its short side in a contact) or one whose tracking was lost
// there after it had moved a lot (1794924961224) leaves no steady floor: there the pose's edges.
// The whole clip's motion was the rule before, and a phone tilting while the athlete stood
// (Miška 2026-11-18, 112 px against a limit of 108 once cut to the jump) lost the pixel edges for
// nothing: toe-off 2 frames late, RSI 1,78 for 2,05. Checked on 14 hand-read clips (2026-11-18).
export function phoneFollows(camera, events, W, H) {
  if (!camera?.h) return false;
  const side = Math.min(W, H), keys = Object.keys(camera.h).map(Number).sort((a, b) => a - b);
  const centre = k => applyH(camera.h[k], [W / 2, H / 2]);
  for (const e of events ?? []) {
    if (e.onBox) continue;
    const ks = keys.filter(k => k >= e.td - 16 && k <= e.to + 16);
    if (ks.length < 2) { if (camera.moved > 0.1 * side) return true; continue; }
    const p0 = centre(ks[0]);
    for (const k of ks) { const p = centre(k); if (Math.hypot(p[0] - p0[0], p[1] - p0[1]) > 0.1 * side) return true; }
  }
  return false;
}
