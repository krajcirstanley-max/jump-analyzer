// The Výsledok screen: feel first, then score and phase tiles, replay, speed, coaching and
// every number. Renders a finished jump into the slots of index.html.
import { profileHtml, rhythmHtml, wireCharts } from './charts.js';
import { MAX_YAW } from './metrics.js';

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
  return withUnit(m, joined);
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
  const off = m.target != null && m.status !== 'ok';
  const pre = m.estimate ? '≈ ' : '';
  const go = m.frame != null ? ` data-frame="${m.frame}"` : '';
  return `<div class="met st-${m.status}${on ? ' on' : ''}" data-key="${esc(m.key)}"${go}>
    <div class="met-top"><span>${esc(m.label)}</span><b>${pre}${value(m, m.value)}${off ? ` <i>→ ${value(m, m.target)}</i>` : ''}</b></div>
    ${m.score != null ? `<div class="met-bar b-${band(m.score)}"><div style="width:${Math.round(m.score)}%"></div></div>` : ''}
    <div class="met-n">Rozsah ${rangeText(m)}</div>
  </div>`;
}

function tile(p) {
  const s = p.score == null ? null : Math.round(p.score);
  return `<button class="tile b-${band(s)}" data-phase="${p.id}" aria-pressed="false">
    <span class="tile-l">${p.id === 'pen' ? 'Predposl.' : esc(p.label)}</span><b>${s ?? '–'}</b>
    <span class="tile-bar"><i style="width:${s ?? 0}%"></i></span>
  </button>`;
}

// 1 krok, 2-4 kroky, 5+ krokov
const kroky = n => `${n} ${n === 1 ? 'krok' : n >= 2 && n <= 4 ? 'kroky' : 'krokov'}`;

// Run-up step count, counted the way Stanley does: every contact from the first step to the board.
function stepCountHtml(c) {
  if (!c?.count) return '';
  return c.seen
    ? `<p class="note">Rozbeh: <b>${kroky(c.count)}</b> (od prvého kroku po dosku, bez naskočenia)</p>`
    : `<p class="note">Rozbeh: štart nie je v zábere, vidno posledných <b>${kroky(c.count)}</b>${c.range ? `, celý rozbeh ${c.range[0] === c.range[1] - 2 ? `${c.range[0]} alebo ${c.range[1]}` : `${c.range[0]} až ${c.range[1]}`} krokov` : ''}</p>`;
}

function speedHtml(s, sc) {
  if (!s) return `<h2>Rýchlosť <small>odhad</small></h2><p class="met-why">Z tohto záberu sa rýchlosť nedá odhadnúť.</p>${stepCountHtml(sc)}`;
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
  const first = s.split1to11 != null
    ? `<div><span>1–11 m</span><b>${sec(s.split1to11)}</b>${shown(s.last) ? `<small>posledný krok ${value(s.last, Math.abs(s.last.value))}</small>` : ''}</div>`
    : cell('Do odrazu', s.last);
  const split2 = s.split11to21 != null ? `<p class="note">11–21 m: <b>${sec(s.split11to21)}</b></p>` : '';
  return `<h2>Rýchlosť <small>${s.cones ? 'z kužeľov' : s.board ? 'z dosky' : 'odhad'}</small></h2>
    <div class="big">${first}${cell('Odraz', s.takeoff)}${lossCell}</div>${split2}${stepCountHtml(sc)}${jumpLine}
    ${hiddenOne ? `<p class="met-why">${esc(hiddenReason(hiddenOne))}</p>` : ''}
    <details><summary>Ako isté to je?</summary><p>Istota: <b>${esc(s.sure)}</b>. ${esc(s.note)}</p></details>`;
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
  const pct = heightCm ? row('Pri dotyku, % výšky', s => f((s.com.td * 100 / heightCm) * 100, 0, '%')) : '';
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
      ${row('Ťažisko pri dotyku', s => f(s.com.td * 100, 0, 'cm'))}
      ${row('Ťažisko najnižšie', s => f(s.com.low * 100, 0, 'cm'))}
      ${row('Ťažisko pri odlepení', s => f(s.com.to * 100, 0, 'cm'))}
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
  if (above) scrollBy(0, below.getBoundingClientRect().top - top0);
}

// els: slots from index.html. player: null when the clip is no longer on the phone.
export function renderResult(els, jump, player, { feel = null, onFeel, noReplayNote, awaitingCoach = false } = {}) {
  const phases = jump.phases ?? [];
  const firstFix = jump.coach?.fixes?.[0]?.phase;
  let sel = phases.find(p => p.id === firstFix)?.id ?? phases.find(p => p.id === 'plant')?.id ?? phases[0]?.id;
  let chipFrame = null;

  const s = scoreOf(jump);
  els.score.innerHTML = `<div class="score"><span class="score-n">${s == null ? '–' : Math.round(s)}</span><span class="score-of">/ 100</span>${feel != null ? `<span class="score-feel" data-feel-shown>Pocit ${feel}/5</span>` : '<span class="score-feel" data-feel-shown></span>'}</div>`;
  els.tiles.innerHTML = phases.map(tile).join('');
  els.speed.innerHTML = speedHtml(jump.speed, jump.stepCount) + profileHtml(jump.profile) + rhythmHtml(jump.profile) + stepsHtml(jump.steps, jump.stepsHeightCm, jump.lowering);
  wireCharts(els.speed);
  els.coach.innerHTML = awaitingCoach ? COACH_WAIT : coachHtml(jump.coach);
  els.all.innerHTML = allNumbers(jump);

  els.playerCard.classList.toggle('hidden', !player);
  if (player) {
    if (jump.replay) player.setRange(jump.replay.from, jump.replay.to);
    player.setLoop(true);
  }

  const markChip = () => els.chips.querySelectorAll('.kf').forEach(b => b.classList.toggle('on', +b.dataset.frame === chipFrame));
  if (player) player.onFrame = f => { chipFrame = f; markChip(); };

  function select(id, { metric = null, scroll = false } = {}) {
    const p = phases.find(x => x.id === id);
    if (!p) return;
    sel = id;
    els.tiles.querySelectorAll('.tile').forEach(t => {
      const on = t.dataset.phase === id;
      t.classList.toggle('on', on);
      t.setAttribute('aria-pressed', String(on));
    });
    const tdTime = player?.ts?.[jump.takeoff?.td];
    els.chips.innerHTML = (p.keyFrames ?? []).filter(k => k.frame != null).map(k => {
      const ms = tdTime != null ? (player.ts[k.frame] - tdTime) * 1000 : null;
      const t = ms == null ? '' : `<small>${Math.abs(ms) < 0.5 ? '0 ms' : `${ms > 0 ? '+' : '−'}${Math.abs(ms).toFixed(0)} ms`}</small>`;
      return `<button class="kf" data-frame="${k.frame}">${esc(k.label)}${t}</button>`;
    }).join('');
    const rows = (p.metrics ?? []).map(m => metricRow(m, m.key === metric)).join('');
    els.detail.innerHTML = `<h2>${esc(p.label)}</h2>${rows || `<p class="met-why">${esc(p.note ?? (p.id === 'landing' ? 'Dopad nie je v zábere, táto fáza sa nedá zmerať.' : 'Táto fáza nie je na videu vidieť.'))}</p>`}${noReplayNote ? `<p class="note">${esc(noReplayNote)}</p>` : ''}`;
    if (player) {
      if (p.frame != null) { player.pause(); player.show(p.frame); }
      player.setBands(phases.map(x => ({ from: x.from, to: x.to, id: x.id, on: x.id === id })));
    }
    markChip();
    if (scroll) els.tiles.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  els.after.onclick = e => {
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
    <div class="feel-ends"><span>zle</span><span>výborne</span></div>`;
  els.feel.onclick = e => {
    const b = e.target.closest('[data-feel]');
    if (!b) return;
    jump.feel = +b.dataset.feel;
    els.score.querySelector('[data-feel-shown]').textContent = `Pocit ${jump.feel}/5`;
    reveal();
    onFeel?.(jump.feel);
  };
}
