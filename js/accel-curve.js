// The acceleration curve of a standing-start run (Stanley, 2026-11-24: "akcelerácia by mala mať tú
// krivku zrýchlenia"). What is measured and what is fitted are drawn apart: each 10 m's mean speed
// from the Freelap splits is a bar (measured), the line is the mono-exponential sprint model
// v = vmax (1 - e^(-t/tau)) fitted to those split times (Samozino et al. 2016, the usual way to get
// a speed curve from timing gates). Left out on 2026-11-15 as "not measured"; back with the line
// labelled as the fit and the bars as the measurement. With two splits tau can't be fitted and is
// the athlete's own from his 30/40 m runs (sprint.js TAU), and the top speed is an extrapolation.
import { fitAccel, speedAt, posAt, TAU } from './analysis/sprint.js';

const n1 = x => Number(x).toFixed(1).replace('.', ',');
const n2 = x => Number(x).toFixed(2).replace('.', ',');

export function accelCurve(legs, who) {
  if (!(legs?.length >= 2) || legs.some(l => !(l > 0))) return null;
  const fit = fitAccel(legs, { tau: TAU[who] ?? 1.4 });
  const D = legs.length * 10;
  const tAtX = x => { let lo = -fit.r, hi = 20; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (posAt(m, fit) < x) lo = m; else hi = m; } return lo; };
  const pts = [];
  for (let x = 0; x <= D + 1e-9; x += 0.5) pts.push([x, speedAt(tAtX(x), fit)]);
  const at = p => { const t = pts.find(q => q[1] >= p * fit.vmax); return t ? t[0] : null; };
  return { fit, D, pts, bars: legs.map((l, i) => ({ from: i * 10, to: i * 10 + 10, v: 10 / l })), x90: at(0.9), x95: at(0.95), fitted: legs.length >= 3 };
}

export function accelCurveHtml(legs, who) {
  const c = accelCurve(legs, who);
  if (!c) return '';
  const W = 320, H = 180, L = 30, R = 8, T = 10, B = 26;
  const vTop = Math.ceil(Math.max(c.fit.vmax, ...c.bars.map(b => b.v)) + 0.3);
  const X = x => L + (x / c.D) * (W - L - R), Y = v => T + (1 - v / vTop) * (H - T - B);
  const grid = [];
  for (let v = 0; v <= vTop; v += 2) grid.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)"/><text x="${L - 4}" y="${Y(v) + 4}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`);
  for (let x = 0; x <= c.D; x += 10) grid.push(`<text x="${X(x)}" y="${H - 8}" text-anchor="${x === 0 ? 'start' : x === c.D ? 'end' : 'middle'}" font-size="10" fill="var(--muted)">${x} m</text>`);
  const bars = c.bars.map(b => `<rect x="${X(b.from) + 2}" y="${Y(b.v)}" width="${X(b.to) - X(b.from) - 4}" height="${Y(0) - Y(b.v)}" fill="var(--accent-bg)"/>
    <text x="${(X(b.from) + X(b.to)) / 2}" y="${Y(b.v) + 14}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent)">${n1(b.v)}</text>`).join('');
  const line = c.pts.map(([x, v], i) => `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Krivka zrýchlenia">${grid.join('')}${bars}
    <path d="${line}" fill="none" stroke="var(--text)" stroke-width="2"/></svg>`;
  const far = c.D < 30 ? ' (odhad za koncom merania)' : '';
  const reach = [c.x90 != null ? `90 % na ${Math.round(c.x90)} m` : '', c.x95 != null ? `95 % na ${Math.round(c.x95)} m` : ''].filter(Boolean).join(' · ');
  const shape = c.fitted ? '' : ` Pri ${c.bars.length} úsekoch sa tvar krivky nedá preložiť, berie sa z tvojich behov na 30 a 40 m.`;
  const bad = c.fit.rms > 0.03 ? `<p class="banner warn">Krivka nesedí s časmi úsekov (odchýlka ${n2(c.fit.rms)} s), ber ju len orientačne.</p>` : '';
  return `<div class="sp-curve"><p class="sp-lb">Krivka zrýchlenia · m/s</p>${svg}
    <p class="sp-lb">Max. rýchlosť podľa krivky <b>${n2(c.fit.vmax)} m/s</b>${far}${reach ? ` · ${reach}` : ''}</p>
    <p class="note">Stĺpce: priemer každých 10 m z Freelapu (namerané). Čiara: krivka zrýchlenia preložená cez tieto časy.${shape}</p>${bad}</div>`;
}
