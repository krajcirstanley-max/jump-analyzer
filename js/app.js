import * as mb from '../vendor/mediabunny.min.mjs';
import { inspectClip, VERDICT } from './footage.js';
import { FrameSource } from './frames.js';
import { Player } from './player.js';
import { skeletonOverlay } from './pose/overlay.js';
import { analyzeJump } from './analysis/jump.js';
import { expectedDistance } from './analysis/runup.js';
import { coaching } from './analysis/coach.js';
import { jointLabels, idealOverlay } from './analysis/labels.js';
import { idealFor } from './analysis/ideal.js';
import { renderResult, showCoach, runupHtml, firstCellHtml } from './analysis/view.js';
import { initRsi } from './rsi-view.js';
import { initFreelap } from './freelap-view.js';
import { initSprint } from './sprint-view.js';
import { jumpSummary, listHtml, todayHtml, trendsHtml } from './train-view.js';
import { CLOUD_URL } from './config.js';
import { cloudReady, getCloudToken, setCloudToken, analyzeInCloud, enableNotifications, pendingCloudJob, resumeCloudJob, warmCloud } from './cloud.js';
import * as hist from './history.js';
import { sessions, sessionPlace, skoky } from './sessions.js';

const APP_VERSION = '0.9.7';
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (x, d = 1) => (x == null || Number.isNaN(x) ? '–' : Number(x).toFixed(d));

$('ver').textContent = `Verzia ${APP_VERSION}`;

// No offline cache on localhost, so edits show up on reload while developing.
const isDev = ['localhost', '127.0.0.1'].includes(location.hostname);
if (isDev) navigator.serviceWorker?.getRegistrations().then(rs => rs.forEach(r => r.unregister()));
else if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW registration failed', err));
}

// ---------- athletes and their PB / goal ----------
const ATHLETES = {
  stanley: { name: 'Stanley', sex: 'male', goal: 8, height: 186 },
  miska: { name: 'Miška', sex: 'female', goal: null, height: 171 },
};
const profileKey = a => `jump.profile.${a}`;
const profiles = {};
for (const a of Object.keys(ATHLETES)) {
  profiles[a] = { pb: null, goal: ATHLETES[a].goal };
  try { Object.assign(profiles[a], JSON.parse(localStorage.getItem(profileKey(a)) || '{}')); } catch { /* storage blocked */ }
}
function saveProfile(a) {
  try { localStorage.setItem(profileKey(a), JSON.stringify(profiles[a])); } catch { /* storage blocked: kept for this session */ }
}

// No athlete switch (Stanley, 2026-11-12): the server tells who is in each clip. `athlete` is only
// the guess until it answers, or when it can't tell: whoever was in the last clip.
let athlete = 'stanley';
try { const a = localStorage.getItem('athlete'); if (a in ATHLETES) athlete = a; } catch { /* storage blocked */ }
function rememberAthlete(a) {
  athlete = a;
  try { localStorage.setItem('athlete', a); } catch { /* storage blocked */ }
}
const otherAthlete = a => Object.keys(ATHLETES).find(x => x !== a);

// Everyone who may be in a clip, with the numbers-only history the coach gets.
async function roster() {
  return Promise.all(Object.entries(ATHLETES).map(async ([id, a]) => ({
    id, sex: a.sex, name: a.name, height: a.height, pb: profiles[id].pb ?? null, history: hist.coachHistory(await hist.listAttempts(id)),
  })));
}

// RSI tab: its own screen and storage.
const rsiView = initRsi({
  root: document.getElementById('rsi'), athletes: ATHLETES, bare: true,
  getAthlete: () => ({ id: athlete, ...ATHLETES[athlete] }), roster, rememberAthlete,
  onProgress: t => trainProgress(t),
  onDone: ({ rec, who }) => { refreshFeeds(); openDetail('rsi', rec.id, who); },
});

// Freelap tab: Start listens for the chips, Stop takes nothing in.
const freelapView = initFreelap({
  root: document.getElementById('freelap'), athletes: ATHLETES, detailRoot: document.getElementById('fl-run'),
  onOpen: key => openRun(key),
  onChange: () => { sprintView.shown(); refreshFeeds(); drawFreelapMini(); },
});
// Sprint tab: film in the app; Freelap runs heard while filming go onto the video.
const sprintView = initSprint({
  root: document.getElementById('sprint'), athletes: ATHLETES, freelap: freelapView, bare: true,
  getAthlete: () => ({ id: athlete, ...ATHLETES[athlete] }), roster,
  onProgress: t => trainProgress(t),
  onDone: rec => { refreshFeeds(); openDetail('sprint', rec.id); },
  saveClip: (id, f) => { navigator.storage?.persist?.().catch(() => {}); return hist.storeClip(id, f); }, loadClip: hist.loadClip, dropClip: hist.deleteMedia,
});
const sprintOfRun = key => sprintView.records().find(r => r.runKey === key)?.id ?? null;
freelapView.setLinker(sprintOfRun);

// Blank clears the field; anything outside a plausible jump is ignored.
function parseMetres(s) {
  const x = parseFloat(String(s).trim().replace(',', '.'));
  return x >= 1 && x <= 12 ? x : null;
}
const metresField = x => (x == null ? '' : x.toFixed(2).replace('.', ','));

// PB and goal are edited on Progres, one pair per athlete.
document.addEventListener('change', e => {
  const f = e.target.closest('[data-pb]');
  if (!f) return;
  const a = f.dataset.pb, key = f.dataset.key;
  if (!(a in ATHLETES) || !['pb', 'goal'].includes(key)) return;
  profiles[a][key] = parseMetres(f.value);
  f.value = metresField(profiles[a][key]);
  saveProfile(a);
  renderLists();
});

// ---------- tabs ----------
// Three tabs (Tréning, História, Progres) and three detail screens reached from them: a jump
// result, a sprint or RSI analysis, the settings. A detail screen has a back button.
let tab = 'train', backTo = 'train';
const tabScroll = {};
const TABS = ['train', 'history', 'progress'], DETAILS = ['result', 'detail', 'settings'];
function showTab(name) {
  if (name === tab) return;
  tabScroll[tab] = scrollY;
  if (TABS.includes(tab)) backTo = tab;
  tab = name;
  for (const t of [...TABS, ...DETAILS]) $(`view-${t}`).classList.toggle('hidden', t !== name);
  $('back').classList.toggle('hidden', !DETAILS.includes(name));
  $('who').classList.toggle('hidden', name === 'result' || name === 'settings');
  $('gear').classList.toggle('hidden', DETAILS.includes(name));
  if (name === 'train' || name === 'history') refreshFeeds();
  if (name === 'progress') renderLists();
  if (name === 'history' && histFilter === 'freelap') freelapView.shown();
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('res-who').classList.toggle('hidden', name !== 'result' || !resultAthlete);
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name || (DETAILS.includes(name) && b.dataset.tab === backTo)));
  if (name !== 'result') player?.pause();
  scrollTo(0, tabScroll[name] ?? 0);
}
function openResultTab() {
  tabScroll.result = 0;
  showTab('result');
  scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------- Výsledok states ----------
const els = {
  feel: $('res-feel'), after: $('res-after'), score: $('res-score'), tiles: $('res-tiles'), chips: $('res-chips'),
  playerCard: $('player-card'), detail: $('res-detail'), speed: $('res-speed'), coach: $('res-coach'), all: $('res-all'), take: $('res-take'),
};

let current = null;          // inspectClip result of the clip on screen
let currentFile = null;
let currentClip = null;      // { file: { name, size }, recordedAt }
let resultAthlete = null;
let resultId = null;         // saved attempt on screen
let saved = Promise.resolve();
let player = null;
let pose = null;
let jump = null;
let cloudCoach = null;
let awaitingCoach = false;   // cloud: numbers are up, the coach is still being written
let runId = 0;
let abort = null;
let poseWorker = null;

function setWho(a) {
  resultAthlete = a;
  $('res-who').innerHTML = a ? whoHtml(a) : '';
  $('res-who').classList.toggle('hidden', tab !== 'result' || !a);
}

// "Stanley · 3. skok z 5": where the attempt on screen sits in its training day. The name is a
// button: one tap gives the attempt to the other athlete when the server got it wrong.
const whoHtml = (a, tail = '') => `${esc(ATHLETES[a].name)}${tail}<span class="who-swap" aria-hidden="true">⇄</span>`;
async function showPlace(id, a) {
  const p = sessionPlace(await hist.listAttempts(a), id);
  if (id !== resultId || a !== resultAthlete) return;
  $('res-who').innerHTML = whoHtml(a, p ? ` · ${p.n}. skok z ${p.total}` : '');
}

// The server found someone else than the guess: the attempt is theirs. The clip stored under the
// guess goes once the attempt is saved under the right name.
let staleClip = null;
function adoptWho(result) {
  const id = result?.who?.id;
  if (!(id in ATHLETES)) return;
  rememberAthlete(id);
  if (id === resultAthlete) return;
  if (held) { staleClip = held.id; hold({ ...held, id: hist.attemptId(id, held.file), athlete: id }); }
  setWho(id);
}

$('res-who').addEventListener('click', () => swapAthlete());
async function swapAthlete() {
  if (!resultId || !pose || !jump || jump.error || isBusy) return;
  const oldId = resultId, to = otherAthlete(resultAthlete);
  await saved;
  const old = await hist.getAttempt(oldId);
  if (!old) return;
  rememberAthlete(to);
  setWho(to);
  if (!currentFile) {            // opened from Progres: the clip is the stored one
    currentFile = (await hist.loadMedia(oldId)).clip;
    currentClip = { file: { name: old.file, size: old.size }, recordedAt: old.recordedAt };
  }
  // The numbers again with the other athlete's sex; the coaching from the server named the wrong
  // person, so the template stands in.
  cloudCoach = null; awaitingCoach = false;
  if (!showJump()) return;
  await saved;
  const newId = resultId;
  if (old.feel != null || old.runup != null || old.measured != null || old.split != null) await hist.patchAttempt(newId, { feel: old.feel ?? null, runup: old.runup ?? null, measured: old.measured ?? null, split: old.split ?? null });
  if (newId === oldId) return;
  // The player still reads the old clip: let go of it, drop the old attempt, open the new one.
  runId++;
  clearResult();
  await hist.deleteAttempt(oldId);
  openAttempt(newId);
}

let isBusy = false;
function setBusy(on) {
  isBusy = on;
  document.querySelector('.tab[data-tab=train]').classList.toggle('busy', on);
}

// One state at a time: idle, progress, message, or the result itself.
function clearResult() {
  abort?.abort(); abort = null;
  dropHeld();
  poseWorker?.terminate(); poseWorker = null;
  setBusy(false);
  player?.dispose(); player = null;
  $('player').innerHTML = '';
  current?.input?.dispose?.(); current = null;
  pose = null; jump = null; cloudCoach = null; awaitingCoach = false; resultId = null;
  for (const id of ['res-progress', 'res-msg', 'res-feel', 'res-after']) $(id).classList.add('hidden');
  $('res-empty').classList.remove('hidden');
}

// The local worker reports English stage names.
const STAGES = {
  'Loading models': 'Pripravujem analýzu',
  'Finding the jumper': 'Hľadám skokana',
  'Following the jumper': 'Sledujem skokana',
  'Tracking pose': 'Sledujem pohyb',
  'Precise pose': 'Spresňujem pohyb',
  'Cleaning the track': 'Čistím údaje',
};

function showProgress(stage, pct = null) {
  $('res-empty').classList.add('hidden');
  $('res-progress').classList.remove('hidden');
  $('pose-stage').textContent = stage;
  $('pose-pct').textContent = pct == null ? '' : `${pct} %`;
  $('pose-bar').style.width = `${pct ?? 0}%`;
}
function progressFrom({ stage, done, total }) {
  const pct = total ? Math.min(100, Math.round((100 * done) / total)) : 0;
  showProgress(STAGES[stage] ?? stage ?? 'Analyzujem', pct);   // the cloud client's stages are already Slovak
}

function showMsg(kind, title, text, actions = '') {
  $('res-progress').classList.add('hidden');
  $('res-empty').classList.add('hidden');
  setBusy(false);
  const m = $('res-msg');
  m.classList.remove('hidden');
  m.innerHTML = `<div class="banner ${kind}"><strong>${esc(title)}</strong>${esc(text)}</div>${actions ? `<div class="row msg-actions">${actions}</div>` : ''}`;
}

const ROUTE = 'Vo Photos daj Share → Export Unmodified Original, ulož do Files a tu vyber Choose File.';
const NOT_FOUND = ['Skok sa nepodarilo nájsť', 'Skontroluj, či je v zábere odraz a aspoň posledné kroky, a skús to znova.'];

$('res-cancel').addEventListener('click', () => {
  runId++;
  clearResult();
  setWho(null);
  showTab('train');
});
$('res-notify').addEventListener('click', async () => {
  $('res-notify').hidden = true;
  await enableNotifications().catch(() => false);
});
$('res-msg').addEventListener('click', e => {
  const b = e.target.closest('[data-retry]');
  if (!b || !currentFile) return;
  $('res-msg').classList.add('hidden');
  runAnalysis(currentFile, runId, b.dataset.retry === 'local');
});

// ---------- analysis ----------
async function analyzeFile(file) {
  const run = ++runId;
  clearResult();
  setWho(athlete);
  openResultTab();
  showProgress('Kontrolujem video');

  const t0 = performance.now();
  let r;
  try {
    r = await inspectClip(file, mb);
  } catch (e) {
    if (run !== runId) return { superseded: true };
    console.warn('Clip unreadable', e);
    showMsg('bad', 'Toto video sa nedá prečítať', ROUTE);
    return { error: e.message };
  }
  r.readMs = performance.now() - t0;
  r.canDecode = await r.track.canDecode().catch(() => false);
  if (run !== runId) { r.input.dispose?.(); return { superseded: true }; }
  current = r;
  currentFile = file;
  currentClip = { file: { name: file.name, size: file.size }, recordedAt: r.tags.creationTime || null };

  // Silent when the clip is fine; speaks only when it can't give true timings.
  if (r.verdict === VERDICT.RENDERED) {
    showMsg('bad', 'Toto je kópia, nie originál', `Video má ${fmt(r.timing.fpsFromGap, 0)} fps, spomalené snímky v ňom chýbajú. ${ROUTE}`);
    return summaryOf(r);
  }
  if (!r.canDecode) {
    showMsg('bad', 'Toto video sa tu nedá prehrať', 'Tento prehliadač nepozná jeho formát. Otvor aplikáciu v Safari na iPhone.');
    return summaryOf(r);
  }
  await openPlayer(r, () => run === runId);
  if (run !== runId) return { superseded: true };
  if (player && !window.__noPose) runAnalysis(file, run, false);
  return summaryOf(r);
}

async function openPlayer(r, stillCurrent) {
  try {
    const src = new FrameSource(mb, r.track, r.packetTimestamps, r.keyTimestamps);
    if (!stillCurrent()) { src.dispose(); return; }
    player = new Player($('player'), src);
    const t0 = performance.now();
    await player.show(0);
    r.firstFrameMs = performance.now() - t0;
  } catch (e) {
    if (!stillCurrent()) return;
    console.warn('Decode failed', e);
    player?.dispose(); player = null;
    r.decodeError = e.message;
    showMsg('bad', 'Toto video sa tu nedá prehrať', 'Tento prehliadač ho nevie dekódovať. Otvor aplikáciu v Safari na iPhone.');
  }
}

async function runAnalysis(file, run, forceLocal) {
  const stillCurrent = () => run === runId;
  $('res-notify').hidden = true;
  setBusy(true);
  // The published site carries no models (414 MB), so with a server configured the only way
  // to analyse is through it: without the access code there is nothing to fall back to.
  if (!forceLocal && CLOUD_URL && !cloudReady()) {
    setBusy(false);
    return showMsg('bad', 'Chýba prístupový kľúč', 'Vlož svoj kľúč v nastaveniach na karte Domov a skús to znova.');
  }
  if (forceLocal || !cloudReady()) return analyzePose(file, stillCurrent);

  const who = ATHLETES[resultAthlete];
  showProgress('Posielam video', 0);
  staleClip = null;
  // The clip goes on the phone first: if the app is closed after the upload, the job can
  // be picked up again and still has its replay.
  const id = hist.attemptId(resultAthlete, currentClip.file);
  await hist.storeClip(id, file);
  if (!stillCurrent()) return;
  hold({ id, athlete: resultAthlete, ...currentClip });
  const athletes = await roster();
  const history = athletes.find(a => a.id === resultAthlete).history;
  return followCloud(run, opts => analyzeInCloud(file, { sex: who.sex, name: who.name, height: who.height, history, athletes, ...opts }));
}

async function followCloud(run, start) {
  const stillCurrent = () => run === runId;
  abort = new AbortController();
  const signal = abort.signal;
  $('res-notify').hidden = !(window.Notification?.permission === 'default');
  let numbersUp = false, attempt = null;
  const onResult = ({ result }) => {
    if (numbersUp || !stillCurrent()) return;
    numbersUp = true;
    abort = null;              // from here the job outlives this screen: only the coach is left
    adoptWho(result);
    pose = result;
    awaitingCoach = true;
    attempt = finishPose();
  };
  try {
    // Once the numbers are up the result screen shows its own "coaching on the way" slot; the
    // progress card must not come back on top of it for the coaching stage.
    const out = await start({ signal, onResult, onProgress: p => { if (stillCurrent() && !numbersUp) progressFrom(p); } });
    if (numbersUp) return void landCoach(attempt, out.coach);
    if (!stillCurrent()) return;
    adoptWho(out.result);
    pose = out.result;
    cloudCoach = out.coach ?? null;
    finishPose();
  } catch (e) {
    if (numbersUp) return void landCoach(attempt, null);
    if (!stillCurrent() || signal.aborted) return;
    console.warn('Cloud analysis failed', e);
    if (/no person found/i.test(e.message)) return showMsg('bad', ...NOT_FOUND);
    showMsg('bad', 'Server teraz neodpovedá', e.name === 'CloudError' ? e.message : 'Skús to znova, alebo to nechaj prepočítať v telefóne, trvá to niekoľko minút.',
      '<button class="btn" data-retry="cloud">Skúsiť znova</button><button class="btn" data-retry="local">Analyzovať v telefóne</button>');
  }
}

// The coach for a saved attempt, whether or not it is still on screen. No coach from the
// server means the template for that jump.
async function landCoach(a, coach) {
  if (!a) return;
  const who = ATHLETES[a.athlete];
  const final = coach ?? coaching(a.jump.metrics, who.sex, { name: who.name });
  await a.saved;
  await hist.setCoach(a.id, final, a.job);
  if (resultId === a.id && awaitingCoach) {
    awaitingCoach = false;
    jump.coach = final;
    showCoach(els, final);
  }
  renderLists();
}

// App opened again with an attempt whose coach never landed: pick the job up if it is the
// one still outstanding, otherwise give that attempt the template.
async function resumeCoaches() {
  for (const a of Object.keys(ATHLETES)) {
    for (const r of await hist.listAttempts(a)) {
      if (!r.coachPending) continue;
      const t = { id: r.id, athlete: r.athlete, jump: r.jump, job: r.coachJob ?? null, saved: Promise.resolve() };
      const job = pendingCloudJob(r.coachJob ?? null);
      if (job && cloudReady()) {
        resumeCloudJob(job.jobId).then(o => landCoach(t, o.coach), () => landCoach(t, null));
      } else landCoach(t, null);
    }
  }
}

// A cloud job in flight: what the app needs to finish it after being closed.
const HOLD_KEY = 'jump.held';
let held = null;
function hold(h) {
  held = h;
  try { localStorage.setItem(HOLD_KEY, JSON.stringify(h)); } catch { /* storage blocked: no resume */ }
}
function releaseHeld() {
  held = null;
  try { localStorage.removeItem(HOLD_KEY); } catch { /* storage blocked */ }
}
function dropHeld() {
  if (held) hist.dropIfOrphan(held.id);
  releaseHeld();
}

// Opened again from the push (or after iOS killed the app) while a job was still running.
async function resumeHeld() {
  let h = null;
  try { h = JSON.parse(localStorage.getItem(HOLD_KEY)); } catch { /* storage blocked */ }
  if (!h) return;
  const job = pendingCloudJob();
  const clip = job?.jobId && cloudReady() ? (await hist.loadMedia(h.id)).clip : null;
  if (!clip) { held = h; dropHeld(); return; }
  const run = ++runId;
  clearResult();
  setWho(h.athlete);
  openResultTab();
  showProgress('Preberám analýzu');
  try {
    const r = await inspectClip(clip, mb, { name: h.file.name });
    if (run !== runId) { r.input.dispose?.(); return; }
    r.readMs = 0;
    current = r;
    currentFile = clip;
    currentClip = { file: h.file, recordedAt: h.recordedAt };
    hold(h);
    await openPlayer(r, () => run === runId);
    if (run !== runId || !player) return;
    setBusy(true);
    followCloud(run, opts => resumeCloudJob(job.jobId, opts));
  } catch (e) {
    console.warn('Resume failed', e);
    showMsg('bad', 'Analýzu sa nepodarilo prevziať', 'Spusti ju znova.');
  }
}

// Local path: the pose pipeline in a fresh worker per clip (Safari keeps WASM memory otherwise).
function analyzePose(file, stillCurrent, opts = {}) {
  poseWorker?.terminate();
  pose = null;
  showProgress('Pripravujem analýzu', 0);
  return new Promise(resolve => {
    const w = poseWorker = new Worker(new URL('./pose/worker.js', import.meta.url), { type: 'module' });
    w.onmessage = e => {
      if (!stillCurrent() || w !== poseWorker) { w.terminate(); return resolve({ superseded: true }); }
      const { progress, result, error } = e.data;
      if (progress) return progressFrom(progress);
      w.terminate();
      poseWorker = null;
      if (error) {
        console.warn('Pose failed', error);
        showMsg('bad', 'Analýza zlyhala', 'Video sa nepodarilo spracovať. Skús to znova.', '<button class="btn" data-retry="local">Skúsiť znova</button>');
        return resolve({ error });
      }
      pose = result;
      finishPose();
      resolve(result);
    };
    w.onerror = e => {
      if (!stillCurrent()) return resolve({ superseded: true });
      console.warn('Worker failed', e.message);
      showMsg('bad', 'Analýza zlyhala', 'Video sa nepodarilo spracovať. Skús to znova.', '<button class="btn" data-retry="local">Skúsiť znova</button>');
      resolve({ error: e.message });
    };
    w.postMessage({ file, opts });
  });
}

function finishPose() {
  setBusy(false);
  $('res-progress').classList.add('hidden');
  if (pose.error) {
    console.warn('No athlete', pose.error);
    showMsg('bad', ...NOT_FOUND);
    return null;
  }
  return showJump();
}

// "Ty / Ideál" at the board touchdown: the athlete's own skeleton with the angles that miss the
// elite norms moved into them (ideal.js). The switch shows only on that frame.
const idealState = { on: false };
let ideal = null;
function idealToggle() {
  const stage = player?.stage;
  if (!stage) return null;
  let el = stage.querySelector('.ideal-toggle');
  if (!el) {
    el = document.createElement('div');
    el.className = 'ideal-toggle hidden';
    el.setAttribute('role', 'radiogroup');
    el.setAttribute('aria-label', 'Porovnanie s ideálom');
    el.innerHTML = '<button data-ideal="0" role="radio">Ty</button><button data-ideal="1" role="radio">+ Ideál</button><span class="ideal-note"></span>';
    el.onclick = e => {
      const b = e.target.closest('[data-ideal]');
      if (!b) return;
      idealState.on = b.dataset.ideal === '1';
      syncIdeal(player.index);
      player.refresh();
    };
    stage.appendChild(el);
    const legend = document.createElement('div');
    legend.className = 'ideal-legend hidden';
    stage.after(legend);
    player.frameHooks.push(i => syncIdeal(i));
  }
  return el;
}
function syncIdeal(i) {
  const el = idealToggle();
  if (!el) return;
  const here = !!ideal && i === ideal.frame;
  el.classList.toggle('hidden', !here);
  el.querySelectorAll('[data-ideal]').forEach(b => {
    const on = (b.dataset.ideal === '1') === idealState.on;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
  });
  el.querySelector('.ideal-note').textContent = '';
  const legend = player.stage.parentNode.querySelector('.ideal-legend');
  if (legend) {
    const show = here && idealState.on;
    legend.classList.toggle('hidden', !show);
    const deg = v => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(0)}°`;
    const moved = (ideal?.items ?? []).filter(it => it.set);
    legend.innerHTML = !show ? '' : moved.length
      ? `<b>Ideál podľa noriem finalistov</b>${moved.map(it => `<span>${esc(it.label)} <strong>${deg(it.ideal)}</strong> <em>ty ${deg(it.you)}</em></span>`).join('')}`
      : '<b>Všetky uhly sú v norme</b>';
  }
}
function setOverlays() {
  player.overlays.length = 0;
  const k = player.src.width / pose.W;
  ideal = jump.error ? null : idealFor(jump, pose, ATHLETES[resultAthlete ?? athlete].sex);
  player.overlays.push(skeletonOverlay(pose, k));   // the ghost draws over it, never in place of it
  idealState.on = false;
  if (!jump.error) player.overlays.push(jointLabels(jump, pose, k, { skip: i => idealState.on && ideal && i === ideal.frame }));
  if (ideal) player.overlays.push(idealOverlay(ideal, k, idealState));
  syncIdeal(player.index);
}

function showJump() {
  const a = resultAthlete ?? athlete, who = ATHLETES[a];
  jump = analyzeJump(pose, who.sex, player.ts, { height: who.height, pb: profiles[a].pb });
  setOverlays();
  player.refresh();
  if (jump.error) {
    console.warn('No jump', jump.error);
    showMsg('bad', ...NOT_FOUND);
    return null;
  }
  jump.coach = cloudCoach ?? (awaitingCoach ? null : coaching(jump.metrics, who.sex, { name: who.name }));   // analyzeJump doesn't know the name
  releaseHeld();                 // the clip now belongs to the attempt
  $('res-empty').classList.add('hidden');
  $('res-msg').classList.add('hidden');
  const rec = hist.attemptRecord(jump, { athlete: resultAthlete, ...currentClip });
  rec.coachPending = awaitingCoach;
  rec.coachJob = awaitingCoach ? pendingCloudJob()?.jobId ?? null : null;
  resultId = rec.id;
  $('res-del').dataset.del = rec.id;
  const stale = staleClip !== rec.id ? staleClip : null;
  staleClip = null;
  saved = hist.saveAttempt(rec, { clip: currentFile, pose }).then(out => {
    if (stale) hist.dropIfOrphan(stale);
    renderLists();
    if (out.ok) showPlace(rec.id, rec.athlete);
    if (out.ok && !out.media.clip) console.warn('Replay not kept: no space for the clip');
  });
  present(null);
  return { id: rec.id, athlete: resultAthlete, jump, job: rec.coachJob, saved };
}

// ---------- run-up steps: prefilled, confirmed or changed by the athlete ----------
// The athlete's last confirmed run-up, kept fresh by renderLists.
const lastRunup = {};
let runup = null;            // { value, confirmed, from } for the attempt on screen
function prefillRunup() {
  const c = jump?.stepCount, a = resultAthlete ?? athlete, last = lastRunup[a] ?? null;
  const pick = () => {
    if (jump?.runup != null) return { value: jump.runup, confirmed: true };
    if (c?.seen) return { value: c.count, from: 'count' };
    // Start not seen: the same run-up as last time when it fits what the video shows.
    if (c?.range) return last != null && last >= c.range[0] && last <= c.range[1] ? { value: last, from: 'last' } : { value: c.range[0], from: 'range' };
    return last != null ? { value: last, from: 'last' } : { value: null };
  };
  return withExpected(pick());
}
// What a full effort from that run-up should reach, from the athlete's PB (runup.js).
function withExpected(r) {
  const pb = profiles[resultAthlete ?? athlete]?.pb ?? null;
  const sp = jump?.speed, toe = sp?.jumpFromToe, est = (jump?.metrics ?? []).find?.(m => m.key === 'estDistance' && m.status !== 'hidden')?.value;
  // The video's own distance, before any tape correction (every metre scaled by tapeFix.k), measured
  // the way the athlete measures: from the take-off line, or from the toe.
  const line = toe > 0 && Number.isFinite(sp?.toeToLine), tf = sp?.tapeFix;
  const from = jump?.tapeFrom ?? tf?.from ?? 'toe';   // they always measure from the toe
  const k = tf?.applied ? tf.k : 1;
  const videoDist = toe > 0 ? (from === 'board' && line ? toe - sp.toeToLine : toe) / k : est > 0 ? est : null;
  return { ...r, pb, judged: jump?.runupJudged ?? null, measured: jump?.measured ?? null, split: jump?.split ?? null,
    videoSplit: sp?.split1to11 ?? null, videoDist, tapeFrom: line ? from : null, tapeFix: tf ?? null, expected: r.value != null && r.value < 18 ? expectedDistance(r.value, pb) : null };
}
const redrawRunup = () => {
  runup = withExpected(runup ?? {});
  const el = $('runup'); if (el) el.outerHTML = runupHtml(jump?.stepCount, runup);
  const f = $('sp-first'); if (f && jump?.speed) f.outerHTML = firstCellHtml(jump.speed, runup);
};

// The confirmed run-up differs from the one the numbers were judged at: judge them again (the
// speed-dependent norms move with it). The coaching text stays as it was written.
// force: run again although the run-up is the same (a new tape distance rescales the metres).
async function rejudge(id, v, force = false) {
  if (!pose || !jump || jump.error || (!force && (jump.runupJudged ?? null) === v)) return;
  const a = resultAthlete, who = ATHLETES[a];
  const next = analyzeJump(pose, who.sex, player?.ts ?? null, { height: who.height, pb: profiles[a].pb, runup: v, tape: jump.measured, tapeFrom: jump.tapeFrom ?? null });
  if (next.error || id !== resultId) return;
  jump = Object.assign(next, { coach: jump.coach, feel: jump.feel, measured: jump.measured, split: jump.split, tapeFrom: jump.tapeFrom ?? null, runup: v });
  if (player) { setOverlays(); player.refresh(); }
  await hist.patchAttempt(id, { ...hist.attemptNumbers(jump), jump });
  if (id === resultId) present(jump.feel ?? null);
  renderLists();
}

// The jump length and the 1-11 m time: prefilled from the video, confirmed with the button or
// typed over (tape, Freelap). Typing saves on its own; blank clears it.
const CONFIRM = {
  measured: { field: 'measured', lo: 1, hi: 12 },
  split: { field: 'split', lo: 0.8, hi: 2.5 },
};
async function saveConfirm(k, raw) {
  if (!resultId || !jump) return;
  const { field, lo, hi } = CONFIRM[k];
  const x = parseFloat(String(raw ?? '').trim().replace(',', '.'));
  const v = x >= lo && x <= hi ? Math.round(x * 100) / 100 : null;
  const changed = jump[field] !== v;
  jump[field] = v;
  redrawRunup();
  const id = resultId;
  await saved;
  await hist.patchAttempt(id, { [field]: v });
  renderLists();
  // A tape distance corrects the video's metres: run the numbers again with it.
  if (field === 'measured' && changed) rejudge(id, jump.runup ?? null, true);
}
// Where the tape was laid from: the take-off line (default) or the take-off toe.
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-tape-from]');
  if (!b || !resultId || !jump || jump.tapeFrom === b.dataset.tapeFrom) return;
  jump.tapeFrom = b.dataset.tapeFrom;
  redrawRunup();
  const id = resultId;
  await saved;
  await hist.patchAttempt(id, { tapeFrom: jump.tapeFrom });
  if (jump.measured != null) rejudge(id, jump.runup ?? null, true);
});
document.addEventListener('change', e => {
  const f = e.target.closest('[data-measured], [data-split]');
  if (f) saveConfirm('measured' in f.dataset ? 'measured' : 'split', f.value);
});
document.addEventListener('click', e => {
  const b = e.target.closest('[data-measured-ok], [data-split-ok]');
  if (!b) return;
  const k = 'measuredOk' in b.dataset ? 'measured' : 'split';
  saveConfirm(k, document.querySelector(k === 'measured' ? '[data-measured]' : '[data-split]')?.value);
});
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-runup]');
  if (!b || !runup || !resultId) return;
  if (b.dataset.runup === 'ok') {
    if (runup.value == null) return;
    const id = resultId, a = resultAthlete;
    runup = { ...runup, confirmed: true };
    jump.runup = runup.value;
    lastRunup[a] = runup.value;
    redrawRunup();
    await saved;
    await hist.patchAttempt(id, { runup: runup.value });
    rejudge(id, runup.value);
    return;
  }
  const v = Math.max(2, Math.min(18, (runup.value ?? 12) + Number(b.dataset.runup)));
  runup = withExpected({ value: v, confirmed: false, from: 'edit' });
  redrawRunup();
});

function present(feel, noReplayNote) {
  runup = prefillRunup();
  renderResult(els, jump, player, {
    feel, noReplayNote, awaitingCoach, runup,
    onFeel: async n => {
      const id = resultId;
      await saved;
      await hist.patchAttempt(id, { feel: n });
      renderLists();
    },
  });
}

// Reopens a saved attempt: its clip, keypoints and numbers, no re-analysis.
async function openAttempt(id) {
  if (isBusy) return showTab('result');   // one result slot: reopening must not kill a running analysis
  const rec = await hist.getAttempt(id);
  if (!rec?.jump) return;
  const run = ++runId;
  clearResult();
  setWho(rec.athlete);
  openResultTab();
  showProgress('Otváram pokus');
  const media = await hist.loadMedia(id);
  if (run !== runId) return;
  jump = rec.jump;
  jump.feel = rec.feel;
  jump.runup = rec.runup ?? null;
  jump.measured = rec.measured ?? null;
  jump.split = rec.split ?? null;
  jump.tapeFrom = rec.tapeFrom ?? null;
  awaitingCoach = !!rec.coachPending;
  resultId = id;
  showPlace(id, rec.athlete);
  pose = media.pose;
  $('res-del').dataset.del = id;
  let note = null;
  if (media.clip && media.pose) {
    try {
      const r = await inspectClip(media.clip, mb, { name: rec.file });
      if (run !== runId) { r.input.dispose?.(); return; }
      current = r;
      await openPlayer(r, () => run === runId);
      if (run !== runId) return;
      $('res-msg').classList.add('hidden');
      if (player) setOverlays();
    } catch (e) { console.warn('Saved clip unreadable', e); }
  }
  if (!player) note = 'Video tohto pokusu už v telefóne nie je, čísla ostali.';
  $('res-progress').classList.add('hidden');
  $('res-empty').classList.add('hidden');
  present(rec.feel, note);
}

// ---------- Progres ----------
// Both athletes, one after the other.
async function renderLists() {
  const ids = Object.keys(ATHLETES);
  const all = await Promise.all(ids.map(a => hist.listAttempts(a)));
  ids.forEach((a, i) => { lastRunup[a] = all[i].findLast(r => r.runup != null)?.runup ?? null; });
  const i = ids.indexOf(athlete);
  $('trends').innerHTML = trendsHtml({ who: athlete, name: ATHLETES[athlete].name, runs: freelapView.runs(), attempts: all[i], rsi: rsiView.records() });
  const root = $('progress');
  root.innerHTML = hist.progressHtml(all[i], profiles[athlete], ATHLETES[athlete].name, athlete);
  root.querySelectorAll('[data-ath]').forEach(hist.wireTrend);
}

// ---------- Tréning and História ----------
const KINDS = {
  skok: { hint: 'Kto skáče, appka zistí z videa sama. Natočené v appke ide 240 fps; z Fotiek vyber originál (Share → Export Unmodified Original → Files).' },
  sprint: { hint: 'Natočené v appke ide 120 fps a s Freelapom aj s časmi vo videu. Rozbor príde sám.' },
  rsi: { hint: 'Drop jump, odrazy, prekážky aj výskok z miesta. Natáčaj spredu, celé chodidlá v zábere. Natočené v appke sa uloží s časmi.' },
};
let kind = 'skok', histFilter = 'all';
try { const k = localStorage.getItem('jump.kind'); if (k in KINDS) kind = k; } catch { /* storage blocked */ }
function drawKind() {
  document.querySelectorAll('.segc [data-kind]').forEach(b => b.classList.toggle('on', b.dataset.kind === kind));
  $('train-hint').textContent = KINDS[kind].hint;
  $('train-film').classList.toggle('hidden', !jumpCam);
}
function trainProgress(t) {
  $('train-progress').textContent = t || '';
  $('train-progress').classList.toggle('hidden', !t);
}
// The app's own camera, for jumps (sprint and RSI open it from their modules). null in Safari.
const jumpCam = (() => {
  const cap = globalThis.Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.nativePromise || !cap.addListener) return null;
  return { open: o => cap.nativePromise('SprintCamera', 'open', o), on: (ev, f) => cap.addListener('SprintCamera', ev, d => d && f(d)) };
})();
// A jump filmed in the app: saved to Photos as filmed, and analysed like an upload.
jumpCam?.on('saved', async d => {
  if (d.mode !== 'jump' || !d.raw) return;
  try {
    const src = globalThis.Capacitor?.convertFileSrc?.(d.raw) ?? d.raw;
    const blob = await (await fetch(src)).blob();
    analyzeFile(new File([blob], `skok-${d.recordedAt ?? Date.now()}.mov`, { type: 'video/quicktime', lastModified: d.recordedAt ?? Date.now() }));
  } catch (e) { trainProgress(`Natočený skok sa nepodarilo otvoriť: ${e?.message ?? e}`); }
});
document.querySelector('.segc').addEventListener('click', e => {
  const b = e.target.closest('[data-kind]');
  if (!b) return;
  kind = b.dataset.kind;
  try { localStorage.setItem('jump.kind', kind); } catch { /* storage blocked */ }
  drawKind(); drawFreelapMini();
});
$('train-film').addEventListener('click', () => {
  if (kind === 'sprint') return sprintView.film();
  if (kind === 'rsi') return rsiView.film();
  jumpCam?.open({ fps: 240, mode: 'jump', freelap: false }).catch(err => alert(`Kameru sa nepodarilo otvoriť: ${err?.message ?? err}`));
});

// Freelap at a glance on Tréning; its runs, by training, under História → Freelap.
function drawFreelapMini() {
  const el = $('fl-mini'), s = freelapView.listener.state, on = s === 'on' || s === 'starting';
  const today = freelapView.runs().filter(r => new Date(r.at).toDateString() === new Date().toDateString()).length;
  el.classList.toggle('hidden', !freelapView.listener || (kind !== 'sprint' && !on));
  el.innerHTML = `<div><b>Freelap</b> <span class="${s === 'on' ? 'fl-on' : 'fl-off'}">${s === 'on' ? '● počúva' : s === 'starting' ? 'zapína sa…' : 'vypnutý'}</span>
    <small>${today ? `${today} ${today === 1 ? 'beh' : today < 5 ? 'behy' : 'behov'} dnes` : 'dnes zatiaľ žiadny beh'} </small><button class="fl-all" data-fl-mini="list">Všetky časy ›</button></div>
    <button class="btn" data-fl-mini="${on ? 'stop' : 'start'}">${on ? 'Stop' : 'Start'}</button>
    ${on ? `<div class="fl-plan"><p class="sp-lb">Ďalšie behy</p>${freelapView.planHtml()}</div>` : ''}`;
}
$('fl-mini').addEventListener('change', e => { if (freelapView.planEvent(e)) drawFreelapMini(); });
$('fl-mini').addEventListener('click', e => {
  if (freelapView.planEvent(e)) return drawFreelapMini();
  const b = e.target.closest('[data-fl-mini]');
  if (!b) return;
  if (b.dataset.flMini === 'list') { showTab('history'); return document.querySelector('#hist-filter [data-f="freelap"]').click(); }
  if (b.dataset.flMini === 'start') freelapView.listener.start(); else freelapView.listener.stop();
  setTimeout(drawFreelapMini, 300); setTimeout(drawFreelapMini, 1500);
});
freelapView.onRun(() => { drawFreelapMini(); refreshFeeds(); });

async function feedItems() {
  const jumps = (await Promise.all(Object.keys(ATHLETES).map(a => hist.listAttempts(a)))).flat().map(r => jumpSummary(r, ATHLETES));
  return [...jumps, ...sprintView.records().map(r => sprintView.summary(r)), ...rsiView.records().map(r => rsiView.summary(r))]
    .filter(it => Number.isFinite(it.at));
}
async function refreshFeeds() {
  const items = await feedItems();
  $('today').innerHTML = todayHtml(items);
  if (histFilter !== 'freelap') $('hist-list').innerHTML = listHtml(items, histFilter);
}
$('hist-filter').addEventListener('click', e => {
  const b = e.target.closest('[data-f]');
  if (!b) return;
  histFilter = b.dataset.f;
  document.querySelectorAll('#hist-filter [data-f]').forEach(x => x.classList.toggle('on', x === b));
  const fl = histFilter === 'freelap';
  $('freelap').classList.toggle('hidden', !fl);
  $('hist-list').classList.toggle('hidden', fl);
  if (fl) freelapView.shown(); else refreshFeeds();
});

// A row opens its detail screen.
function openDetail(k, id, who) {
  const runKey = k === 'sprint' ? sprintView.records().find(r => r.id === id)?.runKey : null;
  $('fl-run').classList.toggle('hidden', !(runKey && freelapView.openRun(runKey)));
  $('sprint').classList.toggle('hidden', k !== 'sprint');
  $('rsi').classList.toggle('hidden', k !== 'rsi');
  if (k === 'sprint') sprintView.open(id); else rsiView.open(id, who);
  tabScroll.detail = 0;
  showTab('detail');
  scrollTo(0, 0);
}
// A Freelap time opens its run, with the video and the analysis when one goes with it.
function openRun(key) {
  const id = sprintOfRun(key);
  if (id) return openDetail('sprint', id);
  $('fl-run').classList.toggle('hidden', !freelapView.openRun(key));
  $('sprint').classList.add('hidden');
  $('rsi').classList.add('hidden');
  tabScroll.detail = 0;
  showTab('detail');
  scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const it = e.target.closest('[data-item]');
  if (!it) return;
  if (it.dataset.item === 'skok') return void openAttempt(it.dataset.id);
  openDetail(it.dataset.item, it.dataset.id, it.dataset.who);
});
$('back').addEventListener('click', () => showTab(backTo));
$('gear').addEventListener('click', () => showTab('settings'));

// The athlete in the header: who Progres shows, and the guess for a clip until the server tells.
function drawWho() { $('who').innerHTML = `${esc(ATHLETES[athlete].name)}<span class="who-swap" aria-hidden="true">⇄</span>`; }
$('who').addEventListener('click', () => { rememberAthlete(otherAthlete(athlete)); drawWho(); if (tab === 'progress') renderLists(); });

document.addEventListener('click', e => {
  const open = e.target.closest('[data-open]');
  if (open && !open.disabled) return void openAttempt(open.dataset.open);
  const del = e.target.closest('[data-del]');
  if (del && del.dataset.del) confirmDelete(del);
});

// Two taps, no dialog: the first arms the button for 3 s.
const delLabels = new WeakMap();
async function confirmDelete(btn) {
  if (!delLabels.has(btn)) {
    delLabels.set(btn, btn.textContent);
    btn.textContent = 'Naozaj?';
    btn.classList.add('armed');
    setTimeout(() => {
      if (!delLabels.has(btn)) return;
      btn.textContent = delLabels.get(btn);
      btn.classList.remove('armed');
      delLabels.delete(btn);
    }, 3000);
    return;
  }
  const id = btn.dataset.del;
  btn.textContent = delLabels.get(btn);
  btn.classList.remove('armed');
  delLabels.delete(btn);
  if (id === resultId) {          // the player must let go of the clip before it is removed
    await saved;
    runId++;
    clearResult();
    setWho(null);
    if (tab === 'result') showTab(backTo);
  }
  await hist.deleteAttempt(id);
  renderLists();
}

// ---------- settings ----------
function renderCloud() {
  $('cloud-state').textContent = cloudReady() ? 'Analýza pobeží na serveri.'
    : CLOUD_URL ? 'Vlož svoj prístupový kľúč, bez neho analýza nepobeží.' : 'Analýza pobeží v telefóne, trvá to niekoľko minút.';
}
// The native build for one person's phone carries their access code (tools/build-www.mjs
// --token-for); the web app has no such file and the fetch just fails.
fetch('build-config.json').then(r => (r.ok ? r.json() : null)).then(c => {
  if (!c?.token || getCloudToken()) return;
  setCloudToken(c.token);
  $('cloud-token').value = getCloudToken();
  renderCloud();
}).catch(() => {});
$('cloud-token').value = getCloudToken() ?? '';
$('cloud-save').addEventListener('click', () => {
  setCloudToken($('cloud-token').value.trim());
  $('cloud-save').textContent = 'Uložené';
  setTimeout(() => { $('cloud-save').textContent = 'Uložiť kľúč'; }, 1500);
  renderCloud();
});
renderCloud();

// Before the picker: the upload takes about as long as a cold start of the server.
$('train-pick').addEventListener('click', () => { if (cloudReady()) warmCloud(); });

$('file').addEventListener('change', e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (kind === 'sprint') sprintView.upload(f);
  else if (kind === 'rsi') rsiView.analyze(f);
  else analyzeFile(f);
});
drawKind(); drawWho(); drawFreelapMini(); refreshFeeds();

renderLists();
resumeCoaches();
resumeHeld();

function summaryOf(r) {
  const t = r.timing;
  return {
    app: APP_VERSION, verdict: r.verdict, file: r.file, container: r.container, codec: r.codecString ?? r.codec,
    size: `${r.width}x${r.height}`, rotation: r.rotation, fps: +fmt(t.fpsFromGap, 2), fpsSpan: +fmt(t.fpsFromSpan, 2),
    frames: t.frames, duration: +fmt(t.duration, 3), gapMs: [+fmt(t.minGapMs, 2), +fmt(t.medianGapMs, 2), +fmt(t.maxGapMs, 2)],
    irregularGaps: t.irregularGaps, keyframes: t.keyframes, maxGop: t.maxGop, reordering: t.hasReordering,
    canDecode: r.canDecode, readMs: Math.round(r.readMs), firstFrameMs: r.firstFrameMs && Math.round(r.firstFrameMs),
    playerStats: player?.src.stats, decodeError: r.decodeError, tags: r.tags, ua: navigator.userAgent,
  };
}

// Test hooks: feed a clip or a saved pose result without the picker or the models.
window.__analyzeFile = analyzeFile;
window.__player = () => player;
window.__pose = () => pose;
window.__jump = () => jump;
window.__loadPose = result => { pose = result; cloudCoach = null; $('res-progress').classList.add('hidden'); showJump(); };
window.__analyzePose = (file, opts) => analyzePose(file, () => true, opts);
// Test hook: runs the cloud flow against a fake job ({ signal, onResult, onProgress }) => Promise.
window.__followCloud = start => followCloud(runId, start);
if (TABS.includes(window.__bootTab)) { tab = null; showTab(window.__bootTab); } // tapped before the app had loaded
// The app starts in a few hundred ms from the phone's own files, which made the splash a flicker.
// Keep it about a second from launch so it reads as a loading screen.
const splash = $('splash');
if (splash) setTimeout(() => { splash.classList.add('gone'); setTimeout(() => splash.remove(), 300); }, Math.max(0, 1000 - performance.now()));
window.__appReady = true; // index.html shows a red bar if this line is never reached
