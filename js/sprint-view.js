// The Sprint tab, top part: film a sprint in the app at 120 fps, or upload one filmed before. If
// Freelap is listening (its card sits right under this one, Stanley 2026-11-13: "tie podstatné
// veci vedľa seba"), every run it hears while filming goes onto the video as a ring timer. The
// camera and the overlay are native (ios/App/App/SprintCamera.swift).
//
// An uploaded clip goes to the server, which finds every contact (server/sprint.mjs); this page
// pairs it with the Freelap run heard while it was filmed and draws the analysis
// (js/analysis/sprint.js). Freelap times stay in the phone.

import { withPath, trimRange } from './viewcopy.js';
import { CHIPS } from './freelap/listen.js';
import { cleanLegs } from './freelap/frame.js';
import { legsFormHtml, readLegs } from './freelap-view.js';
import { sprintTimeline, hudOverlay } from './hud.js';
import { burnAndSave } from './burn.js';
import { sprintAdvice, runSummary } from './analysis/sprint-advice.js';
import { analyzeInCloud, cloudReady, CloudError, warmCloud } from './cloud.js';
import { analyzeSprint, pairRun, modeOfRun, runMetres, cleanSteps, SPRINT_ALGO } from './analysis/sprint.js';

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
// the cut around the Freelap stretch: before the start (a standing start's first move and the
// hearing's delay, which is a guess) and after the finish
const CUT_BEFORE = 0.8, CUT_AFTER = 0.5;
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
      <span class="sp-n">${s.estContact ? '–' : n3(s.contact).replace(/^0/, '')}</span><span class="sp-n">${s.flight != null && !s.estFlight ? n3(s.flight).replace(/^0/, '') : '–'}</span><span class="sp-n">${s.freq != null ? n2(s.freq) : '–'}</span>${metres ? `<span class="sp-n">${n2(s.length)}</span>` : ''}</div>`;
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

// the athlete's best Freelap 0-10 m from a standing start (the card and the chat use the same one)
const bestFirst10Of = (a, run, runs) => (a.kind === 'accel' && run ? Math.min(...runs.filter(r => r.who === a.who && r.legs?.length >= 2 && modeOfRun(r) === 'accel').map(r => r.legs[0])) : null);

export function resultHtml(rec, a, run, runs, athletes, { extra = 0, others = [], canAsk = false } = {}) {
  const name = esc(athletes[a.who]?.name ?? '');
  const what = run?.type === 'rozbeh' ? `rozbeh${run.steps ? ` ${run.steps} krokov` : ''}` : `${KIND[a.kind]}${a.distance ? ` ${a.distance} m` : ''}`;
  const title = `${name}${name ? ' · ' : ''}${what}`;
  const best = bestFirst10Of(a, run, runs);
  // Each 10 m: its Freelap time and speed, and its steps only where the video measured them.
  const legCards = (a.legStats ?? []).map((l, i) => `<div class="sp-cd"><p class="sp-lb">${a.kind === 'accel' ? `${i * 10}–${i * 10 + 10} m` : `${i + 1}. desiatka`}</p><p class="sp-big">${n2(l.time)}</p>
    <p class="sp-lb">${n1(l.speed)} m/s${l.stepLength != null ? ` · krok ${n2(l.stepLength)} m` : ''}${a.kind !== 'accel' && l.freq != null ? ` · ${n2(l.freq)} kr/s` : ''}${a.kind === 'accel' && l.steps && l.stepLength != null ? ` · ${n1(l.steps)} kroku` : ''}</p></div>`).join('');
  const trio = a.kind === 'fly'
    ? [['Frekvencia', n2(a.freq), 'kroku/s'], ['Na zemi', n3(a.contact), 's'], ['Let', n3(a.flight), 's']]
    : [['Frekvencia', `${n1(a.freqFrom)}→${n1(a.freqTo)}`, 'kroku/s'], ['Na zemi', `${n2(a.contactFrom)}→${n2(a.contactTo)}`, 's'], ['Let', `${n2(a.flightFrom)}→${n2(a.flightTo)}`, 's']];
  let insight = '';
  const L = a.legStats ?? [];
  if (a.kind === 'fly' && a.perLeg && L.length === 2 && L.every(l => l.stepLength != null && l.freq != null) && Math.abs(a.legs[0] - a.legs[1]) >= 0.02) {
    // which of the two made the faster 10 m: the longer step or the quicker one, as measured
    const f = a.legs[1] < a.legs[0] ? 1 : 0, o = 1 - f;
    const dl = L[f].stepLength - L[o].stepLength, df = L[f].freq - L[o].freq;
    const why = Math.abs(dl / L[o].stepLength) >= Math.abs(df / L[o].freq) ? `dlhším krokom (${n2(L[f].stepLength)} m)` : `rýchlejšou frekvenciou (${n2(L[f].freq)} kr/s)`;
    insight = `<p class="banner ok">${f + 1}. desiatka rýchlejšia ${why}.</p>`;
  } else if (best != null && Number.isFinite(best) && a.legs[0] - best >= 0.03) {
    insight = `<p class="banner warn">0–10 m o ${n2(a.legs[0] - best)} pomalšie ako najlepší čas (${n2(best)}).</p>`;
  }
  // advice: how it looks, how it should look, one cue (sprint-advice.js); it says what the banner said
  const adv = sprintAdvice(a, { others, bestFirst10: Number.isFinite(best) ? best : null });
  if (adv?.fix) insight = '';
  const adviceHtml = adv ? `<section class="card coach sp-advice">
      <p class="take">${esc(adv.take)}</p>
      ${adv.strength ? `<div class="strength"><span>Silná stránka</span><p>${esc(adv.strength)}</p></div>` : ''}
      ${adv.fix ? `<article class="fix first"><div class="fix-tag">Na ďalší beh</div><p class="cue-say">„${esc(adv.fix.cue)}“</p><h3>${esc(adv.fix.title)}</h3>
        <p class="sp-lb">Ako to vyzerá</p><p>${esc(adv.fix.looks)}</p><p class="sp-lb">Malo by to byť skôr tak</p><p>${esc(adv.fix.should)}</p>
        <details><summary>Prečo</summary><p>${esc(adv.fix.why)}</p></details></article>` : '<p class="note">Rovnomerný beh. Na ďalší beh nič nemeň.</p>'}
    </section>
    ${adv.then.length ? `<section class="card coach"><h2>Potom</h2>${adv.then.map(t => `<article class="fix"><h3>${esc(t.title)}</h3><p>${esc(t.body)}</p></article>`).join('')}</section>` : ''}` : '';
  const ask = canAsk ? `<button class="btn primary sp-ask" data-sp-ask="${esc(rec.id)}">Opýtaj sa na tento beh</button>` : '';
  const split = a.kind === 'fly' && a.contact && a.flight ? Math.round((100 * a.contact) / (a.contact + a.flight)) : null;
  const overview = `<section class="card sp-card"><p class="sp-bar-top"><span>Šprint</span><span>${rec.at ? esc(when(rec.at)) : ''}</span></p>
    <h2>${title}</h2>
    <p class="sp-chips">${run ? '' : `<button class="sp-chip" data-sp-kind="${a.kind === 'accel' ? 'fly' : 'accel'}">${a.kind === 'accel' ? 'Akcel' : 'Fly'} ⇄</button>`}${a.legs.length ? `<span class="sp-chip">${a.legs.length} úseky × 10 m</span>` : ''}${a.kind === 'accel' && rec.video.start?.estimated ? '<span class="sp-note">štart z rúk</span>' : ''}</p>
    ${run ? `<div class="sp-g2">${legCards}</div>` : `<p class="banner warn">K videu sa nenašiel čas z Freelapu. Bez neho sú tu len kroky, kontakty a frekvencia.</p>
    ${legsFormHtml([], { extra, attr: 'data-sl', title: 'Doplň časy z Freelapu, úseky po 10 m' })}`}
    <div class="sp-g3">${trio.map(([l, v, u]) => `<div class="sp-cd"><p class="sp-lb">${l}</p><p class="sp-mid">${v}</p><p class="sp-lb">${u}</p></div>`).join('')}</div>
    ${split != null ? `<div class="sp-cd"><p class="sp-lb">Jeden krok · ${n3(a.stepTime)} s</p><div class="sp-split"><span style="width:${split}%"></span></div><p class="sp-lb">na zemi ${split} % · vo vzduchu ${100 - split} %</p></div>` : ''}
    ${insight}</section>`;
  const shorter = a.kind === 'accel' && a.contactFrom && a.contactTo ? `<p class="banner ok">Na zemi čoraz kratšie (${n2(a.contactFrom)} → ${n2(a.contactTo)}), vo vzduchu dlhšie (${n2(a.flightFrom)} → ${n2(a.flightTo)}).</p>` : '';
  // Only steps seen clearly are shown (a far runner from behind gives impossible ones); say so.
  // Only the measured stretch (2026-11-18: "nikdy nemeriame nábeh"); no advice on how to film. The start
  // and every step are always in the picture (Stanley, same day): steps not found are the analysis's fault.
  const timedZone = a.zoneFrom === 'freelap' || (a.kind === 'accel' && run?.lap && (rec.video.start || a.zeroFromFinish != null));
  const clear = a.tooFew ? `<p class="banner warn">${timedZone ? 'Appka v úseku Freelapu nenašla dosť krokov za sebou.' : 'Appka vo videu nenašla dosť krokov za sebou.'} Video je v poriadku, je to chyba rozboru.</p>`
    : timedZone ? `<p class="note">${a.kind === 'accel' ? 'Len kroky od štartu po cieľ Freelapu.' : 'Len kroky v úseku Freelapu, rozbeh pred ním sa nemeria.'}</p>`
    : a.kind === 'fly' ? `<p class="note">Bez času cieľa z Freelapu neviem, kde úsek začal. Ukazujem rovnomerné kroky pred spomalením.</p>` : '';
  const few = !a.tooFew && a.steps.length < 5 ? ' Z mála krokov je frekvencia a dĺžka ±4 %.' : '';
  const outside = a.kind === 'fly' && a.steps.length && a.legs.length && !a.measured
    ? `<p class="note">Kroky vo videu nie sú z úseku, ktorý meral Freelap, preto bez dĺžky kroku.</p>` : '';
  const steps = `<section class="card sp-card"><p class="sp-bar-top"><span>Kroky</span><span>${a.steps.length} krokov${a.distance ? ` do ${a.distance} m` : ''}</span></p><h2>Každý krok</h2>
    ${clear}${outside}${a.steps.length ? `<p class="sp-legend"><i class="c"></i>na zemi <i class="fl"></i>let · kr/s frekvencia kroku${a.steps.some(s => s.length != null) ? ' · m dĺžka kroku' : ''}</p>${stepsHtml(a)}` : ''}${shorter}${sidesHtml(a)}
    <p class="sp-lb">${a.kind === 'accel' && a.fit ? 'Dĺžky krokov 1–4 ±0,15 m, od 5. ±0,05 m. ' : ''}Zem a let ±0,01 s. Frekvencia a dĺžka jedného kroku ±5 %, za desiatku presnejšie.${few}</p></section>`;
  const video = rec.hasClip ? `<section class="card sp-card sp-video"><div class="sp-vbox" data-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div>
    <div class="filt sp-rate"><button data-rate="1" class="on">1×</button><button data-rate="0.5">½×</button><button data-rate="0.25">¼×</button><button data-rate="0.1">⅒×</button></div></section>`
    : '<section class="card sp-card"><p class="note">Video sa k rozboru ukladá od verzie 0.9. Pri starších rozboroch ostalo len vo Fotkách.</p></section>';
  // Only what is measured (Stanley, 2026-11-15): the modelled speed curve and acceleration profile
  // are left out.
  return video + overview + adviceHtml + ask + steps;
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


// Two taps to delete, like the jumps (Stanley 2026-11-16: "mal by som byť schopný zmazať hociakú analýzu").
const armed = new WeakMap();
function armOrGo(btn) {
  if (armed.has(btn)) { clearTimeout(armed.get(btn)); armed.delete(btn); return true; }
  const label = btn.textContent;
  btn.textContent = 'Naozaj?'; btn.classList.add('armed');
  armed.set(btn, setTimeout(() => { armed.delete(btn); btn.textContent = label; btn.classList.remove('armed'); }, 3000));
  return false;
}

// ---------- Tab ----------
// bare: the app's Tréning tab owns the buttons and the list; this root then shows only the open
// analysis (the detail screen). onProgress(text) and onDone(rec) report back to it.
export function initSprint({ root, athletes, freelap, getAthlete = () => null, roster = async () => [], cam = camera(), bare = false, onProgress = () => {}, onDone = () => {},
  saveClip = null, loadClip = null, dropClip = null, makePlayer = null, onAsk = null, onDeleted = () => {} }) {
  let unsub = null, last = '', busy = 0, progress = '', current = null;   // busy: uploads running
  let clipUrl = null, clipId = null, clipP = null;   // the open analysis's video as an object URL
  let live = null;   // the app's own player on the open clip: { id, player, input }
  let slExtra = 0;   // extra empty 10 m fields in the "doplň časy" form
  const inFlight = new Set();   // records uploading now: a second tap on "Skúsiť znova" does nothing
  const say = t => { progress = t; onProgress(t); };

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip ?? '';
  const send = (_, run) => cam.run({ key: run.key, name: name(run), lap: run.lap, legs: run.legs ?? [] }).catch(() => {});
  const runs = () => freelap?.runs?.() ?? [];

  // Filmed here: the clean clip (no ring over the feet) goes for analysis at once, paired with the
  // run the recorder heard when Freelap was on. One at a time; filming can go on meanwhile.
  // Uploads go one at a time, but the next one starts as soon as the last is on the server, not
  // when its analysis ends (2026-11-15: a run waited up to 5 minutes behind the one before).
  const queue = [], started = new Set();
  const cutWindow = d => {
    const heard = d.freelap !== false ? (d.times ?? []).filter(t => t.arrived != null && t.lap > 0) : [];
    if (!heard.length) return null;
    const from = Math.min(...heard.map(t => t.arrived - LATENCY - t.lap)) - CUT_BEFORE;
    const to = Math.max(...heard.map(t => t.arrived - LATENCY)) + CUT_AFTER;
    return to > from ? { from: Math.max(0, from), to } : null;
  };
  async function autoAnalyze(d) {
    if (started.has(d.raw)) return;
    started.add(d.raw);
    queue.push(d);
    if (queue.length > 1) return;
    while (queue.length) {
      const job = queue[0];
      try {
        const src = globalThis.Capacitor?.convertFileSrc?.(job.raw) ?? job.raw;
        const blob = await (await fetch(src)).blob();
        let file = withPath(new File([blob], 'sprint.mov', { type: 'video/quicktime', lastModified: job.recordedAt ?? Date.now() }), job.raw);
        // Only the Freelap stretch goes to the server when the run was heard before Stop (2026-11-18,
        // Stanley: "orezanie videa predtým ako ide na server"): from the start, which is the finish
        // heard minus the lap, to just after the finish, with room for the hearing's delay and a
        // standing start's first move. A 13 s clip becomes 2-4 s. Heard later or not at all: whole.
        const cut = cutWindow(job);
        if (cut) {
          const t = await trimRange(job.raw, cut.from, cut.to);
          if (t) { file = t.file; job.cut = t.from; }
        }
        let onServer;
        const sent = new Promise(res => { onServer = res; });
        const done = upload(file, job, null, onServer);
        await Promise.race([sent, done]);
      } catch (e) { say(`Rozbor natočeného videa zlyhal: ${e?.message ?? e}`); draw(); }
      queue.shift();
    }
  }
  // The times the camera heard, when they come after the upload began: onto the waiting record.
  // Also when the analysis already finished (a long clip's save to Photos can outlast it): then the
  // run and the finish go straight onto the analysis.
  function timesHeard(d) {
    const l = load(), x = l.find(r => d.raw && (r.raw === d.raw || r.filmed?.raw === d.raw));
    if (!x || !d.times?.length || d.freelap === false) return;
    const t = d.times.find(y => CHIPS_BY_NAME(athletes)[y.name] === (x.video?.who?.id ?? x.who)) ?? d.times[0];
    if (x.pending || x.filmed) x.filmed = { ...(x.filmed ?? {}), times: d.times, freelap: true, raw: d.raw };
    if (!x.run) {
      x.run = runs().find(r => r.key === t.key) ?? cleanLegs({ key: t.key, lap: t.lap, legs: t.legs ?? [], who: CHIPS_BY_NAME(athletes)[t.name] ?? null });
      x.runKey = x.run.key; x.who = x.run.who ?? x.who;
    }
    if (!x.pending && x.video && x.video.finishAt == null && t.arrived != null) x.video.finishAt = +(t.arrived - LATENCY - (x.cut ?? 0)).toFixed(3);
    store(l);
    if (current === x.id) draw();
  }

  if (cam) {
    cam.on('saved', d => {
      last = d.message ?? ''; draw();
      if (d.mode && d.mode !== 'sprint') return;   // RSI and jump clips have their own flow
      // Runs the camera heard go into the Freelap history too, whether or not the page heard them.
      if (d.freelap !== false && d.times?.length && freelap?.addHeard) {
        for (const t of d.times) freelap.addHeard({ key: t.key, chip: String(t.key).split(':')[0], who: CHIPS_BY_NAME(athletes)[t.name] ?? null, lap: t.lap, legs: t.legs, raw: t.raw ?? null, at: (d.recordedAt ?? Date.now()) + (t.arrived ?? 0) * 1000 });
      }
      if (d.raw && cloudReady()) { timesHeard(d); autoAnalyze(d); } // with or without Freelap: without it, steps and contacts only
    });
    // Sprint: the clip as filmed, at Stop: the upload starts before the save to Photos.
    cam.on('recorded', d => { if (d.mode === 'sprint' && d.raw && cloudReady()) autoAnalyze(d); });
    cam.on('closed', () => { unsub?.(); unsub = null; draw(); });
  }

  async function film() {
    const on = freelap.listening();
    unsub?.();
    if (on) unsub = freelap.onRun(send);   // runs heard while the camera is open go to it
    // The recorder also hears the chips itself, to time each run exactly; it names them from this.
    const chips = Object.fromEntries(Object.entries(CHIPS).map(([chip, who]) => [chip, athletes[who]?.name ?? chip]));
    if (cloudReady()) warmCloud();   // the server starts while the athlete runs (2026-11-18)
    try { await cam.open({ fps: 120, freelap: on, chips }); } catch (e) { unsub?.(); unsub = null; alert(`Kameru sa nepodarilo otvoriť: ${e?.message ?? e}`); }
  }

  // One stored analysis, drawn with today's Freelap data (a run picked by hand wins).
  function view(rec) {
    if (rec.pending) return { a: null, run: rec.run ?? null, html: pendingHtml(rec, athletes) };
    const all = runs();
    const run = cleanLegs(rec.runKey ? all.find(r => r.key === rec.runKey) ?? rec.run ?? null : null);
    const who = run?.who ?? rec.who ?? rec.video.who?.id ?? getAthlete()?.id ?? null;
    const a = analyzeSprint(rec.video, run, { mode: run ? null : rec.mode ?? null, who, height: athletes[who]?.height ?? null });
    return { a, run, html: resultHtml(rec, a, run, all, athletes, { extra: slExtra, others: othersOf(rec, who), canAsk: !!onAsk && cloudReady() }) };
  }

  // The athlete's earlier runs, as the advice compares them (their own usual contact, foot, sides).
  function othersOf(rec, who) {
    const all = runs();
    return load().filter(r => r.id !== rec.id && !r.pending && r.video?.steps && (r.who ?? r.run?.who) === who).slice(0, 12).map(r => {
      const run = cleanLegs(r.runKey ? all.find(x => x.key === r.runKey) ?? r.run ?? null : null);
      try { return runSummary(analyzeSprint(r.video, run, { who, height: athletes[who]?.height ?? null })); } catch { return null; }
    }).filter(Boolean);
  }
  // for the chat: the analysis on screen, as numbers
  function contextOf(id) {
    const rec = load().find(r => r.id === id);
    if (!rec || rec.pending) return null;
    const { a, run } = view(rec), who = run?.who ?? rec.who ?? rec.video?.who?.id ?? null;
    const best = bestFirst10Of(a, run, runs());
    const adv = sprintAdvice(a, { others: othersOf(rec, who), bestFirst10: Number.isFinite(best) ? best : null });
    return { rec, who, ctx: {
      athlete: athletes[who]?.name ?? null, sex: athletes[who]?.sex ?? null, heightCm: athletes[who]?.height ?? null,
      recordedAt: rec.at ? new Date(rec.at).toISOString() : null, kind: a.kind, distanceM: a.distance,
      freelap: run ? { lap: run.lap, legs: run.legs } : null,
      tens: (a.legStats ?? []).map((l, k) => ({ m: `${k * 10}-${k * 10 + 10}`, time: l.time, speed: l.speed, stepLength: l.stepLength, freq: l.freq, steps: l.steps,
        footInFrontCm: a.kind === 'fly' && a.looks?.legs?.[k]?.timed ? a.looks.legs[k].aheadCm : null,
        shinAtTouchdownDeg: a.looks?.legs?.[k]?.shin ?? null, trunkLeanDeg: a.looks?.legs?.[k]?.trunk ?? null })),
      phase: a.kind === 'fly' ? 'maximálna rýchlosť' : 'akcelerácia z miesta a prechod',
      bestFirst10: Number.isFinite(best) ? best : null,
      run: { freq: a.freq ?? null, contact: a.contact ?? null, flight: a.flight ?? null, stepTime: a.stepTime ?? null, contactFromTo: a.contactFrom != null ? [a.contactFrom, a.contactTo] : null },
      looks: a.looks?.all ?? null, sides: a.sides ?? null,
      steps: (a.steps ?? []).map(s => ({ foot: s.foot, contact: s.contact, flight: s.flight, freq: s.freq ?? null, length: s.length ?? null })),
      advice: adv ? { take: adv.take, strength: adv.strength, cue: adv.fix?.cue ?? null, looks: adv.fix?.looks ?? null, should: adv.fix?.should ?? null } : null,
      earlierRuns: othersOf(rec, who).slice(0, 6),
    } };
  }

  // The run's record exists from the start (pending), with its clip, so the video plays at once.
  const patch = (id, f) => { const l = load(), x = l.find(r => r.id === id); if (x) { f(x); store(l); } return x; };
  async function upload(file, filmed = null, retryId = null, onServer = null, fresh = false, quiet = false) {
    if (busy > 0 && !filmed && !retryId) return;
    if (retryId && inFlight.has(retryId)) return;
    if (!cloudReady()) { say('Najprv ulož prístupový kľúč v nastaveniach.'); draw(); return; }
    busy++; say(filmed ? 'Rozoberám natočený šprint…' : 'Nahrávam video…');
    let pid = retryId;
    if (!pid) {
      const heard = filmed?.freelap !== false ? filmed?.times?.[0] : null;
      const run0 = heard ? runs().find(r => r.key === heard.key) ?? cleanLegs({ key: heard.key, lap: heard.lap, legs: heard.legs ?? [], who: CHIPS_BY_NAME(athletes)[heard.name] ?? null }) : null;
      const at = filmed?.recordedAt ?? file.lastModified ?? Date.now();
      // what the recorder heard stays on the record, so a retry pairs the run the same way
      const pend = { id: `sp${Date.now()}`, at, pending: true, stage: 'Nahrávam video', video: null, run: run0, runKey: run0?.key ?? null, who: run0?.who ?? getAthlete()?.id ?? null, mode: null,
        filmed: filmed ? { times: filmed.times ?? null, recordedAt: filmed.recordedAt ?? null, freelap: filmed.freelap !== false, raw: filmed.raw ?? null } : null,
        raw: filmed?.raw ?? null,   // the camera's path for this clip: late times find the record by it
        cut: filmed?.cut ?? 0 };     // s cut off the start of the clip: clip times are that much earlier
      const l = load(); l.unshift(pend);
      for (const old of l.slice(MAX)) if (old.hasClip) dropClip?.(old.id);
      store(l.slice(0, MAX));
      pid = pend.id;
      if (saveClip) saveClip(pid, file).then(() => { patch(pid, x => { x.hasClip = true; }); if (current === pid) draw(); }).catch(() => {});
      // a later clip of several picked at once waits in the list: the screen keeps the one being watched
      if (!quiet || !current) current = pid;
      onDone(pend);   // opens the run's screen now: the video first
    } else patch(pid, x => { x.error = null; x.stage = 'Nahrávam video'; });
    inFlight.add(pid);
    draw();
    let lastStage = '', lastSave = 0;
    const x0 = load().find(r => r.id === pid);
    try {
      const me = getAthlete() ?? {};
      const { result } = await analyzeInCloud(file, {
        sex: me.sex, name: me.name, height: me.height, mode: 'sprint', athletes: await roster(),
        clip: pid, fresh, who: (() => { const f = load().find(r => r.id === pid)?.filmed ?? filmed; const n = f?.freelap !== false && f?.times?.length === 1 ? f.times[0].name : null; return n ? CHIPS_BY_NAME(athletes)[n] ?? null : null; })(),
        onJob: jobId => { patch(pid, x => { x.jobId = jobId; }); onServer?.(); },
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
      const video = { steps: result.steps, looks: result.looks ?? null, start: result.start, modeGuess: result.modeGuess, algo: result.algo ?? 1, recordedAt: filmed?.recordedAt ?? result.recordedAt ?? file.lastModified ?? null, duration: result.duration, fps: result.fps, who: result.who ?? null };
      let run = null;
      // the times may have come in after the upload began: the record has the latest
      filmed = load().find(r => r.id === pid)?.filmed ?? filmed;
      if (filmed && filmed.freelap === false) run = null;   // Freelap was off: no times, none paired later
      else if (filmed?.times?.length) {
        // the run the recorder heard: the athlete's own when two ran, else the first
        const who = result.who?.id, heard = filmed.times;
        const t = heard.find(x => who && CHIPS_BY_NAME(athletes)[x.name] === who) ?? heard[0];
        video.finishAt = +(t.arrived - LATENCY - (x0?.cut ?? 0)).toFixed(3);
        run = runs().find(r => r.key === t.key) ?? cleanLegs({ key: t.key, lap: t.lap, legs: t.legs, who: CHIPS_BY_NAME(athletes)[t.name] ?? who ?? null, at: video.recordedAt + t.arrived * 1000 });
      } else run = pairRun(runs(), video, null);
      // run again: the run already paired and the finish already heard stay as they were
      const old = load().find(r => r.id === pid);
      if (video.finishAt == null && old?.video?.finishAt != null) video.finishAt = old.video.finishAt;
      if (retryId && old?.runKey && !(filmed?.times?.length)) run = runs().find(r => r.key === old.runKey) ?? old.run ?? run;
      // Freelap off stays off, also when run again later (filmed is gone by then): only splits typed
      // by hand (a hand: run) are kept
      const off = (filmed?.freelap === false || x0?.filmed?.freelap === false || old?.noFreelap) && !String(old?.runKey ?? '').startsWith('hand:');
      // the pending record becomes the analysis; its clip is already stored under the same id
      const rec = patch(pid, x => Object.assign(x, { at: video.recordedAt ?? x.at, video, runKey: off ? null : run?.key ?? x.runKey ?? null, run: off ? null : run ?? x.run ?? null, noFreelap: off || undefined, jobId: undefined, who: run?.who ?? x.run?.who ?? result.who?.id ?? me.id ?? null, pending: false, stage: null, error: null, filmed: null }));
      say('');
      // the screen was opened when the run was filmed: only refresh the lists now, no jump
      if (rec) onDone(rec, { quiet: true });
    } catch (err) {
      const msg = err?.message || 'Analýza zlyhala. Skús to znova.';
      say(msg); patch(pid, x => { x.error = msg; });
    } finally {
      busy = Math.max(0, busy - 1); inFlight.delete(pid); draw();
    }
  }

  function draw() {
    const list = load(), rec = list.find(r => r.id === current);
    if (bare) { root.innerHTML = rec ? view(rec).html + delHtml(rec) : ''; attachClip(rec); return; }
    const head = `
      <div class="card sp-go">
        <div class="sp-btns">
          ${cam ? '<button class="btn go primary" data-sp="film">Natáčať šprint</button>' : ''}
          <label class="btn go${busy > 0 ? ' disabled' : ''}">Nahrať video<input type="file" accept="video/*" hidden data-sp="file"></label>
        </div>
        <p class="note">${cam ? '120 snímok za sekundu, uloží sa do Fotiek. Keď Freelap nižšie počúva, vo videu bežia stopky. ' : ''}Nahraté video rozoberiem po krokoch: kontakt, let, frekvencia, a s časom z Freelapu aj dĺžka kroku a rýchlosť.</p>
        ${progress ? `<p class="note" aria-live="polite">${esc(progress)}</p>` : ''}
        ${last ? `<p class="sp-last">${esc(last)}</p>` : ''}
      </div>`;
    const body = rec ? view(rec).html + delHtml(rec) : '';
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
      if (live?.id === rec.id && live.root === box) { syncHud(rec); return; }
      // The same run drawn again (its clip saved, its result in): the player already there moves
      // into the new screen and keeps playing. A new one each time restarted the video and decoded
      // the clip again while the analysis ran (2026-11-17: "prehrávanie seká").
      if (live?.id === rec.id && live.player && live.root && live.root !== box) {
        box.replaceWith(live.root);
        live.root.closest('section')?.querySelector('.sp-rate')?.classList.add('hidden');
        syncHud(rec);
        return;
      }
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
        syncHud(rec);
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

  // the copy for Photos with Freelap burned in: only for a clip from the gallery (one filmed in the app
  // was written with it already)
  function burnTl(rec) { const { run, a } = view(rec); return run && rec.video?.finishAt == null ? sprintTimeline({ legs: cleanLegs(run).legs, lap: run.lap, zero: a?.kind === 'accel' ? rec.video?.start?.release ?? null : null, name: name(run) }) : null; }
  // Freelap over an uploaded clip in the player (filmed in the app it is already burned in: finishAt
  // heard), redone on every draw: times typed or corrected after the player was made (2026-11-22, a
  // fly given 0.95 / 0.94 later showed no panel) replace the old panel.
  function syncHud(rec) {
    const p = live?.id === rec.id ? live.player : null;
    if (!p?.overlays || !p.src) return;
    if (live.hud) { const i = p.overlays.indexOf(live.hud); if (i >= 0) p.overlays.splice(i, 1); live.hud = null; }
    const tl = burnTl(rec);
    if (tl) { live.hud = hudOverlay(tl, p, { W: p.src.width, H: p.src.height }); p.overlays.push(live.hud); }
    p.refresh?.();
  }
  const delHtml = rec => `${rec.hasClip && !rec.pending && burnTl(rec) ? `<button class="btn" data-sp-burn="${esc(rec.id)}">Uložiť video s overlay do Fotiek</button>` : ''}${rec.hasClip && !rec.pending ? `<button class="btn" data-sp-again="${esc(rec.id)}">Znovu analyzovať</button>` : ''}<button class="btn danger" data-sp-del="${esc(rec.id)}">Zmazať beh</button>`;
  function remove(id) {
    const list = load(), r = list.find(x => x.id === id);
    if (!r) return;
    if (live?.id === id) { live.player?.dispose?.(); live.input?.dispose?.(); live = null; }
    store(list.filter(x => x.id !== id));
    if (r.hasClip) dropClip?.(id);
    if (current === id) current = null;
    draw(); onDeleted(r);
  }
  root.addEventListener('click', e => {
    const bn = e.target.closest('[data-sp-burn]');
    if (bn) {
      const rec = load().find(x => x.id === bn.dataset.spBurn), tl = rec && burnTl(rec);
      if (tl && loadClip) loadClip(rec.id).then(blob => { if (!blob) return alert('Video sa v telefóne nenašlo.'); return burnAndSave(bn, blob, tl, { name: 'sprint' }); });
      return;
    }
    const del = e.target.closest('[data-sp-del]');
    if (del) { if (armOrGo(del)) remove(del.dataset.spDel); return; }
    if (e.target.closest('[data-sp="film"]')) return film();
    const rt = e.target.closest('[data-rate]');
    if (rt) {
      const v = root.querySelector('.sp-vbox video');
      if (v) { v.playbackRate = +rt.dataset.rate; v.defaultPlaybackRate = +rt.dataset.rate; }
      root.querySelectorAll('[data-rate]').forEach(x => x.classList.toggle('on', x === rt));
      return;
    }
    // splits typed for a video Freelap did not time: they become its run
    if (e.target.closest('[data-sl-add]')) { slExtra++; draw(); return; }
    if (e.target.closest('[data-sl-del]')) { slExtra = Math.max(0, slExtra - 1); draw(); return; }
    const o = e.target.closest('[data-sp-open]');
    if (o) { current = o.dataset.spOpen === current ? null : o.dataset.spOpen; draw(); if (current && cloudReady()) rerunOld(current); root.scrollIntoView?.({ behavior: 'smooth' }); return; }
    // "Znovu analyzovať": the stored clip to the server as a new job (fresh), the old numbers stay on
    // screen until the new ones land, as with an algorithm update (rerunOld)
    const ag = e.target.closest('[data-sp-again]');
    if (ag && loadClip) {
      const id = ag.dataset.spAgain, r0 = load().find(r => r.id === id);
      if (!r0 || inFlight.has(id)) return;
      ag.disabled = true; ag.textContent = 'Analyzujem znova…';
      loadClip(id).then(blob => {
        if (!blob) return alert('Video sa v telefóne nenašlo.');
        const file = new File([blob], 'sprint.mov', { type: blob.type || 'video/quicktime', lastModified: r0.at ?? Date.now() });
        return upload(file, r0.filmed ?? (r0.run ? { times: null, recordedAt: r0.video?.recordedAt ?? r0.at, freelap: true } : null), id, null, true);
      }).catch(() => {}).finally(() => draw());
      return;
    }
    const rt2 = e.target.closest('[data-sp-retry]');
    if (rt2 && loadClip) {
      retry(rt2.dataset.spRetry).then(ok => { if (!ok) alert('Video sa v telefóne nenašlo.'); });
      return;
    }
    const ak = e.target.closest('[data-sp-ask]');
    if (ak && onAsk) { onAsk(ak.dataset.spAsk); return; }
    const k = e.target.closest('[data-sp-kind]');
    if (k && current) { const list = load(), r = list.find(x => x.id === current); if (r) { r.mode = k.dataset.spKind; store(list); draw(); } }
  });
  root.addEventListener('change', e => {
    if (e.target.matches('[data-sp="file"]')) { const f = e.target.files?.[0]; e.target.value = ''; if (f) upload(f); }
    if (e.target.matches('[data-sl]') && current && freelap?.addTyped) {
      const legs = readLegs(root, 'data-sl'), rec = load().find(r => r.id === current);
      if (!legs || !rec) return;
      const run = freelap.addTyped({ who: rec.who ?? rec.video?.who?.id ?? getAthlete()?.id ?? null, at: rec.at, legs });
      if (!run) return;
      slExtra = 0;
      patch(current, x => { x.runKey = run.key; x.run = run; x.noFreelap = undefined; });
      draw(); onDone(load().find(r => r.id === current), { quiet: true });
    }
  });

  // localhost only: lets a developer render a stored result without a server run
  if (['localhost', '127.0.0.1'].includes(globalThis.location?.hostname)) globalThis.__sprintShow = rec => { const list = load(); list.unshift(rec); store(list); current = rec.id; draw(); };

  // A run left pending by a reloaded app picks up where it was (2026-11-15: three runs were left
  // as "zlyhala" though the server had one of them done): the clip is in the phone and the server
  // finds a job it already made from it, so this only uploads what never arrived.
  function retry(id) {
    const r0 = load().find(r => r.id === id);
    if (inFlight.has(id)) return Promise.resolve(true);
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
  // Analyses made with an older contact rule, from the last three days and with their clip in the
  // phone, go to the server once more (2026-11-15: the new rule finds the far steps the old one
  // lost). The old numbers stay on screen until the new ones land.
  // Only the analysis opened (2026-11-15 review: all of them at start meant ~250 MB on mobile data).
  async function rerunOld(only) {
    const since = Date.now() - 7 * 86400_000;
    // uploaded in the last week (the id is the upload time; `at` is when it was filmed, and a clip of
    // 4 July uploaded today never ran again: 2026-11-18)
    const added = r => Number(String(r.id).slice(2)) || r.at;
    const ids = load().filter(r => r.id === only && !r.pending && r.hasClip && r.video && (r.video.algo ?? 1) < SPRINT_ALGO && added(r) >= since && !r.rerun).map(r => r.id);
    for (const id of ids) {
      patch(id, x => { x.rerun = SPRINT_ALGO; });
      const r0 = load().find(r => r.id === id), blob = await loadClip?.(id).catch(() => null);
      if (!blob) continue;
      const file = new File([blob], 'sprint.mov', { type: blob.type || 'video/quicktime', lastModified: r0.at ?? Date.now() });
      await upload(file, r0.filmed ?? (r0.run ? { times: null, recordedAt: r0.video.recordedAt ?? r0.at, freelap: true } : null), id, null, true).catch(() => {});
    }
  }
  // The access code of a fresh install comes from build-config.json a moment after start: wait
  // for it up to 10 s before calling the waiting runs failed.
  (async () => {
    for (let i = 0; i < 20 && !cloudReady(); i++) await new Promise(r => setTimeout(r, 500));
    if (cloudReady()) return resumeAll();
    const l = load(); let ch = false;
    for (const r of l) if (r.pending && !r.error) { r.error = 'Analýza sa prerušila. Video je uložené, skús znova.'; ch = true; }
    if (ch) { store(l); draw(); }
  })();
  draw();
  return {
    shown: draw, film, upload, records: load, contextOf,
    chatOf: id => load().find(r => r.id === id)?.chat ?? [],
    saveChat: (id, messages) => patch(id, x => { x.chat = messages.slice(-30); }),
    open(id) { current = id; slExtra = 0; draw(); if (cloudReady()) rerunOld(id); },
    busy: () => busy > 0,
    // One line for the Tréning and História lists.
    summary(rec) {
      if (rec.pending) {
        const who = rec.run?.who ?? rec.who ?? null;
        return { kind: 'sprint', id: rec.id, at: rec.at, who, title: `${athletes[who]?.name ?? ''}${who ? ' · ' : ''}šprint`, sub: rec.error ? 'analýza zlyhala' : 'analýza beží…', value: rec.run ? n2(rec.run.lap) : '…', valueSub: rec.run ? 's' : '' };
      }
      const run = cleanLegs(rec.runKey ? runs().find(r => r.key === rec.runKey) ?? rec.run ?? null : rec.run ?? null);
      const who = run?.who ?? rec.who ?? null, k = rec.mode ?? (run ? modeOfRun(run) : rec.video.modeGuess);
      // the steps the result screen shows (impossible ones dropped), so list and screen agree
      const steps = cleanSteps((rec.video.steps ?? []).filter(x => x.contact != null), { accel: k === 'accel' && !!rec.video.start, fps: rec.video.fps ?? 120 });
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
