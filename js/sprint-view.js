// The Sprint tab, top part: film a sprint in the app at 120 fps, or upload one filmed before. If
// Freelap is listening (its card sits right under this one, Stanley 2026-11-13: "tie podstatné
// veci vedľa seba"), every run it hears while filming goes onto the video as a ring timer. The
// camera and the overlay are native (ios/App/App/SprintCamera.swift).
//
// An uploaded clip goes to the server, which finds every contact (server/sprint.mjs); this page
// pairs it with the Freelap run heard while it was filmed and draws the analysis
// (js/analysis/sprint.js). Freelap times stay in the phone.

import { CHIPS } from './freelap/listen.js';
import { cleanLegs } from './freelap/frame.js';
import { analyzeInCloud, cloudReady, CloudError } from './cloud.js';
import { analyzeSprint, pairRun, profileFromRuns, modeOfRun, runMetres } from './analysis/sprint.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n2 = x => (x == null ? '–' : Number(x).toFixed(2).replace('.', ','));
const n1 = x => (x == null ? '–' : Number(x).toFixed(1).replace('.', ','));
const n3 = x => (x == null ? '–' : Number(x).toFixed(3).replace('.', ','));
const when = t => new Date(t).toLocaleString('sk-SK', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
// Own key: 'jump.sprint' already held something else on Stanley's phone, and reading it as
// analyses broke the app at start (r.video undefined, 2026-11-13). Anything malformed is skipped.
const KEY = 'jump.sprint.analyses';
try { // keep the analyses made under the old key, drop whatever else was there
  const old = JSON.parse(localStorage.getItem('jump.sprint') || 'null');
  if (Array.isArray(old) && !localStorage.getItem('jump.sprint.analyses')) localStorage.setItem('jump.sprint.analyses', JSON.stringify(old.filter(r => r?.id && Array.isArray(r.video?.steps))));
} catch { /* storage blocked or not a list */ }
// pending: a run whose video is already saved and watchable while the analysis still runs (0.15.0)
const load = () => { try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v.filter(r => r?.id && (Array.isArray(r.video?.steps) || r.pending)) : []; } catch { return []; } };
const MAX = 60;
const store = v => { try { localStorage.setItem(KEY, JSON.stringify(v.slice(0, MAX))); } catch { /* storage blocked */ } };
const FOOT = { l: 'L', r: 'P' };
const KIND = { accel: 'akcelerácia', fly: 'letmých', rozbeh: 'rozbeh' };
const LATENCY = 0.2; // s from the chip crossing the last cone to the phone hearing it (SprintOverlay, a guess until measured)
const CHIPS_BY_NAME = athletes => Object.fromEntries(Object.entries(athletes).map(([id, a]) => [a.name, id]));

// The app's own camera plugin, through Capacitor's bridge. null in Safari.
function camera(cap = globalThis.Capacitor) {
  if (!cap?.isNativePlatform?.() || !cap.nativePromise || !cap.addListener) return null;
  return {
    open: o => cap.nativePromise('SprintCamera', 'open', o),
    run: r => cap.nativePromise('SprintCamera', 'run', r),
    on: (ev, f) => cap.addListener('SprintCamera', ev, d => d && f(d)),
  };
}

// ---------- Screens ----------
function speedSvg(a, fly) {
  const pts = a.steps.filter(s => s.at != null && s.speed != null);
  if (!pts.length) return '';
  const D = a.distance, top = Math.max(9.5, Math.ceil((fly ?? Math.max(...pts.map(p => p.speed))) + 0.3));
  const X = d => 22 + (d / D) * 262, Y = v => 150 - ((v - 3) / (top - 3)) * 130;
  const line = [[0, 3], ...pts.map(p => [p.at, p.speed])].map(([d, v]) => `${X(Math.max(0, d)).toFixed(1)},${Y(Math.max(3, v)).toFixed(1)}`).join(' ');
  const ticks = Array.from({ length: D / 10 + 1 }, (_, i) => i * 10);
  return `<svg class="sp-curve" viewBox="0 0 300 175" role="img" aria-label="Rýchlosť po krokoch">
    <line x1="22" y1="150" x2="285" y2="150" class="ax"/>
    ${fly ? `<line x1="22" y1="${Y(fly).toFixed(1)}" x2="285" y2="${Y(fly).toFixed(1)}" class="fly"/><text x="284" y="${(Y(fly) - 6).toFixed(1)}" text-anchor="end">letmý ${n2(fly)}</text>` : ''}
    ${ticks.slice(1, -1).map(d => `<line x1="${X(d)}" y1="20" x2="${X(d)}" y2="150" class="grid"/>`).join('')}
    ${[3, 6, 9].filter(v => v <= top).map(v => `<text x="16" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${v}</text>`).join('')}
    <polyline points="${line}" class="ln"/>
    ${pts.map(p => `<circle cx="${X(p.at).toFixed(1)}" cy="${Y(p.speed).toFixed(1)}" r="4"/>`).join('')}
    ${ticks.map((d, i) => `<text x="${X(d)}" y="166" text-anchor="${i === 0 ? 'start' : i === ticks.length - 1 ? 'end' : 'middle'}">${d} m</text>`).join('')}
  </svg>`;
}

// Each step: contact and flight as a bar, then the numbers: time on the ground, in the air, the
// step's frequency (steps per second) and its length (with Freelap only; Stanley, 2026-11-15).
function stepsHtml(a) {
  const scale = 520;
  const metres = a.steps.some(s => s.length != null);
  let lastLeg = 0;
  const rows = a.steps.map((s, i) => {
    let sep = '';
    if (s.leg != null && s.leg > lastLeg) { sep = `<div class="sp-sep">${(lastLeg + 1) * 10} m · Freelap ${n2(a.legs.slice(0, lastLeg + 1).reduce((x, y) => x + y, 0))}</div>`; lastLeg = s.leg; }
    return `${sep}<div class="sp-row"><span class="sp-i">${i + 1}</span><span class="sp-f">${FOOT[s.foot]}</span>
      <span class="sp-bar"><span class="c" style="width:${(s.contact * scale).toFixed(0)}px"></span>${s.flight != null ? `<span class="fl" style="width:${(s.flight * scale).toFixed(0)}px"></span>` : ''}</span>
      <span class="sp-n">${n3(s.contact).replace(/^0/, '')}</span><span class="sp-n">${s.flight != null ? n3(s.flight).replace(/^0/, '') : '–'}</span><span class="sp-n">${s.freq != null ? n2(s.freq) : '–'}</span>${metres ? `<span class="sp-n">${n2(s.length)}</span>` : ''}</div>`;
  }).join('');
  return `<div class="sp-row sp-head"><span class="sp-i">#</span><span class="sp-f"></span><span class="sp-bar"></span><span class="sp-n">zem</span><span class="sp-n">let</span><span class="sp-n">kr/s</span>${metres ? '<span class="sp-n">m</span>' : ''}</div>${rows}`;
}

function sidesHtml(a) {
  const { l, r } = a.sides;
  if (!(l.n >= 2 && r.n >= 2)) return '';
  const df = r.flight - l.flight, dc = r.contact - l.contact;
  const big = Math.abs(df) >= 0.015 ? ['letíš', df] : Math.abs(dc) >= 0.015 ? ['si na zemi', dc] : null;
  const note = big ? `<p class="banner warn">Po ${big[1] > 0 ? 'pravej' : 'ľavej'} ${big[0]} o ${n2(Math.abs(big[1]))} s dlhšie. Zatiaľ ${Math.min(l.n, r.n)} kroky na nohu, over na ďalších behoch.</p>` : '';
  return `<p class="sp-lb">Ľavá vs pravá</p><div class="sp-g2">
    <div class="sp-cd"><p class="sp-lb">Ľavá</p><p>zem <b>${n3(l.contact)}</b><br>let po nej <b>${n3(l.flight)}</b></p></div>
    <div class="sp-cd"><p class="sp-lb">Pravá</p><p>zem <b>${n3(r.contact)}</b><br>let po nej <b>${n3(r.flight)}</b></p></div></div>${note}`;
}

function profileHtml(runs, athletes) {
  const ps = Object.keys(athletes).map(id => [id, profileFromRuns(runs, id)]).filter(([, p]) => p);
  if (!ps.length) return '';
  const maxF = Math.max(...ps.map(([, p]) => p.F0));
  const bars = (k, f) => ps.map(([id, p]) => `<div class="sp-pb"><span>${esc(athletes[id].name)}</span><span class="sp-track"><span style="width:${Math.min(100, f(p)).toFixed(0)}%"></span></span><b>${k(p)}</b></div>`).join('');
  const lines = ps.map(([id, p]) => {
    const gap = p.flyBest ? p.flyBest - p.vmax : null;
    const start = p.F0 === maxF && ps.length > 1 ? 'silnejší štart' : ps.length > 1 ? 'slabší štart' : `štart ${n1(p.F0)} N/kg`;
    const top = gap != null && p.pctOfFly < 97 ? `krivka sa zastaví ${n2(gap)} m/s pod letmým` : 'vrchol zo štartu dosiahne celý';
    return `<p class="banner ok">${esc(athletes[id].name)}: ${start}, ${top}.</p>`;
  }).join('');
  return `<section class="card sp-card"><p class="sp-bar-top"><span>Profil zrýchlenia</span><span>z behov na 30–40 m</span></p><h2>Kde je rezerva</h2>
    <div class="sp-cd"><p class="sp-lb">Sila do zeme na štarte (N/kg)</p>${bars(p => n1(p.F0), p => (100 * p.F0) / (maxF * 1.05))}</div>
    <div class="sp-cd"><p class="sp-lb">Vrchol zo štartu / letmý</p>${bars(p => (p.pctOfFly != null ? `${p.pctOfFly} %` : '–'), p => p.pctOfFly ?? 0)}</div>
    ${lines}</section>`;
}

export function resultHtml(rec, a, run, runs, athletes) {
  const name = esc(athletes[a.who]?.name ?? '');
  const what = run?.type === 'rozbeh' ? `rozbeh${run.steps ? ` ${run.steps} krokov` : ''}` : `${KIND[a.kind]}${a.distance ? ` ${a.distance} m` : ''}`;
  const title = `${name}${name ? ' · ' : ''}${what}`;
  const best = a.kind === 'accel' && run ? Math.min(...runs.filter(r => r.who === a.who && r.legs?.length >= 2 && modeOfRun(r) === 'accel').map(r => r.legs[0])) : null;
  const legCards = (a.legStats ?? []).map((l, i) => `<div class="sp-cd"><p class="sp-lb">${a.kind === 'accel' ? `${i * 10}–${i * 10 + 10} m` : `${i + 1}. desiatka`}</p><p class="sp-big">${n2(l.time)}</p>
    <p class="sp-lb">${a.kind === 'accel' ? `${n1(l.steps)} kroku · ${n2(l.stepLength)} m` : `${n1(l.speed)} m/s · krok ${n2(l.stepLength)} m`}</p></div>`).join('');
  const trio = a.kind === 'fly'
    ? [['Frekvencia', n2(a.freq), 'kroku/s'], ['Na zemi', n3(a.contact), 's'], ['Let', n3(a.flight), 's']]
    : [['Frekvencia', `${n1(a.freqFrom)}→${n1(a.freqTo)}`, 'kroku/s'], ['Na zemi', `${n2(a.contactFrom)}→${n2(a.contactTo)}`, 's'], ['Let', `${n2(a.flightFrom)}→${n2(a.flightTo)}`, 's']];
  let insight = '';
  if (a.kind === 'fly' && a.legStats?.length === 2 && Math.abs(a.legs[0] - a.legs[1]) >= 0.02) {
    const f = a.legs[1] < a.legs[0] ? 1 : 0;
    insight = `<p class="banner ok">${f + 1}. desiatka rýchlejšia dlhším krokom (${n2(a.legStats[f].stepLength)} m), frekvencia rovnaká.</p>`;
  } else if (best != null && Number.isFinite(best) && a.legs[0] - best >= 0.03) {
    insight = `<p class="banner warn">0–10 m o ${n2(a.legs[0] - best)} pomalšie ako najlepší čas (${n2(best)}).</p>`;
  }
  const split = a.kind === 'fly' && a.contact && a.flight ? Math.round((100 * a.contact) / (a.contact + a.flight)) : null;
  const overview = `<section class="card sp-card"><p class="sp-bar-top"><span>Šprint</span><span>${rec.at ? esc(when(rec.at)) : ''}</span></p>
    <h2>${title}</h2>
    <p class="sp-chips">${run ? '' : `<button class="sp-chip" data-sp-kind="${a.kind === 'accel' ? 'fly' : 'accel'}">${a.kind === 'accel' ? 'Akcel' : 'Fly'} ⇄</button>`}${a.legs.length ? `<span class="sp-chip">${a.legs.length} úseky × 10 m</span>` : ''}${a.kind === 'accel' && rec.video.start?.estimated ? '<span class="sp-note">štart z rúk</span>' : ''}</p>
    ${run ? `<div class="sp-g2">${legCards}</div>` : `<p class="banner warn">K videu sa nenašiel čas z Freelapu. Bez neho sú tu len kroky, kontakty a frekvencia.</p>`}
    <div class="sp-g3">${trio.map(([l, v, u]) => `<div class="sp-cd"><p class="sp-lb">${l}</p><p class="sp-mid">${v}</p><p class="sp-lb">${u}</p></div>`).join('')}</div>
    ${split != null ? `<div class="sp-cd"><p class="sp-lb">Jeden krok · ${n3(a.stepTime)} s</p><div class="sp-split"><span style="width:${split}%"></span></div><p class="sp-lb">na zemi ${split} % · vo vzduchu ${100 - split} %</p></div>` : ''}
    ${insight}</section>`;
  const fly = Math.max(0, ...runs.filter(r => r.who === a.who && r.legs?.length >= 2 && modeOfRun(r) === 'fly').map(r => 10 / Math.min(...r.legs))) || null;
  const curve = a.kind === 'accel' && a.curve ? `<section class="card sp-card"><p class="sp-bar-top"><span>Krivka rýchlosti</span><span>m/s</span></p><h2>Ako zrýchľoval${a.who === 'miska' ? 'a' : ''}</h2><p class="sp-lb">bodka = jeden krok</p>
    ${speedSvg(a, fly)}
    <div class="sp-g2"><div class="sp-cd"><p class="sp-lb">Na ${a.distance} m</p><p class="sp-big">${n1(a.curve.at(-1).v)}</p>${fly ? `<p class="sp-lb">${Math.round((100 * a.curve.at(-1).v) / fly)} % letmej</p>` : ''}</div>
    <div class="sp-cd"><p class="sp-lb">Prírastok</p><p class="sp-small">${(() => { const c5 = a.curve.filter(c => c.x % 5 === 0); return [`na ${c5[0].x} m ${n1(c5[0].v)}`, ...c5.slice(1).map((c, i) => `${c5[i].x}–${c.x} m +${n1(c.v - c5[i].v)}`)].join('<br>'); })()}</p></div></div></section>` : '';
  const shorter = a.kind === 'accel' && a.contactFrom && a.contactTo ? `<p class="banner ok">Na zemi čoraz kratšie (${n2(a.contactFrom)} → ${n2(a.contactTo)}), vo vzduchu dlhšie (${n2(a.flightFrom)} → ${n2(a.flightTo)}).</p>` : '';
  // Only steps seen clearly are shown (a far runner from behind gives impossible ones); say so.
  const clear = a.tooFew ? `<p class="banner warn">Vo videu nebolo dosť jasne viditeľných krokov za sebou. Kroky sa merajú najlepšie, keď beží k tebe alebo popri tebe zblízka.</p>`
    : a.dropped > 0 ? `<p class="note">Ukazujem ${a.steps.length} krokov, ktoré bolo vo videu jasne vidieť. Kroky ďaleko a zozadu som vynechal.</p>` : '';
  const few = !a.tooFew && a.steps.length < 5 ? ' Z mála krokov je frekvencia a dĺžka ±4 %.' : '';
  const steps = `<section class="card sp-card"><p class="sp-bar-top"><span>Kroky</span><span>${a.steps.length} krokov${a.distance ? ` do ${a.distance} m` : ''}</span></p><h2>Každý krok</h2>
    ${clear}${a.steps.length ? `<p class="sp-legend"><i class="c"></i>na zemi <i class="fl"></i>let · kr/s frekvencia kroku${a.steps.some(s => s.length != null) ? ' · m dĺžka kroku' : ''}</p>${stepsHtml(a)}` : ''}${shorter}${sidesHtml(a)}
    <p class="sp-lb">${a.kind === 'accel' && a.fit ? 'Dĺžky krokov 1–4 ±0,15 m, od 5. ±0,05 m. ' : ''}Zem a let ±0,01 s.${few}</p></section>`;
  const video = rec.hasClip ? `<section class="card sp-card sp-video"><div class="sp-vbox" data-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div>
    <div class="filt sp-rate"><button data-rate="1" class="on">1×</button><button data-rate="0.5">½×</button><button data-rate="0.25">¼×</button><button data-rate="0.1">⅒×</button></div></section>`
    : '<section class="card sp-card"><p class="note">Video sa k rozboru ukladá od verzie 0.9. Pri starších rozboroch ostalo len vo Fotkách.</p></section>';
  return video + overview + curve + steps + profileHtml(runs, athletes);
}

// The video first, the numbers when they come (Stanley, 2026-11-14: "video si viem pozrieť hneď po
// behu bez overlay"). Shown from the moment the clip is saved until the analysis lands.
function pendingHtml(rec, athletes) {
  const who = athletes[rec.run?.who ?? rec.who]?.name ?? '';
  return `<section class="card sp-card">
      <h2>Šprint${who ? ` · ${esc(who)}` : ''} · ${esc(when(rec.at))}</h2>
      <div class="sp-video pd-video">
        <div class="sp-vbox" data-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div>
        <span class="pd-chip">${rec.error ? '⚠ analýza zlyhala' : '◌ analýza beží'}</span>
      </div>
      <div class="filt sp-rate"><button data-rate="1" class="on">1×</button><button data-rate="0.5">½×</button><button data-rate="0.25">¼×</button><button data-rate="0.1">⅒×</button></div>
      <p class="note">Video si môžeš pozrieť hneď. Kroky, zem a vzduch a rýchlosť sa doplnia, keď analýza dobehne, a všetko sa uloží k behu.</p>
    </section>
    ${rec.run ? `<section class="card"><div class="pd-fl"><div><span>Freelap</span><b>${n2(rec.run.lap)} s</b></div><span>${cleanLegs(rec.run).legs.map(n2).join(' + ')}</span></div></section>` : ''}
    <section class="card" data-pd-prog="${esc(rec.id)}">${pendingSteps(rec)}</section>`;
}
// The analysis steps alone, redrawn in place on every progress tick so the video keeps playing.
function pendingSteps(rec) {
  const st = rec.stage ?? '', up = /nahr/i.test(st);
  const step = (cls, txt, note = '') => `<div class="pd-step ${cls}"><span class="pd-dot">${cls === 'done' ? '✓' : ''}</span>${esc(txt)}${note ? `<small>${esc(note)}</small>` : ''}</div>`;
  return `<h2>Analýza</h2>
      ${step(rec.hasClip ? 'done' : 'now', 'Video uložené v telefóne')}
      ${step(rec.error ? 'next' : up ? 'now' : 'done', 'Nahrávam na server', up ? st : '')}
      ${step(rec.error ? 'next' : up ? 'next' : 'now', 'Hľadám kroky a postavu', !up && st ? st : '')}
      ${step('next', 'Zem, vzduch, rýchlosť')}
      ${rec.error ? `<p class="banner bad">${esc(rec.error)}</p><button class="btn" data-sp-retry="${esc(rec.id)}">Skúsiť znova</button>` : '<p class="note">Môžeš ísť na ďalší beh. Výsledok sa doplní sám.</p>'}`;
}

// ---------- Tab ----------
// bare: the app's Tréning tab owns the buttons and the list; this root then shows only the open
// analysis (the detail screen). onProgress(text) and onDone(rec) report back to it.
export function initSprint({ root, athletes, freelap, getAthlete = () => null, roster = async () => [], cam = camera(), bare = false, onProgress = () => {}, onDone = () => {},
  saveClip = null, loadClip = null, dropClip = null, makePlayer = null }) {
  let unsub = null, last = '', busy = false, progress = '', current = null;
  let clipUrl = null, clipId = null, clipP = null;   // the open analysis's video as an object URL
  let live = null;   // the app's own player on the open clip: { id, player, input }
  const say = t => { progress = t; onProgress(t); };

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip ?? '';
  const send = (_, run) => cam.run({ key: run.key, name: name(run), lap: run.lap, legs: run.legs ?? [] }).catch(() => {});
  const runs = () => freelap?.runs?.() ?? [];

  // Filmed here: the clean clip (no ring over the feet) goes for analysis at once, paired with the
  // run the recorder heard when Freelap was on. One at a time; filming can go on meanwhile.
  const queue = [];
  async function autoAnalyze(d) {
    queue.push(d);
    if (queue.length > 1) return;
    while (queue.length) {
      const job = queue[0];
      try {
        const src = globalThis.Capacitor?.convertFileSrc?.(job.raw) ?? job.raw;
        const blob = await (await fetch(src)).blob();
        const file = new File([blob], 'sprint.mov', { type: 'video/quicktime', lastModified: job.recordedAt ?? Date.now() });
        await upload(file, job);
      } catch (e) { say(`Rozbor natočeného videa zlyhal: ${e?.message ?? e}`); draw(); }
      queue.shift();
    }
  }

  if (cam) {
    cam.on('saved', d => {
      last = d.message ?? ''; draw();
      if (d.mode && d.mode !== 'sprint') return;   // RSI and jump clips have their own flow
      // Runs the camera heard go into the Freelap history too, whether or not the page heard them.
      if (d.freelap !== false && d.times?.length && freelap?.addHeard) {
        for (const t of d.times) freelap.addHeard({ key: t.key, chip: String(t.key).split(':')[0], who: CHIPS_BY_NAME(athletes)[t.name] ?? null, lap: t.lap, legs: t.legs, at: (d.recordedAt ?? Date.now()) + (t.arrived ?? 0) * 1000 });
      }
      if (d.raw && cloudReady()) autoAnalyze(d); // with or without Freelap: without it, steps and contacts only
    });
    cam.on('closed', () => { unsub?.(); unsub = null; draw(); });
  }

  async function film() {
    const on = freelap.listening();
    unsub?.();
    if (on) unsub = freelap.onRun(send);   // runs heard while the camera is open go to it
    // The recorder also hears the chips itself, to time each run exactly; it names them from this.
    const chips = Object.fromEntries(Object.entries(CHIPS).map(([chip, who]) => [chip, athletes[who]?.name ?? chip]));
    try { await cam.open({ fps: 120, freelap: on, chips }); } catch (e) { unsub?.(); unsub = null; alert(`Kameru sa nepodarilo otvoriť: ${e?.message ?? e}`); }
  }

  // One stored analysis, drawn with today's Freelap data (a run picked by hand wins).
  function view(rec) {
    if (rec.pending) return { a: null, run: rec.run ?? null, html: pendingHtml(rec, athletes) };
    const all = runs();
    const run = cleanLegs(rec.runKey ? all.find(r => r.key === rec.runKey) ?? rec.run ?? null : null);
    const who = run?.who ?? rec.who ?? rec.video.who?.id ?? getAthlete()?.id ?? null;
    const a = analyzeSprint(rec.video, run, { mode: run ? null : rec.mode ?? null, who });
    return { a, run, html: resultHtml(rec, a, run, all, athletes) };
  }

  // The run's record exists from the start (pending), with its clip, so the video plays at once.
  const patch = (id, f) => { const l = load(), x = l.find(r => r.id === id); if (x) { f(x); store(l); } return x; };
  async function upload(file, filmed = null, retryId = null) {
    if (busy && !filmed && !retryId) return;
    if (!cloudReady()) { say('Najprv ulož prístupový kľúč v nastaveniach.'); draw(); return; }
    busy = true; say(filmed ? 'Rozoberám natočený šprint…' : 'Nahrávam video…');
    let pid = retryId;
    if (!pid) {
      const heard = filmed?.freelap !== false ? filmed?.times?.[0] : null;
      const run0 = heard ? runs().find(r => r.key === heard.key) ?? cleanLegs({ key: heard.key, lap: heard.lap, legs: heard.legs ?? [], who: CHIPS_BY_NAME(athletes)[heard.name] ?? null }) : null;
      const at = filmed?.recordedAt ?? file.lastModified ?? Date.now();
      // what the recorder heard stays on the record, so a retry pairs the run the same way
      const pend = { id: `sp${Date.now()}`, at, pending: true, stage: 'Nahrávam video', video: null, run: run0, runKey: run0?.key ?? null, who: run0?.who ?? getAthlete()?.id ?? null, mode: null,
        filmed: filmed ? { times: filmed.times ?? null, recordedAt: filmed.recordedAt ?? null, freelap: filmed.freelap !== false } : null };
      const l = load(); l.unshift(pend);
      for (const old of l.slice(MAX)) if (old.hasClip) dropClip?.(old.id);
      store(l.slice(0, MAX));
      pid = pend.id;
      if (saveClip) saveClip(pid, file).then(() => { patch(pid, x => { x.hasClip = true; }); if (current === pid) draw(); }).catch(() => {});
      current = pid;
      onDone(pend);   // opens the run's screen now: the video first
    } else patch(pid, x => { x.error = null; x.stage = 'Nahrávam video'; });
    draw();
    let lastStage = '', lastSave = 0;
    const x0 = load().find(r => r.id === pid);
    try {
      const me = getAthlete() ?? {};
      const { result } = await analyzeInCloud(file, {
        sex: me.sex, name: me.name, height: me.height, mode: 'sprint', athletes: await roster(),
        clip: pid, onJob: jobId => patch(pid, x => { x.jobId = jobId; }),
        onProgress: p => {
          const t = `${p.stage}${p.total > 1 ? ` ${Math.round((100 * p.done) / p.total)} %` : ''}…`;
          if (t === lastStage) return;
          lastStage = t; onProgress(t);
          const now = Date.now();
          const x = now - lastSave > 1000 ? (lastSave = now, patch(pid, r => { r.stage = t; })) : Object.assign(load().find(r => r.id === pid) ?? {}, { stage: t });
          // only the steps are redrawn: a full draw() would rebuild the <video> and restart it
          const box = current === pid && root.querySelector(`[data-pd-prog="${CSS.escape(pid)}"]`);
          if (box && x) box.innerHTML = pendingSteps({ ...x, stage: t });
        },
      });
      if (result?.error) throw new CloudError(result.error);
      const video = { steps: result.steps, start: result.start, modeGuess: result.modeGuess, recordedAt: filmed?.recordedAt ?? result.recordedAt ?? file.lastModified ?? null, duration: result.duration, fps: result.fps, who: result.who ?? null };
      let run = null;
      if (filmed && filmed.freelap === false) run = null;   // Freelap was off: no times, none paired later
      else if (filmed?.times?.length) {
        // the run the recorder heard: the athlete's own when two ran, else the first
        const who = result.who?.id, heard = filmed.times;
        const t = heard.find(x => who && CHIPS_BY_NAME(athletes)[x.name] === who) ?? heard[0];
        video.finishAt = +(t.arrived - LATENCY).toFixed(3);
        run = runs().find(r => r.key === t.key) ?? cleanLegs({ key: t.key, lap: t.lap, legs: t.legs, who: CHIPS_BY_NAME(athletes)[t.name] ?? who ?? null, at: video.recordedAt + t.arrived * 1000 });
      } else run = pairRun(runs(), video, null);
      // the pending record becomes the analysis; its clip is already stored under the same id
      const off = filmed?.freelap === false || x0?.filmed?.freelap === false;
      const rec = patch(pid, x => Object.assign(x, { at: video.recordedAt ?? x.at, video, runKey: off ? null : run?.key ?? x.runKey ?? null, run: off ? null : run ?? x.run ?? null, noFreelap: off || undefined, jobId: undefined, who: run?.who ?? x.run?.who ?? result.who?.id ?? me.id ?? null, pending: false, stage: null, error: null, filmed: null }));
      say('');
      // the screen was opened when the run was filmed: only refresh the lists now, no jump
      if (rec) onDone(rec, { quiet: true });
    } catch (err) {
      const msg = err?.message || 'Analýza zlyhala. Skús to znova.';
      say(msg); patch(pid, x => { x.error = msg; });
    } finally {
      busy = false; draw();
    }
  }

  function draw() {
    const list = load(), rec = list.find(r => r.id === current);
    if (bare) { root.innerHTML = rec ? view(rec).html : ''; attachClip(rec); return; }
    const head = `
      <div class="card sp-go">
        <div class="sp-btns">
          ${cam ? '<button class="btn go primary" data-sp="film">Natáčať šprint</button>' : ''}
          <label class="btn go${busy ? ' disabled' : ''}">Nahrať video<input type="file" accept="video/*" hidden data-sp="file"></label>
        </div>
        <p class="note">${cam ? '120 snímok za sekundu, uloží sa do Fotiek. Keď Freelap nižšie počúva, vo videu bežia stopky. ' : ''}Nahraté video rozoberiem po krokoch: kontakt, let, frekvencia, a s časom z Freelapu aj dĺžka kroku a rýchlosť.</p>
        ${progress ? `<p class="note" aria-live="polite">${esc(progress)}</p>` : ''}
        ${last ? `<p class="sp-last">${esc(last)}</p>` : ''}
      </div>`;
    const body = rec ? view(rec).html : '';
    const past = list.length ? `<div class="card"><h2>Rozbory</h2><ul class="sp-list">${list.map(r => {
      const who = athletes[r.run?.who ?? r.who]?.name ?? '';
      const k = r.pending ? null : r.mode ?? (r.run ? modeOfRun(r.run) : r.video.modeGuess);
      if (r.pending) return `<li><button class="sp-item${r.id === current ? ' on' : ''}" data-sp-open="${esc(r.id)}"><b>${esc(who)} · šprint · ${r.error ? 'analýza zlyhala' : 'analýza beží…'}</b><small>${esc(when(r.at))}</small></button></li>`;
      return `<li><button class="sp-item${r.id === current ? ' on' : ''}" data-sp-open="${esc(r.id)}"><b>${esc(who)} · ${KIND[k]}${r.run ? `${runMetres(cleanLegs(r.run)) ? ` ${runMetres(cleanLegs(r.run))} m` : ''} · ${n2(r.run.lap)}` : ''}</b><small>${esc(when(r.at))}</small></button></li>`;
    }).join('')}</ul></div>` : '';
    root.innerHTML = head + body + past;
    attachClip(rec);
  }

  // The app's own player (the jumps' one: decodes the clip itself) where it is there: a plain
  // <video> showed a struck-out play button on the phone (2026-11-15, RSI); same storage here.
  async function attachClip(rec) {
    const box = root.querySelector('[data-clip]');
    if (!rec?.hasClip || !box || !loadClip) return;
    if (makePlayer) {
      if (live?.id === rec.id && live.root === box) return;
      live?.player?.dispose?.(); live?.input?.dispose?.();
      const mine = { id: rec.id, root: box }; live = mine;
      const blob = await loadClip(rec.id).catch(() => null);
      if (live !== mine || !box.isConnected) return;
      if (!blob) { box.innerHTML = '<p class="note">Video sa nenašlo v telefóne.</p>'; return; }
      try {
        box.innerHTML = ''; box.classList.add('player');
        const made = await makePlayer(box, blob);
        if (live !== mine || !box.isConnected) { made.player?.dispose?.(); made.input?.dispose?.(); return; }
        Object.assign(mine, made);
        box.closest('section')?.querySelector('.sp-rate')?.classList.add('hidden');   // the player has its own speeds
        return;
      } catch (e) { console.warn('Sprint clip: own player failed', e); box.classList.remove('player'); }
    }
    if (clipId !== rec.id) {
      if (clipUrl) URL.revokeObjectURL(clipUrl);
      clipUrl = null; clipId = rec.id;
      clipP = loadClip(rec.id).catch(() => null).then(blob => {
        if (clipId === rec.id) clipUrl = blob ? URL.createObjectURL(blob) : null;
      });
    }
    await clipP;
    if (clipId !== rec.id) return;
    const now = root.querySelector(`[data-clip="${CSS.escape(rec.id)}"]`);
    if (!now) return;
    now.innerHTML = clipUrl ? `<video src="${clipUrl}" controls playsinline muted preload="metadata"></video>` : '<p class="note">Video sa nenašlo v telefóne.</p>';
  }

  root.addEventListener('click', e => {
    if (e.target.closest('[data-sp="film"]')) return film();
    const rt = e.target.closest('[data-rate]');
    if (rt) {
      const v = root.querySelector('.sp-vbox video');
      if (v) { v.playbackRate = +rt.dataset.rate; v.defaultPlaybackRate = +rt.dataset.rate; }
      root.querySelectorAll('[data-rate]').forEach(x => x.classList.toggle('on', x === rt));
      return;
    }
    const o = e.target.closest('[data-sp-open]');
    if (o) { current = o.dataset.spOpen === current ? null : o.dataset.spOpen; draw(); root.scrollIntoView?.({ behavior: 'smooth' }); return; }
    const rt2 = e.target.closest('[data-sp-retry]');
    if (rt2 && loadClip) {
      retry(rt2.dataset.spRetry).then(ok => { if (!ok) alert('Video sa v telefóne nenašlo.'); });
      return;
    }
    const k = e.target.closest('[data-sp-kind]');
    if (k && current) { const list = load(), r = list.find(x => x.id === current); if (r) { r.mode = k.dataset.spKind; store(list); draw(); } }
  });
  root.addEventListener('change', e => {
    if (e.target.matches('[data-sp="file"]')) { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }
  });

  // localhost only: lets a developer render a stored result without a server run
  if (['localhost', '127.0.0.1'].includes(globalThis.location?.hostname)) globalThis.__sprintShow = rec => { const list = load(); list.unshift(rec); store(list); current = rec.id; draw(); };

  // A run left pending by a reloaded app picks up where it was (2026-11-15: three runs were left
  // as "zlyhala" though the server had one of them done): the clip is in the phone and the server
  // finds a job it already made from it, so this only uploads what never arrived.
  function retry(id) {
    const r0 = load().find(r => r.id === id);
    if (!r0 || !loadClip) return Promise.resolve(false);
    return loadClip(id).then(blob => {
      if (!blob) return false;
      return upload(new File([blob], 'sprint.mov', { type: blob.type || 'video/quicktime', lastModified: r0.at ?? Date.now() }), r0.filmed ?? null, id).then(() => true);
    }).catch(() => false);
  }
  async function resumeAll() {
    // twice at most by itself: a clip the server can't read must not go up on every start
    const ids = load().filter(r => r.pending && r.hasClip && (r.tries ?? 0) < 2).map(r => r.id);
    for (const id of ids) {
      patch(id, x => { x.error = null; x.stage = 'Pokračujem v analýze'; x.tries = (x.tries ?? 0) + 1; });
      if (!(await retry(id))) patch(id, x => { x.error = 'Video sa v telefóne nenašlo.'; });
    }
  }
  if (cloudReady()) setTimeout(resumeAll, 1500); else { const l = load(); let ch = false; for (const r of l) if (r.pending && !r.error) { r.error = 'Analýza sa prerušila. Video je uložené, skús znova.'; ch = true; } if (ch) store(l); }
  draw();
  return {
    shown: draw, film, upload, records: load,
    open(id) { current = id; draw(); },
    busy: () => busy,
    // One line for the Tréning and História lists.
    summary(rec) {
      if (rec.pending) {
        const who = rec.run?.who ?? rec.who ?? null;
        return { kind: 'sprint', id: rec.id, at: rec.at, who, title: `${athletes[who]?.name ?? ''}${who ? ' · ' : ''}šprint`, sub: rec.error ? 'analýza zlyhala' : 'analýza beží…', value: rec.run ? n2(rec.run.lap) : '…', valueSub: rec.run ? 's' : '' };
      }
      const run = cleanLegs(rec.runKey ? runs().find(r => r.key === rec.runKey) ?? rec.run ?? null : rec.run ?? null);
      const who = run?.who ?? rec.who ?? null, k = rec.mode ?? (run ? modeOfRun(run) : rec.video.modeGuess);
      const steps = rec.video.steps ?? [];
      const contact = steps.length ? steps.reduce((a, x) => a + (x.contact ?? 0), 0) / steps.length : null;
      return {
        kind: 'sprint', id: rec.id, at: rec.at, who,
        title: `${athletes[who]?.name ?? ''}${who ? ' · ' : ''}${k === 'rozbeh' ? `rozbeh${run?.steps ? ` ${run.steps} kr.` : ''}` : `${k === 'accel' ? 'akcel' : 'letmých'}${runMetres(run) ? ` ${runMetres(run)} m` : ''}`}`,
        sub: run ? (run.legs.length > 1 ? run.legs.map(n2).join(' + ') : 'Freelap') : `zem ${contact != null ? n3(contact) : '–'} s · bez Freelapu`,
        value: run ? n2(run.lap) : `${steps.length}`, valueSub: run ? 's' : 'krokov',
      };
    },
  };
}
