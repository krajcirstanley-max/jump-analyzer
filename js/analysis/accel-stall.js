// Where an acceleration stops gaining and why (Stanley, 2026-11-24: "nech vieš odhaliť kde sa nezrýchľuje
// a prečo"), from measured numbers only:
// - each 10 m: the Freelap time, and with the steps counted in it the mean step length and frequency
//   (speed = frequency × length). The gain from one 10 m to the next splits exactly into what the
//   longer step and what the quicker step brought: dv = f̄·dL + L̄·df with the two 10 m's means.
// - each step: contact and step time, good to a frame at each edge (±8 ms at 120 fps). A stall is a
//   change of 3 frames or more that holds over two steps (median of three): the contact stops getting
//   shorter, or the step time gets longer. A per-step speed would need each step's length, which the
//   video doesn't give, and the fitted curve is smooth by construction, so it can't show a stall.
// - against the athlete's own best acceleration: which 10 m gave time away, and through length or rate.
const n2 = x => Number(x).toFixed(2).replace('.', ',');
const n1 = x => Number(x).toFixed(1).replace('.', ',');
const med3 = (a, i) => { const v = [a[i - 1], a[i], a[i + 1]].filter(Number.isFinite).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : NaN; };
const FRAME = 1 / 120;
const zone = k => `${k * 10}–${k * 10 + 10} m`;

// A 10 m's step length only when every step in it was found: no step over 1.5 times the run's usual
// step time (a missed step doubles one), and steps after its end, so the clip didn't stop inside it.
// Filmed head-on from the finish, the first steps out of a start 30 m away and the last 10 m cut off by
// the clip's end lose steps (22 Nov, against the blind reads: 6 of 8 in 0-10 m, 1 of 4 in 20-30 m), and
// one step in five moves the length 20 %.
export function legParts(a) {
  const S = (a.steps ?? []).filter(s => Number.isFinite(s.step));
  const usual = S.map(s => s.step).sort((x, y) => x - y)[Math.floor(S.length / 2)];
  const lastTd = Math.max(...(a.steps ?? []).map(s => s.td));
  return (a.legStats ?? []).map((l, k) => {
    const mine = S.filter(s => s.leg === k);
    // and the first 10 m only with the first step out of the start seen (it lands ~0.35 s after the release)
    const start = l.end - l.time, first = Math.min(...(a.steps ?? []).map(s => s.td));
    const whole = mine.length >= 3 && mine.every(s => s.step < 1.5 * usual) && lastTd >= l.end && (k > 0 || first - start <= 0.45);
    const len = whole ? l.stepLength : null;
    return { k, time: l.time, speed: 10 / l.time, length: len, freq: len ? 10 / l.time / len : null };
  });
}

// the stall in the steps: the first step (from the 3rd, out of the start) where the smoothed contact sits
// 3 frames over its shortest so far, or the smoothed step time 3 frames over its quickest, and the next
// step still 2 frames over
export function stepStall(steps) {
  const S = (steps ?? []).filter(s => Number.isFinite(s.contact));
  if (S.length < 6) return null;
  const c = S.map(s => s.contact), t = S.map(s => (Number.isFinite(s.step) ? s.step : NaN));
  const cs = c.map((_, i) => med3(c, i)), ts = t.map((_, i) => med3(t, i));
  let cMin = Infinity, tMin = Infinity, cAt = -1, tAt = -1;
  for (let i = 2; i < S.length - 1; i++) {
    if (cs[i - 1] < cMin) { cMin = cs[i - 1]; cAt = i - 1; }
    if (ts[i - 1] < tMin) { tMin = ts[i - 1]; tAt = i - 1; }
    const cUp = cs[i] - cMin >= 3 * FRAME - 1e-9 && cs[i + 1] - cMin >= 2 * FRAME - 1e-9;
    const tUp = Number.isFinite(ts[i]) && ts[i] - tMin >= 3 * FRAME - 1e-9 && ts[i + 1] - tMin >= 2 * FRAME - 1e-9;
    if (cUp || tUp) {
      return { step: i + 1, leg: S[i].leg ?? null,
        contact: cUp ? { from: cMin, to: cs[i], fromStep: cAt + 1 } : null,
        rate: tUp ? { from: 1 / tMin, to: 1 / ts[i], fromStep: tAt + 1 } : null };
    }
  }
  return null;
}

export function accelStall(a, best = null) {
  if (!a || a.kind !== 'accel' || !(a.legStats?.length >= 2)) return null;
  const P = legParts(a), lines = [];
  // the 10 m that gained least against the one before, split into length and rate
  const gains = P.slice(1).map((p, i) => {
    const q = P[i];
    if (p.length == null || q.length == null) return { k: p.k, dv: p.speed - q.speed };
    const fm = (p.freq + q.freq) / 2, lm = (p.length + q.length) / 2;
    return { k: p.k, dv: p.speed - q.speed, byLength: fm * (p.length - q.length), byRate: lm * (p.freq - q.freq), dL: p.length - q.length, df: p.freq - q.freq };
  });
  for (const g of gains) {
    if (g.byLength == null) { lines.push(`${zone(g.k)}: +${n1(g.dv)} m/s oproti ${zone(g.k - 1)}.`); continue; }
    const from = g.byRate < 0 ? `všetko z dlhšieho kroku (${g.dL >= 0 ? '+' : ''}${n2(g.dL)} m), frekvencia klesla o ${n2(-g.df)} kr/s`
      : g.byLength < 0 ? `všetko z frekvencie (+${n2(g.df)} kr/s), krok sa skrátil o ${n2(-g.dL)} m`
      : `${Math.round((100 * g.byLength) / (g.byLength + g.byRate))} % z dĺžky kroku (+${n2(g.dL)} m), zvyšok z frekvencie (+${n2(g.df)} kr/s)`;
    lines.push(`${zone(g.k)}: +${n1(g.dv)} m/s, ${from}.`);
  }
  const stall = stepStall(a.steps);
  let stallText = null;
  if (stall) {
    const what = [stall.contact ? `kontakt sa predĺžil z ${n2(stall.contact.from)} na ${n2(stall.contact.to)} s` : null,
      stall.rate ? `frekvencia klesla z ${n2(stall.rate.from)} na ${n2(stall.rate.to)} kr/s` : null].filter(Boolean).join(' a ');
    stallText = `Od ${stall.step}. kroku${stall.leg != null ? ` (${zone(stall.leg)})` : ''} ${what}.`;
  }
  // against the best: the 10 m with the most time given away, at least 0.03 s
  let vsBest = null;
  if (best?.legStats?.length) {
    const B = legParts(best);
    const d = P.map((p, k) => (B[k] ? { k, lost: p.time - B[k].time, p, b: B[k] } : null)).filter(Boolean).sort((x, y) => y.lost - x.lost)[0];
    if (d && d.lost >= 0.03) {
      const why = d.p.length != null && d.b.length != null
        ? (d.p.length < d.b.length - 0.04 && !(d.p.freq < d.b.freq - 0.1) ? `kratší krok (${n2(d.p.length)} m, v najlepšom ${n2(d.b.length)} m)`
          : d.p.freq < d.b.freq - 0.1 && !(d.p.length < d.b.length - 0.04) ? `nižšia frekvencia (${n2(d.p.freq)} kr/s, v najlepšom ${n2(d.b.freq)})`
          : `kratší krok (${n2(d.p.length)} vs ${n2(d.b.length)} m) aj nižšia frekvencia (${n2(d.p.freq)} vs ${n2(d.b.freq)} kr/s)`)
        : null;
      vsBest = { k: d.k, lost: d.lost, text: `Najviac rezervy oproti tvojej najlepšej akcelerácii: ${zone(d.k)}, o ${n2(d.lost)} s${why ? `, ${why}` : ''}.` };
    }
  }
  return { parts: P, gains, stall, stallText, vsBest, lines };
}

export function accelStallHtml(a, best = null) {
  const s = accelStall(a, best);
  if (!s || (!s.lines.length && !s.stallText && !s.vsBest)) return '';
  return `<section class="card sp-card"><h2>Kde zrýchľovanie stráca</h2>
    ${s.vsBest ? `<p class="banner warn">${s.vsBest.text}</p>` : ''}
    ${s.stallText ? `<p>${s.stallText}</p>` : '<p>Kontakt sa skracuje a frekvencia drží krok po kroku, bez zaseknutia nad chybu merania.</p>'}
    ${s.lines.length ? `<p class="sp-lb">Odkiaľ prišla rýchlosť v každej desiatke</p><ul class="sp-gain">${s.lines.map(l => `<li>${l}</li>`).join('')}</ul>` : ''}
    <p class="note">Z nameraného: časy Freelapu, kroky spočítané v každej desiatke, kontakt a čas každého kroku (±0,01 s). Zaseknutie sa hlási až pri zmene o 3 snímky, ktorá trvá aspoň 2 kroky.</p></section>`;
}
