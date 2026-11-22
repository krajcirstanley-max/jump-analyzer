// The numbers on the video (Stanley, 2026-11-22: "všade kde je Freelap má byť overlay aj každý výskok
// má mať overlay", and burned into a copy for the gallery). One drawing for both: the app's player
// draws it over the frame on screen, the export (burn.js) draws it into every frame of the copy, so the
// video in Photos shows exactly what the app showed.
//
// A timeline is a function of the time from the clip's first frame (s) to what is on screen then:
//   { freelap: { title, clock, rows: [{ label, value, state: 'done'|'now'|'dim' }] } | null,
//     hud: { top, left: { cap, v, u }, right, ring: { v, u, fill, best } } | null,
//     flags: [{ x, y, label }] (frame pixels), strip: ['done'|'now'|''] | null }
// The panels follow the RSI scoreboard (rsi-view.js hudHtml) and the sprint camera's Freelap clock.

const num = (x, d) => (Number.isFinite(x) ? Number(x).toFixed(d).replace('.', ',') : '–');

// ---------- drawing (canvas pixels; rect = where the video frame is on the canvas) ----------
function rrect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif';
const font = (px, w = 400) => `${w} ${px}px ${FONT}`;

export function drawFreelap(ctx, rect, f) {
  const u = rect.w / 360, x = rect.x + 12 * u, y = rect.y + 12 * u, pad = 11 * u;
  ctx.save();
  ctx.font = font(13 * u);
  const rowW = Math.max(0, ...f.rows.map(r => ctx.measureText(r.label).width + 14 * u + ctx.measureText(r.value || '…').width));
  ctx.font = font(30 * u, 700); const clkW = ctx.measureText(f.clock).width;
  ctx.font = font(11 * u, 600); const tW = ctx.measureText(f.title.toUpperCase()).width;
  const w = Math.max(150 * u, rowW, clkW, tW) + 2 * pad, h = pad * 2 + 13 * u + 32 * u + f.rows.length * 18 * u;
  ctx.fillStyle = 'rgba(10,12,16,0.82)'; rrect(ctx, x, y, w, h, 14 * u); ctx.fill();
  let cy = y + pad;
  ctx.textBaseline = 'top'; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = font(11 * u, 600); ctx.fillText(f.title.toUpperCase(), x + pad, cy);
  cy += 14 * u; ctx.fillStyle = '#fff'; ctx.font = font(30 * u, 700); ctx.fillText(f.clock, x + pad, cy);
  cy += 34 * u; ctx.font = font(13 * u);
  for (const r of f.rows) {
    ctx.globalAlpha = r.state === 'dim' ? 0.45 : 1;
    ctx.fillStyle = r.state === 'now' ? '#ffd166' : '#fff';
    ctx.font = font(13 * u, r.state === 'now' ? 700 : 400);
    ctx.textAlign = 'left'; ctx.fillText(r.label, x + pad, cy);
    ctx.textAlign = 'right'; ctx.fillText(r.state === 'now' && !r.value ? '…' : r.value, x + w - pad, cy);
    cy += 18 * u;
  }
  ctx.restore();
}

export function drawHud(ctx, rect, h) {
  const u = rect.w / 360, side = 10 * u, W = rect.w - 2 * side, bottom = rect.y + rect.h - 18 * u;
  const tileW = W * 0.27, ringD = W * 0.36, ringY = bottom - ringD / 2, tileH = 64 * u;
  ctx.save(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (h.top) { ctx.font = font(13 * u, 700); ctx.fillStyle = '#fff'; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 4 * u; ctx.fillText(h.top, rect.x + rect.w / 2, bottom - ringD - 12 * u); ctx.shadowBlur = 0; }
  const tile = (t, cx) => {
    if (!t) return;
    ctx.fillStyle = 'rgba(10,12,16,0.66)'; rrect(ctx, cx - tileW / 2, ringY - tileH / 2, tileW, tileH, 14 * u); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.font = font(10 * u, 600); ctx.fillText(t.cap.toUpperCase(), cx, ringY - 19 * u);
    ctx.fillStyle = '#fff'; ctx.font = font(21 * u, 700); ctx.fillText(t.v, cx, ringY + 1 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.font = font(11.5 * u); ctx.fillText(t.u, cx, ringY + 20 * u);
  };
  tile(h.left, rect.x + side + tileW / 2);
  tile(h.right, rect.x + rect.w - side - tileW / 2);
  if (h.ring) {
    const cx = rect.x + rect.w / 2, r = ringD / 2 - 4 * u, lw = 7 * u * (ringD / (W * 0.36));
    ctx.fillStyle = 'rgba(10,12,16,0.66)'; ctx.beginPath(); ctx.arc(cx, ringY, r, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = lw; ctx.stroke();
    const fill = Math.max(0, Math.min(1, h.ring.fill ?? 0));
    if (fill > 0) { ctx.strokeStyle = h.ring.best ? '#3ddc97' : '#5ab8f0'; ctx.lineCap = 'round'; ctx.beginPath(); ctx.arc(cx, ringY, r, -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * fill); ctx.stroke(); }
    ctx.fillStyle = '#fff'; ctx.font = font(26 * u * Math.min(1, 5 / Math.max(4, String(h.ring.v).length)), 700); ctx.fillText(h.ring.v, cx, ringY - 4 * u);
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.font = font(11 * u); ctx.fillText(h.ring.u, cx, ringY + 18 * u);
  }
  ctx.restore();
  return { ring: h.ring ? { x: rect.x + rect.w / 2 - ringD / 2, y: ringY - ringD / 2, w: ringD, h: ringD } : null };
}

export function drawFlag(ctx, p, label, u) {
  ctx.save(); ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2 * u;
  ctx.beginPath(); ctx.moveTo(p[0], p[1] - 4 * u); ctx.lineTo(p[0], p[1] - 30 * u); ctx.stroke();
  ctx.font = font(11 * u, 700); ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#fff';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 3 * u; ctx.fillText(label, p[0], p[1] - 32 * u);
  ctx.restore();
}

export function drawStrip(ctx, rect, strip) {
  const u = rect.w / 360, x0 = rect.x + 12 * u, w = rect.w - 24 * u, gap = 4 * u, n = strip.length, seg = (w - gap * (n - 1)) / n, y = rect.y + rect.h - 16 * u;
  ctx.save();
  strip.forEach((s, k) => { ctx.fillStyle = s === 'done' ? '#5ab8f0' : s === 'now' ? '#ffd166' : 'rgba(255,255,255,0.35)'; rrect(ctx, x0 + k * (seg + gap), y, seg, 6 * u, 3 * u); ctx.fill(); });
  ctx.restore();
}

// Everything on screen at time t. toCanvas maps frame pixels to canvas pixels (for the flags).
export function drawAt(ctx, rect, state, toCanvas = p => p) {
  if (!state) return {};
  const u = rect.w / 360;
  for (const f of state.flags ?? []) drawFlag(ctx, toCanvas([f.x, f.y]), f.label, u);
  if (state.freelap) drawFreelap(ctx, rect, state.freelap);
  let hit = {};
  if (state.hud) hit = drawHud(ctx, rect, state.hud);
  else if (state.strip) drawStrip(ctx, rect, state.strip);
  return hit;
}

// ---------- timelines ----------
// The Freelap clock is Freelap's, not the video's: between two gates it runs from one Freelap time to
// the next, so it shows Freelap's split exactly when the athlete passes each cone in the picture (the
// picture's own times run about 8 % long filmed across the hall, conetimes.js).
export function warp(knots, t) {
  if (!knots.length || t < knots[0][0]) return null;
  for (let k = 1; k < knots.length; k++) {
    const [a, A] = knots[k - 1], [b, B] = knots[k];
    if (t <= b) return A + (B - A) * (t - a) / (b - a);
  }
  return knots.at(-1)[1];
}

// Rozbeh: the Freelap panel through the run-up, flags at the cones as they are passed, then the
// board panel. g: { marks: {21,11,6,1: s from the first frame}, pieces (fiveFromMarks, far to near),
// legs [21-11, 11-1], tdT, contact, verdict, gates: [{ mark, at: [[t, x, y], ...] }], name, bestV }
export function rozbehTimeline(g) {
  const L = (g.legs ?? []).filter(Number.isFinite);
  const far = L.length >= 2 ? L.at(-2) : null, near = L.length ? L.at(-1) : null;
  const p = g.pieces ?? [], piece = (a, b) => p.find(x => x.to === a && x.from === b);
  const m = g.marks ?? {};
  // the rows and the Freelap time at each gate, nearest the start first
  const rows = [];
  if (far != null) {
    const p116 = piece(11, 6), p61 = piece(6, 1);
    rows.push({ label: '21–11 m', at: 21, upto: 11, s: far, v: 10 / far });
    if (p116 && p61) { rows.push({ label: '11–6 m', at: 11, upto: 6, s: p116.s, v: p116.v }); rows.push({ label: '6–1 m', at: 6, upto: 1, s: p61.s, v: p61.v }); }
    else if (near != null) rows.push({ label: '11–1 m', at: 11, upto: 1, s: near, v: 10 / near });
  } else if (near != null) rows.push({ label: '11–1 m', at: 11, upto: 1, s: near, v: 10 / near });
  const knots = []; let acc = 0;
  if (rows.length && Number.isFinite(m[rows[0].at])) {
    knots.push([m[rows[0].at], 0]);
    for (const r of rows) { acc += r.s; if (!Number.isFinite(m[r.upto])) { knots.length = 0; break; } knots.push([m[r.upto], acc]); }
  }
  const total = rows.reduce((a, r) => a + r.s, 0);
  const v61 = piece(6, 1)?.v ?? (near ? 10 / near : null);
  return t => {
    const st = { freelap: null, hud: null, flags: [], strip: null };
    if (rows.length) {
      const c = knots.length ? warp(knots, t) : null;
      let run = 0;
      const shown = rows.map(r => {
        const done = knots.length ? c != null && c >= run + r.s - 1e-9 : true, now = knots.length && c != null && !done && c >= run;
        run += r.s;
        return { label: r.label, value: done ? `${num(r.s, 2)} s · ${num(r.v, 2)}` : '', state: done ? 'done' : now ? 'now' : 'dim' };
      });
      st.freelap = { title: `Freelap${g.name ? ` · ${g.name}` : ''}`, clock: num(knots.length ? (c ?? 0) : total, 2), rows: shown };
      st.strip = shown.map(r => (r.state === 'done' ? 'done' : r.state === 'now' ? 'now' : ''));
    }
    // a cone gets its flag for the 0.25 s around its passing
    for (const gt of g.gates ?? []) {
      const hit = gt.at.reduce((b, q) => (Math.abs(q[0] - t) < Math.abs((b?.[0] ?? 1e9) - t) ? q : b), null);
      const tc = m[gt.mark];
      if (hit && Number.isFinite(tc) && Math.abs(t - tc) <= 0.25 && Math.abs(hit[0] - t) < 0.02) st.flags.push({ x: hit[1], y: hit[2], label: `${gt.mark} m` });
    }
    if (Number.isFinite(g.tdT) && t >= g.tdT - 0.05) {
      st.hud = { top: g.verdict ?? '', left: near ? { cap: '11–1 m', v: num(near, 2), u: 's' } : null,
        right: Number.isFinite(g.contact) ? { cap: 'na doske', v: num(g.contact, 2), u: 's' } : null,
        ring: v61 ? { v: num(v61, 2), u: 'm/s do dosky', fill: g.bestV ? v61 / g.bestV : 1, best: !g.bestV || v61 >= g.bestV - 1e-9 } : null };
      st.strip = null;
    }
    return st;
  };
}

// Skok: the Freelap panel when the jump has a Freelap time, and from the toe-off to 2.5 s after the
// landing the jump's panel: speed into the board, the distance in the ring (the tape when typed, else
// the estimate, marked as one), the board contact; the angle and the height above.
// j: { toT, landT, endT, split, approach, contact, angle, height, tape, est, flight, name }
export function jumpTimeline(j) {
  return t => {
    const st = { freelap: null, hud: null, flags: [], strip: null };
    if (j.split > 0) st.freelap = { title: `Freelap${j.name ? ` · ${j.name}` : ''}`, clock: num(j.split, 2), rows: [{ label: '11–1 m', value: `${num(j.split, 2)} s · ${num(10 / j.split, 2)}`, state: 'done' }] };
    const end = Number.isFinite(j.landT) ? j.landT + 2.5 : j.endT ?? Infinity;
    if (Number.isFinite(j.toT) && t >= j.toT && t <= end) {
      const dist = j.tape > 0 ? { v: num(j.tape, 2), u: 'm · pásmo', fill: 1, best: true } : Number.isFinite(j.est) ? { v: `≈${num(j.est, 2)}`, u: 'm · odhad (ťukni)', fill: 1, best: false }
        : Number.isFinite(j.flight) ? { v: num(j.flight, 2), u: 's let', fill: 1, best: false } : null;
      const top = [Number.isFinite(j.angle) ? `uhol ${num(j.angle, 1)}°` : '', Number.isFinite(j.height) ? `výška ${Math.round(j.height)} cm` : ''].filter(Boolean).join(' · ');
      st.hud = { top, left: Number.isFinite(j.approach) ? { cap: 'do dosky', v: num(j.approach, 2), u: 'm/s' } : null,
        right: Number.isFinite(j.contact) ? { cap: 'na doske', v: num(j.contact, 2), u: 's' } : null, ring: dist };
    }
    return st;
  };
}

// RSI: the marks the app already shows (rsi-view.js rsiMarks: { from, to, hud }) as a timeline.
export function marksTimeline(marks) {
  return t => {
    const m = (marks ?? []).filter(x => t >= x.from && t < x.to).at(-1);
    if (!m?.hud) return { freelap: null, hud: null, flags: [], strip: null };
    const h = m.hud;
    return { freelap: null, flags: [], strip: null, hud: { top: h.top ?? '', left: h.left, right: h.right, ring: h.ring } };
  };
}

// The player's overlay: draws the timeline at the frame shown, in the part of the canvas the frame
// covers. hit (optional) receives the ring's box in canvas pixels for a tap.
export function hudOverlay(timeline, player, size, hit = null) {
  // the player's toCanvas takes (x, y); drawAt and the burn take [x, y]
  return (ctx, toCanvasXY, index) => {
    const toCanvas = p => toCanvasXY(p[0], p[1]);
    const ts = player.ts; if (!ts?.length) return;
    const t = ts[index] - ts[0];
    const a = toCanvas([0, 0]), b = toCanvas([size.W, size.H]);
    const x0 = Math.max(0, Math.min(a[0], b[0])), y0 = Math.max(0, Math.min(a[1], b[1]));
    const x1 = Math.min(ctx.canvas.width, Math.max(a[0], b[0])), y1 = Math.min(ctx.canvas.height, Math.max(a[1], b[1]));
    if (!(x1 > x0 && y1 > y0)) return;
    const r = drawAt(ctx, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, timeline(t), toCanvas);
    if (hit) hit.ring = r.ring ?? null;
  };
}

// Šprint uploaded from the gallery (one filmed in the app already has Freelap burned in natively): an
// acceleration whose start the video saw runs Freelap's clock from that release and fills each 10 m
// as its time comes; a fly (where the video can't tell when the first gate was passed) shows the
// times without a clock. s: { legs, lap, zero (s from the first frame) | null, name }
export function sprintTimeline(s) {
  const legs = (s.legs ?? []).filter(x => x > 0), lap = s.lap ?? legs.reduce((a, b) => a + b, 0);
  const rows = legs.length > 1 ? legs.map((l, i) => ({ label: `${i * 10}–${(i + 1) * 10} m`, s: l })) : [{ label: 'čas', s: lap }];
  return t => {
    if (!(lap > 0)) return { freelap: null, hud: null, flags: [], strip: null };
    const c = Number.isFinite(s.zero) ? Math.max(0, Math.min(lap, t - s.zero)) : null;
    let run = 0;
    const shown = rows.map(r => { const done = c == null || c >= run + r.s - 1e-9, now = c != null && !done && c >= run; run += r.s; return { label: r.label, value: done ? `${num(r.s, 2)} s · ${num(10 / r.s, 2)}` : '', state: done ? 'done' : now ? 'now' : 'dim' }; });
    return { freelap: { title: `Freelap${s.name ? ` · ${s.name}` : ''}`, clock: num(c == null ? lap : (t < s.zero ? 0 : c), 2), rows: shown }, hud: null, flags: [], strip: null };
  };
}
