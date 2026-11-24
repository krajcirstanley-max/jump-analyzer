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

// ---------- against published norms (research 2026-11-24) ----------
// Stavridis et al. 2022 (J Phys Educ Sport 22:1126, Tables 2-3): sub-elite men sprinters, n = 9, 1.80 m,
// 100 m 10.49 s, 3-point standing start, per 5 m to 30 m. Only rate and contact told levels apart there.
// No per-5 m values for women from a standing start exist: women are shown, not graded.
export const STAVRIDIS_MEN = {
  relLength: [0.63, 0.88, 1.02, 1.07, 1.12, 1.16],   // step length / body height
  freq: [3.45, 4.73, 4.66, 4.77, 4.68, 4.66],        // Hz
  contact: [0.161, 0.128, 0.116, 0.106, 0.104, 0.103], // s
};
// Flag bands: rate 1 SD (~0.25 Hz), length 0.06 of height, contact judged from 15 m only (earlier steps
// vary 12-20 % trial to trial, Thomson 2007) and 2 frames over.
const LOW_FREQ = 0.25, SHORT_REL = 0.06, LONG_CONTACT = 2 / 120;
// Haugen et al. 2019 (PLoS One, Table 1), long jumpers from a standing start: 10 m segments men n = 9
// 10-20 8.40, 20-30 9.35, 30-40 9.52 m/s; women n = 8 7.69, 8.33, 8.40. Freelap is good to ±2 % per 10 m.
export const HAUGEN_JUMPERS = { m: [null, 8.40, 9.35, 9.52], f: [null, 7.69, 8.33, 8.40] };

export function bandsVsNorm(a, { sex = 'male', heightM = null } = {}) {
  if (!a || a.kind !== 'accel' || !a.steps?.length) return null;
  const S = a.steps.filter(s => Number.isFinite(s.at) && Number.isFinite(s.step));
  const men = sex !== 'female' && Number.isFinite(heightM);
  const rows = [];
  // the first 5 m only when the first step out of the start was seen (head-on, 30 m away, it often isn't)
  const L0 = a.legStats?.[0], startSeen = !!L0 && Math.min(...a.steps.map(s => s.td)) - (L0.end - L0.time) <= 0.45;
  for (let b = 0; b < 6; b++) {
    const mine = S.filter(s => s.at >= b * 5 && s.at < b * 5 + 5);
    if (!mine.length || (b === 0 && !startSeen)) continue;
    const mean = k => mine.reduce((t, s) => t + s[k], 0) / mine.length;
    const freq = 1 / mean('step'), contact = mean('contact');
    const lens = mine.filter(s => Number.isFinite(s.length)).map(s => s.length), length = lens.length ? lens.reduce((x, y) => x + y, 0) / lens.length : null;
    const n = men ? { freq: STAVRIDIS_MEN.freq[b], length: STAVRIDIS_MEN.relLength[b] * heightM, contact: STAVRIDIS_MEN.contact[b] } : null;
    rows.push({ band: b, from: b * 5, to: b * 5 + 5, steps: mine.length, freq, length, contact, norm: n,
      lowFreq: !!n && b >= 1 && freq < n.freq - LOW_FREQ,
      short: !!n && length != null && length < n.length - SHORT_REL * heightM,
      longContact: !!n && b >= 3 && contact > n.contact + LONG_CONTACT });
  }
  // does the speed still grow like a long jumper's, or flatten early: 10 m segment gains against Haugen's
  const g = sex === 'female' ? 'f' : 'm', H = HAUGEN_JUMPERS[g], v = (a.legStats ?? []).map(l => 10 / l.time);
  const plateau = [];
  for (let k = 2; k < v.length && k < H.length; k++) {
    const mineGain = v[k] / v[k - 1] - 1, normGain = H[k] / H[k - 1] - 1;
    plateau.push({ k, mine: mineGain, norm: normGain, early: mineGain < normGain - 0.04 });
  }
  return { rows, plateau, graded: men };
}

const z5 = r => `${r.from}–${r.to} m`;
export function bandsHtml(a, opts) {
  const B = bandsVsNorm(a, opts);
  if (!B || !B.rows.length) return '';
  const say = [];
  const lf = B.rows.filter(r => r.lowFreq), sh = B.rows.filter(r => r.short), lc = B.rows.filter(r => r.longContact);
  if (lf.length) say.push(`Frekvencia nižšia ako u šprintérov v ${lf.map(z5).join(', ')} (${lf.map(r => `${n2(r.freq)} vs ${n2(r.norm.freq)}`).join('; ')} kr/s).`);
  if (sh.length) say.push(`Kratší krok v ${sh.map(z5).join(', ')} (${sh.map(r => `${n2(r.length)} vs ${n2(r.norm.length)}`).join('; ')} m).`);
  if (lc.length) say.push(`Dlhší kontakt v ${lc.map(z5).join(', ')} (${lc.map(r => `${r.contact.toFixed(3).replace('.', ',')} vs ${r.norm.contact.toFixed(3).replace('.', ',')}`).join('; ')} s).`);
  if (B.graded && !say.length) say.push('Frekvencia, krok aj kontakt v pásme šprintérov v každých 5 m.');
  const early = B.plateau.filter(p => p.early);
  const pl = B.plateau.map(p => `${zone(p.k - 1)} → ${zone(p.k)}: ${p.mine >= 0 ? '+' : ''}${Math.round(p.mine * 100)} % (skokani ${p.norm >= 0 ? '+' : ''}${Math.round(p.norm * 100)} %)`);
  const plText = early.length ? `Rýchlosť sa ustáli skôr ako u skokanov: ${pl.join(', ')}.` : pl.length ? `Rýchlosť ešte rastie ako u skokanov: ${pl.join(', ')}.` : '';
  const head = `<div class="sp-row sp-head"><span class="sp-i">m</span><span class="sp-n">kr/s</span><span class="sp-n">krok m</span><span class="sp-n">zem s</span></div>`;
  const cell = (v, nv, bad, d) => `<span class="sp-n${bad ? ' bad' : ''}">${v == null ? '–' : d(v)}${nv != null ? `<small> ${d(nv)}</small>` : ''}</span>`;
  const rows = B.rows.map(r => `<div class="sp-row"><span class="sp-i">${r.from}–${r.to}</span>${cell(r.freq, r.norm?.freq, r.lowFreq, n2)}${cell(r.length, r.norm?.length, r.short, n2)}${cell(r.contact, r.norm?.contact, r.longContact, x => Number(x).toFixed(3).replace('.', ','))}</div>`).join('');
  return `<section class="card sp-card"><h2>Každých 5 m oproti normám</h2>
    ${say.map(t => `<p>${t}</p>`).join('')}${plText ? `<p>${plText}</p>` : ''}
    <div class="sp-bands">${head}${rows}</div>
    <p class="note">${B.graded ? 'Malým číslom norma: šprintéri zo štartu z miesta (Stavridis 2022, 9 mužov), dĺžka kroku prepočítaná na tvoju výšku. ' : 'Pre ženy zo štartu z miesta publikované normy po 5 m nie sú, čísla sa nehodnotia. '}Rast rýchlosti oproti skokanom do diaľky (Haugen 2019). Frekvencia a kontakt namerané z každého kroku, dĺžka kroku z času kroku na krivke cez brány Freelapu. Freelap ±2 % na 10 m, preto sa rozdiel rastu hlási až od 4 %.</p></section>`;
}
