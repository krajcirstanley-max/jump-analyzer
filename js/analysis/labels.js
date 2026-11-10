// Knee, hip and trunk-lean pills drawn next to the skeleton on every replay frame.
// Angles follow metrics.js (WA conventions); withheld where the view is too far off
// side-on to trust them, and where the athlete is covered and the pose is a guess.
import { P, has, mid, angle3, sharpen } from './kinematics.js';
import { viewYaw, MAX_YAW, landingLeg } from './metrics.js';
import { hiddenFrames } from '../pose/occlusion.js';

const LEFT = '#3fc8ff', RIGHT = '#ff8a2a', MID = '#f1efe8'; // same colours as the skeleton
const deg = r => (r * 180) / Math.PI;

// The leg the numbers describe: the stance leg in a contact, else the takeoff leg.
export function labelLeg(jump, i) {
  const { pen, takeoffFoot } = jump;
  return pen && i >= pen.td && i <= pen.to ? pen.foot : takeoffFoot;
}

export function jointAngles(kp, s, dir) {
  if (!has(kp, s + 'hip', s + 'knee', s + 'ank', s + 'sho', 'lsho', 'rsho', 'lhip', 'rhip')) return null;
  const sho = P(kp, s + 'sho'), hip = P(kp, s + 'hip'), knee = P(kp, s + 'knee');
  // Hip over 180 when the thigh is behind the trunk line (metrics.js).
  const a = angle3(sho, hip, knee);
  const cross = (sho[0] - hip[0]) * (knee[1] - hip[1]) - (sho[1] - hip[1]) * (knee[0] - hip[0]);
  const shoMid = mid(P(kp, 'lsho'), P(kp, 'rsho')), hipMid = mid(P(kp, 'lhip'), P(kp, 'rhip'));
  return {
    knee: angle3(hip, knee, P(kp, s + 'ank')),
    hip: cross * dir < 0 ? 360 - a : a,
    lean: deg(Math.atan2((shoMid[0] - hipMid[0]) * dir, hipMid[1] - shoMid[1])), // + = forward
  };
}

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

// Puts each pill beside its joint, on its preferred side when that is free. Falls back to
// the other sides, then to the least-covered spot, so a small far-away athlete stays readable.
// pills: [{ ax, ay, w, h, side }], side +1 = right. Returns [{ x, y, w, h }] in input order.
export function placePills(pills, W, H, gap) {
  const placed = [];
  return pills.map(p => {
    const { ax, ay, w, h, side } = p;
    const beside = s => (s > 0 ? ax + gap : ax - gap - w);
    const row = h + gap / 2;
    const spots = [0, -row, row, -2 * row, 2 * row].flatMap(dy => [side, -side].map(s => [beside(s), ay - h / 2 + dy]))
      .map(([x, y]) => ({ x: Math.max(0, Math.min(W - w, x)), y: Math.max(0, Math.min(H - h, y)), w, h }));
    const cost = c => placed.reduce((sum, q) => sum + overlap(c, q), 0);
    let best = spots[0], bestCost = cost(best);
    for (const c of spots) {
      const v = cost(c);
      if (v === 0) { best = c; bestCost = 0; break; }
      if (v < bestCost) { best = c; bestCost = v; }
    }
    placed.push(best);
    return best;
  });
}

const signed = v => `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(0)}°`;

// jump: analyzeJump() output; result: pose result; scale: frame pixels per pose pixel.
export function jointLabels(jump, result, scale) {
  const { from, to } = jump.replay;
  const hidden = hiddenFrames(result);
  const sharp = result.clean ? sharpen(result.clean, jump.fps) : result.smooth; // same track as the numbers
  return (ctx, toCanvas, index) => {
    if (index < from || index > to || hidden.has(index)) return;
    const kp = result.smooth?.[index];
    if (!kp || !(viewYaw(kp) <= MAX_YAW)) return;
    const s = index >= (jump.landing ?? Infinity) ? landingLeg(result.smooth[jump.landing], jump.takeoffFoot) : labelLeg(jump, index);
    const a = jointAngles(sharp[index] ?? kp, s, jump.dir);
    if (!a) return;

    const W = ctx.canvas.width, H = ctx.canvas.height;
    const dpr = W / (ctx.canvas.clientWidth || W);
    const fs = 12 * dpr, h = fs * 1.6, gap = 7 * dpr, pad = fs * 0.55;
    const at = n => toCanvas(P(kp, n)[0] * scale, P(kp, n)[1] * scale);
    const shoulders = toCanvas(...mid(P(kp, 'lsho'), P(kp, 'rsho')).map(v => v * scale));
    const accent = s === 'l' ? LEFT : RIGHT;
    // Knee and shoulders in front, hip behind: they stay apart even on a small athlete.
    const items = [
      { text: `koleno ${a.knee.toFixed(0)}°`, at: at(s + 'knee'), side: jump.dir, accent },
      { text: `bedro ${a.hip.toFixed(0)}°`, at: at(s + 'hip'), side: -jump.dir, accent },
      { text: `náklon ${signed(a.lean)}`, at: shoulders, side: jump.dir, accent: MID },
    ].filter(it => it.at[0] >= 0 && it.at[0] <= W && it.at[1] >= 0 && it.at[1] <= H); // zoomed past it

    ctx.save();
    ctx.font = `600 ${fs}px -apple-system, system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    const pills = items.map(it => ({ ax: it.at[0], ay: it.at[1], w: ctx.measureText(it.text).width + pad * 2, h, side: it.side }));
    placePills(pills, W, H, gap).forEach((b, i) => {
      ctx.beginPath();
      ctx.roundRect(b.x, b.y, b.w, b.h, h / 2);
      ctx.fillStyle = 'rgba(10,12,16,0.78)';
      ctx.fill();
      ctx.lineWidth = Math.max(1, dpr);
      ctx.strokeStyle = items[i].accent;
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.fillText(items[i].text, b.x + pad, b.y + h / 2);
    });
    ctx.restore();
  };
}
