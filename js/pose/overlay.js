// Draws the athlete's skeleton on the player canvas: left side blue, right side orange.
import { JI, BONES, MODELS } from './models.js';
import { hiddenFrames } from './occlusion.js';

const LEFT = '#3fc8ff', RIGHT = '#ff8a2a', MID = '#f1efe8';
const sideOf = name => (name[0] === 'l' ? 'l' : name[0] === 'r' ? 'r' : 'm');
const colour = s => (s === 'l' ? LEFT : s === 'r' ? RIGHT : MID);
const DIMMED = 0.3; // frames where the athlete is covered and the pose is a guess

// result: pipeline output; scale: frame-source pixels per pipeline pixel.
export function skeletonOverlay(result, scale) {
  const hidden = hiddenFrames(result);
  return (ctx, toCanvas, index) => {
    // Cleaned + smoothed track when available (score is 1 = present, 0 = gap).
    const sm = result.smooth?.[index];
    const acc = result.accurate?.[index];
    const kp = sm || acc || result.fast?.[index];
    if (!kp) return;
    const minScore = sm ? 0.5 : MODELS[acc ? result.models.accurate : result.models.fast].minScore;
    const ok = j => kp[j * 3 + 2] >= minScore;
    const at = j => toCanvas(kp[j * 3] * scale, kp[j * 3 + 1] * scale);
    const lw = Math.max(2, ctx.canvas.width / 220);
    ctx.save();
    if (hidden.has(index)) ctx.globalAlpha = DIMMED;
    ctx.lineCap = 'round';
    ctx.lineWidth = lw;
    for (const [a, b] of BONES) {
      const ia = JI[a], ib = JI[b];
      if (!ok(ia) || !ok(ib)) continue;
      const sa = sideOf(a), sb = sideOf(b);
      ctx.strokeStyle = colour(sa === sb ? sa : 'm');
      const [x0, y0] = at(ia), [x1, y1] = at(ib);
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    for (const [name, j] of Object.entries(JI)) {
      if (!ok(j) || name.endsWith('ear') || name === 'nose') continue;
      const [x, y] = at(j);
      ctx.fillStyle = colour(sideOf(name));
      ctx.beginPath(); ctx.arc(x, y, lw * 0.9, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  };
}
