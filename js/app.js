import * as mb from '../vendor/mediabunny.min.mjs';
import { withPath } from './viewcopy.js';
import { inspectClip, VERDICT } from './footage.js';
import { FrameSource } from './frames.js';
import { Player } from './player.js';
import { skeletonOverlay } from './pose/overlay.js';
import { analyzeJump, cleanEdges } from './analysis/jump.js';
import { expectedDistance } from './analysis/runup.js';
import { coaching, coachFits } from './analysis/coach.js';
import { jointLabels, idealOverlay, flightOverlay } from './analysis/labels.js';
import { centreOfMass } from './analysis/kinematics.js';
import { idealsFor } from './analysis/ideal.js';
import { renderResult, showCoach, runupHtml, firstCellHtml, stopEdit } from './analysis/view.js';
import { initRsi } from './rsi-view.js';
import { initRozbeh, splitsOf } from './rozbeh-view.js';
import { initFreelap } from './freelap-view.js';
import { initSprint } from './sprint-view.js';
import { pairRun } from './analysis/sprint.js';
import { CHIPS } from './freelap/listen.js';
import { initCompare } from './compare-view.js';
let compareView = null;   // two jumps side by side (compare-view.js), set up below
import { jumpSummary, listHtml, todayHtml, trendsHtml } from './train-view.js';
import { initRecap, recapButtons } from './recap-view.js';
import { CLOUD_URL } from './config.js';
import { cloudReady, getCloudToken, setCloudToken, analyzeInCloud, enableNotifications, pendingCloudJob, resumeCloudJob, warmCloud, askAboutJump } from './cloud.js';
import { whatIf, bestAngle } from './analysis/whatif.js';
import { jumpTimeline, hudOverlay } from './hud.js';
import { burnAndSave } from './burn.js';
import * as hist from './history.js';
import { sessions, sessionPlace, skoky } from './sessions.js';

const APP_VERSION = '0.32.2';
let inBatch = false;   // a later clip of several picked at once: its screen does not open
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

// The jumps' own player for a stored clip (RSI, sprint): it decodes the clip itself, so it plays
// where a plain <video> would not (a struck-out play button on the phone, 2026-11-15).
async function clipPlayer(root, blob) {
  const r = await inspectClip(blob, mb, { name: 'clip.mov' });
  const p = new Player(root, new FrameSource(mb, r.track, r.packetTimestamps, r.keyTimestamps));
  await p.show(0);
  p.attachVideo(blob); // smooth playback; the canvas keeps steps and pause
  return { player: p, input: r.input };
}

// RSI tab: its own screen and storage.
const rsiView = initRsi({
  root: document.getElementById('rsi'), athletes: ATHLETES, bare: true,
  getAthlete: () => ({ id: athlete, ...ATHLETES[athlete] }), roster, rememberAthlete,
  onProgress: t => trainProgress(t),
  onDone: ({ rec, who }, o) => { refreshFeeds(); if (!o?.quiet && !inBatch) openDetail('rsi', rec.id, who); },
  onDeleted: () => { refreshFeeds(); renderLists(); showTab(backTo); },
  saveClip: (id, f) => { navigator.storage?.persist?.().catch(() => {}); return hist.storeClip(id, f); }, loadClip: hist.loadClip, dropClip: hist.deleteMedia,
  makePlayer: clipPlayer,
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
  onDone: (rec, o) => { refreshFeeds(); if (!o?.quiet && !inBatch) openDetail('sprint', rec.id); },
  onDeleted: () => { refreshFeeds(); renderLists(); showTab(backTo); },
  saveClip: (id, f) => { navigator.storage?.persist?.().catch(() => {}); return hist.storeClip(id, f); }, loadClip: hist.loadClip, dropClip: hist.deleteMedia,
  makePlayer: clipPlayer,
  onAsk: id => openSprintChat(id),
});
const sprintOfRun = key => sprintView.records().find(r => r.runKey === key)?.id ?? null;
// Rozbeh tab (2026-11-19): a full run-up with its take-off, never a landing. Own screen and storage.
let rbFeedTimer = null;
const rozbehView = initRozbeh({
  root: document.getElementById('rozbeh'), athletes: ATHLETES, freelap: freelapView,
  getAthlete: () => ({ id: athlete, ...ATHLETES[athlete] }), roster,
  inspect: async file => {
    const r = await inspectClip(file, mb);
    r.input.dispose?.();
    const ts = r.packetTimestamps ?? [];
    return { fps: r.timing.fpsFromGap, recordedAt: Date.parse(r.tags.creationTime) || null, duration: ts.length ? ts.at(-1) - ts[0] : null };
  },
  onProgress: t => trainProgress(t),
  onChange: () => { clearTimeout(rbFeedTimer); rbFeedTimer = setTimeout(() => { refreshFeeds(); rozbehView.refresh(); }, 250); },
  onDeleted: () => { refreshFeeds(); renderLists(); showTab(backTo); },
  saveClip: (id, f) => { navigator.storage?.persist?.().catch(() => {}); return hist.storeClip(id, f); },
  loadClip: hist.loadClip, loadOriginal: hist.loadOriginal, dropClip: hist.deleteMedia, storePose: hist.storePose, loadPose: id => hist.loadMedia(id).then(m => m.pose),
  makePlayer: clipPlayer,
});
// Two jumps side by side: each its own player with its skeleton and angles, lined up on the jump.
initRecap({ hist, athletes: ATHLETES, profiles });
compareView = initCompare({
  root: document.getElementById('compare'), athletes: ATHLETES,
  listAll: async () => (await Promise.all(Object.keys(ATHLETES).map(a => hist.listAttempts(a)))).flat(),
  loadOne: async id => { const rec = await hist.getAttempt(id); if (!rec) return null; const m = await hist.loadMedia(id); return { rec, clip: m.clip, pose: m.pose }; },
  makePane: async (el, x) => {
    const r = await inspectClip(x.clip, mb, { name: x.rec.file });
    const p = new Player(el, new FrameSource(mb, r.track, r.packetTimestamps, r.keyTimestamps));
    const k = p.src.width / x.pose.W;
    p.overlays.push(skeletonOverlay(x.pose, k));
    if (!x.rec.jump.error) p.overlays.push(jointLabels(x.rec.jump, x.pose, k));
    await p.show(0);
    return { player: p, input: r.input };
  },
});
// The test phone (www/fake.html on a *.localhost dev origin) drives these directly.
if (/\.localhost$/.test(location.hostname) && globalThis.__fake) globalThis.__app = { freelapView, sprintView, compareView, openDetail, showTab };
$('res-compare').addEventListener('click', async () => {
  if (!resultId) return;
  await saved;   // a jump just analysed is written to the history first
  player?.pause();
  openDetail('compare');
  compareView.pick(resultId);
});
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
const TABS = ['train', 'history', 'progress'], DETAILS = ['result', 'detail', 'settings', 'chat'];
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
  if (name !== 'detail') compareView?.close();
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
  playerCard: $('player-card'), detail: $('res-detail'), speed: $('res-speed'), coach: $('res-coach'), whatif: $('res-whatif'), timeline: $('res-timeline'), all: $('res-all'), take: $('res-take'),
};

// The video plays while it uploads and the server works (Stanley 2026-11-16: "počas nahrávania to
// ani neviem vidieť v appke"): the player card sits above the progress card until the numbers land,
// then goes back to its place in the result.
const playerHome = { parent: els.playerCard.parentNode, next: els.playerCard.nextSibling };
function playerToProgress() {
  if (!player || els.playerCard.nextSibling === $('res-progress')) return;
  $('res-progress').before(els.playerCard);
  els.playerCard.classList.remove('hidden');
}
function playerBackHome() {
  if (els.playerCard.parentNode !== playerHome.parent) playerHome.parent.insertBefore(els.playerCard, playerHome.next);
}

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
    currentFile = await hist.loadOriginal(oldId);   // not the watching copy: it would replace the original
    currentClip = { file: { name: old.file, size: old.size }, recordedAt: old.recordedAt };
  }
  // The numbers again with the other athlete's sex; the coaching from the server named the wrong
  // person, so the template stands in.
  cloudCoach = null; awaitingCoach = false;
  if (!showJump()) return;
  await saved;
  const newId = resultId;
  const corrected = old.measured != null || old.split != null || !!cleanEdges(old.edges);
  if (old.feel != null || old.runup != null || corrected || old.tapeFrom != null || old.edges) await hist.patchAttempt(newId, { feel: old.feel ?? null, runup: old.runup ?? null, measured: old.measured ?? null, split: old.split ?? null, tapeFrom: old.tapeFrom ?? null, edges: cleanEdges(old.edges) });
  if (newId === oldId) { if (corrected) { Object.assign(jump, { measured: old.measured ?? null, split: old.split ?? null, tapeFrom: old.tapeFrom ?? null, edges: cleanEdges(old.edges) }); rejudge(newId, old.runup ?? null, true); } return; }
  // The player still reads the old clip: let go of it, drop the old attempt, open the new one.
  runId++;
  clearResult();
  await hist.deleteAttempt(oldId);
  await openAttempt(newId);
  // the tape and the Freelap time correct the video: run the numbers again with them
  if (corrected && resultId === newId) rejudge(newId, old.runup ?? null, true);
}

let isBusy = false;
function setBusy(on) {
  isBusy = on;
  document.querySelector('.tab[data-tab=train]').classList.toggle('busy', on);
}

// One state at a time: idle, progress, message, or the result itself.
function clearResult() {
  stopEdit();
  abort?.abort(); abort = null;
  dropHeld();
  poseWorker?.terminate(); poseWorker = null;
  setBusy(false);
  player?.dispose(); player = null;
  $('player').innerHTML = '';
  current?.input?.dispose?.(); current = null;
  pose = null; jump = null; cloudCoach = null; awaitingCoach = false; resultId = null;
  for (const id of ['res-progress', 'res-msg', 'res-feel', 'res-after']) $(id).classList.add('hidden');
  playerBackHome();
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
  playerToProgress();
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

const ROUTE = globalThis.Capacitor?.isNativePlatform?.() ? 'Vyber ho cez Nahrať v appke: z galérie sa vezme tak, ako bolo natočené.' : 'Vo Photos daj Share → Export Unmodified Original, ulož do Files a tu vyber Choose File.';
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
  detachRunning();   // a jump still on its way keeps going in the background
  const run = ++runId;
  screenJob = null;
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
  currentClip = { file: { name: file.name, size: file.size }, recordedAt: r.tags.creationTime || null, duration: r.timing?.duration ?? null };

  // Silent when the clip is fine; speaks only when it can't give true timings.
  if (r.verdict === VERDICT.RENDERED) {
    // a normal-speed video lands here too, not only a baked copy (2026-11-19: a 30 fps long jump was called a copy)
    const f = fmt(r.timing.fpsFromGap, 0);
    showMsg('bad', `Video má len ${f} fps`, `Na skok treba spomalené video (120 fps). Pri ${f} fps padne odraz na doske medzi snímky. Ak bolo natočené spomalene: ${ROUTE}`);
    return summaryOf(r);
  }
  if (!r.canDecode) {
    showMsg('bad', 'Toto video sa tu nedá prehrať', 'Tento prehliadač nepozná jeho formát. Otvor aplikáciu v Safari na iPhone.');
    return summaryOf(r);
  }
  await openPlayer(r, () => run === runId, file);
  if (run !== runId) return { superseded: true };
  if (player && !window.__noPose) runAnalysis(file, run, false);
  return summaryOf(r);
}

let shownClip = null;   // the clip in the player, for the copy with the overlay burned in
async function openPlayer(r, stillCurrent, blob = null) {
  shownClip = blob;
  try {
    const src = new FrameSource(mb, r.track, r.packetTimestamps, r.keyTimestamps);
    if (!stillCurrent()) { src.dispose(); return; }
    player = new Player($('player'), src);
    const t0 = performance.now();
    await player.show(0);
    r.firstFrameMs = performance.now() - t0;
    // the phone's own decoder for dragging the timeline (the canvas keeps steps, pause and the drawings)
    if (blob) { try { player.attachVideo(blob); } catch (e) { console.warn('no native video', e); } }
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
  // A newer clip can take the screen during the awaits below; this one then finishes in the
  // background with its own clip instead of being dropped (2026-11-19, ten long jumps picked at once).
  const clip0 = currentClip, a0 = resultAthlete;
  const id = hist.attemptId(a0, clip0.file);
  await hist.storeClip(id, file);
  if (!stillCurrent()) return void cloudJumpInBackground(file, clip0, a0);
  hold({ id, athlete: a0, ...clip0 });
  const athletes = await roster();
  if (!stillCurrent()) return void cloudJumpInBackground(file, clip0, a0);
  const history = athletes.find(a => a.id === a0).history;
  // the job id goes with the held clip: a resume after iOS closed the app follows this clip's own
  // job, never "the newest one" (2026-11-19: IMG_2435 came back with IMG_2434's numbers)
  const onJob = j => { if (!stillCurrent()) return; screenJob = j; if (held && held.file?.name === clip0.file.name && held.file?.size === clip0.file.size) hold({ ...held, jobId: j }); };
  const fl = filmedRuns.get(clip0?.file?.name) ?? null;   // a gallery clip pairs once its touchdown is known
  return followCloud(run, opts => analyzeInCloud(file, { sex: who.sex, name: who.name, height: who.height, history, athletes, onJob, split: runSplit(fl), who: fl?.who ?? null, ...opts }));
}

async function followCloud(run, start) {
  const stillCurrent = () => run === runId;
  abort = new AbortController();
  const signal = abort.signal;
  $('res-notify').hidden = !(window.Notification?.permission === 'default');
  let numbersUp = false, attempt = null, p = null;
  const onResult = ({ result }) => {
    if (numbersUp || !stillCurrent()) return;
    numbersUp = true;
    if (detachable?.promise === p) detachable = null;   // saved below; the coach lands on its own
    abort = null;              // from here the job outlives this screen: only the coach is left
    adoptWho(result);
    pose = result;
    awaitingCoach = true;
    attempt = finishPose();
  };
  try {
    // Once the numbers are up the result screen shows its own "coaching on the way" slot; the
    // progress card must not come back on top of it for the coaching stage.
    p = start({ signal, onResult, onProgress: q => { if (stillCurrent() && !numbersUp) progressFrom(q); } });
    detachable = { promise: p, ctx: { id: held?.id ?? null, athlete: resultAthlete, file: currentFile, clip: currentClip } };
    const out = await p;
    if (detachable?.promise === p) detachable = null;
    if (numbersUp) return void landCoach(attempt, out.coach);
    if (!stillCurrent()) return;
    adoptWho(out.result);
    pose = out.result;
    cloudCoach = out.coach ?? null;
    finishPose();
  } catch (e) {
    if (detachable?.promise === p) detachable = null;
    if (numbersUp) return void landCoach(attempt, null);
    if (!stillCurrent() || signal.aborted) return;
    console.warn('Cloud analysis failed', e);
    if (/no person found/i.test(e.message)) return showMsg('bad', ...NOT_FOUND);
    showMsg('bad', 'Server teraz neodpovedá', e.name === 'CloudError' ? e.message : 'Skús to znova, alebo to nechaj prepočítať v telefóne, trvá to niekoľko minút.',
      '<button class="btn" data-retry="cloud">Skúsiť znova</button><button class="btn" data-retry="local">Analyzovať v telefóne</button>');
  }
}

// A jump still uploading or being analysed when the next one starts keeps going and lands in the
// history on its own (Stanley 2026-11-16: "keď sa nedokončí analýza, môžem začať nové natáčať a na
// pozadí sa tamto analyzuje"). The Tréning tab says how many are still on their way.
let detachable = null;            // the cloud job on screen: { promise, ctx }
const background = new Map();     // clip id -> ctx, jumps finishing in the background
function bgStatus(msg = '') {
  const n = background.size;
  trainProgress(n ? `${n === 1 ? 'Jeden skok sa' : `${n} skoky sa`} dokončuje na pozadí…${msg ? ` ${msg}` : ''}` : msg);
}
function detachRunning() {
  const d = detachable;
  if (!d || !abort || !d.ctx.id) return;
  detachable = null;
  abort = null;                   // clearResult must not cancel the upload or the job
  held = null;                    // nor drop its clip
  // it gets its row in the lists like any background jump, and the same saving: numbers, then coach
  bgSet(d.ctx.id, { athlete: d.ctx.athlete, clip: d.ctx.clip, at: Date.parse(d.ctx.clip?.recordedAt) || Date.now(), stage: 'server počíta', error: false });
  followBackground(d.ctx, () => d.promise);
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
let screenJob = null;   // the server job of the jump on the screen
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
  const job = h.jobId ? pendingCloudJob(h.jobId) : null;
  const clip = cloudReady() ? await hist.loadOriginal(h.id) : null;
  // closed before its upload went out: it goes now, in the background, from the stored clip
  if (clip && !h.jobId) { releaseHeld(); background.set(h.id, null); return void runQueue([{ id: h.id, file: clip, clip: { file: h.file, recordedAt: h.recordedAt }, athlete: h.athlete }]); }
  if (!clip || !job) { held = h; dropHeld(); return; }
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
    screenJob = job.jobId;
    await openPlayer(r, () => run === runId, clip);
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

// "Ty / + Ideál" on every phase frame that has norms (penultimate, board touchdown, deepest knee,
// toe-off, landing): the athlete's own skeleton with the angles that miss the elite norms moved
// into them, drawn as a ghost (ideal.js, labels.js). The switch shows on those frames and stays
// on while stepping between them.
const idealState = { on: false };
let ideals = [], ideal = null, flightIdeal = null;   // flightIdeal: { frame, you, ideal } take-off angle   // ideal: the one on the frame being shown
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
  ideal = ideals.find(x => x.frame === i) ?? null;
  const here = !!ideal || !!(flightIdeal && i === flightIdeal.frame);
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
    // the take-off angle's ideal path is drawn on this frame too
    const atTO = flightIdeal && i === flightIdeal.frame;
    if (atTO && !flightIdeal.ok) moved.push({ label: `najlepší uhol odrazu (+${Math.round(flightIdeal.gain * 100)} cm)`, ideal: flightIdeal.ideal, you: flightIdeal.you, oneDp: true });
    const okNote = atTO && flightIdeal.ok ? `<small class="sty-note">Uhol odrazu ${flightIdeal.you.toFixed(1).replace('.', ',')}° je ideálny.</small>` : '';
    legend.innerHTML = !show ? '' : moved.length
      ? `<b>${esc(ideal?.name ?? 'Ideál')} · priemer finalistov</b>${moved.map(it => `<span class="${it.oneDp || it.matters ? 'mat' : 'sty'}">${esc(it.label)} <strong>${it.oneDp ? `${it.ideal.toFixed(1).replace('.', ',')}°` : deg(it.ideal)}</strong> <em>ty ${it.oneDp ? `${it.you.toFixed(1).replace('.', ',')}°` : deg(it.you)}</em></span>`).join('')}${moved.some(it => !it.oneDp && !it.matters) ? '<small class="sty-note">Sivé je v rozptyle finalistov, to je tvoj štýl, nie chyba.</small>' : ''}${okNote}`
      : `<b>${esc(ideal?.name ?? '')}: postava je v norme finalistov</b>${okNote}`;
  }
}
function setOverlays() {
  player.overlays.length = 0;
  const k = player.src.width / pose.W;
  ideals = jump.error ? [] : idealsFor(jump, pose, ATHLETES[resultAthlete ?? athlete].sex);
  flightIdeal = null;
  ideal = null;
  player.overlays.push(skeletonOverlay(pose, k));   // the ghost draws over it, never in place of it
  idealState.on = false;
  if (!jump.error) player.overlays.push(jointLabels(jump, pose, k, { skip: i => idealState.on && ideals.some(x => x.frame === i) }));
  if (ideals.length) player.overlays.push(idealOverlay(ideals, k, idealState));
  if (!jump.error) {
    // take-off arrow and flight path; the ideal one when the take-off angle is out of its norm
    const sex = ATHLETES[resultAthlete ?? athlete].sex, to = jump.takeoff?.to, kp = pose.smooth?.[to];
    // the green path: his own best take-off angle, the one that gives the most distance (whatif.js)
    const fl = jump.flight, T = fl?.ground?.flightTime, G = 9.81;
    const drop = Number.isFinite(T) && Number.isFinite(fl?.vyTO) ? ((G * T - fl.vyTO) ** 2 - fl.vyTO ** 2) / (2 * G) : NaN;
    const best = bestAngle(fl?.vxTO, fl?.vyTO, drop, ATHLETES[resultAthlete ?? athlete].height / 100);
    const idTO = ideals.find(x => x.frame === to);
    // drawn only when it is a degree or more away; closer than that the legend just says the
    // angle is ideal (Stanley, 2026-11-14: "nechaj tak, len nech je poznámka, že ideál to je")
    const ok = !!best && Math.abs(best.angle - best.from) < 1;
    const ideal = best && !ok ? best : null;
    flightIdeal = best ? { frame: to, you: best.from, ideal: best.angle, gain: best.gain, ok } : null;
    player.overlays.push(flightOverlay(jump, pose, k, idealState, { com: kp && centreOfMass(kp, sex), idealCom: idTO?.kp ? centreOfMass(idTO.kp, sex) : null, ideal }));
    // the jump's panel over the video (hud.js), the same as burned into the copy for Photos
    player.overlays.push(hudOverlay(jumpTimeline(jumpHudData()), player, { W: player.src.width, H: player.src.height }, jumpHit));
    hookRingTap();
  }
  syncIdeal(player.index);
}
// "Znovu analyzovať" (Stanley, 2026-11-23: "daj tam tlačidlo všade"): the stored clip goes to the
// server again as a background jump under the same id, so the new reading replaces this one and
// the typed fields stay (saveNumbers). The row in Tréning / História shows it on its way.
document.addEventListener('click', async e => {
  const b = e.target.closest('#res-again');
  if (!b || !resultId || background.has(resultId)) return;
  if (!cloudReady()) return alert('Chýba spojenie so serverom.');
  const id = resultId, rec = await hist.getAttempt(id), blob = rec && await hist.loadOriginal(id);
  if (!blob) return alert('Video tohto skoku už v telefóne nie je.');
  const file = blob instanceof File ? blob : new File([blob], rec.file, { type: blob.type || 'video/quicktime', lastModified: Date.parse(rec.recordedAt) || Date.now() });
  const clip = { file: { name: rec.file, size: rec.size }, recordedAt: rec.recordedAt ?? null, duration: null };
  b.disabled = true; b.textContent = 'Posiela sa na server…';
  bgSet(id, { athlete: rec.athlete, clip, at: Date.parse(rec.recordedAt) || Date.now(), stage: 'posiela sa', error: false });
  showTab(backTo ?? 'history');
  runQueue([{ id, file, clip, athlete: rec.athlete }]).finally(() => { b.disabled = false; b.textContent = 'Znovu analyzovať'; });
});
// The copy for Photos with the jump's panel burned in, from the numbers of this moment (tape, Freelap).
document.addEventListener('click', e => {
  const b = e.target.closest('#res-burn');
  if (!b || !shownClip || !jump || jump.error) return;
  burnAndSave(b, shownClip, jumpTimeline(jumpHudData()), { name: 'skok' });
});
// What the jump's overlay shows: the tape when typed, else the estimate; Freelap's speed when paired.
const jumpHit = { ring: null };
function jumpHudData() {
  const m = Object.fromEntries((jump.metrics ?? []).filter(x => x.status !== 'hidden').map(x => [x.key, x.value]));
  const ts = player?.ts ?? [], at = i => (Number.isInteger(i) && ts[i] != null ? ts[i] - ts[0] : null);
  const split = jump.split ?? null;
  return { name: ATHLETES[resultAthlete ?? athlete]?.name ?? '', split, toT: at(jump.takeoff?.to), landT: at(jump.landing),
    approach: split > 0 ? 10 / split : m.speedApproach ?? m.speedLast ?? null, contact: m.contactTO != null ? m.contactTO / 1000 : null,
    angle: m.takeoffAngle ?? null, height: m.peakHeight ?? null, tape: jump.measured ?? null, est: m.estDistance ?? null, flight: m.flight != null ? m.flight / 1000 : null };
}
// A tap on the ring opens the tape field (Stanley, 2026-11-22: "musím vedieť prísť a zmeniť ten
// odhad vzdialenosti"): a typed distance re-runs every number and the overlay with it.
let ringHooked = null;
function hookRingTap() {
  const c = player?.canvas; if (!c || ringHooked === c) return;
  ringHooked = c;
  let down = null;
  c.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  c.addEventListener('pointerup', e => {
    const r = jumpHit.ring; if (!r || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 8) return;
    const box = c.getBoundingClientRect(), sx = c.width / box.width, sy = c.height / box.height;
    const x = (e.clientX - box.left) * sx, y = (e.clientY - box.top) * sy;
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;
    const f = document.querySelector('[data-measured]');
    if (f) { f.closest('details')?.setAttribute('open', ''); f.scrollIntoView({ behavior: 'smooth', block: 'center' }); setTimeout(() => f.focus(), 350); }
  });
}

function showJump() {
  const a = resultAthlete ?? athlete, who = ATHLETES[a];
  jump = analyzeJump(pose, who.sex, player.ts, { height: who.height, pb: profiles[a].pb });
  const self = currentClip?.file ? hist.attemptId(a, currentClip.file) : null;
  const fl = jump.error ? null : jumpRun(currentClip, a, player.ts?.[jump.takeoff.td] ?? null, self), split = runSplit(fl);
  if (split && self) runOwner.set(fl.key, self);
  if (split) { jump = analyzeJump(pose, who.sex, player.ts, { height: who.height, pb: profiles[a].pb, split }); if (!jump.error) { jump.split = split; jump.runKey = fl.key; } }
  setOverlays();
  player.refresh();
  if (jump.error) {
    console.warn('No jump', jump.error);
    showMsg('bad', ...(/nedá zmerať/.test(jump.error)
      ? ['Skok sa nedá zmerať', 'V zábere chýba doska alebo čiary dráhy, z ktorých sa počítajú metre a rýchlosť. Video si môžeš pozrieť; nabudúce natoč tak, aby bolo vidno dosku aj dráhu.']
      : NOT_FOUND));
    return null;
  }
  jump.coach = cloudCoach ?? (awaitingCoach ? null : coaching(jump.metrics, who.sex, { name: who.name }));   // analyzeJump doesn't know the name
  releaseHeld();                 // the clip now belongs to the attempt
  $('res-empty').classList.add('hidden');
  $('res-msg').classList.add('hidden');
  const rec = hist.attemptRecord(jump, { athlete: resultAthlete, ...currentClip });
  if (jump.runKey) rec.runKey = jump.runKey;
  rec.coachPending = awaitingCoach;
  rec.coachJob = awaitingCoach ? screenJob : null;
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
// speed-dependent norms move with it). The coaching text stays as it was written while it still fits.
// Only a time the athlete typed is Freelap truth; confirming the video's own 1-11 m time adds nothing.
const typedSplit = j => (j?.split != null && !(Math.abs(j.split - (j.speed?.split1to11 ?? -1)) < 0.006) ? j.split : null);
// force: run again although the run-up is the same (a new tape distance rescales the metres).
async function rejudge(id, v, force = false) {
  if (!pose || !jump || jump.error || (!force && (jump.runupJudged ?? null) === v)) return;
  const a = resultAthlete, who = ATHLETES[a];
  const next = analyzeJump(pose, who.sex, player?.ts ?? null, { height: who.height, pb: profiles[a].pb, runup: v, tape: jump.measured, tapeFrom: jump.tapeFrom ?? null, split: typedSplit(jump), edges: jump.edges ?? null });
  if (next.error || id !== resultId) return;
  // the written coaching stays unless today's numbers contradict it; then the template speaks
  const coach = coachFits(jump.coach, next.metrics) || jump.coach == null ? jump.coach : coaching(next.metrics, who.sex, { name: who.name });
  jump = Object.assign(next, { coach, feel: jump.feel, measured: jump.measured, split: jump.split, tapeFrom: jump.tapeFrom ?? null, runup: v, edges: jump.edges ?? null });
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
  // A tape distance or a Freelap time corrects the video: run every number again with it, so the
  // phases, the main point and O koľko ďalej all follow (Stanley, 2026-11-14).
  if (changed) rejudge(id, jump.runup ?? null, true);
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
  playerBackHome();
  runup = prefillRunup();
  renderResult(els, jump, player, {
    feel, noReplayNote, awaitingCoach, runup, sex: ATHLETES[resultAthlete ?? athlete].sex, name: ATHLETES[resultAthlete ?? athlete].name, height: ATHLETES[resultAthlete ?? athlete].height,
    onFeel: async n => {
      const id = resultId;
      await saved;
      await hist.patchAttempt(id, { feel: n });
      renderLists();
    },
    // a contact frame set by hand (frame) or given back to the analysis (null): saved on the
    // attempt and every number read again with it
    onEdge: async (key, frame) => {
      const id = resultId;
      if (!id || !jump || jump.error) return;
      await saved;
      const edges = { ...(jump.edges ?? {}) };
      if (frame == null) delete edges[key]; else edges[key] = frame;
      jump.edges = cleanEdges(edges);
      await hist.patchAttempt(id, { edges: jump.edges });
      await rejudge(id, jump.runup ?? null, true);
      if (frame != null && jump.edgesUsed?.[key] !== frame) showMsg('warn', 'Túto snímku nejde použiť. ', 'Dotyk a odraz by išli mimo poradia.');
    },
  });
  $('res-ask').classList.toggle('hidden', !cloudReady() || !jump || !!jump.error);
  $('res-again').classList.toggle('hidden', !cloudReady() || !resultId);
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
  jump.edges = cleanEdges(rec.edges);
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
      await openPlayer(r, () => run === runId, media.clip);
      if (run !== runId) return;
      $('res-msg').classList.add('hidden');
      if (player) setOverlays();
    } catch (e) { console.warn('Saved clip unreadable', e); }
  }
  if (!player) note = 'Video tohto pokusu už v telefóne nie je, čísla ostali.';
  $('res-progress').classList.add('hidden');
  $('res-empty').classList.add('hidden');
  present(rec.feel, note);
  // A saved jump is read again with today's code, so the score, the phases and O koľko ďalej
  // follow every fix (2026-11-14: the score stopped counting flight time and distance).
  if (pose && !jump.error) rejudge(id, jump.runup ?? null, true);
}

// ---------- Progres ----------
// Both athletes, one after the other.
async function renderLists() {
  const ids = Object.keys(ATHLETES);
  const all = await Promise.all(ids.map(a => hist.listAttempts(a)));
  ids.forEach((a, i) => { lastRunup[a] = all[i].findLast(r => r.runup != null)?.runup ?? null; });
  const i = ids.indexOf(athlete);
  $('trends').innerHTML = trendsHtml({ who: athlete, name: ATHLETES[athlete].name, runs: freelapView.runs(), attempts: all[i], rsi: rsiView.records(), rozbeh: rozbehView.records() });
  const root = $('progress');
  root.innerHTML = hist.progressHtml(all[i], profiles[athlete], ATHLETES[athlete].name, athlete);
  root.querySelectorAll('[data-ath]').forEach(hist.wireTrend);
}

// ---------- Tréning and História ----------
const KINDS = {
  skok: { hint: 'Kto skáče, appka zistí z videa sama. Natočené v appke ide 120 fps; Nahrať otvorí galériu a vezme video ako je natočené, aj viac naraz.' },
  rozbeh: { hint: 'Celý rozbeh s odrazom, bez dopadu. Natoč zboku ako akceleráciu. Časy 21–11 a 11–1 m z Freelapu (typ Rozbeh), 11–6 a 6–1 m ich rozdelí klobúčik na 5,2 m vo videu; kroky a odraz z videa.' },
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
// The Freelap run of a jump (Stanley, 2026-11-20: "zapnúť tiež Freelap meranie"): heard while the
// app filmed it, or on the Freelap list within the clip's time. Its last 10 m before the board is the
// 1-11 m time the jump otherwise only gets typed. who: the athlete when known (null: any chip).
// One run only: two athletes' runs in the window and no athlete known means no pairing.
// tTake: seconds into the clip of the board touchdown, once the analysis has it. The run is heard as
// the chip passes the 1 m cone, a moment before the board, and reaches the phone up to ~2 s later,
// so it has to land from 1.5 s before to 3 s after the touchdown. The whole clip is too loose: clips
// copied or edited together carry one time (IMG_5162-5166 all 11:08:49-50, 2026-11-20 test).
function jumpRun(clip, who = null, tTake = null, self = null) {
  const filmed = filmedRuns.get(clip?.file?.name);
  if (filmed) return filmed;
  const t = typeof clip?.recordedAt === 'string' ? Date.parse(clip.recordedAt) : clip?.recordedAt;
  if (!t || !Number.isFinite(tTake)) return null;
  const at = t + tTake * 1000;
  // a run already on another jump stays there (one run, one jump)
  const free = r => !runOwner.has(r.key) || runOwner.get(r.key) === self;
  const near = freelapView.runs().filter(r => r.type !== 'accel' && r.type !== 'fly' && r.legs?.length && r.at >= at - 1500 && r.at <= at + 3000 && (!who || !r.who || r.who === who) && free(r));
  return near.length === 1 ? near[0] : null;   // two runs that close: not ours to pick
}
// Runs the app's own camera heard, by the clip's file name: those need no time window.
const filmedRuns = new Map();
// Which jump each Freelap run went to (runKey -> attempt id), from the history at start.
const runOwner = new Map();
hist.listAttempts().then(l => { for (const r of l) if (r.runKey) runOwner.set(r.runKey, r.id); }).catch(() => {});
const runSplit = run => { const s = splitsOf(run?.legs)?.s1_11; return s > 0.8 && s < 2.5 ? +s.toFixed(3) : null; };
const chipNames = () => Object.fromEntries(Object.entries(CHIPS).map(([chip, w]) => [chip, ATHLETES[w]?.name ?? chip]));
const chipWho = name => Object.entries(ATHLETES).find(([, v]) => v.name === name)?.[0] ?? null;

// A jump filmed in the app: saved to Photos as filmed, and analysed like an upload.
let filmFor = 'skok';
jumpCam?.on('saved', async d => {
  if (d.mode !== 'jump' || !d.raw) return;
  // The runs the recorder heard go on the Freelap list first, so the jump pairs with its own run.
  const heard = d.freelap !== false && d.times?.length ? d.times.map(t => freelapView.addHeard({ key: t.key, chip: String(t.key).split(':')[0], who: chipWho(t.name), lap: t.lap, legs: t.legs, raw: t.raw ?? null, at: (d.recordedAt ?? Date.now()) + (t.arrived ?? 0) * 1000, type: 'rozbeh' })).filter(Boolean) : [];
  const name = `${filmFor === 'rozbeh' ? 'rozbeh' : 'skok'}-${d.recordedAt ?? Date.now()}.mov`;
  if (heard.length === 1) filmedRuns.set(name, heard[0]);   // one run while filming: that jump's
  try {
    const src = globalThis.Capacitor?.convertFileSrc?.(d.raw) ?? d.raw;
    const blob = await (await fetch(src)).blob();
    if (filmFor === 'rozbeh') return void rozbehView.upload(withPath(new File([blob], name, { type: 'video/quicktime', lastModified: d.recordedAt ?? Date.now() }), d.raw));
    analyzeFile(withPath(new File([blob], name, { type: 'video/quicktime', lastModified: d.recordedAt ?? Date.now() }), d.raw));
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
  if (cloudReady()) warmCloud();   // the server boots (~3 min) while the athlete films
  if (kind === 'sprint') return sprintView.film();
  if (kind === 'rsi') return rsiView.film();
  filmFor = kind;   // a run-up films with the jump camera and goes to Rozbeh when saved
  // 120 fps: the jump analysis is proven there; Miška's two 240 fps jumps (2026-11-16) failed
  // (Stanley: "vypni 240 fps v appke").
  jumpCam?.open({ fps: 120, mode: 'jump', freelap: freelapView.listening(), chips: chipNames() }).catch(err => alert(`Kameru sa nepodarilo otvoriť: ${err?.message ?? err}`));
});

// Freelap at a glance on Tréning; its runs, by training, under História → Freelap.
function drawFreelapMini() {
  const el = $('fl-mini'), s = freelapView.listener.state, on = s === 'on' || s === 'starting';
  const today = freelapView.runs().filter(r => new Date(r.at).toDateString() === new Date().toDateString()).length;
  el.classList.toggle('hidden', !freelapView.listener || (kind !== 'sprint' && kind !== 'rozbeh' && kind !== 'skok' && !on));
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
  freelapView.turn(b.dataset.flMini === 'start');
  setTimeout(drawFreelapMini, 300); setTimeout(drawFreelapMini, 1500);
});
freelapView.onRun(() => { drawFreelapMini(); refreshFeeds(); });
setTimeout(drawFreelapMini, 1500);   // a Start left on comes back on by itself

async function feedItems() {
  const jumps = (await Promise.all(Object.keys(ATHLETES).map(a => hist.listAttempts(a)))).flat().map(r => jumpSummary(r, ATHLETES));
  return [...jumps, ...bgRows(), ...rozbehView.records().map(r => rozbehView.summary(r)), ...sprintView.records().map(r => sprintView.summary(r)), ...rsiView.records().map(r => rsiView.summary(r))]
    .filter(it => Number.isFinite(it.at));
}
async function refreshFeeds() {
  const items = await feedItems();
  // "Video z tréningu" for every athlete who jumped that day
  const recapOf = day => recapButtons(items, day);
  $('today').innerHTML = todayHtml(items, recapOf);
  if (histFilter !== 'freelap') $('hist-list').innerHTML = listHtml(items, histFilter, recapOf);
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
  $('compare').classList.toggle('hidden', k !== 'compare');
  if (k === 'compare') {
    for (const el of ['fl-run', 'sprint', 'rsi', 'rozbeh']) $(el).classList.add('hidden');
    tabScroll.detail = 0; showTab('detail'); scrollTo(0, 0);
    return;
  }
  compareView?.close();
  const runKey = k === 'sprint' ? sprintView.records().find(r => r.id === id)?.runKey : null;
  $('fl-run').classList.toggle('hidden', !(runKey && freelapView.openRun(runKey)));
  $('sprint').classList.toggle('hidden', k !== 'sprint');
  $('rsi').classList.toggle('hidden', k !== 'rsi');
  $('rozbeh').classList.toggle('hidden', k !== 'rozbeh');
  if (k === 'sprint') sprintView.open(id); else if (k === 'rozbeh') rozbehView.open(id); else rsiView.open(id, who);
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
  $('rozbeh').classList.add('hidden');
  tabScroll.detail = 0;
  showTab('detail');
  scrollTo(0, 0);
}
document.addEventListener('click', e => {
  const it = e.target.closest('[data-item]');
  if (!it) return;
  if (it.dataset.item === 'skok' && it.dataset.id.startsWith('bg:')) return void bgTap(it.dataset.id.slice(3));
  if (it.dataset.item === 'skok') return void openAttempt(it.dataset.id);
  openDetail(it.dataset.item, it.dataset.id, it.dataset.who);
});
$('back').addEventListener('click', () => showTab(tab === 'chat' ? chatBack : backTo));
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
$('train-pick').addEventListener('click', e => {
  if (cloudReady()) warmCloud();
  if (!jumpCam) return;            // Safari: the file input as before
  e.preventDefault();              // the app: straight from Photos, the original file
  pickFromGallery();
});

// Videos picked in Photos come as the original files (the native picker, SprintCamera.pickVideo):
// no "Export Unmodified Original → Files" any more (Stanley 2026-11-16). Several at once: the first
// jump opens on the screen, the others go straight to the background, each with its own clip and
// result, two at a time (2026-11-19: of ten long jumps picked at once only the first and the last
// were saved, the last with the ninth one's numbers: each new clip took over the screen's clip
// before the one before had left, and the one before was dropped or saved under the new clip).
// Sprints and RSI queue on their own.
async function pickFromGallery() {
  let files;
  try { files = (await globalThis.Capacitor.nativePromise('SprintCamera', 'pickVideo', { limit: 10 }))?.files ?? []; }
  catch (err) { return alert(`Galériu sa nepodarilo otvoriť: ${err?.message ?? err}`); }
  const picked = kind;   // the switch can change while the clips wait their turn
  const pickedFor = athlete, rest = [];
  for (const [k, f] of files.entries()) {
    let file;
    try {
      const blob = await (await fetch(globalThis.Capacitor.convertFileSrc(f.path))).blob();
      file = withPath(new File([blob], f.name || `video-${Date.now()}.mov`, { type: blob.type || 'video/quicktime', lastModified: Date.now() }), f.path);
    } catch (err) { trainProgress(`Video ${f.name ?? ''} sa nepodarilo otvoriť.`); continue; }
    // Sprint and RSI take one upload at a time and drop a second one while busy (2026-11-17: of
    // several drop jumps picked at once only the first was analysed), so each waits its turn.
    if (picked === 'rozbeh') { await rozbehView.upload(file, { quiet: k > 0 }); continue; }
    if (picked === 'sprint' || picked === 'rsi') {
      const view = picked === 'sprint' ? sprintView : rsiView;
      while (view.busy()) await new Promise(r => setTimeout(r, 500));
      // only the first clip opens its screen: the next ones wait in the list, so the video being
      // watched is not swapped for the next upload (2026-11-17)
      inBatch = k > 0;
      try { await (picked === 'sprint' ? view.upload(file, null, null, null, false, inBatch) : view.analyze(file, null, null, inBatch)); } finally { inBatch = false; }
    } else if (k > 0 && cloudReady()) {
      rest.push(file);
    } else {
      const run = runId + 1;
      analyzeFile(file);
      if (k < files.length - 1 && !cloudReady()) await onItsWay(run);
    }
  }
  if (rest.length) {
    for (const f of rest) background.set(`wait:${f.name}:${f.size}`, null);   // counted from the start
    bgStatus();
    // every waiting clip is stored and listed first, so it still goes out if iOS closes the app
    const ready = [];
    for (const f of rest) { const w = await waitInBackground(f, pickedFor); background.delete(`wait:${f.name}:${f.size}`); if (w) { background.set(w.id, null); ready.push(w); } }
    bgStatus();
    await runQueue(ready);
  }
}
// Two background jumps at a time from a list of stored, listed clips.
// All of them go to the server at once and wait in its queue (2026-11-19: two at a time, the rest
// waited on a locked phone while the server sat idle).
async function runQueue(list) {
  const worker = async () => { for (let w; (w = list.shift());) { background.delete(w.id); await cloudJumpInBackground(w.file, w.clip, w.athlete); } };
  await Promise.all(Array.from({ length: Math.min(8, list.length) }, worker));
}
// The screen stays on while anything is on its way, so iOS does not pause the app mid-upload.
let awake = false;
function keepAwakeWhileBusy() {
  const busy = background.size > 0 || rozbehView.busy() || rozbehView.records().some(r => r.pending);
  if (busy === awake) return;
  awake = busy;
  globalThis.Capacitor?.nativePromise?.('SprintCamera', 'keepAwake', { on: busy }).catch(() => {});
}
setInterval(keepAwakeWhileBusy, 3000);
// A jump that never takes the screen (a batch past its first clip): read the clip, store it on the
// phone and list it as waiting. null when it can't be analysed.
async function waitInBackground(file, a) {
  let r;
  try { r = await inspectClip(file, mb); } catch { bgStatus(`Video ${file.name} sa nedá prečítať.`); return null; }
  r.input.dispose?.();
  if (r.verdict === VERDICT.RENDERED) { bgStatus(`${file.name}: video má len ${fmt(r.timing.fpsFromGap, 0)} fps, skok potrebuje spomalené.`); return null; }
  const clip = { file: { name: file.name, size: file.size }, recordedAt: r.tags.creationTime || null, duration: r.timing?.duration ?? null };
  const id = hist.attemptId(a, clip.file);
  bgSet(id, { athlete: a, clip, at: Date.parse(clip.recordedAt) || Date.now(), stage: 'čaká v rade', error: false });
  try { await hist.storeClip(id, file); } catch { /* the upload still goes; only a resume needs the stored clip */ }
  bgJobs.add({ id, athlete: a, clip, jobId: null });
  return { id, file, clip, athlete: a };
}
async function cloudJumpInBackground(file, clip, a) {
  const id = hist.attemptId(a, clip.file), ctx = { id, athlete: a, file, clip };
  bgSet(id, { athlete: a, clip, at: Date.parse(clip.recordedAt) || Date.now(), stage: 'posiela sa', error: false });
  try { await hist.storeClip(id, file); } catch { /* only a resume needs it */ }
  const who = ATHLETES[a], athletes = await roster();
  const fl = filmedRuns.get(clip?.file?.name) ?? null;
  await followBackground(ctx, opts => analyzeInCloud(file, { sex: who.sex, name: who.name, height: who.height, history: athletes.find(x => x.id === a)?.history ?? [], athletes, split: runSplit(fl), who: fl?.who ?? null, ...opts }));
}
// A background jump from its job to the history: the numbers are saved as soon as the server has
// them, and the coaching text lands on the saved jump when it comes (it is written on its own
// container since 2026-11-19, so it can be a minute or two behind). start(opts) is the upload or
// the resume of a job; opts carries onJob, onProgress and onResult.
async function followBackground(ctx, start) {
  const { id, athlete: a } = ctx;
  background.set(id, ctx);
  bgStatus();
  let jobId = null, saving = null;
  const saveOnce = result => (saving ??= saveNumbers(ctx, result, jobId));
  try {
    const out = await start({
      onJob: j => { jobId = j; bgJobs.add({ id, athlete: a, clip: ctx.clip, jobId: j }); bgSet(id, { stage: 'čaká na server' }); },
      onProgress: q => { if (!saving) bgSet(id, { stage: q?.stage === 'queued' ? 'čaká na server' : 'server počíta' }); },
      onResult: ({ result }) => { saveOnce(result); },
    });
    const t = await saveOnce(out?.result);
    if (t) await landCoach(t, out?.coach ?? null);
  } catch (e) {
    console.warn('Background jump failed', e);
    const t = saving ? await saving : null;
    if (t) await landCoach(t, null);
    else bgSet(id, { stage: 'nepodarilo sa · ťukni a skús znova', error: true });
  } finally {
    background.delete(id);
    bgJobs.drop(id);
    bgStatus();
  }
}
// The numbers of a background jump saved as an attempt, its coaching still to come. null when no
// jump came out: the row stays, with its stored clip, so it can be tried again.
async function saveNumbers(ctx, result, jobId) {
  const a = result?.who?.id in ATHLETES ? result.who.id : ctx.athlete, who = ATHLETES[a];
  let j = result && !result.error ? analyzeJump(result, who.sex, result.ts ?? null, { height: who.height, pb: profiles[a].pb }) : { error: 'no result' };
  const fl = j.error ? null : jumpRun(ctx.clip, a, result.ts?.[j.takeoff.td] ?? null, hist.attemptId(a, ctx.clip.file)), split = runSplit(fl);
  if (split) runOwner.set(fl.key, hist.attemptId(a, ctx.clip.file));
  if (split) j = analyzeJump(result, who.sex, result.ts ?? null, { height: who.height, pb: profiles[a].pb, split });
  if (j.error) { bgSet(ctx.id, { stage: 'skok sa nenašiel · ťukni a skús znova', error: true }); return null; }
  j.coach = null;
  if (split) j.split = split;   // Freelap's time stands like a typed one
  const rec = hist.attemptRecord(j, { athlete: a, ...ctx.clip });
  if (split) rec.runKey = fl.key;
  // A re-analysis keeps what was typed for this jump (feel, run-up steps, the tape); the hand-moved
  // contacts go, since redoing the reading is the point (2026-11-23, "Znovu analyzovať").
  const old = await hist.getAttempt(rec.id);
  for (const k of ['feel', 'runup', 'measured', 'tapeFrom']) if (old?.[k] != null && rec[k] == null) { rec[k] = old[k]; rec.jump[k] = old[k]; }
  rec.coachPending = true;
  rec.coachJob = jobId;
  await hist.saveAttempt(rec, { clip: ctx.file, pose: result });
  if (rec.id !== ctx.id) hist.dropIfOrphan(ctx.id);
  bgDone(ctx.id);
  renderLists();
  bgStatus(`Skok (${who.name}) je hotový.`);
  return { id: rec.id, athlete: a, jump: j, job: jobId, saved: Promise.resolve() };
}
// Rows for jumps on their way, in Tréning and História like sprint's and RSI's: one per clip,
// saying where it is. A failed one stays with "skúsiť znova" instead of vanishing.
const bgState = new Map();   // clip id -> { id, athlete, clip, at, stage, error }
let feedTimer = null;
const feedSoon = () => { clearTimeout(feedTimer); feedTimer = setTimeout(refreshFeeds, 250); };
function bgSet(id, patch) { bgState.set(id, { ...(bgState.get(id) ?? { id, added: Date.now() }), ...patch }); feedSoon(); }
function bgDone(id) { bgState.delete(id); feedSoon(); }
function bgRows() {
  return [...bgState.values()].filter(s => s.clip).map(s => ({
    // listed at the upload, so it shows under Dnes while it is on its way (the saved jump then
    // sits on the day it was filmed)
    kind: 'skok', id: `bg:${s.id}`, who: s.athlete, at: s.added,
    title: `Skok · ${s.clip.file.name}`, sub: s.stage, value: s.error ? '!' : '…', valueSub: s.error ? 'znova' : '',
  }));
}
async function bgTap(id) {
  const s = bgState.get(id);
  if (!s?.error || background.has(id)) return;
  const file = cloudReady() ? await hist.loadOriginal(id) : null;
  if (!file) { bgSet(id, { stage: 'video sa v telefóne nenašlo, nahraj ho znova' }); return; }
  bgSet(id, { stage: 'posiela sa', error: false });
  await runQueue([{ id, file, clip: s.clip, athlete: s.athlete }]);
}
// Background jumps in flight, kept so they finish after iOS closed the app: a batch of ten waits
// up to 25 min for the server, longer than the phone stays awake.
const BG_KEY = 'jump.bg';
const bgJobs = {
  list() { try { return JSON.parse(localStorage.getItem(BG_KEY)) || []; } catch { return []; } },
  write(l) { try { localStorage.setItem(BG_KEY, JSON.stringify(l)); } catch { /* storage blocked: no resume */ } },
  add(e) { this.write([...this.list().filter(x => x.id !== e.id), e]); },
  drop(id) { this.write(this.list().filter(x => x.id !== id)); },
};
async function resumeBackground() {
  const waiting = [];
  for (const e of bgJobs.list()) {
    if (background.has(e.id)) continue;
    if (!e.jobId) {   // never sent: send it now from the stored clip
      const file = cloudReady() ? await hist.loadOriginal(e.id) : null;
      if (file) { background.set(e.id, null); waiting.push({ id: e.id, file, clip: e.clip, athlete: e.athlete }); } else bgJobs.drop(e.id);
      continue;
    }
    const job = cloudReady() ? pendingCloudJob(e.jobId) : null;
    const file = job ? await hist.loadOriginal(e.id) : null;
    if (!file) { bgJobs.drop(e.id); hist.dropIfOrphan(e.id); continue; }
    const ctx = { id: e.id, athlete: e.athlete, file, clip: e.clip };
    bgSet(e.id, { athlete: e.athlete, clip: e.clip, at: Date.parse(e.clip?.recordedAt) || Date.now(), stage: 'server počíta', error: false });
    followBackground(ctx, opts => resumeCloudJob(e.jobId, opts));
  }
  for (const w of waiting) bgSet(w.id, { athlete: w.athlete, clip: w.clip, at: Date.parse(w.clip?.recordedAt) || Date.now(), stage: 'čaká v rade', error: false });
  if (waiting.length) { bgStatus(); await runQueue(waiting); }
}
// Until jump run `run` is uploading (it can then finish in the background) or is over.
async function onItsWay(run) {
  for (let t = 0; t < 600; t++) {
    if (run !== runId || (detachable && abort) || !isBusy && t > 3) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

$('file').addEventListener('change', e => {
  const f = e.target.files?.[0];
  e.target.value = '';
  if (!f) return;
  if (kind === 'sprint') sprintView.upload(f);
  else if (kind === 'rozbeh') rozbehView.upload(f);
  else if (kind === 'rsi') rsiView.analyze(f);
  else analyzeFile(f);
});
drawKind(); drawWho(); drawFreelapMini(); refreshFeeds();

renderLists();
resumeCoaches();
resumeHeld();
resumeBackground();
rozbehView.resume();

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

// ---------- Opýtaj sa: a chat about the jump on screen ----------
// The server sees this jump (numbers against the norms, the O koľko ďalej card, the earlier jumps)
// plus a digest of the athletes' own notes (server/chat.py). The conversation is kept on the attempt.
let chat = { id: null, kind: 'jump', messages: [], busy: false };
const n2 = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d).replace('.', ',') : null);
async function chatContext() {
  const a = resultAthlete ?? athlete, who = ATHLETES[a];
  const wi = whatIf(jump, who.sex, { height: who.height });
  const shown = (jump.metrics ?? []).filter(m => m.status !== 'hidden' && Number.isFinite(m.value))
    .map(m => ({ key: m.key, label: m.label, value: +Number(m.value).toFixed(2), unit: m.unit, norm: m.norm, status: m.status }));
  const past = (await hist.listAttempts(a)).filter(r => r.id !== resultId).slice(0, 6).map(r => ({
    date: (r.recordedAt || r.analysedAt || '').slice(0, 10), score: Number.isFinite(r.score) ? Math.round(r.score) : null,
    runup: r.runup ?? null, measured: r.measured ?? null, cue: r.cue ?? null,
  }));
  return {
    athlete: who.name, sex: who.sex, heightCm: who.height, pb: profiles[a]?.pb ?? null, goal: who.goal ?? null,
    recordedAt: currentClip?.recordedAt ?? null, runupSteps: jump.runup ?? null, measuredLength: jump.measured ?? null, split1to11: jump.split ?? jump.speed?.split1to11 ?? null,
    score: Number.isFinite(jump.score?.score) ? Math.round(jump.score.score) : null, mainPoint: els.pickTake ?? jump.coach?.take ?? null,
    metrics: shown,
    whatIf: (wi?.items ?? []).map(x => ({ fault: x.title, metric: x.label, now: x.now, norm: x.target, unit: x.unit, cmTotal: x.total?.map(v => Math.round(v * 100)) ?? null, cue: x.cue,
      effects: x.effects.map(e => ({ what: e.label, change: e.value, cm: e.cm?.map(v => Math.round(v * 100)) ?? null })) })),
    earlierJumps: past,
  };
}
function chatSuggestions() {
  if (chat.kind === 'sprint') {
    const c = sprintView.contextOf(chat.id)?.ctx, t = c?.tens ?? [], out = [];
    if (t.length >= 2 && t[1].time > t[0].time + 0.015) out.push('Prečo bola druhá desiatka pomalšia?');
    if (c?.sides?.l?.n >= 2 && c?.sides?.r?.n >= 2 && Math.abs(c.sides.r.flight - c.sides.l.flight) >= 0.015) out.push('Čo s rozdielom ľavá a pravá?');
    if (c?.looks?.aheadCm != null) out.push('Ako vyzerá môj dopad?');
    return [...out.slice(0, 2), 'Zlepšujem sa?'];
  }
  const wi = whatIf(jump, ATHLETES[resultAthlete ?? athlete].sex, { height: ATHLETES[resultAthlete ?? athlete].height });
  const Q = { speedLow: 'Ako prísť do dosky rýchlejšie?', flat: 'Ako na strmší odraz?', steep: 'Ako na plochší odraz?', hipDropHigh: 'Čo s bokmi v predposlednom?',
    sitting: 'Ako prebehnúť predposledný?', longContact: 'Ako byť kratšie na doske?', overReach: 'Ako nenaťahovať posledný krok?', landing: 'Ako na lepší doskok?' };
  const s = (wi?.items ?? []).slice(0, 2).map(x => Q[x.id] ?? `Čo s tým: ${x.title.toLowerCase()}?`);
  return [...s, 'Zlepšujem sa?'];
}
// The answer's light markdown: **bold**, the cue in „…“, paragraphs; anything else stays text.
const md = t => esc(t).replace(/\*\*([^*]{1,80})\*\*/g, '<b>$1</b>').replace(/„([^“]{1,60})“/g, '<span class="cue">„$1“</span>').split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
function drawChat() {
  const list = $('ch-list');
  list.innerHTML = chat.messages.map(m => `<div class="msg ${m.role === 'user' ? 'me' : 'bot'}">${m.role === 'user' ? esc(m.text) : md(m.text)}</div>`).join('')
    + (chat.busy ? '<div class="msg bot typing"><span></span><span></span><span></span></div>' : '')
    + (chat.error ? `<p class="banner bad">${esc(chat.error)}</p>` : '');
  $('ch-sugg').innerHTML = chat.messages.length ? '' : chatSuggestions().map(q => `<button type="button" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  $('ch-input').disabled = chat.busy;
  list.lastElementChild?.scrollIntoView({ block: 'end' });
}
// The same chat about a sprint run: its 10s, steps, the foot from the side, left and right, the
// advice and the athlete's earlier runs (sprint-view.js contextOf); kept on the run.
function openSprintChat(id) {
  const c = sprintView.contextOf(id);
  if (!c) return;
  if (!(chat?.id === id && chat.busy)) chat = { id, kind: 'sprint', messages: sprintView.chatOf(id), busy: false, error: null };
  const d = new Date(c.rec.at);
  $('ch-sub').textContent = `${c.ctx.athlete ?? ''} · šprint ${d.getDate()}. ${d.getMonth() + 1}. ${d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' })}`;
  const bits = [c.ctx.freelap ? `Freelap ${n2(c.ctx.freelap.lap)} s` : null, c.ctx.run?.freq ? `${n2(c.ctx.run.freq)} kr/s` : null, c.ctx.run?.contact ? `zem ${n2(c.ctx.run.contact, 3)} s` : null].filter(Boolean);
  $('ch-ctx').innerHTML = `Vidí tento beh${bits.length ? `: <b>${esc(bits.join(' · '))}</b>` : ''}, každý krok, tvoje predošlé behy a tvoje poznámky.`;
  chatBack = 'detail';
  showTab('chat');
  drawChat();
}
let chatBack = 'result';
async function openChat() {
  if (!jump || jump.error || !resultId) return;
  const rec = await hist.getAttempt(resultId);
  const who = ATHLETES[resultAthlete ?? athlete];
  chatBack = 'result';
  // an answer still on its way for this jump: keep that chat, don't drop the pending reply
  if (!(chat?.id === resultId && chat.busy)) chat = { id: resultId, kind: 'jump', messages: rec?.chat ?? [], busy: false, error: null };
  const d = new Date(rec?.recordedAt || rec?.analysedAt || Date.now());
  $('ch-sub').textContent = `${who.name} · skok ${d.getDate()}. ${d.getMonth() + 1}.${rec?.file ? ` · ${rec.file.replace(/\.[^.]+$/, '')}` : ''}`;
  const by = Object.fromEntries((jump.metrics ?? []).map(m => [m.key, m]));
  const bits = [['contactTO', 0, 'kontakt', 'ms'], ['takeoffAngle', 1, 'uhol', '°'], ['speedLast', 2, 'rýchlosť', 'm/s'], ['hipDrop', 1, 'boky', 'cm']]
    .filter(([k]) => by[k] && by[k].status !== 'hidden' && Number.isFinite(by[k].value)).map(([k, d2, l, u]) => `${l} ${n2(by[k].value, d2)}${u === '°' ? '°' : ` ${u}`}`);
  $('ch-ctx').innerHTML = `Vidí tento skok${bits.length ? `: <b>${esc(bits.join(' · '))}</b>` : ''}, kartu O koľko ďalej, tvoje predošlé skoky a tvoje poznámky.`;
  showTab('chat');
  drawChat();
}
async function sendChat(text) {
  text = String(text ?? '').trim();
  if (!text || chat.busy) return;
  const id = chat.id;
  chat.messages.push({ role: 'user', text });
  chat.busy = true; chat.error = null;
  drawChat();
  try {
    const sprint = chat.kind === 'sprint';
    const ctx = sprint ? sprintView.contextOf(id)?.ctx : await chatContext();
    if (!ctx) throw new Error('Tento beh sa nenašiel.');
    const answer = await askAboutJump(ctx, chat.messages.slice(-12), { kind: chat.kind });
    if (chat.id !== id) return;
    chat.messages.push({ role: 'assistant', text: answer });
  } catch (err) {
    if (chat.id !== id) return;
    chat.error = err?.message || 'Odpoveď sa nepodarilo získať.';
    chat.messages.pop();
    $('ch-input').value = text;
  }
  chat.busy = false;
  drawChat();
  if (chat.kind === 'sprint') sprintView.saveChat(id, chat.messages);
  else await hist.patchAttempt(id, { chat: chat.messages.slice(-30) }).catch(() => {});
}
$('res-ask').addEventListener('click', () => openChat());
$('ch-form').addEventListener('submit', e => { e.preventDefault(); const v = $('ch-input').value; $('ch-input').value = ''; sendChat(v); });
$('ch-sugg').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) sendChat(b.dataset.q); });

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
