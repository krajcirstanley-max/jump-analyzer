// The Výsledok screen: feel first, then score and phase tiles, replay, speed, coaching and
// every number. Renders a finished jump into the slots of index.html.
import { profileHtml, rhythmHtml, wireCharts } from './charts.js';
import { MAX_YAW } from './metrics.js';
import { whatIf } from './whatif.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (x, dp) => Number(x).toFixed(dp).replace('.', ',').replace(/^-/, '−');
const decimals = m => (m.unit === 'm' || m.unit === 'm/s' ? 2 : m.key === 'takeoffAngle' ? 1 : 0);
const withUnit = (m, s) => (m.unit === '°' ? `${s}°` : `${s} ${m.unit}`);
const value = (m, v) => withUnit(m, num(v, decimals(m)));
const band = s => (s == null ? 'none' : s >= 85 ? 'hi' : s >= 60 ? 'mid' : 'lo');
const shown = m => m && m.status !== 'hidden' && m.value != null;
const scoreOf = jump => (typeof jump.score === 'number' ? jump.score : jump.score?.score ?? null);

function rangeText(m) {
  const [lo, hi] = m.norm, dp = decimals(m);
  const joined = lo < 0 || hi < 0 ? `${num(lo, dp)} až ${num(hi, dp)}` : `${num(lo, dp)}–${num(hi, dp)}`;
  return withUnit(m, joined) + (m.runup ? ` · pre ${kroky(m.runup)}` : '');
}

function hiddenReason(m) {
  if (m.reason) return `${m.reason[0].toUpperCase()}${m.reason.slice(1)}${/[.!?]$/.test(m.reason) ? '' : '.'}`;
  if (Number.isFinite(m.yaw)) return `Kamera bola ${Math.round(m.yaw)}° od bočného pohľadu, limit je ${MAX_YAW}°.`;
  return 'Z tohto záberu sa to nedá spoľahlivo zmerať.';
}

function metricRow(m, on) {
  if (!shown(m)) {
    return `<div class="met st-hidden" data-key="${esc(m.key)}"><div class="met-top"><span>${esc(m.label)}</span></div><p class="met-why">${esc(hiddenReason(m))}</p></div>`;
  }
  const off = m.target != null && m.status !== 'ok' && !m.range;
  const pre = m.estimate && !m.range ? '≈ ' : '';
  const go = m.frame != null ? ` data-frame="${m.frame}"` : '';
  return `<div class="met st-${m.status}${on ? ' on' : ''}" data-key="${esc(m.key)}"${go}>
    <div class="met-top"><span>${esc(m.label)}</span><b>${pre}${m.range ? withUnit(m, `${num(m.range[0], 0)}–${num(m.range[1], 0)}`) : value(m, m.value)}${off ? ` <i>→ ${value(m, m.target)}</i>` : ''}</b></div>
    ${m.noRef ? '' : bandHtml(m)}
    ${normLine(m)}
    ${poseHtml(m)}
    ${partsHtml(m)}
  </div>`;
}

// The band's source under the value. Not every band is the finalists' (legTD is Nemtsev's sub-elite
// jumpers, kneeTO one study), and an info-only metric says it isn't graded and why (audit 2026-11-24).
function normLine(m) {
  const why = m.why ? `nehodnotí sa: ${esc(m.why)}` : 'nehodnotí sa';
  if (m.status === 'info' && m.noRef) return `<div class="met-n">Bez publikovanej normy, ${why}.</div>`;
  const src = m.ref ? `${esc(m.ref)}:` : 'Norma finalistov';
  return `<div class="met-n">${src} ${rangeText(m)}${m.status === 'info' ? ` · ${why}` : ''}</div>`;
}

// Where a lowering is read (2026-11-23, Stanley: „správnu pózu … a píš to tam presne“): the two poses,
// each a button to that frame, and what the range means.
function poseHtml(m) {
  if (!m.frames || !['hipDrop', 'comDropBoard'].includes(m.key)) return '';
  const [a, b] = m.frames, go = (f, t) => `<button class="pose-go" data-frame="${f}">${t} ▸</button>`;
  const where = m.key === 'hipDrop'
    ? `v póze, keď je ťažisko presne nad členkom stojnej nohy: ${go(a, '3. posledný krok')} → ${go(b, 'predposledný')}`
    : `od dotyku predposledného kroku po dotyk na doske: ${go(a, 'predposledný')} → ${go(b, 'doska')}`;
  return `<div class="met-pose">Výška ťažiska nad zemou z celého tela (aj chodidla), ako v 3D štúdiách, ${where}.</div>`;
}

// Where a lowering comes from (2026-11-23, Stanley: „tie cm“): each part's share in cm, biggest first.
const PART_LABEL = { thigh: 'stehno', shank: 'predkolenie', foot: 'chodidlo', top: 'trup a ruky' };
function partsHtml(m) {
  if (!m.parts) return '';
  const bits = Object.entries(m.parts).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => `${PART_LABEL[k]} <b>${num(Math.round(v * 10) / 10 || 0, 1)}</b>`);
  return `<div class="met-parts">Z toho (cm): ${bits.join(' · ')}</div>`;
}

// The finalists' range as a band and the athlete as a dot on it (design approved by Stanley,
// 2026-11-14): what is outside the norm shows at a glance, not only as a score bar.
function bandHtml(m) {
  if (!Array.isArray(m.norm) || !Number.isFinite(m.value)) return '';
  const [lo, hi] = m.norm, span = Math.abs(hi - lo) || 1, a = Math.min(lo, hi) - span * 0.6, b = Math.max(lo, hi) + span * 0.6;
  const at = v => Math.max(2, Math.min(98, ((v - a) / (b - a)) * 100));
  const l = at(Math.min(lo, hi)), w = at(Math.max(lo, hi)) - l;
  return `<div class="met-band b-${band(m.score)}"><i style="left:${l.toFixed(1)}%;width:${w.toFixed(1)}%"></i><b style="left:${at(m.value).toFixed(1)}%"></b></div>`;
}

function tile(p) {
  const s = p.score == null ? null : Math.round(p.score);
  return `<button class="tile b-${band(s)}" data-phase="${p.id}" aria-pressed="false">
    <span class="tile-l">${p.id === 'pen' ? 'Predposl.' : esc(p.label)}</span><b>${s ?? '–'}</b>${p.result ? '<small class="tile-thin">výsledok</small>' : ''}
  </button>`;
}

// 1 krok, 2-4 kroky, 5+ krokov
const kroky = n => `${n} ${n === 1 ? 'krok' : n >= 2 && n <= 4 ? 'kroky' : 'krokov'}`;

// Run-up step count, counted the way Stanley does: every contact from the mark to the board.
// The number is prefilled and the athlete confirms it or changes it in steps of 2 (Stanley,
// 2026-11-12: "nech je predvyplnené a ja len potvrdím alebo zmením"); run-ups are even, at most 18.
// c: the detected count (stepcount.js). r: { value, confirmed, from, expected, pb, measured } where
// from says where the prefilled number came from: 'count', 'range', 'last' (the athlete's last
// confirmed run-up); expected: runup.js expectedDistance for that run-up.
const metres = x => `${num(x, 2)} m`;
export function runupHtml(c, r) {
  const v = r?.value ?? null;
  const seenLine = c?.seen ? `Appka napočítala ${kroky(c.count)}.`
    : c?.count ? `${{ blind: 'Začiatok je príliš ďaleko na prečítanie', hole: 'Časť rozbehu v zábere chýba' }[c.why] ?? 'Štart nie je v zábere'}, vidno posledných ${kroky(c.count)}${c.range ? `, celý rozbeh ${c.range[0] === c.range[1] - 2 ? `${c.range[0]} alebo ${c.range[1]}` : `${c.range[0]} až ${c.range[1]}`}` : ''}.`
    : 'Appka kroky z videa nespočítala.';
  const fromLine = r?.confirmed ? '' : r?.from === 'last' ? ' Predvyplnené podľa posledného potvrdeného rozbehu.' : '';
  return `<div class="runup" id="runup">
    ${splitRowHtml(r)}
    <div class="runup-row">
      <span class="runup-l">Rozbeh</span>
      <button class="runup-step" data-runup="-2" aria-label="O 2 kroky menej"${v != null && v <= 2 ? ' disabled' : ''}>−</button>
      <b class="runup-n">${v ?? '?'}</b><span class="runup-u">${v == null ? 'krokov' : kroky(v).split(' ')[1]}</span>
      <button class="runup-step" data-runup="2" aria-label="O 2 kroky viac"${v != null && v >= 18 ? ' disabled' : ''}>+</button>
      ${r?.confirmed ? '<span class="runup-ok">✓ potvrdené</span>' : `<button class="btn small primary" data-runup="ok"${v == null ? ' disabled' : ''}>Potvrdiť</button>`}
    </div>
    <p class="note">${seenLine}${fromLine} Počíta sa od značky po dosku vrátane.</p>
    ${r?.expected ? `<p class="note runup-exp">Naplno z ${kroky(r.expected.steps)} je strop okolo <b>${metres(r.expected.mid)}</b> (${num(r.expected.lo, 2)}–${num(r.expected.hi, 2)} m), ${Math.round(r.expected.pct * 100)} % tvojho PB ${metres(r.expected.pb)}.${r.judged === r.value ? ' Uhol odrazu, koleno a rýchlosti sú posudzované pre tento rozbeh.' : ' Po potvrdení sa uhol odrazu, koleno a rýchlosti posúdia pre tento rozbeh.'}</p>`
      : v >= 6 && v < 18 && !(r?.pb > 0) ? '<p class="note runup-exp">Zapíš PB v Progrese a appka povie, koľko by mal skok z tohto rozbehu merať.</p>' : ''}
    ${lengthRowHtml(r)}
  </div>`;
}

// Speed and length are prefilled from the video and the athlete confirms them or types the real
// number over them (Stanley, 2026-11-14: "musím vedieť potvrdiť aj rýchlosť alebo napísať a aj
// dĺžku"), the same way as the run-up. r.split / r.measured are the saved numbers (null = not yet
// confirmed); r.videoSplit / r.videoDist what the video read.
const same = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;
const okBtn = (done, attr) => (done ? '<span class="runup-ok">✓ potvrdené</span>' : `<button class="btn small primary" ${attr}>Potvrdiť</button>`);
function splitRowHtml(r) {
  const saved = r?.split ?? null, video = r?.videoSplit ?? null, v = saved ?? video;
  const note = saved != null ? (same(saved, video) ? 'Potvrdené z videa.' : 'Zapísané ručne.')
    : video != null ? 'Z videa. Potvrď ho, alebo prepíš časom z Freelapu.' : 'Video tento čas neurčilo. Zapíš ho z Freelapu.';
  return `<div class="conf-row"><span class="runup-l">Čas 1–11 m</span>
      <input data-split type="text" inputmode="decimal" autocomplete="off" placeholder="napr. 1,10" value="${v != null ? num(v, 2) : ''}"><span class="runup-u">s</span>
      ${okBtn(saved != null, 'data-split-ok')}</div>
    <p class="note">${note}</p>`;
}
// The tape also corrects the video's metres (jump.js tapeFix): the line under the row says by how
// much, or why not.
function lengthRowHtml(r) {
  const saved = r?.measured ?? null, video = r?.videoDist ?? null, v = saved ?? video, from = r?.tapeFrom;
  const where = from === 'toe' ? 'od odrazovej špičky' : from === 'board' ? 'od čiary dosky' : 'odhad z videa';
  const tf = r?.tapeFix, pct = k => `${k > 1 ? '+' : '−'}${num(Math.abs((k - 1) * 100), 1)} %`;
  const fixLine = saved == null || !tf || same(saved, video) ? ''
    : tf.applied ? ` Rýchlosť v lete spresnená o ${pct(tf.kFlight ?? tf.k)}: nad pieskom nie sú čiary dráhy, rozbeh a kroky ostávajú.`
    : tf.tooFar ? ` Video ukázalo ${metres(tf.video)}, rozdiel ${pct(tf.k)} je priveľký na chybu mierky. Asi je zle prečítaná stopa v piesku, nič som neprepočítal.` : '';
  const note = saved != null ? (same(saved, video) ? `Potvrdené z videa, ${where}.` : `Zapísané z pásma, ${where}.${fixLine}`)
    : video != null ? `Z videa, ${where}. Potvrď, alebo prepíš dĺžkou z pásma.` : 'Video dĺžku neurčilo. Zapíš ju z pásma.';
  const chips = from ? `<div class="filt conf-from"><button data-tape-from="toe" class="${from === 'toe' ? 'on' : ''}">od špičky</button><button data-tape-from="board" class="${from === 'board' ? 'on' : ''}">od dosky</button></div>` : '';
  return `<div class="conf-row"><span class="runup-l">Dĺžka skoku</span>
      <input data-measured type="text" inputmode="decimal" autocomplete="off" placeholder="napr. 6,50" value="${v != null ? num(v, 2) : ''}"><span class="runup-u">m</span>
      ${okBtn(saved != null, 'data-measured-ok')}</div>
    ${chips}<p class="note">${note}</p>`;
}

// The 1-11 m cell: the confirmed or typed time once there is one, else the video's.
export function firstCellHtml(s, ru) {
  const sec = v => `${num(v, 2)} s`;
  const t = ru?.split ?? s?.split1to11 ?? null;
  if (t == null) return `<div id="sp-first">${cellHtml('Do odrazu', s?.last)}</div>`;
  const typed = ru?.split != null && !same(ru.split, s?.split1to11);
  return `<div id="sp-first"><span>1–11 m</span><b>${sec(t)}</b>${typed ? '<small>zapísané</small>' : shown(s?.last) ? `<small>posledný krok ${value(s.last, Math.abs(s.last.value))}</small>` : ''}</div>`;
}
const cellHtml = (label, m) => `<span>${label}</span><b>${shown(m) ? value(m, Math.abs(m.value)) : '–'}</b>`;

function speedHtml(s, sc, ru) {
  if (!s) return `<h2>Rýchlosť <small>odhad</small></h2><p class="met-why">Z tohto záberu sa rýchlosť nedá odhadnúť.</p>${runupHtml(sc, ru)}`;
  const cell = (label, m, extra = '') => `<div><span>${label}</span><b>${shown(m) ? value(m, Math.abs(m.value)) : '–'}</b>${extra}</div>`;
  // The percentage survives a bad metre scale: it is a ratio of two speeds.
  const pctText = s.lossPct == null ? null : `${num(Math.abs(s.lossPct), 0)} %`;
  const lossCell = shown(s.loss) ? cell('Strata', s.loss, pctText ? `<small>${pctText}</small>` : '')
    : `<div><span>Strata</span><b>${pctText ?? '–'}</b></div>`;
  const hiddenOne = [s.last, s.takeoff, s.loss].find(m => m && !shown(m));
  const jumpLine = s.jumpFromToe != null ? `<p class="note">Skok od odrazovej špičky po prvú stopu v piesku: <b>${num(s.jumpFromToe, 2)} m</b></p>` : "";
  // Stanley reads speed as a time over a distance (Freelap 1-11 m), so that leads when the
  // cones are in the video; the last step in m/s moves under it.
  const sec = v => `${num(v, 2)} s`;
  const first = firstCellHtml(s, ru);
  const halves = s.split6to11 != null && s.split1to6 != null
    ? `<p class="note">11–6 m: <b>${sec(s.split6to11)}</b> · 6–1 m: <b>${sec(s.split1to6)}</b>${s.split1to6 > s.split6to11 * 1.02 ? ` · do dosky spomalíš o ${num((s.split1to6 / s.split6to11 - 1) * 100, 0)} %` : ''}</p>` : '';
  const split2 = (s.split11to21 != null ? `<p class="note">11–21 m: <b>${sec(s.split11to21)}</b></p>` : '') + halves;
  return `<h2>Rýchlosť <small>${s.cones ? 'z kužeľov' : s.board ? 'z dosky' : 'odhad'}</small></h2>
    <div class="big">${first}${cell('Odraz', s.takeoff)}${lossCell}</div>${split2}${runupHtml(sc, ru)}${jumpLine}
    ${hiddenOne ? `<p class="met-why">${esc(hiddenReason(hiddenOne))}</p>` : ''}
    <details><summary>Ako isté to je?</summary><p>Istota: <b>${esc(s.sure)}</b>. ${esc(s.note)}</p></details>`;
}

// Every run-up step's time, from the counted contacts: shortening steps into the board, and a
// longer last one, show without reading a table.
function rhythmBars(c, fps) {
  const f = c?.contacts?.map(x => x.frame).filter(Number.isFinite);
  if (!(f?.length >= 4) || !(fps > 0)) return '';
  const t = f.slice(1).map((x, i) => (x - f[i]) / fps), lo = Math.min(...t) * 0.85, hi = Math.max(...t);
  const bars = t.map((v, i) => `<div><i style="height:${(12 + ((v - lo) / (hi - lo || 1)) * 52).toFixed(0)}px"${i === t.length - 1 ? ' class="last"' : ''}></i><small>${i + 2}</small></div>`).join('');
  const n2 = v => num(v, 2);
  return `<div class="rhythm"><span class="rhythm-l">Rytmus krokov (čas kroku)</span><div class="rhythm-bars">${bars}</div>
    <p class="note">Kroky ${n2(t[0])} → ${n2(Math.min(...t.slice(-3, -1)))} s, posledný do dosky ${n2(t.at(-1))} s.</p></div>`;
}

// The last three foot contacts, named the way the coach says it (3rd-last, penultimate, take-off),
// then what happens between them: the flight, the distance toe to toe and the rhythm.
function stepsHtml(steps, heightCm, lowering) {
  if (!steps?.length) return '';
  const name = { third: '3. od konca', pen: 'Predposl.', take: 'Odraz' };
  const short = { third: '3. od konca', pen: 'Predposl.', take: 'odraz' };
  const cols = ['third', 'pen', 'take'].map(id => steps.find(s => s.id === id)).filter(Boolean);
  const f = (v, dp, unit) => (Number.isFinite(v) ? `${num(v, dp)}${unit ? ` ${unit}` : ''}` : '–');
  const row = (label, get) => `<tr><th>${label}</th>${cols.map(s => `<td>${get(s)}</td>`).join('')}</tr>`;
  // centre-of-mass heights in cm are not shown: a phone's body scale moves them by several cm (2026-11-23)
  const pct = '';
  // between contacts: each one with the next
  const gaps = cols.slice(0, -1).map((s, k) => [s, cols[k + 1]]);
  const far = s => (s.id === 'third' ? '≈ ' : '');
  const gapRow = (label, get) => `<tr><th>${label}</th>${gaps.map(([a]) => `<td>${get(a)}</td>`).join('')}</tr>`;
  const gapRows = [
    gapRow('Let', a => f(a.flightMs, 0, 'ms')),
    gapRow('Dĺžka kroku', a => (Number.isFinite(a.length) ? far(a) : '') + f(a.length, 2, 'm')),
    gapRow('Frekvencia', a => f(a.freqHz, 1, 'Hz')),
    gapRow('Let ÷ kontakt', a => f(a.flightRatio, 2, '')),
    gapRow('Rýchlosť', a => (Number.isFinite(a.speed) ? far(a) : '') + f(a.speed, 1, 'm/s')),
  ].join('');
  const low = lowering && [
    Number.isFinite(lowering.intoPen) && `do predposledného <b>${num(lowering.intoPen, 1)} cm</b> (dotyk 3. od konca → dotyk predposledného)`,
    Number.isFinite(lowering.intoBoard) && `do odrazu <b>${num(lowering.intoBoard, 1)} cm</b> (odlepenie z predposledného → najnižší bod na doske, ako World Athletics)`,
  ].filter(Boolean);
  return `<h3 class="steps-h">Posledné dotyky</h3>
    <table class="steps"><thead><tr><th></th>${cols.map(s => `<th>${name[s.id]}</th>`).join('')}</tr></thead><tbody>
      ${row('Kontakt', s => f(s.contactMs, 0, 'ms'))}
      ${row('Došľap pred ťažiskom', s => (s.id === 'third' ? '–' : f(s.tdDist, 2, 'm')))}
      ${row('Ťažisko pred špičkou pri odlepení', s => (s.id === 'third' ? '–' : f(s.toDist, 2, 'm')))}
      ${pct}
    </tbody></table>
    ${low?.length ? `<p class="note">Zníženie ťažiska: ${low.join('; ')}. Publikované hodnoty sú 1–9 cm a chyba merania aj v laboratóriu je okolo 3 cm.</p>` : ''}
    <h3 class="steps-h">Medzi dotykmi</h3>
    <table class="steps gaps"><thead><tr><th></th>${gaps.map(([a, b]) => `<th>${short[a.id]} → ${short[b.id]}</th>`).join('')}</tr></thead><tbody>${gapRows}</tbody></table>
    <p class="note">Došľap je päta pred ťažiskom pri dotyku; pri 3. kroku od konca sa neukazuje, lebo je ďaleko od dosky. Let je od odlepenia jednej nohy po dotyk druhej, dĺžka od špičky po špičku, frekvencia z času od dotyku po ďalší dotyk, rýchlosť ťažiska v tom istom úseku. Riadok predposledný → odraz je let do dosky. ≈ pri 3. kroku od konca: je ďaleko od dosky, dĺžka asi ±0,15 m, rýchlosť asi ±0,3 m/s. Časy sú presné na snímku, výška ťažiska na centimetre.</p>`;
}

function fixHtml(f, first) {
  return `<article class="fix${first ? ' first' : ''}">
    ${first ? '<div class="fix-tag">Na ďalší rozbeh</div>' : ''}
    ${first && f.cue ? `<p class="cue-say">„${esc(f.cue)}“</p>` : ''}
    <h3>${esc(f.title)}</h3>
    <p>${esc(f.body)}</p>
    <details><summary>Prečo</summary><p>${esc(f.why)}</p></details>
    <button class="linkish" data-go-phase="${esc(f.phase)}" data-go-metric="${esc(f.metricKey ?? '')}">Pozrieť v zázname ›</button>
  </article>`;
}

function coachHtml(c) {
  if (!c) return '';
  const fixes = c.fixes ?? [];
  return `<div class="card coach">
      ${c.take ? `<p class="take">${esc(c.take)}</p>` : ''}
      ${c.strength ? `<div class="strength"><span>Silná stránka</span><p>${esc(c.strength)}</p></div>` : ''}
      ${fixes[0] ? fixHtml(fixes[0], true) : '<p class="note">Všetko je v rozsahu. Na ďalší skok nič nemeň.</p>'}
    </div>
    ${fixes.length > 1 ? `<div class="card coach"><h2>Potom</h2>${fixes.slice(1).map(f => fixHtml(f, false)).join('')}</div>` : ''}`;
}

function allNumbers(jump) {
  const seen = new Set();
  const group = (title, rows) => (rows.length ? `<h3 class="all-h">${esc(title)}</h3>${rows.map(m => metricRow(m)).join('')}` : '');
  const byPhase = (jump.phases ?? []).map(p => {
    p.metrics.forEach(m => seen.add(m.key));
    return group(p.label, p.metrics);
  }).join('');
  return byPhase + group('Ostatné', jump.metrics.filter(m => !seen.has(m.key)));
}

const COACH_WAIT = '<div class="card coach"><p class="note">Koučing sa ešte píše…</p></div>';

// Coaching can land while the athlete reads further down: only this slot changes, and when
// it sits above the screen the page is shifted by what it grew, so nothing moves under them.
export function showCoach(els, coach) {
  const below = els.all.closest('details');
  const top0 = below.getBoundingClientRect().top;
  const above = els.coach.getBoundingClientRect().bottom <= 0;
  els.coach.innerHTML = coachHtml(coach);
  if (els.take) els.take.innerHTML = takeHtml(els.pickTake ? { take: els.pickTake } : coach);
  if (above) scrollBy(0, below.getBoundingClientRect().top - top0);
}

// What the one score is made of (coach.js unifiedScore): the jump's result against its expectation and the
// technique, each with what it rests on; a half that could not be judged says why.
const BASIS = { 'speed-own': n => `podľa tvojej rýchlosti a ${n} skokov`, own: n => `oproti tvojim ${n} skokom`, population: () => 'podľa rýchlosti, orientačne' };
function scoreParts(sc) {
  if (!sc || typeof sc !== 'object') return '';
  const o = sc.outcome, t = sc.technique;
  const res = o ? `<span class="score-part">Výsledok <b>${Math.round(o.score)}</b> · let ${num(o.T, 2)} s, čakané ${num(o.Texp, 2)} (${BASIS[o.basis](o.n)})</span>`
    : '<span class="score-part">Výsledok bez hodnotenia: chýba čas letu alebo porovnanie</span>';
  const tec = t != null ? `<span class="score-part">Technika <b>${Math.round(t)}</b> · z ${sc.graded ?? '?'} čísel</span>`
    : '<span class="score-part">Technika bez hodnotenia: málo zmeraných čísel</span>';
  return res + tec;
}
// Score as a ring, the word for it, the feel and the distance estimate beside it.
const WORD = s => (s == null ? '' : s >= 85 ? 'výborná' : s >= 70 ? 'dobrá' : s >= 55 ? 'priemerná' : 'slabá');
function scoreHtml(jump, s, feel) {
  const r = 44, c = 2 * Math.PI * r, f = s == null ? 0 : Math.max(0, Math.min(1, s / 100));
  const est = (jump.metrics ?? []).find(m => m.key === 'estDistance' && shown(m));
  return `<div class="score">
    <svg class="score-ring b-${band(s)}" viewBox="0 0 104 104" aria-label="Skóre skoku ${s == null ? '' : Math.round(s)} zo 100">
      <circle cx="52" cy="52" r="${r}" class="track"/><circle cx="52" cy="52" r="${r}" class="fill" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 52 52)"/>
      <text x="52" y="58" class="n">${s == null ? '–' : Math.round(s)}</text><text x="52" y="76" class="of">/ 100</text></svg>
    <div class="score-side"><span class="score-l">Skok</span><b>${WORD(s)}</b>
      ${scoreParts(jump.score)}
      <span class="score-feel" data-feel-shown>${feel ? `Pocit ${feel}/5` : ''}</span>
      ${est ? `<span class="score-est">odhad dĺžky <b>≈ ${num(est.value, 2)} m</b></span>` : ''}</div>
  </div>`;
}
// "O koľko ďalej" (whatif.js): each fault of this jump moved to the norm, in centimetres, with
// what else moves and its cue; the first one is the one thing to work on now.
const DP = { '°': 1, cm: 1, ms: 0, 'm/s': 2, m: 2, '%': 0, s: 2 };
const withU = (v, u) => `${num(v, DP[u] ?? 1)}${u === '°' ? '°' : u ? ` ${u}` : ''}`;
// cm with a range only when it is narrow (Stanley: "5-25 je priveľa").
const cm1 = v => Math.round(v * 100);
const cmText = (g, signed = true) => {
  const [a, b] = g.map(cm1), s = v => (signed && v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : `${v}`);
  return b - a <= 2 ? `${s(Math.round((a + b) / 2))} cm` : `${s(a)} až ${Math.abs(b)} cm`;
};
export function whatIfHtml(w) {
  if (!w) return '';
  if (!w.items.length) return '<h2>O koľko ďalej</h2><p class="note">V tomto skoku nie je nič mimo normy.</p>';
  const ARROW = { up: '▲', down: '▼', same: '=' };
  // the arrow is the direction of the number, the colour whether it helps
  const arrow = e => (/^bez/.test(e.value) ? '=' : /^[−-]/.test(e.value) ? '▼' : /^\+|vyššie|strmší/.test(e.value) ? '▲' : ARROW[e.kind]);
  const eff = e => `<div class="fx-row ${e.kind}"><span class="ar">${arrow(e)}</span><span>${esc(e.label)}<small>${esc(e.value)}</small></span><b class="cm">${e.cm ? (e.kind === 'same' && !e.cm[0] && !e.cm[1] ? '0 cm' : cmText(e.cm)) : 'v čísle vyššie'}</b></div>`;
  const row = (x, i) => `<div class="wi${i === 0 ? ' pick' : ''}">
      ${i === 0 ? '<span class="wi-tag">Teraz zlepšuj toto</span>' : ''}
      <div class="wi-head"><b>${esc(x.title)}</b><span class="wi-gain">${x.total ? cmText(x.total) : ''}</span></div>
      <p class="wi-num">${x.freelap ? `${x.freelap.typed ? 'Freelap 1–11 m' : '1–11 m z videa'}: ${num(x.freelap.now, 2)} → ${num(x.freelap.target, 2)} s` : x.numText ? esc(x.numText) : `${esc(x.label)}: ${withU(x.now, x.unit)} → ${withU(x.target, x.unit)}`}</p>
      ${x.cue ? `<p class="wi-cue">Cue: „${esc(x.cue)}“</p>` : ''}
      ${x.img ? `<p class="wi-img"><b>Predstav si</b>${esc(x.img)}</p>` : ''}
      ${x.effects.length ? `<div class="fx"><span class="fx-l">Z toho</span>${x.effects.map(eff).join('')}
        ${x.total ? `<div class="sum"><span>Spolu za túto zmenu</span><b>${cmText(x.total)}</b></div>` : ''}</div>` : ''}
      <p class="src">${x.basis === 'fyzika' ? 'Prepočet z tvojho odrazu.' : x.basis === 'štúdie' ? 'Z meraní v štúdiách pri rovnakej rýchlosti, štatisticky neisté.' : x.basis === 'odhad' ? 'Odhad z fyziky otáčania v lete, nie z merania.' : 'Centimetre sa pre túto chybu nedajú vyčísliť.'}${x.note ? ` ${esc(x.note)}` : ''}</p>
    </div>`;
  return `<h2>O koľko ďalej</h2>
    <p class="note">Keby bola chyba z tohto skoku v norme. Zoradené podľa toho, koľko ťa stojí. Vyber jednu vec, ďalšie video môže ukázať inú.</p>
    ${w.items.map(row).join('')}
    <p class="note wi-all">Zelené pridá, červené uberie, sivé je už v čísle nad ním.${w.together ? ` Rôzne zmeny sa nesčítajú, lebo jedna posunie druhú: všetky naraz asi ${cmText(w.together)}.` : ''}</p>`;
}

// "Zem, vzduch, let": every contact and flight, like the sprint view; a row jumps the video there.
const n3 = v => num(v, 3).replace(/^0/, '');
export function timelineHtml(jump) {
  const t = jump?.timeline;
  if (!t?.rows?.length) return '';
  const by = Object.fromEntries((jump.metrics ?? []).map(m => [m.key, m]));
  const FOOT = { l: 'Ľ', r: 'P' }, NAME = { third: '3. od konca', pen: 'predposl.', take: 'odraz' };
  const bad = k => (by[k] && (by[k].status === 'low' || by[k].status === 'high') ? ' bad' : '');
  const px = 480, rows = t.rows.map((r, i) => {
    const take = r.id === 'take', air = take ? `<span class="air"></span>` : r.air != null ? `<span class="fl" style="width:${Math.round(r.air * px)}px"></span>` : '';
    const ck = take ? bad('contactTO') : r.id === 'pen' ? bad('contactPen') : '';
    return `<button class="tl-row${take ? ' key' : ''}" data-frame="${r.td}"><span>${i + 1}</span><span>${NAME[r.id] ? `<b>${NAME[r.id]}</b> ` : ''}${FOOT[r.foot] ?? ''}</span>
      <span class="tl-bar"><span class="c" style="width:${Math.round(r.contact * px)}px"></span>${air}</span><span class="tl-n${ck}">${n3(r.contact)}</span><span class="tl-n">${r.air != null ? n3(r.air) : '–'}</span></button>`;
  }).join('');
  const land = t.landingFrame != null ? `<button class="tl-row key" data-frame="${t.landingFrame}"><span></span><span><b>dopad</b></span><span class="tl-go">${t.apex != null ? `vrchol letu +${num(t.apex, 2)} s · ` : ''}dopad +${num(t.landing, 2)} s ▸</span><span></span><span></span></button>` : '';
  const box = (label, m, val, norm) => `<div><span>${label}</span><b class="${m && (m.status === 'low' || m.status === 'high') ? 'bad' : ''}">${val}</b>${norm ? `<small>${norm}</small>` : ''}</div>`;
  const ct = by.contactTO, fl = by.flight, pen = t.rows.find(r => r.id === 'pen'), take = t.rows.find(r => r.id === 'take');
  return `<h2>Zem, vzduch, let</h2>
    <p class="note">Každý dotyk s rozbehom, odrazom a dopadom. Ťukni na riadok a video skočí na ten záber, nech si to overíš.</p>
    <div class="tl-legend"><span><i class="c"></i>na zemi</span><span><i class="fl"></i>vo vzduchu</span></div>
    <div class="tl-row head"><span>#</span><span>krok</span><span></span><span class="tl-n">zem</span><span class="tl-n">vzd.</span></div>
    ${rows}${land}
    <div class="tl-sum">
      ${ct ? box('Odraz na zemi', ct, `${num(ct.value / 1000, 3)} s`, `finalisti ${num(ct.norm[0] / 1000, 3)}–${num(ct.norm[1] / 1000, 3)}`) : ''}
      ${fl && fl.status !== 'hidden' ? box('Let', fl, `${num(fl.value / 1000, 2)} s`, `${fl.ref ? 'odvodené' : 'finalisti'} ${num(fl.norm[0] / 1000, 2)}–${num(fl.norm[1] / 1000, 2)}`) : ''}
      ${pen && take ? box('Rytmus', null, `${n3(pen.contact)} → ${n3(take.contact)}`, 'predposl. → odraz') : ''}
    </div>`;
}

// The one thing to take away, under the phases.
const takeHtml = c => (c?.take ? `<div class="take-card"><span>Hlavná vec</span><p>${esc(c.take)}</p></div>` : '');

// els: slots from index.html. player: null when the clip is no longer on the phone.
// Hand-set contact frames (2026-11-15, Stanley: an "Upraviť" button first, then "Dotyk je tu").
// Editing stays on across the re-render that follows a change, off for a new attempt.
const EDGE_SET = { penTD: 'Dotyk predposledného', penTO: 'Odlepenie predposledného', TD: 'Dotyk', TO: 'Odraz' };
const EDGE_HINT = { penTD: 'prvú snímku, keď je chodidlo na zemi', penTO: 'poslednú snímku, keď je špička ešte na zemi', TD: 'prvú snímku, keď je chodidlo na doske', TO: 'poslednú snímku, keď je špička ešte na doske' };
// '+1 snímka', '−2 snímky': the player counts frames from the start of its cut, so the bar speaks in steps
const steps = n => `${n > 0 ? '+' : '−'}${Math.abs(n)} ${Math.abs(n) === 1 ? 'snímka' : Math.abs(n) < 5 ? 'snímky' : 'snímok'}`;
// How far from the analysis' frame a hand edit may go: 0,1 s (12 frames at 120 fps). It was 3
// frames, and IMG_4933's toe-off came 7 frames early (2026-11-16): it could not be fixed by hand.
const EDGE_REACH_S = 0.1;
let editOn = false, editSel = null;   // the phase being edited stays selected after the numbers are read again
export const stopEdit = () => { editOn = false; editSel = null; };
export function renderResult(els, jump, player, { feel = null, onFeel, noReplayNote, awaitingCoach = false, runup = null, sex = 'male', name = '', height = null, onEdge = null } = {}) {
  // The what-if pick is the one thing; "Hlavná vec" says the same (Stanley approved, 2026-11-14).
  const wi = whatIf(jump, sex, { height });
  const pickTake = wi?.items?.[0]?.take;
  els.pickTake = pickTake && name ? `${name}, ${pickTake}.` : null;
  const phases = jump.phases ?? [];
  const firstFix = jump.coach?.fixes?.[0]?.phase;
  let sel = (editOn && phases.find(p => p.id === editSel)?.id) || (phases.find(p => p.id === firstFix)?.id ?? phases.find(p => p.id === 'plant')?.id ?? phases[0]?.id);
  let chipFrame = null;

  const s = scoreOf(jump);
  els.score.innerHTML = scoreHtml(jump, s, feel);
  if (els.take) els.take.innerHTML = takeHtml(els.pickTake ? { take: els.pickTake } : jump.coach);
  els.tiles.innerHTML = phases.map(tile).join('');
  els.speed.innerHTML = speedHtml(jump.speed, jump.stepCount, runup) + rhythmBars(jump.stepCount, jump.fps) + profileHtml(jump.profile) + rhythmHtml(jump.profile) + stepsHtml(jump.steps, jump.stepsHeightCm, jump.lowering);
  wireCharts(els.speed);
  els.coach.innerHTML = awaitingCoach ? COACH_WAIT : coachHtml(jump.coach);
  if (els.whatif) els.whatif.innerHTML = whatIfHtml(wi);
  if (els.timeline) { els.timeline.innerHTML = timelineHtml(jump); els.timeline.classList.toggle('hidden', !jump.timeline?.rows?.length); }
  els.all.innerHTML = allNumbers(jump);

  els.playerCard.classList.toggle('hidden', !player);
  if (player) {
    if (jump.replay) player.setRange(jump.replay.from, jump.replay.to);
    player.setLoop(true);
  }

  const markChip = () => els.chips.querySelectorAll('.kf[data-frame]').forEach(b => b.classList.toggle('on', +b.dataset.frame === chipFrame));
  if (player) player.onFrame = f => { chipFrame = f; markChip(); drawBar(); };
  // "Upraviť" and its bar: one "… je tu · frame" button per contact edge of the phase, live only
  // within 0,1 s of the analysis' frame, so a slip of the finger can't move it far.
  const EDGE_REACH = Math.max(3, Math.round(EDGE_REACH_S * (jump.fps > 0 ? jump.fps : 120)));
  const edgesOf = p => (p?.keyFrames ?? []).filter(k => k.frame != null && EDGE_SET[k.id]);
  function editHtml(p) {
    if (!onEdge || !player || !edgesOf(p).length) return '';
    return `<button class="kf kf-edit" data-edit>${editOn ? 'Hotovo' : 'Upraviť'}</button>`;
  }
  // On the video: which frame the analysis has, and "… je tu · frame" for the one on screen.
  function drawBar() {
    const stage = player?.stage;
    if (!stage) return;
    // Under the ‹ › buttons, not on the video: on a close portrait clip the panels covered the foot
    // being set (2026-11-23).
    const host = stage.parentElement, anchor = host.querySelector('.controls') ?? stage;
    let bar = host.querySelector('.kf-bar');
    const p = phases.find(x => x.id === sel), list = editOn ? edgesOf(p) : [];
    if (!list.length) { bar?.remove(); return; }
    if (!bar) { bar = document.createElement('div'); bar.className = 'kf-bar'; anchor.after(bar); }
    const cur = player.index;
    bar.innerHTML = list.map(k => {
      const ok = cur !== k.frame && Math.abs(cur - k.frame) <= EDGE_REACH;
      const off = cur - k.frame;
      return `<div class="kf-edge"><p><b>${esc(EDGE_SET[k.id])}</b>${k.hand ? ' · upravené ručne' : ''} · ${off ? `teraz ${steps(off)}` : 'si na ňom'}</p>
        ${ok ? '' : `<small>Šípkami ‹ › nájdi ${EDGE_HINT[k.id]} (do ${EDGE_REACH} snímok).</small>`}
        <div class="kf-btns"><button class="kf-set" data-edge-set="${k.id}"${ok ? '' : ' disabled'}>${esc(EDGE_SET[k.id])} je tu${off && ok ? ` (${steps(off)})` : ''}</button>${k.hand ? `<button class="kf-undo" data-edge-reset="${k.id}">Vrátiť</button>` : ''}</div></div>`;
    }).join('');
  }

  function select(id, { metric = null, scroll = false } = {}) {
    const p = phases.find(x => x.id === id);
    if (!p) return;
    sel = id;
    if (editOn) editSel = id;
    els.tiles.querySelectorAll('.tile').forEach(t => {
      const on = t.dataset.phase === id;
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', String(on));
    });
    const tdTime = player?.ts?.[jump.takeoff?.td];
    els.chips.innerHTML = (p.keyFrames ?? []).filter(k => k.frame != null).map(k => {
      const ms = tdTime != null ? (player.ts[k.frame] - tdTime) * 1000 : null;
      const t = ms == null ? '' : `<small>${Math.abs(ms) < 0.5 ? '0 ms' : `${ms > 0 ? '+' : '−'}${Math.abs(ms).toFixed(0)} ms`}</small>`;
      return `<button class="kf${k.hand ? ' hand' : ''}" data-frame="${k.frame}">${esc(k.label)}${k.hand ? ' ✎' : ''}${t}</button>`;
    }).join('') + editHtml(p);
    const rows = (p.metrics ?? []).map(m => metricRow(m, m.key === metric)).join('');
    els.detail.innerHTML = `<h2>${esc(p.label)}</h2>${rows || `<p class="met-why">${esc(p.note ?? (p.id === 'landing' ? 'Dopad nie je v zábere, táto fáza sa nedá zmerať.' : 'Táto fáza nie je na videu vidieť.'))}</p>`}${noReplayNote ? `<p class="note">${esc(noReplayNote)}</p>` : ''}`;
    if (player) {
      if (p.frame != null) { player.pause(); player.show(p.frame); }
      player.setBands(phases.map(x => ({ from: x.from, to: x.to, id: x.id, on: x.id === id })));
    }
    markChip();
    drawBar();
    if (scroll) els.tiles.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  els.after.onclick = e => {
    if (e.target.closest('[data-edit]')) {
      editOn = !editOn; editSel = editOn ? sel : null; select(sel);
      // the video and its arrows in view, the frame on the analysis' contact
      if (editOn && player) { const k = edgesOf(phases.find(x => x.id === sel))[0]; if (k) { player.pause(); player.show(k.frame); } requestAnimationFrame(() => els.playerCard.scrollIntoView({ block: 'end' })); }
      return;
    }
    const set = e.target.closest('[data-edge-set]');
    if (set && player && !set.disabled) return onEdge?.(set.dataset.edgeSet, player.index);
    const reset = e.target.closest('[data-edge-reset]');
    if (reset) return onEdge?.(reset.dataset.edgeReset, null);
    const tileBtn = e.target.closest('[data-phase]');
    if (tileBtn) return select(tileBtn.dataset.phase);
    const link = e.target.closest('[data-go-phase]');
    if (link) return select(link.dataset.goPhase, { metric: link.dataset.goMetric || null, scroll: true });
    const go = e.target.closest('[data-frame]');
    if (go && player) { player.pause(); player.show(+go.dataset.frame); }
  };

  const reveal = () => {
    els.feel.classList.add('hidden');
    els.after.classList.remove('hidden');
    select(sel);
    player?.refresh();
  };

  // The athlete says how it felt before seeing any numbers (Coaching SOP).
  if (feel != null) return reveal();
  els.after.classList.add('hidden');
  els.feel.classList.remove('hidden');
  els.feel.innerHTML = `<h2>Ako sa to cítilo?</h2><p class="note">Povedz to skôr, než uvidíš čísla.</p>
    <div class="feel-row">${[1, 2, 3, 4, 5].map(n => `<button class="feel-b" data-feel="${n}">${n}</button>`).join('')}</div>
    <div class="feel-ends"><span>zle</span><span>výborne</span></div>
    <button class="feel-skip" data-feel-skip>Preskočiť</button>`;
  els.feel.onclick = e => {
    // Skipped (Stanley, 2026-11-20): stored as 0, so the question doesn't come back; 0 is never shown
    // or counted as a feeling anywhere (every reader takes only 1-5).
    if (e.target.closest('[data-feel-skip]')) { jump.feel = 0; reveal(); onFeel?.(0); return; }
    const b = e.target.closest('[data-feel]');
    if (!b) return;
    jump.feel = +b.dataset.feel;
    els.score.querySelector('[data-feel-shown]').textContent = `Pocit ${jump.feel}/5`;
    reveal();
    onFeel?.(jump.feel);
  };
}
