import * as mb from '../vendor/mediabunny.min.mjs';
import { inspectClip, VERDICT } from './footage.js';
import { FrameSource } from './frames.js';
import { Player } from './player.js';
import { skeletonOverlay } from './pose/overlay.js';
import { analyzeJump } from './analysis/jump.js';
import { coaching } from './analysis/coach.js';
import { jointLabels } from './analysis/labels.js';
import { renderResult, showCoach } from './analysis/view.js';
import { CLOUD_URL } from './config.js';
import { cloudReady, getCloudToken, setCloudToken, analyzeInCloud, enableNotifications, pendingCloudJob, resumeCloudJob, warmCloud } from './cloud.js';
import * as hist from './history.js';

const APP_VERSION = '0.3.0';
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

let athlete = 'stanley';
try { const a = localStorage.getItem('athlete'); if (a in ATHLETES) athlete = a; } catch { /* storage blocked */ }

// Blank clears the field; anything outside a plausible jump is ignored.
function parseMetres(s) {
  const x = parseFloat(String(s).trim().replace(',', '.'));
  return x >= 1 && x <= 12 ? x : null;
}
const metresField = x => (x == null ? '' : x.toFixed(2).replace('.', ','));

function renderPb() {
  const { name } = ATHLETES[athlete], p = profiles[athlete];
  const note = p.goal == null ? `${name}, aký je tvoj cieľ? Zapíš ho sem.` : 'Zapíš svoj PB a uvidíš, koľko chýba.';
  $('pb-bar').innerHTML = hist.pbBarHtml(p, note);
}
function fillPbFields() {
  $('pb').value = metresField(profiles[athlete].pb);
  $('goal').value = metresField(profiles[athlete].goal);
  renderPb();
}
for (const key of ['pb', 'goal']) {
  $(key).addEventListener('change', () => {
    const v = parseMetres($(key).value);
    profiles[athlete][key] = v;
    $(key).value = metresField(v);
    saveProfile(athlete);
    renderPb();
    renderLists();
  });
}

// ---------- tabs ----------
let tab = 'home';
const tabScroll = {};
function showTab(name) {
  if (name === tab) return;
  tabScroll[tab] = scrollY;
  tab = name;
  for (const t of ['home', 'result', 'progress']) $(`view-${t}`).classList.toggle('hidden', t !== name);
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  $('athlete-switch').classList.toggle('hidden', name === 'result');
  $('res-who').classList.toggle('hidden', name !== 'result' || !resultAthlete);
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
  playerCard: $('player-card'), detail: $('res-detail'), speed: $('res-speed'), coach: $('res-coach'), all: $('res-all'),
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
  $('res-who').textContent = a ? ATHLETES[a].name : '';
  $('res-who').classList.toggle('hidden', tab !== 'result' || !a);
}

let isBusy = false;
function setBusy(on) {
  isBusy = on;
  document.querySelector('.tab[data-tab=result]').classList.toggle('busy', on);
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
  showTab('home');
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
  // The clip goes on the phone first: if the app is closed after the upload, the job can
  // be picked up again and still has its replay.
  const id = hist.attemptId(resultAthlete, currentClip.file);
  await hist.storeClip(id, file);
  if (!stillCurrent()) return;
  hold({ id, athlete: resultAthlete, ...currentClip });
  const history = hist.coachHistory(await hist.listAttempts(resultAthlete));
  return followCloud(run, opts => analyzeInCloud(file, { sex: who.sex, name: who.name, height: who.height, history, ...opts }));
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

function setOverlays() {
  player.overlays.length = 0;
  const k = player.src.width / pose.W;
  player.overlays.push(skeletonOverlay(pose, k));
  if (!jump.error) player.overlays.push(jointLabels(jump, pose, k));
}

function showJump() {
  const who = ATHLETES[resultAthlete ?? athlete];
  jump = analyzeJump(pose, who.sex, player.ts, { height: who.height });
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
  saved = hist.saveAttempt(rec, { clip: currentFile, pose }).then(out => {
    renderLists();
    if (out.ok && !out.media.clip) console.warn('Replay not kept: no space for the clip');
  });
  present(null);
  return { id: rec.id, athlete: resultAthlete, jump, job: rec.coachJob, saved };
}

function present(feel, noReplayNote) {
  renderResult(els, jump, player, {
    feel, noReplayNote, awaitingCoach,
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
  awaitingCoach = !!rec.coachPending;
  resultId = id;
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

// ---------- Domov and Progres ----------
async function renderLists() {
  const a = athlete, { name } = ATHLETES[a];
  const records = await hist.listAttempts(a);
  if (a !== athlete) return;
  const last = records.at(-1);
  const el = $('latest');
  if (!last) {
    el.disabled = true;
    el.innerHTML = `<span class="latest-l">Posledné skóre</span><span class="latest-n">–</span><span class="latest-s">${esc(name)} zatiaľ nemá žiadny pokus.</span>`;
  } else {
    const waiting = hist.needsFeel(last);
    el.disabled = !(last.schema >= hist.SCHEMA);
    el.dataset.open = last.id;
    el.innerHTML = `<span class="latest-l">Posledné skóre</span>
      <span class="latest-n">${waiting || last.score == null ? '–' : Math.round(last.score)}<small>/ 100</small></span>
      <span class="latest-s">${waiting ? 'Klepni a povedz, ako sa to cítilo' : esc(hist.fmtDate(last.recordedAt))}</span>`;
  }
  const root = $('progress');
  root.innerHTML = hist.progressHtml(records, profiles[a], name);
  hist.wireTrend(root);
}

function setAthlete(a) {
  athlete = a;
  try { localStorage.setItem('athlete', a); } catch { /* storage blocked */ }
  document.querySelectorAll('[data-athlete]').forEach(b => {
    b.classList.toggle('on', b.dataset.athlete === a);
    b.setAttribute('aria-checked', String(b.dataset.athlete === a));
  });
  fillPbFields();
  renderLists();
}
document.querySelectorAll('[data-athlete]').forEach(b => b.addEventListener('click', () => setAthlete(b.dataset.athlete)));

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
    if (tab === 'result') showTab('progress');
  }
  await hist.deleteAttempt(id);
  renderLists();
}

// ---------- settings ----------
function renderCloud() {
  $('cloud-state').textContent = cloudReady() ? 'Analýza pobeží na serveri.'
    : CLOUD_URL ? 'Vlož svoj prístupový kľúč, bez neho analýza nepobeží.' : 'Analýza pobeží v telefóne, trvá to niekoľko minút.';
}
$('cloud-token').value = getCloudToken() ?? '';
$('cloud-save').addEventListener('click', () => {
  setCloudToken($('cloud-token').value.trim());
  $('cloud-save').textContent = 'Uložené';
  setTimeout(() => { $('cloud-save').textContent = 'Uložiť kľúč'; }, 1500);
  renderCloud();
});
renderCloud();

// Before the picker: the upload takes about as long as a cold start of the server.
document.querySelector('label[for=file]').addEventListener('click', () => { if (cloudReady()) warmCloud(); });

$('file').addEventListener('change', e => {
  const f = e.target.files?.[0];
  if (f) analyzeFile(f);
  e.target.value = '';
});

setAthlete(athlete);
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
