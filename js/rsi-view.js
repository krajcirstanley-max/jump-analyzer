// The RSI tab: pick a clip of a plyometric drill, the server finds every contact and flight and
// names the drill, and the screen shows contact time, flight, jump height and both RSI forms.
// Results are kept per athlete in this browser (numbers only, no video) for the trend. The server
// tells who is in the clip (no athlete switch since 2026-11-12); a tap on the name moves a result.
import { analyzeInCloud, cloudReady, CloudError } from './cloud.js';

const NAMES = {
  drop_jump: 'Drop jump', drop_jump_single: 'Drop jump jednonož', pogo: 'Pogo', repeated_hops: 'Opakované odrazy',
  hops: 'Odrazy', hurdle_hops: 'Odrazy cez prekážky', cmj: 'Výskok z podrepu (CMJ)', squat_jump: 'Výskok z drepu (SJ)',
  single_leg_hops: 'Odrazy jednonož', unknown: 'Neznámy cvik', other: 'Iný cvik',
};
const LEG = { both: 'obe nohy', lr: 'obe nohy', left: 'ľavá', right: 'pravá', l: 'ľavá', r: 'pravá' };
const num = (x, dp) => (Number.isFinite(x) ? Number(x).toFixed(dp).replace('.', ',') : '–');
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const key = a => `jump.rsi.${a}`;
const load = a => { try { return JSON.parse(localStorage.getItem(key(a)) || '[]'); } catch { return []; } };
const save = (a, list) => { try { localStorage.setItem(key(a), JSON.stringify(list.slice(-200))); } catch { /* storage blocked */ } };

// Keep only what the screen and the trend need.
function record(r, file) {
  const leg = r.named?.leg ?? r.leg;
  return {
    id: `${Date.now()}`, at: new Date().toISOString(), file: file?.name ?? '', fps: Math.round(r.fps),
    exercise: r.exercise, leg, boxCm: r.boxCm ?? null, boxEstCm: r.boxEstCm == null ? null : Math.round(r.boxEstCm),
    askBox: r.askBox, rsiErrPct: r.rsiErrPct, camera: r.camera ?? null,
    jumps: r.jumps.map(j => ({ contactMs: Math.round(j.contactMs), flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1), rsi: +j.rsi.toFixed(2), ri: +j.ri.toFixed(2), slow: j.slow, landingFlexed: j.landingFlexed })),
    standing: (r.standing ?? []).map(j => ({ flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1) })),
    best5: r.best5 ? { rsi: +r.best5.rsi.toFixed(2), ri: +r.best5.ri.toFixed(2), contactMs: Math.round(r.best5.contactMs) } : null,
  };
}
const bestOf = rec => rec.jumps.reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);

function tile(label, value, sub = '') { return `<div><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`; }

function resultHtml(rec) {
  const b = bestOf(rec), st = rec.standing?.[0];
  const odd = rec.exercise === 'other' ? '<p class="note">Toto nevyzerá ako drop jump, odrazy ani výskok. Čísla nižšie sú len z dotykov, ktoré som našiel.</p>' : '';
  const head = odd + `<h2>${esc(NAMES[rec.exercise] ?? rec.exercise)} <small>${esc(LEG[rec.leg] ?? '')}${rec.boxCm ? ` · debna ${rec.boxCm} cm` : ''} · ${rec.fps} fps</small></h2>`;
  // No box question: RSI is jump height / contact time, the box never enters it (Stanley).
  const box = '';
  if (!b) {
    return `${head}${box}<div class="big">${tile('Výška výskoku', st ? `${num(st.heightCm, 1)} cm` : '–')}${tile('Let', st ? `${st.flightMs} ms` : '–')}${tile('RSI', '–', 'z výskoku z miesta sa nepočíta')}</div>
      <p class="note">Pri výskoku z miesta je výška z času letu. RSI-mod by potreboval začiatok pohybu, ten sa z videa číta neisto.</p>`;
  }
  const many = rec.jumps.length > 1;
  const rows = rec.jumps.map((j, k) => `<tr class="${j === b ? 'on' : ''}"><th>${k + 1}.</th><td>${j.contactMs}${j.slow ? '⚠' : ''}</td><td>${j.flightMs}</td><td>${num(j.heightCm, 1)}</td><td><b>${num(j.rsi, 2)}</b></td><td>${num(j.ri, 2)}</td></tr>`).join('');
  // RSI of every rebound as a line with its own scale (a bar from zero would hide 1.3 vs 1.6)
  const bars = many ? (() => {
    const v = rec.jumps.map(j => j.rsi), lo = Math.min(...v), hi = Math.max(...v), pad = (hi - lo) * 0.15 || 0.1;
    const y0 = lo - pad, y1 = hi + pad, W = 320, H = 110, L = 30, R = 8, T = 10, B = 20;
    const X = k => L + (k / (v.length - 1)) * (W - L - R), Y = r => T + ((y1 - r) / (y1 - y0)) * (H - T - B);
    const ticks = [lo, (lo + hi) / 2, hi];
    return `<svg class="viz-svg rsi-line" viewBox="0 0 ${W} ${H}" role="img" aria-label="RSI každého odrazu">
      ${ticks.map(t => `<line class="viz-grid" x1="${L}" x2="${W - R}" y1="${Y(t).toFixed(1)}" y2="${Y(t).toFixed(1)}"/><text class="viz-tick" x="${L - 5}" y="${(Y(t) + 3).toFixed(1)}" text-anchor="end">${num(t, 2)}</text>`).join('')}
      <polyline class="viz-line" points="${v.map((r, k) => `${X(k).toFixed(1)},${Y(r).toFixed(1)}`).join(' ')}"/>
      ${v.map((r, k) => `<circle class="viz-dot" cx="${X(k).toFixed(1)}" cy="${Y(r).toFixed(1)}" r="4"><title>${k + 1}. odraz: RSI ${num(r, 2)}</title></circle><text class="viz-tick" x="${X(k).toFixed(1)}" y="${H - 5}" text-anchor="middle">${k + 1}</text>`).join('')}
    </svg>`;
  })() : '';
  const flags = [
    rec.jumps.some(j => j.slow) && '⚠ kontakt nad 250 ms: to už nie je rýchly odraz.',
    rec.camera?.used && rec.camera.tracked < 0.9 && 'Telefón sa hýbal a pozadie som nevedel sledovať celé video: kontakty na konci môžu byť nepresné.',
    rec.jumps.some(j => j.landingFlexed) && 'Pri dopade boli boky nižšie než pri odraze: let a výška môžu byť trochu nadhodnotené.',
  ].filter(Boolean);
  return `${head}${box}
    <div class="big">${tile('RSI', num(rec.best5?.rsi ?? b.rsi, 2), rec.best5 ? 'priemer 5 najlepších' : 'výška ÷ kontakt, m/s')}${tile('Kontakt', `${rec.best5?.contactMs ?? b.contactMs} ms`)}${tile('Výška', `${num(b.heightCm, 1)} cm`, many ? 'pri najlepšom RSI' : '')}</div>
    <p class="note">Let ÷ kontakt: <b>${num(rec.best5?.ri ?? b.ri, 2)}</b> (tak to počíta My Jump). Presnosť RSI pri ${rec.fps} fps asi ±${rec.rsiErrPct?.[0]}–${rec.rsiErrPct?.[1]} %${rec.fps < 200 ? ', na 240 fps je to polovica' : ''}.</p>
    ${bars}
    <table class="steps rsi-table"><thead><tr><th></th><th>Kontakt<br><small>ms</small></th><th>Let<br><small>ms</small></th><th>Výška<br><small>cm</small></th><th>RSI<br><small>m/s</small></th><th>Let÷<br>kont.</th></tr></thead><tbody>${rows}</tbody></table>
    ${flags.length ? `<p class="note">${flags.join(' ')}</p>` : ''}`;
}

function historyHtml(list) {
  if (!list.length) return '';
  const byEx = {};
  for (const r of list) (byEx[`${r.exercise}|${r.leg}`] ??= []).push(r);
  const groups = Object.entries(byEx).map(([k, rs]) => {
    const [ex, leg] = k.split('|');
    const vals = rs.map(r => r.best5?.rsi ?? bestOf(r)?.rsi).filter(Number.isFinite);
    const items = rs.slice(-8).reverse().map(r => {
      const b = bestOf(r), d = new Date(r.at);
      return `<li><span>${d.getDate()}. ${d.getMonth() + 1}.${r.boxCm ? ` · ${r.boxCm} cm` : ''}</span><b>${b ? num(r.best5?.rsi ?? b.rsi, 2) : `${num(r.standing?.[0]?.heightCm, 1)} cm`}</b><small>${b ? `${r.best5?.contactMs ?? b.contactMs} ms` : 'výška'}</small></li>`;
    }).join('');
    const spark = vals.length > 1 ? (() => { const lo = Math.min(...vals), hi = Math.max(...vals), w = 120, h = 28;
      const pts = vals.map((v, i) => `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - lo) / (hi - lo || 1)) * (h - 6)).toFixed(1)}`).join(' ');
      return `<svg class="rsi-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}"/></svg>`; })() : '';
    return `<div class="rsi-group"><div class="rsi-gh"><b>${esc(NAMES[ex] ?? ex)}</b><small>${esc(LEG[leg] ?? '')}</small>${spark}</div><ul>${items}</ul></div>`;
  }).join('');
  return groups;
}

export function initRsi({ root, athletes, getAthlete, roster, rememberAthlete }) {
  root.innerHTML = `
    <div class="card"><h2>RSI</h2>
      <p class="note">Natáčaj <b>spredu</b>, pokojne aj z ruky (pohyb telefónu odrátam podľa pozadia), v zábere celé chodidlá a kus okolia. Najlepšie <b>240 fps</b> (Slo-mo). Cvik rozpoznám sám.</p>
      <label class="btn big-btn" id="rsi-pick">Analyzovať RSI<input type="file" accept="video/*" hidden id="rsi-file"></label>
      <p class="note hidden" id="rsi-progress" aria-live="polite"></p>
    </div>
    <div class="card hidden" id="rsi-result"></div>
    <div class="card hidden" id="rsi-history"></div>`;
  const $ = id => root.querySelector(`#${id}`);
  let current = null, busy = false;

  // Both athletes' histories, each under its name.
  const renderHistory = () => {
    const parts = Object.keys(athletes).map(a => [a, load(a)]).filter(([, list]) => list.length);
    $('rsi-history').classList.toggle('hidden', !parts.length);
    $('rsi-history').innerHTML = '<h2>História</h2>' + parts.map(([a, list]) => `<p class="rsi-who">${esc(athletes[a].name)}</p>${historyHtml(list)}`).join('');
  };
  const show = (rec, who) => {
    current = { rec, who };
    $('rsi-result').classList.remove('hidden');
    $('rsi-result').innerHTML = `<button class="top-who rsi-swap" data-rsi-swap>${esc(athletes[who].name)}<span class="who-swap" aria-hidden="true">⇄</span></button>${resultHtml(rec)}`;
  };
  // Wrong person: the result moves to the other athlete's history.
  root.addEventListener('click', e => {
    if (!e.target.closest('[data-rsi-swap]') || !current) return;
    const { rec, who } = current, to = Object.keys(athletes).find(a => a !== who);
    save(who, load(who).filter(r => r.id !== rec.id));
    const list = load(to); list.push(rec); list.sort((x, y) => String(x.at).localeCompare(String(y.at))); save(to, list);
    rememberAthlete(to);
    show(rec, to); renderHistory();
  });

  $('rsi-file').addEventListener('change', async e => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (!file || busy) return;
    const who = getAthlete(), prog = $('rsi-progress');
    if (!cloudReady()) { prog.classList.remove('hidden'); prog.textContent = 'Najprv ulož prístupový kľúč v nastaveniach.'; return; }
    busy = true; $('rsi-pick').classList.add('disabled');
    prog.classList.remove('hidden'); prog.textContent = 'Nahrávam video…';
    try {
      const { result } = await analyzeInCloud(file, {
        sex: who.sex, name: who.name, height: who.height, mode: 'rsi', boxCm: null, athletes: await roster(),
        onProgress: p => { prog.textContent = `${p.stage}${p.total > 1 ? ` ${Math.round((100 * p.done) / p.total)} %` : ''}…`; },
      });
      if (result?.error) throw new CloudError(result.error);
      const rec = record(result, file);
      const id = result.who?.id in athletes ? result.who.id : who.id;
      rememberAthlete(id);
      const list = load(id); list.push(rec); save(id, list);
      prog.classList.add('hidden');
      show(rec, id); renderHistory();
    } catch (err) {
      prog.textContent = err?.message || 'Analýza zlyhala. Skús to znova.';
    } finally {
      busy = false; $('rsi-pick').classList.remove('disabled');
    }
  });
  // localhost only: lets a developer render a stored result without a server run
  if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__rsiShow = (rec, who = getAthlete().id) => { show(rec, who); renderHistory(); };
  return {
    shown() { renderHistory(); },
  };
}
