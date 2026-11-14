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
    id: `${Date.now()}`, at: new Date().toISOString(), file: file?.name ?? '', fps: Math.round(r.fps), marks: rsiMarks(r),
    exercise: r.exercise, leg, noRebound: !!r.noRebound, boxCm: r.boxCm ?? null, boxFrom: r.boxFrom ?? null, boxEstCm: r.boxEstCm == null ? null : Math.round(r.boxEstCm),
    askBox: r.askBox, rsiErrPct: r.rsiErrPct, camera: r.camera ?? null,
    jumps: r.jumps.map(j => ({ td: j.td, t: +((r.ts?.[j.td] ?? j.td / (r.fps || 120)) - (r.ts?.[0] ?? 0)).toFixed(3), contactMs: Math.round(j.contactMs), flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1), rsi: +j.rsi.toFixed(2), ri: +j.ri.toFixed(2), slow: j.slow, landingFlexed: j.landingFlexed })),
    standing: (r.standing ?? []).map(j => ({ td: j.td, to: j.to, flightMs: Math.round(j.flightMs), heightCm: +j.heightCm.toFixed(1) })),
    best5: r.best5 ? { rsi: +r.best5.rsi.toFixed(2), ri: +r.best5.ri.toFixed(2), contactMs: Math.round(r.best5.contactMs) } : null,
  };
}
const bestOf = rec => (rec.jumps ?? []).reduce((b, j) => (!b || j.rsi > b.rsi ? j : b), null);

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
    // Vertical jumps from standing (CMJ, squat jump): every one in the clip, the best on top.
    const all = rec.standing ?? [], top = all.reduce((x, y) => (!x || y.heightCm > x.heightCm ? y : x), null);
    const list = all.length > 1 ? `<table class="steps rsi-table"><thead><tr><th></th><th>Let<br><small>ms</small></th><th>Výška<br><small>cm</small></th></tr></thead><tbody>${all.map((j, k) => `<tr class="${j === top ? 'on' : ''}"><th>${k + 1}.</th><td>${j.flightMs}</td><td><b>${num(j.heightCm, 1)}</b></td></tr>`).join('')}</tbody></table>` : '';
    return `${head}${box}<div class="big">${tile('Výška výskoku', top ? `${num(top.heightCm, 1)} cm` : '–', all.length > 1 ? `najlepší z ${all.length}` : '')}${tile('Let', top ? `${top.flightMs} ms` : '–')}${tile('RSI', '–', 'z výskoku z miesta sa nepočíta')}</div>
      ${list}<p class="note">Výška je z času letu (h = g·t²/8): odraz a dopad musia byť na rovných nohách, dopad na pokrčené nohy ju nadsadí.</p>`;
  }
  const many = rec.jumps.length > 1;
  const st0 = (rec.standing ?? []).find(x => x.td < rec.jumps[0].td && (x.to ?? x.td) < rec.jumps[0].td) ?? null;
  const startRow = st0 ? `<tr><th>štart</th><td>–</td><td>${st0.flightMs}</td><td>${num(st0.heightCm, 1)}</td><td>–</td><td>–</td></tr>` : '';
  const rows = startRow + rec.jumps.map((j, k) => `<tr class="${j === b ? 'on' : ''}"${rec.hasClip && j.t != null ? ` data-seek="${j.t}"` : ''}><th>${k + 1}.</th><td>${j.contactMs}${j.slow ? '⚠' : ''}</td><td>${j.flightMs}</td><td>${num(j.heightCm, 1)}</td><td><b>${num(j.rsi, 2)}</b></td><td>${num(j.ri, 2)}</td></tr>`).join('');
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
  for (const r of list) if (!r.pending) (byEx[`${r.exercise}|${r.leg}`] ??= []).push(r);
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
const s2 = x => num(x, 2), s3 = x => num(x, 3), cm = x => `${num(x, 0)} cm`, cm1 = x => `${num(x, 1)} cm`;
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
    const next = jumps.length ? at(jumps[0].to) + dt : up + fl;
    out.push({ from: up, to: next, title: hurdles ? '1. prekážka · let' : '1. skok · let', big: cm1(start.heightCm), small: `let ${s3(fl)} s · zo státia`,
      hud: { top: hurdles ? '1. prekážka' : '1. skok', left: { cap: 'výška', v: num(start.heightCm, 1), u: 'cm' }, right: { cap: 'let', v: s3(fl), u: 's' }, ring: { v: '–', u: 'zo státia', fill: 0 } } });
  }
  const off = start ? 1 : 0;
  // The numbers ride on the video like a scoreboard (Stanley, 2026-11-14, a screenshot of another
  // app: "takto overlay"): the height on the left, the contact on the right, the RSI in a ring in
  // the middle, full for the best rebound of the clip. `hud` is that; title/big/small say the same
  // in one line for anything that can only draw text.
  // Vertical jumps from standing (no rebounds): the height in the ring, from take-off to 3 s after landing.
  if (!jumps.length) {
    const st = r.standing ?? [], top = Math.max(...st.map(j => j.heightCm));
    st.forEach((j, k) => {
      const up = at(j.to) + dt, fl = j.flightMs / 1000, n = st.length > 1 ? `${k + 1}. výskok` : 'Výskok';
      out.push({ from: up, to: up + fl + 3, title: n, big: cm1(j.heightCm), small: `let ${s3(fl)} s`,
        hud: { top: n, left: { cap: 'let', v: s3(fl), u: 's' }, right: null, ring: { v: num(j.heightCm, 1), u: 'cm', fill: j.heightCm / top, best: j.heightCm === top && st.length > 1 } } });
    });
    return out.sort((a, b) => a.from - b.from);
  }
  // A series (hops, hurdle hops, hops over cones): each rebound from its take-off to the next one's,
  // then the best rebound and the averages for 3 s (Stanley, 2026-11-14: "výšku aj kontakt pre
  // každý a aj RSI").
  const best = Math.max(...jumps.map(j => j.rsi));
  jumps.forEach((j, k) => {
    const c = j.contactMs / 1000, fl = j.flightMs / 1000, h = j.heightCm;
    const up = at(j.to) + dt, land = up + fl, nx = jumps[k + 1];
    const name = hurdles ? `${k + 1 + off}. prekážka` : many ? `${k + 1}. odraz` : 'Odraz';
    out.push({ from: up, to: nx ? at(nx.to) + dt : land + (many || hurdles ? 0 : 2.5), title: name, big: `RSI ${s2(j.rsi)}`, small: `zem ${s3(c)} s · ${cm1(h)}`,
      hud: { top: many || hurdles ? `${name} z ${jumps.length + (hurdles ? off : 0)}` : name, left: { cap: 'výška', v: num(h, 1), u: 'cm' }, right: { cap: 'na zemi', v: s3(c), u: 's' },
        ring: { v: s2(j.rsi), u: 'RSI', fill: j.rsi / best, best: many && j.rsi === best } } });
  });
  if (many || hurdles) {
    const last = jumps.at(-1), end = at(last.to) + dt + last.flightMs / 1000;
    const mean = k => jumps.reduce((a, j) => a + j[k], 0) / jumps.length;
    const bi = jumps.reduce((b, j, k) => (j.rsi > jumps[b].rsi ? k : b), 0);
    const title = `${hurdles ? prekazok(jumps.length + off) : odrazy(jumps.length)} · najlepší ${bi + 1 + (hurdles ? off : 0)}.`;
    out.push({ from: end, to: end + 3, title, big: `RSI ${s2(jumps[bi].rsi)}`, small: `priemer: zem ${s3(mean('contactMs') / 1000)} s · ${cm1(mean('heightCm'))} · RSI ${s2(mean('rsi'))}`,
      hud: { top: title, left: { cap: 'priemer', v: num(mean('heightCm'), 1), u: 'cm' }, right: { cap: 'priemer', v: s3(mean('contactMs') / 1000), u: 's' }, ring: { v: s2(jumps[bi].rsi), u: 'najlepšie RSI', fill: 1, best: true } } });
  }
  return out.sort((a, b) => a.from - b.from);
}

// The clip with the marks over it, as on the video in Photos: one box that changes with the
// moment (on the ground, in the air, the summary), and a strip with one piece per rebound, the best
// one green (Stanley, 2026-11-14: "nech je to vidno na overlay ako sprint").
const RATES = '<div class="filt sp-rate"><button data-rate="1" class="on">1×</button><button data-rate="0.5">½×</button><button data-rate="0.25">¼×</button><button data-rate="0.1">⅒×</button></div>';
function videoHtml(rec) {
  if (!rec.hasClip) return '';
  const b = bestOf(rec), n = rec.jumps?.length ?? 0;
  const strip = n > 1 ? `<div class="rsi-strip">${rec.jumps.map((j, k) => `<span data-k="${k}"${j === b ? ' class="best"' : ''}></span>`).join('')}</div>` : '';
  return `<div class="sp-video rsi-video"><div class="sp-vbox" data-rsi-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div>
    ${rec.pending ? `<span class="pd-chip">${rec.error ? '⚠ analýza zlyhala' : '◌ analýza beží'}</span>` : '<div class="rsi-ov hidden"></div>'}${strip}</div>${RATES}`;
}
// The scoreboard over the video: height left, contact right, RSI in the ring (full = the best).
const RING = 2 * Math.PI * 44;
function hudHtml(h) {
  const tile = (t, side) => (t ? `<div class="hud-tile ${side}"><small>${esc(t.cap)}</small><b>${esc(t.v)}</b><i>${esc(t.u)}</i></div>` : '<div class="hud-tile empty"></div>');
  const fill = Math.max(0, Math.min(1, h.ring?.fill ?? 0));
  // no line above (Stanley, 2026-11-14: „3. odraz z 5 netreba“)
  return `<div class="hud-row">${tile(h.left, 'l')}
    <div class="hud-ring${h.ring?.best ? ' best' : ''}"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="hud-track" cx="50" cy="50" r="44"/><circle class="hud-arc" cx="50" cy="50" r="44" stroke-dasharray="${RING.toFixed(1)}" style="stroke-dashoffset:${RING.toFixed(1)}" data-to="${(RING * (1 - fill)).toFixed(1)}"/></svg>
      <div class="hud-val"><b>${esc(h.ring?.v ?? '')}</b><i>${esc(h.ring?.u ?? '')}</i></div></div>${tile(h.right, 'r')}</div>`;
}
const pendingSteps = rec => {
  const st = rec.stage ?? '', up = /nahr/i.test(st);
  const step = (cls, txt, note = '') => `<div class="pd-step ${cls}"><span class="pd-dot">${cls === 'done' ? '✓' : ''}</span>${esc(txt)}${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  return `<h2>Analýza</h2>
    ${step(rec.hasClip ? 'done' : 'now', 'Video uložené v telefóne')}
    ${step(rec.error ? 'next' : up ? 'now' : 'done', 'Nahrávam na server', up ? st : '')}
    ${step(rec.error ? 'next' : up ? 'next' : 'now', 'Hľadám dotyky a lety', !up && st ? st : '')}
    ${step('next', 'Zem, let, výška, RSI pre každý odraz')}
    ${rec.error ? `<p class="banner bad">${esc(rec.error)}</p>${rec.hasClip ? `<button class="btn" data-rsi-retry="${esc(rec.id)}">Skúsiť znova</button>` : ''}` : '<p class="note">Video si môžeš pozrieť hneď. Čísla a overlay sa doplnia samé.</p>'}`;
};

// bare: the Tréning tab owns the buttons and the lists; this root shows only the open result.
export function initRsi({ root, athletes, getAthlete, roster, rememberAthlete, cam = camera(), bare = false, onProgress = () => {}, onDone = () => {},
  saveClip = null, loadClip = null, dropClip = null }) {
  root.innerHTML = `
    <div class="card${bare ? ' hidden' : ''}"><h2>RSI</h2>
      <p class="note">Natáčaj <b>spredu</b>, pokojne aj z ruky (pohyb telefónu odrátam podľa pozadia), v zábere celé chodidlá a kus okolia. Najlepšie <b>240 fps</b> (Slo-mo). Cvik rozpoznám sám.</p>
      <div class="sp-btns">
        <label class="btn big-btn" id="rsi-pick">Analyzovať RSI<input type="file" accept="video/*" hidden id="rsi-file"></label>
        ${cam ? '<button class="btn big-btn" id="rsi-film">Natočiť</button>' : ''}
      </div>
      ${cam ? '<p class="note">Natočené v appke (240 fps) sa rozoberie samo a do Fotiek sa uloží jedno video, už s časom na zemi, letom a RSI.</p>' : ''}
      <p class="note hidden" id="rsi-progress" aria-live="polite"></p>
    </div>
    <div class="card hidden" id="rsi-result"></div>
    <div class="card hidden${bare ? ' bare' : ''}" id="rsi-history"></div>`;
  const $ = id => root.querySelector(`#${id}`);
  let current = null, busy = false;

  // Both athletes' histories, each under its name.
  const renderHistory = () => {
    if (bare) return;
    const parts = Object.keys(athletes).map(a => [a, load(a)]).filter(([, list]) => list.length);
    $('rsi-history').classList.toggle('hidden', !parts.length);
    $('rsi-history').innerHTML = '<h2>História</h2>' + parts.map(([a, list]) => `<p class="rsi-who">${esc(athletes[a].name)}</p>${historyHtml(list)}`).join('');
  };
  const show = (rec, who) => {
    current = { rec, who };
    $('rsi-result').classList.remove('hidden');
    $('rsi-result').innerHTML = rec.pending
      ? `<h2>${esc(athletes[who]?.name ?? '')} · odrazy</h2>${videoHtml(rec)}<div data-rsi-prog="${esc(rec.id)}">${pendingSteps(rec)}</div>`
      : `<button class="top-who rsi-swap" data-rsi-swap>${esc(athletes[who].name)}<span class="who-swap" aria-hidden="true">⇄</span></button>${videoHtml(rec)}${resultHtml(rec)}`;
    attachClip(rec);
  };
  // A list kept to 200; the clips of records that fall off go too.
  const put = (a, list) => { const keep = list.slice(-200); for (const r of list.slice(0, list.length - keep.length)) if (r.hasClip) dropClip?.(r.id); save(a, keep); };
  const patch = (a, id, f) => { const list = load(a), x = list.find(r => r.id === id); if (x) { f(x); save(a, list); } return x; };

  // The open record's video, with the marks drawn over it while it plays.
  let clipUrl = null, clipId = null, clipP = null;
  async function attachClip(rec) {
    if (!rec?.hasClip || !loadClip) return;
    if (clipId !== rec.id) {
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      clipUrl = null; clipId = rec.id;
      clipP = loadClip(rec.id).catch(() => null).then(blob => { if (clipId === rec.id) clipUrl = blob ? URL.createObjectURL(blob) : null; });
    }
    await clipP;
    const box = root.querySelector(`[data-rsi-clip="${CSS.escape(rec.id)}"]`);
    if (!box || clipId !== rec.id) return;
    box.innerHTML = clipUrl ? `<video src="${clipUrl}" controls playsinline muted preload="metadata"></video>` : '<p class="note">Video sa nenašlo v telefóne.</p>';
    const v = box.querySelector('video'), ov = root.querySelector('.rsi-ov'), strip = [...root.querySelectorAll('.rsi-strip span')];
    if (!v || rec.pending) return;
    const marks = rec.marks ?? [], times = (rec.jumps ?? []).map(j => j.t);
    let lastKey = '';
    const tick = () => {
      const t = v.currentTime, m = marks.find(x => t >= x.from && t < x.to);
      const key = m ? `${m.title}|${m.big}` : '';
      if (ov && key !== lastKey) {
        lastKey = key;
        ov.classList.toggle('hidden', !m);
        ov.classList.toggle('hud', !!m?.hud);
        ov.innerHTML = !m ? '' : m.hud ? hudHtml(m.hud) : `<small>${esc(m.title)}</small><b>${esc(m.big)}</b>${m.small ? `<i>${esc(m.small)}</i>` : ''}`;
        // the ring fills when a new rebound comes up
        const arc = ov.querySelector('.hud-arc');
        if (arc) requestAnimationFrame(() => requestAnimationFrame(() => { arc.style.strokeDashoffset = arc.dataset.to; }));
      }
      strip.forEach((el, k) => el.classList.toggle('on', times[k] != null && t >= times[k]));
    };
    const loop = () => { if (!v.isConnected) return; tick(); v.requestVideoFrameCallback ? v.requestVideoFrameCallback(loop) : null; };
    v.addEventListener('timeupdate', tick); v.addEventListener('seeked', tick);
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(loop);
    tick();
  }
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
  root.addEventListener('click', e => {
    const rt = e.target.closest('[data-rate]');
    if (rt) {
      const v = root.querySelector('[data-rsi-clip] video');
      if (v) { v.playbackRate = +rt.dataset.rate; v.defaultPlaybackRate = +rt.dataset.rate; }
      root.querySelectorAll('[data-rate]').forEach(x => x.classList.toggle('on', x === rt));
      return;
    }
    // a row of the table: the video jumps to that rebound
    const sk = e.target.closest('[data-seek]');
    if (sk) {
      const v = root.querySelector('[data-rsi-clip] video');
      if (v) { v.pause(); v.currentTime = Math.max(0, +sk.dataset.seek - 0.05); v.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
      return;
    }
    const re = e.target.closest('[data-rsi-retry]');
    if (re && current && loadClip) {
      const { rec, who } = current;
      loadClip(rec.id).then(blob => { if (blob) analyze(new File([blob], 'rsi.mov', { type: blob.type || 'video/quicktime' }), null, { id: rec.id, who }); else alert('Video sa v telefóne nenašlo.'); });
    }
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

  // The record exists from the moment the clip is in (pending, with its video), so it can be
  // watched at once; the numbers and the overlay fill it in when the analysis lands (Stanley,
  // 2026-11-14: "video hneď a čísla neskôr", as for the sprint). retry: { id, who } of a pending one.
  async function analyze(file, filmed = null, retry = null) {
    if (busy && !filmed && !retry) return;
    const who = getAthlete(), el = $('rsi-progress');
    // the progress line, here and on the Tréning tab
    const prog = { classList: el.classList, set textContent(t) { el.textContent = t; onProgress(t); } };
    if (!cloudReady()) { prog.classList.remove('hidden'); prog.textContent = 'Najprv ulož prístupový kľúč v nastaveniach.'; if (filmed) cam.finalize({ id: filmed.id, marks: [] }).catch(() => {}); return; }
    busy = true; $('rsi-pick').classList.add('disabled');
    prog.classList.remove('hidden'); prog.textContent = filmed ? 'Rozoberám natočené video…' : 'Nahrávam video…';
    let pid = retry?.id ?? null, pwho = retry?.who ?? who.id;
    if (!pid) {
      pid = `rsi${Date.now()}`;
      const pend = { id: pid, at: new Date().toISOString(), file: file?.name ?? '', pending: true, stage: 'Nahrávam video', hasClip: false, jumps: [], standing: [] };
      const list = load(pwho); list.push(pend); put(pwho, list);
      if (saveClip) saveClip(pid, file).then(() => { const x = patch(pwho, pid, r => { r.hasClip = true; }); if (x && current?.rec.id === pid) show(x, pwho); }).catch(() => {});
      show(pend, pwho);
      onDone({ rec: pend, who: pwho });   // opens the screen now: the video first
    } else {
      const x = patch(pwho, pid, r => { r.error = null; r.stage = 'Nahrávam video'; });
      if (x && current?.rec.id === pid) show(x, pwho);
    }
    let lastStage = '';
    try {
      const { result } = await analyzeInCloud(file, {
        sex: who.sex, name: who.name, height: who.height, mode: 'rsi', boxCm: null, athletes: await roster(),
        onProgress: p => {
          const t = `${p.stage}${p.total > 1 ? ` ${Math.round((100 * p.done) / p.total)} %` : ''}…`;
          if (t === lastStage) return;
          lastStage = t; prog.textContent = t;
          // only the steps are redrawn, so the video keeps playing
          const box = current?.rec.id === pid && root.querySelector(`[data-rsi-prog="${CSS.escape(pid)}"]`);
          if (box) box.innerHTML = pendingSteps({ ...current.rec, stage: t });
        },
      });
      if (result?.error) throw new CloudError(result.error);
      const old = load(pwho).find(r => r.id === pid);
      const rec = { ...record(result, file), id: pid, at: old?.at ?? new Date().toISOString(), hasClip: !!old?.hasClip };
      const id = result.who?.id in athletes ? result.who.id : pwho;
      rememberAthlete(id);
      // the pending record becomes the result, under whoever the server saw
      save(pwho, load(pwho).filter(r => r.id !== pid));
      const list = load(id); list.push(rec); list.sort((x, y) => String(x.at).localeCompare(String(y.at))); put(id, list);
      prog.classList.add('hidden'); onProgress('');
      if (!current || current.rec.id === pid) show(rec, id);
      renderHistory();
      onDone({ rec, who: id }, { quiet: true });
      // the filmed clip goes to Photos now, once, with the numbers on it
      if (filmed) cam.finalize({ id: filmed.id, marks: rsiMarks(result) }).catch(() => {});
    } catch (err) {
      const msg = err?.message || 'Analýza zlyhala. Skús to znova.';
      prog.textContent = msg;
      const x = patch(pwho, pid, r => { r.error = msg; r.stage = null; });
      if (x && current?.rec.id === pid) show(x, pwho);
      onDone({ rec: x, who: pwho }, { quiet: true });
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
    cam.on('saved', d => { if (d.mode === 'rsi') { const prog = $('rsi-progress'); prog.classList.remove('hidden'); prog.textContent = d.message ?? ''; onProgress(d.message ?? ''); } });
  }
  // localhost only: lets a developer render a stored result without a server run
  if (['localhost', '127.0.0.1'].includes(location.hostname)) window.__rsiShow = (rec, who = getAthlete().id) => { show(rec, who); renderHistory(); };
  const film = () => cam?.open({ fps: 240, mode: 'rsi', freelap: false }).catch(err => alert(`Kameru sa nepodarilo otvoriť: ${err?.message ?? err}`));
  // A clip left pending by a closed app has no upload behind it any more: say so, keep the video.
  for (const a of Object.keys(athletes)) {
    const list = load(a); let ch = false;
    for (const r of list) if (r.pending && !r.error) { r.error = 'Analýza sa prerušila (appka sa zavrela). Video je uložené, skús znova.'; ch = true; }
    if (ch) save(a, list);
  }
  return {
    shown() { renderHistory(); },
    film, analyze, busy: () => busy,
    records: () => Object.keys(athletes).flatMap(a => load(a).map(rec => ({ rec, who: a }))),
    open(id, who) { const rec = load(who).find(r => r.id === id); if (rec) show(rec, who); },
    // One line for the Tréning and História lists.
    summary({ rec, who }) {
      if (rec.pending) return { kind: 'rsi', id: rec.id, who, at: Date.parse(rec.at), title: `${athletes[who]?.name ?? ''} · odrazy`, sub: rec.error ? 'analýza zlyhala' : 'analýza beží…', value: '…', valueSub: '' };
      const b = bestOf(rec), st = (rec.standing ?? []).reduce((x, y) => (!x || y.heightCm > x.heightCm ? y : x), null);
      const name = NAMES[rec.exercise] ?? rec.exercise, leg = rec.leg && rec.leg !== 'both' && rec.leg !== 'lr' ? ` ${LEG[rec.leg] ?? ''}` : '';
      return {
        kind: 'rsi', id: rec.id, who, at: Date.parse(rec.at),
        title: `${athletes[who]?.name ?? ''} · ${name}${leg}${rec.boxCm ? ` ${rec.boxCm} cm` : ''}`,
        sub: b ? `zem ${num((rec.best5?.contactMs ?? b.contactMs) / 1000, 3)} · let ${num(b.flightMs / 1000, 3)}` : st ? `let ${num(st.flightMs / 1000, 3)} s` : '',
        value: b ? num(rec.best5?.rsi ?? b.rsi, 2) : st ? num(st.heightCm, 1) : '–', valueSub: b ? 'RSI' : st ? 'cm' : '',
      };
    },
  };
}
