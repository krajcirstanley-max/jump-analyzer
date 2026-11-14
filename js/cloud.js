// Client for the analysis server: uploads the clip, follows the job, returns the result in
// the same shape the local worker produces. Upload must finish while the app is open; after
// that the job runs on its own and a push arrives when it is done.
import { CLOUD_URL } from './config.js';

const TOKEN_KEY = 'ja-cloud-token';
const JOBS_KEY = 'ja-cloud-jobs';
const OLD_JOB_KEY = 'ja-cloud-job';   // single entry written by earlier versions
const JOB_KEEP_MS = 7 * 24 * 3600_000; // the server forgets a job after a week
const JOBS_MAX = 20;
export const MAX_UPLOAD = 300 * 1024 * 1024;

const POLL_MS = 1500;
const UPLOAD_TRIES = 3;
const RETRY_MS = 1500;           // first backoff after a failed upload; doubles
const POLL_FAIL_LIMIT_MS = 5 * 60_000; // keep polling through a bad network this long
const JOB_LIMIT_MS = 10 * 60_000;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};

// Pending jobs, oldest first. Athletes upload back to back, so each job has its own entry
// and finishing one must leave the others alone.
function readJobs() {
  let list = [];
  try { list = JSON.parse(store.get(JOBS_KEY)) || []; } catch { /* corrupt: start over */ }
  if (!Array.isArray(list)) list = [];
  try {
    const old = JSON.parse(store.get(OLD_JOB_KEY));
    if (old?.jobId && !list.some(j => j.jobId === old.jobId)) list.unshift(old);
  } catch { /* nothing usable there */ }
  const cutoff = Date.now() - JOB_KEEP_MS;
  return list.filter(j => j?.jobId && j.at > cutoff);
}
function writeJobs(list) {
  store.set(JOBS_KEY, JSON.stringify(list.slice(-JOBS_MAX)));
  store.del(OLD_JOB_KEY);
}
const rememberJob = jobId => writeJobs([...readJobs().filter(j => j.jobId !== jobId), { jobId, at: Date.now() }]);
const forgetJob = jobId => writeJobs(readJobs().filter(j => j.jobId !== jobId));

const base = () => CLOUD_URL.replace(/\/+$/, '');
export const getCloudToken = () => store.get(TOKEN_KEY) || '';
export const setCloudToken = t => (t ? store.set(TOKEN_KEY, String(t).trim()) : store.del(TOKEN_KEY));
export const cloudReady = () => Boolean(base() && getCloudToken());
const auth = () => ({ Authorization: `Bearer ${getCloudToken()}` });

// ---------- Result on the wire ----------
// JSON cannot carry Float32Array or NaN, so frames travel as number arrays with null for NaN.
const plain = a => a && Array.from(a, v => (Number.isNaN(v) || v == null ? null : +v.toFixed(2)));
const typed = a => a && Float32Array.from(a, v => (v == null ? NaN : v));

export function toWire(res, ts) {
  const r = { ...res, ts: ts.map(t => +t.toFixed(6)) };
  for (const k of ['fast', 'accurate', 'clean', 'smooth']) r[k] = res[k]?.map(plain);
  r.boxes = res.boxes?.map(b => b && b.map(v => +v.toFixed(1)));
  return r;
}

// Same arrays the worker hands over. The server runs this on its own output too, so the
// numbers it writes coaching from are the numbers the phone computes.
export function fromWire(w) {
  const r = { ...w };
  for (const k of ['fast', 'accurate', 'clean', 'smooth']) r[k] = w[k]?.map(typed);
  return r;
}

// ---------- Errors ----------
export class CloudError extends Error {
  constructor(msg, transient = false) { super(msg); this.name = 'CloudError'; this.transient = transient; }
}
const NET = 'Nepodarilo sa spojiť so serverom. Skontroluj pripojenie a skús to znova.';
const aborted = () => new DOMException('Analýza bola zrušená.', 'AbortError');

function statusError(status, detail) {
  if (status === 401 || status === 403) return new CloudError('Prístupový kľúč nie je platný. Skontroluj ho v nastaveniach.');
  if (status === 413) return new CloudError(`Video je väčšie ako ${MAX_UPLOAD / 1048576} MB. Skráť ho a skús to znova.`);
  if (status === 404) return new CloudError('Server túto analýzu nepozná. Spusti ju znova.');
  if (status === 408 || status === 425 || status === 429 || status >= 500) return new CloudError('Server je práve nedostupný. Skúsim to znova.', true);
  return new CloudError(detail || `Server odmietol požiadavku (${status}).`);
}

const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(aborted());
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(aborted()); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

// ---------- Upload ----------
// XHR, because fetch has no upload progress in Safari.
function post(url, file, { signal, onProgress }) {
  return new Promise((res, rej) => {
    if (signal?.aborted) return rej(aborted());
    const x = new XMLHttpRequest();
    const onAbort = () => x.abort();
    const done = fn => v => { signal?.removeEventListener('abort', onAbort); fn(v); };
    x.open('POST', url);
    x.setRequestHeader('Authorization', auth().Authorization);
    x.setRequestHeader('Content-Type', 'application/octet-stream');
    x.upload.onprogress = e => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    x.onload = done(() => {
      let body = null;
      try { body = JSON.parse(x.responseText); } catch { /* not json */ }
      if (x.status >= 200 && x.status < 300 && body?.jobId) res(body);
      else rej(statusError(x.status, body?.detail));
    });
    x.onerror = done(() => rej(new CloudError(NET, true)));
    x.ontimeout = done(() => rej(new CloudError(NET, true)));
    x.onabort = done(() => rej(aborted()));
    signal?.addEventListener('abort', onAbort, { once: true });
    x.send(file);
  });
}

async function upload(file, query, { signal, onProgress }) {
  const url = `${base()}/jobs?${query}`;
  const report = (done, total) => onProgress?.({ stage: 'Nahrávam video', done, total });
  for (let attempt = 1; ; attempt++) {
    try {
      report(0, file.size);
      return await post(url, file, { signal, onProgress: report });
    } catch (e) {
      if (e.name === 'AbortError' || !e.transient || attempt >= UPLOAD_TRIES) throw e;
      await sleep(RETRY_MS * 2 ** (attempt - 1), signal);
    }
  }
}

// ---------- Following a job ----------
const STAGES = {
  'Finding the jumper': 'Hľadám skokana',
  'Following the jumper': 'Sledujem skokana',
  'Tracking pose': 'Sledujem pohyb',
  'Precise pose': 'Spresňujem pohyb',
  'Cleaning the track': 'Čistím záznam',
  'Loading models': 'Pripravujem analýzu',
  queued: 'Čakám na server',
  locate: 'Hľadám odraz vo videu',
  ground: 'Meriam dosku a piesok',
  camera: 'Sledujem pohyb telefónu',
  rsi: 'Počítam kontakty a lety',
  contacts: 'Hľadám kontakty so zemou',
  analysis: 'Počítam výsledky',
  coach: 'Píšem odporúčania',
};
export const stageLabel = s => STAGES[s] || s || 'Pracujem';

async function getJob(id, signal, haveResult) {
  let r;
  try {
    r = await fetch(`${base()}/jobs/${encodeURIComponent(id)}${haveResult ? '?omit=result' : ''}`, { headers: auth(), cache: 'no-store', signal });
  } catch (e) {
    if (e?.name === 'AbortError') throw aborted();
    throw new CloudError(NET, true);
  }
  if (!r.ok) throw statusError(r.status);
  try { return await r.json(); } catch { throw new CloudError(NET, true); }
}

// A phone that locks mid-job stops the timers; on wake the first request often fails,
// so failures are only fatal after a long unbroken stretch of them.
async function follow(id, { signal, onProgress, onResult, t0 }) {
  let okAt = Date.now();
  const started = Date.now();
  let have = null;
  // Once, as soon as the numbers exist; the coaching text comes later.
  const announce = wire => {
    if (have) return;
    if (wire.error) throw new CloudError(wire.error);
    have = fromWire(wire);
    onResult?.({ result: have, ms: Date.now() - t0 });
  };
  for (;;) {
    if (signal?.aborted) throw aborted();
    if (Date.now() - started > JOB_LIMIT_MS) throw new CloudError('Analýza trvá neobvykle dlho. Skús to znova.');
    let job = null;
    try {
      job = await getJob(id, signal, Boolean(have));
      okAt = Date.now();
    } catch (e) {
      if (e.name === 'AbortError' || !e.transient) { if (e.name !== 'AbortError') forgetJob(id); throw e; }
      if (Date.now() - okAt > POLL_FAIL_LIMIT_MS) throw new CloudError(NET);
    }
    if (job) {
      if (job.state === 'error') {
        forgetJob(id);
        if (have) return { result: have, coach: null, ms: Date.now() - t0 };
        throw new CloudError(job.error || 'Analýza zlyhala. Skús to znova.');
      }
      if (job.result) {
        try { announce(job.result); } catch (e) { forgetJob(id); throw e; }
      }
      if (job.state === 'done') {
        forgetJob(id);
        if (!have) throw new CloudError('Analýza zlyhala. Skús to znova.');
        return { result: have, coach: job.coach ?? null, ms: Date.now() - t0 };
      }
      const s = job.state === 'queued' ? 'queued' : job.stage;
      onProgress?.({ stage: stageLabel(s), done: job.done ?? 0, total: job.total ?? 1 });
    }
    await sleep(POLL_MS, signal);
  }
}

// ---------- Public ----------
// Natočiť / Nahrať / an upload: holds a GPU up on the server for WARM_MIN (api.py /warm with
// minutes), so the ~3 min cold start runs while the athlete films and the container is still
// there when the clip arrives, locked phone or not. Each tap pushes it out again; nothing runs
// longer than WARM_MIN after the last one (Stanley, 2026-11-14: warm on filming only, no
// open-ended training session at ~4 $/h).
export const WARM_MIN = 6;
export function warmCloud() {
  if (!cloudReady()) return;
  fetch(`${base()}/warm?minutes=${WARM_MIN}`, { method: 'POST', headers: auth() }).catch(() => {});
}

export async function analyzeInCloud(file, { sex, name, height, history, athletes = null, mode = 'jump', boxCm = null, onProgress, onResult, signal } = {}) {
  if (!cloudReady()) throw new CloudError('Server nie je nastavený.');
  if (file.size > MAX_UPLOAD) throw statusError(413);
  const t0 = Date.now();
  warmCloud();
  const params = new URLSearchParams({ sex: sex || 'male', name: name || '' });
  if (height) params.set('height', String(height));
  if (mode === 'rsi') { params.set('mode', 'rsi'); if (boxCm) params.set('box', String(boxCm)); }
  if (mode === 'sprint') params.set('mode', 'sprint');
  // The query string is bounded, and the newest attempts matter most.
  let h = (history || []).slice(-5);
  while (h.length && JSON.stringify(h).length > 6000) h = h.slice(1);
  if (h.length) params.set('history', JSON.stringify(h));
  // Everyone who may be in the clip: the server tells who it is. Same bound on the histories.
  if (athletes?.length) {
    const r = athletes.map(a => ({ ...a, history: (a.history || []).slice(-5) }));
    while (JSON.stringify(r).length > 6000 && r.some(a => a.history.length)) for (const a of r) a.history = a.history.slice(1);
    params.set('athletes', JSON.stringify(r));
  }
  const { jobId } = await upload(file, params, { signal, onProgress });
  // RSI and sprint jobs take seconds and the jump screen would not know what to do with one on resume.
  if (mode === 'jump') rememberJob(jobId);
  return follow(jobId, { signal, onProgress, onResult, t0 });
}

// Jobs the app lost track of (closed mid-analysis, opened again from the push).
export const pendingCloudJobs = () => readJobs();

// With an id: that job if it is still pending, else null. Without: the newest pending job.
export function pendingCloudJob(jobId) {
  const list = readJobs();
  if (jobId === undefined) return list.at(-1) ?? null;
  return list.find(j => j.jobId === jobId) ?? null;
}

export function resumeCloudJob(jobId, { onProgress, onResult, signal } = {}) {
  return follow(jobId, { signal, onProgress, onResult, t0: Date.now() });
}

const b64bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

// Call straight from a tap: iOS only asks for permission inside a user gesture, and only
// in an app added to the Home Screen (elsewhere PushManager does not exist).
export async function enableNotifications() {
  if (!cloudReady() || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return false;
  if (await Notification.requestPermission() !== 'granted') return false;
  try {
    await navigator.serviceWorker.register('sw.js');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const r = await fetch(`${base()}/push/key`, { headers: auth() });
      if (!r.ok) return false;
      const { publicKey } = await r.json();
      if (!publicKey) return false;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64bytes(publicKey) });
    }
    const r = await fetch(`${base()}/push/subscribe`, {
      method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify(sub),
    });
    return r.ok;
  } catch (e) {
    console.warn('Push setup failed', e);
    return false;
  }
}
