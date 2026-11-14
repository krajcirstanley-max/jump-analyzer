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
  // Which foot: the pose's own when it saw one foot on every rebound (left/right keypoints don't
  // mirror); Claude's reading of the frames otherwise.
  const leg = r.singleLeg ? r.leg : (r.named?.leg ?? r.leg);
  return {
    id: `${Date.now()}`, at: new Date().toISOString(), file: file?.name ?? '', fps: Math.round(r.fps),
    exercise: r.exercise, leg, noRebound: !!r.noRebound, boxCm: r.boxCm ?? null, boxFrom: r.boxFrom ?? null, boxEstCm: r.boxEstCm == null ? null : Math.round(r.boxEstCm),
    askBox: r.askBox, rsiErrPct: r.rsiErrPct, camera: r.camera ?? null,
    jumps: r.jumps.map(j => ({ td: j.td, contactMs: Math.round(j.contactMs), flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1), rsi: +j.rsi.toFixed(2), ri: +j.ri.toFixed(2), slow: j.slow, landingFlexed: j.landingFlexed })),
    standing: (r.standing ?? []).map(j => ({ td: j.td, to: j.to, flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1) })),
    best5: r.best5 ? { rsi: +r.best5.rsi.toFixed(2), ri: +r.best5.ri.toFixed(2), contactMs: Math.round(r.best5.contactMs) } : null,
  };
}
const bestOf = rec => rec.jumps.reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);

function tile(label, value, sub = '') { return `<div><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ''}</div>`; }

function resultHtml(rec) {
  const b = bestOf(rec), st = rec.standing?.[0];
  const odd = rec.exercise === 'other' ? '<p class="note">Toto nevyzerá ako drop jump, odrazy ani výskok. Čísla nižšie sú len z dotykov, ktoré som našiel.</p>' : '';
  const head = odd + `<h2>${esc(NAMES[rec.exercise] ?? rec.exercise)} <small>${esc(LEG[rec.leg] ?? '')}${rec.boxCm ? ` · debna ${rec.boxFrom === 'estimate' ? '≈ ' : ''}${rec.boxCm} cm` : ''} · ${rec.fps} fps</small></h2>`;
  // RSI is jump height / contact time, the box never enters it (Stanley). Its height is only
  // noted: read off the video, or typed in when the video could not show it.
  const box = rec.askBox && !rec.boxCm ? `<p class="note">Výšku debničky som z videa nevedel odhadnúť. Dopíš ju:</p>
    <label class="measured"><span>Výška debničky</span><input data-rsi-box type="text" inputmode="numeric" autocomplete="off" placeholder="napr. 30"><span>cm</span></label>` : '';
  if (!b && rec.noRebound) {
    return `${head}${box}<p class="banner warn">Vo videu je zoskok a dopad, ale odraz po ňom nie je vidieť: video končí skôr, alebo po dopade nebol výskok. RSI sa bez odrazu nedá vyrátať. Natoč aj výskok po dopade.</p>`;
  }
  if (!b) {
    return `${head}${box}<div class="big">${tile('Výška výskoku', st ? `${num(st.heightCm, 1)} cm` : '–')}${tile('Let', st ? `${st.flightMs} ms` : '–')}${tile('RSI', '–', 'z výskoku z miesta sa nepočíta')}</div>
      <p class="note">Pri výskoku z miesta je výška z času letu. RSI-mod by potreboval začiatok pohybu, ten sa z videa číta neisto.</p>`;
  }
  const many = rec.jumps.length > 1;
  const st0 = (rec.standing ?? []).find(x => x.td < rec.jumps[0].td && (x.to ?? x.td) < rec.jumps[0].td) ?? null;
  const startRow = st0 ? `<tr><th>štart</th><td>–</td><td>${st0.flightMs}</td><td>${num(st0.heightCm, 1)}</td><td>–</td><td>–</td></tr>` : '';
  const rows = startRow + rec.jumps.map((j, k) => `<tr class="${j === b ? 'on' : ''}"><th>${k + 1}.</th><td>${j.contactMs}${j.slow ? '⚠' : ''}</td><td>${j.flightMs}</td><td>${num(j.heightCm, 1)}</td><td><b>${num(j.rsi, 2)}</b></td><td>${num(j.ri, 2)}</td></tr>`).join('');
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

// The app's own camera (ios/App/App/SprintCamera.swift), in its RSI mode. null in Safari.
function camera(cap = globalThis.Capacitor) {
  if (!cap?.isNativePlatform?.() || !cap.nativePromise || !cap.addListener) return null;
  return {
    open: o => cap.nativePromise('SprintCamera', 'open', o),
    finalize: o => cap.nativePromise('SprintCamera', 'finalize', o),
    on: (ev, f) => cap.addListener('SprintCamera', ev, d => d && f(d)),
  };
}

// What goes onto the filmed clip, each while it applies: the contact, the flight, then the result.
// Times in seconds from the start of the clip.
const s2 = x => num(x, 2), s3 = x => num(x, 3), cm = x => `${num(x, 0)} cm`;
const odrazy = n => `${n} ${n >= 2 && n <= 4 ? 'odrazy' : 'odrazov'}`;
const prekazok = n => `${n} ${n === 1 ? 'prekážka' : n >= 2 && n <= 4 ? 'prekážky' : 'prekážok'}`;
export function rsiMarks(r) {
  const ts = r.ts, t0 = ts?.[0] ?? 0, dt = 1 / (r.fps || 120), at = f => (ts?.[f] ?? f * dt) - t0;
  const out = [], jumps = r.jumps ?? [], many = jumps.length > 1;
  // Hurdle hops (Stanley, 2026-11-14: "prekážky chceme každý jeden"): the flight over the first
  // hurdle comes from a standing start, so it is no rebound, but it is a hurdle: shown too.
  const hurdles = r.exercise === 'hurdle_hops';
  const start = (r.standing ?? []).filter(st => jumps.length && st.to < jumps[0].td).at(-1);
  if (start) {
    const up = at(start.to) + dt, fl = start.flightMs / 1000;
    out.push({ from: up, to: up + fl, title: hurdles ? '1. prekážka · Let' : '1. skok · Let', big: `${s3(fl)} s`, small: '' });
  }
  const off = start ? 1 : 0;
  // A series (hops, hurdle hops): each contact's time on the ground and each flight, numbered, and
  // the averages after the last landing (Stanley, 2026-11-14: "gct len a dĺžka letu").
  jumps.forEach((j, k) => {
    const c = j.contactMs / 1000, fl = j.flightMs / 1000, h = j.heightCm;
    const down = at(j.td), up = at(j.to) + dt, land = up + fl;
    const n = hurdles ? `pred ${k + 1 + off}. prekážkou · ` : many ? `${k + 1}. odraz · ` : '';
    const nf = hurdles ? `${k + 1 + off}. prekážka · ` : n;
    out.push({ from: down, to: up, title: `${n}Na zemi`, big: `${s3(c)} s`, small: '' });
    out.push({ from: up, to: land, title: `${nf}Let`, big: `${s3(fl)} s`, small: many || hurdles ? '' : `výška ${cm(h)} · RSI ${s2(j.rsi)}` });
    if (!many && !hurdles) out.push({ from: land, to: land + 2.5, title: 'RSI', big: s2(j.rsi), small: `zem ${s2(c)} s · let ${s2(fl)} s · ${cm(h)}` });
  });
  if (many || hurdles) {
    const last = jumps.at(-1), end = at(last.to) + dt + last.flightMs / 1000;
    const avg = (list, k) => list.reduce((a, j) => a + j[k], 0) / list.length / 1000;
    const flights = [...(start ? [start] : []), ...jumps];
    out.push({ from: end, to: end + 3, title: `${hurdles ? prekazok(flights.length) : odrazy(jumps.length)} · priemer`, big: `${s3(avg(jumps, 'contactMs'))} s`, small: `na zemi · let ${s3(avg(flights, 'flightMs'))} s` });
  }
  return out.sort((a, b) => a.from - b.from);
}

export function initRsi({ root, athletes, getAthlete, roster, rememberAthlete, cam = camera() }) {
  root.innerHTML = `
    <div class="card"><h2>RSI</h2>
      <p class="note">Natáčaj <b>spredu</b>, pokojne aj z ruky (pohyb telefónu odrátam podľa pozadia), v zábere celé chodidlá a kus okolia. Najlepšie <b>240 fps</b> (Slo-mo). Cvik rozpoznám sám.</p>
      <div class="sp-btns">
        <label class="btn big-btn" id="rsi-pick">Analyzovať RSI<input type="file" accept="video/*" hidden id="rsi-file"></label>
        ${cam ? '<button class="btn big-btn" id="rsi-film">Natočiť</button>' : ''}
      </div>
      ${cam ? '<p class="note">Natočené v appke (240 fps) sa rozoberie samo a do Fotiek sa uloží jedno video, už s časom na zemi, letom a RSI.</p>' : ''}
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
  // The box height typed in when the video could not show it.
  root.addEventListener('change', e => {
    if (!e.target.matches('[data-rsi-box]') || !current) return;
    const cm = Math.round(parseFloat(String(e.target.value).replace(',', '.')));
    if (!(cm >= 5 && cm <= 120)) { e.target.value = ''; return; }
    const { rec, who } = current;
    rec.boxCm = cm; rec.boxFrom = 'typed';
    save(who, load(who).map(r => (r.id === rec.id ? rec : r)));
    show(rec, who); renderHistory();
  });
  // Wrong person: the result moves to the other athlete's history.
  root.addEventListener('click', e => {
    if (!e.target.closest('[data-rsi-swap]') || !current) return;
    const { rec, who } = current, to = Object.keys(athletes).find(a => a !== who);
    save(who, load(who).filter(r => r.id !== rec.id));
    const list = load(to); list.push(rec); list.sort((x, y) => String(x.at).localeCompare(String(y.at))); save(to, list);
    rememberAthlete(to);
    show(rec, to); renderHistory();
  });

  async function analyze(file, filmed = null) {
    if (busy && !filmed) return;
    const who = getAthlete(), prog = $('rsi-progress');
    if (!cloudReady()) { prog.classList.remove('hidden'); prog.textContent = 'Najprv ulož prístupový kľúč v nastaveniach.'; if (filmed) cam.finalize({ id: filmed.id, marks: [] }).catch(() => {}); return; }
    busy = true; $('rsi-pick').classList.add('disabled');
    prog.classList.remove('hidden'); prog.textContent = filmed ? 'Rozoberám natočené video…' : 'Nahrávam video…';
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
      // the filmed clip goes to Photos now, once, with the numbers on it
      if (filmed) cam.finalize({ id: filmed.id, marks: rsiMarks(result) }).catch(() => {});
    } catch (err) {
      prog.textContent = err?.message || 'Analýza zlyhala. Skús to znova.';
      if (filmed) cam.finalize({ id: filmed.id, marks: [] }).catch(() => {});   // saved as filmed, never lost
    } finally {
      busy = false; $('rsi-pick').classList.remove('disabled');
    }
  }
  $('rsi-file').addEventListener('change', e => {
    const file = e.target.files?.[0]; e.target.value = '';
    if (file) analyze(file);
  });
  if (cam) {
    $('rsi-film').addEventListener('click', () => cam.open({ fps: 240, mode: 'rsi', freelap: false }).catch(err => alert(`Kameru sa nepodarilo otvoriť: ${err?.message ?? err}`)));
    // Filmed clips, one at a time; the camera can stay open meanwhile.
    const queue = [];
    cam.on('recorded', async d => {
      if (d.mode !== 'rsi' || !d.raw) return;
      queue.push(d);
      if (queue.length > 1) return;
      while (queue.length) {
        const job = queue[0];
        try {
          const src = globalThis.Capacitor?.convertFileSrc?.(job.raw) ?? job.raw;
          const blob = await (await fetch(src)).blob();
          await analyze(new File([blob], 'rsi.mov', { type: 'video/quicktime', lastModified: job.recordedAt ?? Date.now() }), job);
        } catch { cam.finalize({ id: job.id, marks: [] }).catch(() => {}); }
        queue.shift();
      }
    });
    cam.on('saved', d => { if (d.mode === 'rsi') { const prog = $('rsi-progress'); prog.classList.remove('hidden'); prog.textContent = d.message ?? ''; } });
  }
  // localhost only: lets a developer render a stored result without a server run
  if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__rsiShow = (rec, who = getAthlete().id) => { show(rec, who); renderHistory(); };
  return {
    shown() { renderHistory(); },
  };
}
