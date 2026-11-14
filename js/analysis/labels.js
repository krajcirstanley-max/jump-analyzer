// Knee, hip and trunk-lean pills drawn next to the skeleton on every replay frame.
// Angles follow metrics.js (WA conventions); withheld where the view is too far off
// side-on to trust them, and where the athlete is covered and the pose is a guess.
import { P, has, mid, angle3, sharpen } from './kinematics.js';
import { viewYaw, MAX_YAW, landingLeg } from './metrics.js';
import { hiddenFrames } from '../pose/occlusion.js';
import { BONES, JI } from '../pose/models.js';

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
// skip(index): frames where another overlay speaks instead (the ideal pose).
export function jointLabels(jump, result, scale, { skip = null } = {}) {
  const { from, to } = jump.replay;
  const hidden = hiddenFrames(result);
  const sharp = result.clean ? sharpen(result.clean, jump.fps) : result.smooth; // same track as the numbers
  return (ctx, toCanvas, index) => {
    if (index < from || index > to || hidden.has(index) || skip?.(index)) return;
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

// The ideal pose (ideal.js) as a ghost over the athlete's own skeleton: a wide, see-through green
// body where the norms put it, and a short arrow from each joint that has to move to where it
// should be (Stanley, 2026-11-14: "teraz to je také meh … ako ghost"). The numbers stay under
// the video: pills on the body covered the skeleton (2026-11-12). state.on is the switch.
export const IDEAL = '#1fbf6b';
// ideals: one per phase frame (ideal.js idealsFor), or a single one.
export function idealOverlay(ideals, scale, state) {
  const list = Array.isArray(ideals) ? ideals : [ideals];
  return (ctx, toCanvas, index) => {
    const ideal = state.on && list.find(x => x && x.frame === index);
    if (!ideal) return;
    const kp = ideal.kp, you = ideal.you;
    const ok = (q, j) => q && Number.isFinite(q[j * 3]) && q[j * 3 + 2] >= 0.5;
    const at = (q, j) => toCanvas(q[j * 3] * scale, q[j * 3 + 1] * scale);
    const lw = Math.max(2.5, ctx.canvas.width / 180);
    ctx.save();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // the ghost body: a soft wide band, then a thin core line
    for (const [w, a] of [[lw * 5, 0.42], [lw * 1.2, 1]]) {
      ctx.globalAlpha = a; ctx.strokeStyle = IDEAL; ctx.lineWidth = w;
      for (const [na, nb] of BONES) {
        const ia = JI[na], ib = JI[nb];
        if (!ok(kp, ia) || !ok(kp, ib)) continue;
        const [x0, y0] = at(kp, ia), [x1, y1] = at(kp, ib);
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      }
    }
    // arrows: your joint → where the ideal puts it, only for joints that really move
    ctx.globalAlpha = 1;
    const min = Math.max(6, ctx.canvas.width / 90);
    for (const [name, j] of Object.entries(JI)) {
      if (!ok(kp, j) || !ok(you, j) || /ear|nose|eye|wri|elb/.test(name)) continue;
      const [x0, y0] = at(you, j), [x1, y1] = at(kp, j), d = Math.hypot(x1 - x0, y1 - y0);
      if (d < min) continue;
      const ux = (x1 - x0) / d, uy = (y1 - y0) / d, hd = Math.min(d * 0.45, lw * 3.2);
      ctx.strokeStyle = '#fff'; ctx.fillStyle = IDEAL; ctx.lineWidth = lw * 0.9;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - ux * hd * 0.6, y1 - uy * hd * 0.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - ux * hd - uy * hd * 0.55, y1 - uy * hd + ux * hd * 0.55);
      ctx.lineTo(x1 - ux * hd + uy * hd * 0.55, y1 - uy * hd - ux * hd * 0.55);
      ctx.closePath(); ctx.fill();
      ctx.lineWidth = Math.max(1, lw * 0.35); ctx.stroke();
    }
    ctx.restore();
  };
}
