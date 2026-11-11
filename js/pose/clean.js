// Cleans a keypoint track: fixes left/right swaps, removes spikes, fills short gaps,
// and makes a smoothed copy for display and angles. The unsmoothed (cleaned) copy is
// kept for event timing, because low-pass filtering smears touchdown/toe-off peaks.
import { J, JI } from './models.js';

const K = J.length;
const LEG = ['hip', 'knee', 'ank', 'heel', 'bigtoe', 'smalltoe'];
const ARM = ['elb', 'wri'];
const pairs = parts => parts.map(p => [JI['l' + p], JI['r' + p]]);
export const LEG_PAIRS = pairs(LEG);
export const ARM_PAIRS = pairs(ARM);

// Body size per frame (shoulder-mid to hip-mid), to make distances scale-free.
function torso(f) {
  const mid = (a, b, c) => (f[a * 3 + c] + f[b * 3 + c]) / 2;
  const s = [mid(JI.lsho, JI.rsho, 0), mid(JI.lsho, JI.rsho, 1)];
  const h = [mid(JI.lhip, JI.rhip, 0), mid(JI.lhip, JI.rhip, 1)];
  return Math.max(1, Math.hypot(s[0] - h[0], s[1] - h[1]));
}

const pos = (f, k, swap, pr) => {
  if (swap) for (const [l, r] of pr) { if (k === l) { k = r; break; } if (k === r) { k = l; break; } }
  return [f[k * 3], f[k * 3 + 1]];
};

// Viterbi over {as detected, swapped} for one limb group. Transition cost is how far
// the group's points jump between consecutive frames under each labelling; a real
// swap glitch makes both legs "teleport", the right labelling keeps them continuous.
// Continuity alone can't tell left from right after the legs cross, so each swapped
// frame also pays `trust`: the model's own labels (it sees near vs far leg) win unless
// keeping them makes the limbs teleport.
export function resolveSwaps(frames, pr, ok, trust = 0.15) {
  const idx = [];
  frames.forEach((f, i) => { if (f) idx.push(i); });
  if (idx.length < 2) return new Set();
  const keys = pr.flat();
  const cost = (fa, sa, fb, sb, scale) => {
    let c = 0, n = 0;
    for (const k of keys) {
      if (!ok(fa, k) || !ok(fb, k)) continue;
      const [ax, ay] = pos(fa, k, sa, pr), [bx, by] = pos(fb, k, sb, pr);
      c += Math.hypot(ax - bx, ay - by) / scale; n++;
    }
    return n ? c / n : 0;
  };
  let acc = [0, trust];
  const back = [];
  for (let t = 1; t < idx.length; t++) {
    const fa = frames[idx[t - 1]], fb = frames[idx[t]];
    const scale = torso(fb);
    const next = [0, 1].map(sb => {
      const opts = [0, 1].map(sa => acc[sa] + cost(fa, sa, fb, sb, scale) + (sb ? trust : 0));
      return opts[0] <= opts[1] ? [opts[0], 0] : [opts[1], 1];
    });
    back.push(next.map(n => n[1]));
    acc = next.map(n => n[0]);
  }
  const swapped = new Set();
  let s = acc[0] <= acc[1] ? 0 : 1;
  for (let t = idx.length - 1; t >= 0; t--) {
    if (s) swapped.add(idx[t]);
    if (t > 0) s = back[t - 1][s];
  }
  return swapped;
}

// Both feet on one spot: for a few frames the model can put the left and the right foot in the
// same place (IMG_4676, frames 547-549, in the middle of the take-off contact: the stance foot
// vanished, the contact split in two and the board contact came out as 0 ms). The foot that
// jumped away from where it last was is dropped; the gap is filled later like any other. Point
// by point, because the collapse is often partial: at 547 the toes and heels sat together while
// the ankles did not. Returns the frames that were changed.
const FOOT = ['ank', 'heel', 'bigtoe', 'smalltoe'].map(p => [JI['l' + p], JI['r' + p]]);
export function dropCollapsedFeet(frames, ok, { near = 0.12, back = 10 } = {}) {
  const changed = new Set();
  const last = {}; // keypoint -> [x, y, frame] where it was last seen apart from its pair
  frames.forEach((f, i) => {
    if (!f) return;
    const sc = torso(f);
    let g = null;
    for (const [l, r] of FOOT) {
      if (!ok(f, l) || !ok(f, r)) continue;
      const pt = k => [f[k * 3], f[k * 3 + 1]];
      if (Math.hypot(f[l * 3] - f[r * 3], f[l * 3 + 1] - f[r * 3 + 1]) >= near * sc) { last[l] = [...pt(l), i]; last[r] = [...pt(r), i]; continue; }
      const away = k => { const p = last[k]; return p && i - p[2] <= back ? Math.hypot(f[k * 3] - p[0], f[k * 3 + 1] - p[1]) : NaN; };
      const dl = away(l), dr = away(r);
      if (!Number.isFinite(dl) || !Number.isFinite(dr)) continue;
      // Feet really side by side (in flight, landing) both arrive smoothly: only a point that
      // teleported goes (548: the right toe 240 px from where it stood a frame earlier).
      if (Math.max(dl, dr) < Math.max(0.5 * sc, 2 * Math.min(dl, dr))) continue;
      g ??= Float32Array.from(f);
      g[(dl > dr ? l : r) * 3 + 2] = 0;
    }
    if (g) { frames[i] = g; changed.add(i); }
  });
  return [...changed];
}

function applySwap(f, pr) {
  const g = Float32Array.from(f);
  for (const [l, r] of pr) for (let c = 0; c < 3; c++) { g[l * 3 + c] = f[r * 3 + c]; g[r * 3 + c] = f[l * 3 + c]; }
  return g;
}

const median = a => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Hampel filter: points more than 3 MADs from the local median become gaps (NaN).
export function hampel(x, half) {
  const out = Float64Array.from(x);
  const flagged = [];
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) continue;
    const w = [];
    for (let j = Math.max(0, i - half); j <= Math.min(x.length - 1, i + half); j++) if (!Number.isNaN(x[j])) w.push(x[j]);
    if (w.length < 3) continue;
    const m = median(w), mad = 1.4826 * median(w.map(v => Math.abs(v - m)));
    if (mad > 0 && Math.abs(x[i] - m) > 3 * mad) { out[i] = NaN; flagged.push(i); }
  }
  return { out, flagged };
}

// Fills NaN runs no longer than maxGap with linear interpolation; longer runs stay NaN.
export function fillGaps(x, maxGap) {
  const out = Float64Array.from(x);
  let i = 0;
  while (i < out.length) {
    if (!Number.isNaN(out[i])) { i++; continue; }
    let j = i;
    while (j < out.length && Number.isNaN(out[j])) j++;
    if (i > 0 && j < out.length && j - i <= maxGap) {
      for (let k = i; k < j; k++) out[k] = out[i - 1] + (out[j] - out[i - 1]) * (k - i + 1) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

// 2nd-order Butterworth low-pass, run forward and backward (zero phase), with
// reflected padding at the ends. NaN runs split the signal into segments.
export function filtfilt(x, cutoff, fs) {
  const wc = Math.tan(Math.PI * cutoff / fs);
  const k1 = Math.SQRT2 * wc, k2 = wc * wc, a0 = 1 + k1 + k2;
  const b = [k2 / a0, 2 * k2 / a0, k2 / a0], a = [2 * (k2 - 1) / a0, (1 - k1 + k2) / a0];
  const pass = s => {
    const y = new Float64Array(s.length);
    y[0] = s[0]; y[1] = s[1];
    for (let n = 2; n < s.length; n++) y[n] = b[0] * s[n] + b[1] * s[n - 1] + b[2] * s[n - 2] - a[0] * y[n - 1] - a[1] * y[n - 2];
    return y;
  };
  const out = Float64Array.from(x);
  let i = 0;
  while (i < x.length) {
    if (Number.isNaN(x[i])) { i++; continue; }
    let j = i;
    while (j < x.length && !Number.isNaN(x[j])) j++;
    const seg = x.slice(i, j);
    if (seg.length >= 6) {
      const pad = Math.min(seg.length - 1, Math.round(fs / cutoff));
      const ext = [];
      for (let k = pad; k > 0; k--) ext.push(2 * seg[0] - seg[k]);
      ext.push(...seg);
      for (let k = 1; k <= pad; k++) ext.push(2 * seg[seg.length - 1] - seg[seg.length - 1 - k]);
      const y = pass(pass(Float64Array.from(ext)).reverse()).reverse();
      for (let k = 0; k < seg.length; k++) out[i + k] = y[pad + k];
    }
    i = j;
  }
  return out;
}

// Full cleaning. raw: per-frame Float32Array(K*3) or null (pipeline output merged:
// accurate where present, else fast). okScore(frameIndex) -> min score for that frame.
// Returns { clean, smooth, swapped, flagged } with clean/smooth as per-frame arrays.
export function cleanTrack(raw, okScore, fps, { cutoff = 12, maxGapMs = 25 } = {}) {
  const N = raw.length;
  const minOf = new Map(raw.map((f, i) => [f, okScore(i)]));
  const okF = (f, k) => f[k * 3 + 2] >= minOf.get(f);

  // 0. Both feet put on one spot: the foot that jumped away goes.
  let frames = raw.slice();
  const collapsed = dropCollapsedFeet(frames, (f, k) => f[k * 3 + 2] >= minOf.get(f));
  collapsed.forEach(i => minOf.set(frames[i], okScore(i)));

  // 1. Left/right: legs and arms resolved separately over the whole clip.
  const swapped = { legs: resolveSwaps(frames, LEG_PAIRS, okF), arms: new Set() };
  frames = frames.map((f, i) => (f && swapped.legs.has(i) ? applySwap(f, LEG_PAIRS) : f));
  frames.forEach((f, i) => { if (f) minOf.set(f, okScore(i)); });
  swapped.arms = resolveSwaps(frames, ARM_PAIRS, okF);
  frames = frames.map((f, i) => (f && swapped.arms.has(i) ? applySwap(f, ARM_PAIRS) : f));

  // 2. Per coordinate: low-confidence -> gap, Hampel spikes -> gap, short gaps filled.
  const half = Math.max(3, Math.round(0.0125 * fps));
  const maxGap = Math.max(1, Math.round((maxGapMs / 1000) * fps));
  const clean = frames.map(f => (f ? new Float32Array(K * 3) : null));
  const smooth = frames.map(f => (f ? new Float32Array(K * 3) : null));
  const flagged = new Set();
  for (let k = 0; k < K; k++) {
    for (let c = 0; c < 2; c++) {
      const x = new Float64Array(N).fill(NaN);
      frames.forEach((f, i) => { if (f && f[k * 3 + 2] >= okScore(i)) x[i] = f[k * 3 + c]; });
      const h = hampel(x, half);
      h.flagged.forEach(i => flagged.add(`${i}:${J[k]}`));
      const filled = fillGaps(h.out, maxGap);
      const sm = filtfilt(filled, cutoff, fps);
      frames.forEach((f, i) => {
        if (!f) return;
        clean[i][k * 3 + c] = filled[i];
        smooth[i][k * 3 + c] = sm[i];
      });
    }
    frames.forEach((f, i) => {
      if (!f) return;
      const has = !Number.isNaN(clean[i][k * 3]) && !Number.isNaN(clean[i][k * 3 + 1]);
      clean[i][k * 3 + 2] = smooth[i][k * 3 + 2] = has ? 1 : 0;
    });
  }
  return { clean, smooth, swapped, flagged };
}
