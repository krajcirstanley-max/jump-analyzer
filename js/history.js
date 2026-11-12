// Attempt history per athlete. Metrics + the full jump object live in IndexedDB; the clip
// and pose keypoints live in OPFS (IndexedDB as a fallback), so reopening an attempt shows
// its replay without re-analysis.

import { fromWire } from './cloud.js';
import { sessions, skoky, dayLabel } from './sessions.js';

const DB = 'jump-analyzer', STORE = 'attempts', BLOBS = 'blobs', DIR = 'attempts';
export const SCHEMA = 2;   // records without `schema` predate v1: numbers only, no replay

export const PHASE_LABELS = [
  ['pen', 'Predposledný'], ['plant', 'Plant'], ['toeoff', 'Odraz'], ['flight', 'Let'], ['landing', 'Dopad'],
];

let dbp = null;
function open() {
  return dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('athlete', 'athlete');
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    req.onerror = () => { dbp = null; reject(req.error); };
  });
}

async function tx(mode, fn, store = STORE) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => resolve(out instanceof IDBRequest ? out.result : out);   // a missing key is undefined, not the request
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// ---------- records ----------

// One record per athlete + clip: re-analysing the same clip replaces it.
export const attemptId = (athlete, file) => `${athlete}:${file.name}:${file.size}`;

export function attemptRecord(jump, { athlete, file, recordedAt }) {
  const metrics = Object.fromEntries(jump.metrics.map(m => [m.key, { v: m.value, s: m.status }]));
  const score = typeof jump.score === 'number' ? jump.score : jump.score?.score ?? null;
  const now = new Date().toISOString();
  return {
    schema: SCHEMA,
    id: attemptId(athlete, file),
    athlete, file: file.name, size: file.size, recordedAt: recordedAt || now, analysedAt: now,
    score, phases: (jump.phases ?? []).map(p => ({ id: p.id, score: p.score })),
    metrics, cue: jump.coach?.nextCue ?? null, feel: jump.feel ?? null, runup: jump.runup ?? null,
    jump, media: { clip: null, pose: null },
  };
}

// Writes the record first so the result is safe even if the clip doesn't fit on the phone.
// Returns { ok, media: { clip, pose } }, each 'opfs', 'idb' or null.
export async function saveAttempt(rec, { clip, pose } = {}) {
  try {
    await tx('readwrite', s => s.put(cloneable(rec)));
  } catch (e) { console.warn('Attempt not saved', e); return { ok: false, media: {} }; }
  navigator.storage?.persist?.().catch(() => {});
  const media = { ...rec.media };
  if (pose) media.pose = await putMedia(rec.id, 'pose', poseBlob(pose));
  if (clip) media.clip = await putMedia(rec.id, 'clip', clip);
  if (await getAttempt(rec.id)) await patchAttempt(rec.id, { media });
  else await removeMedia(rec.id);          // deleted while the clip was being written
  return { ok: true, media };
}

function cloneable(rec) {
  try { structuredClone(rec); return rec; }
  catch { return JSON.parse(JSON.stringify(rec)); }
}

export async function getAttempt(id) {
  try { return (await tx('readonly', s => s.get(id))) ?? null; } catch { return null; }
}

export async function patchAttempt(id, patch) {
  try {
    await tx('readwrite', s => {
      const g = s.get(id);
      g.onsuccess = () => { if (g.result) s.put({ ...g.result, ...patch }); };
    });
    return true;
  } catch { return false; }
}

// Coaching lands after the numbers. `job` guards against a re-analysis of the same clip
// having replaced the record in the meantime.
export async function setCoach(id, coach, job = null) {
  try {
    await tx('readwrite', s => {
      const g = s.get(id);
      g.onsuccess = () => {
        const r = g.result;
        if (!r || (r.coachJob ?? null) !== job) return;
        s.put({ ...r, jump: { ...r.jump, coach }, cue: coach?.nextCue ?? null, coachPending: false, coachJob: null });
      };
    });
    return true;
  } catch { return false; }
}

export async function listAttempts(athlete) {
  try {
    const all = await tx('readonly', s => s.index('athlete').getAll(athlete));
    return (all || []).sort((a, b) => String(a.recordedAt ?? '').localeCompare(String(b.recordedAt ?? '')));
  } catch { return []; }
}

export async function deleteAttempt(id) {
  await removeMedia(id);
  try { await tx('readwrite', s => s.delete(id)); return true; } catch { return false; }
}

// The server's coach gets the athlete's last 5 attempts, numbers only.
export function coachHistory(records) {
  return records.filter(r => r.score != null).slice(-5).map(r => ({
    date: r.recordedAt, score: r.score, phases: r.phases,
    metrics: Object.fromEntries(Object.entries(r.metrics ?? {}).filter(([, m]) => m.s !== 'hidden').map(([k, m]) => [k, m.v])),
  }));
}

// A new attempt keeps its numbers hidden until the athlete has said how it felt.
export const needsFeel = r => r.schema >= SCHEMA && r.feel == null;

// ---------- clip + pose storage ----------
// Safari before 26 has no createWritable, only sync handles inside a Worker.

const fileName = (id, kind) => `${encodeURIComponent(id).replace(/%/g, '_')}.${kind}`;

async function opfsDir(create) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create });
}

async function putWritable(name, blob) {
  const dir = await opfsDir(true);
  const fh = await dir.getFileHandle(name, { create: true });
  if (!fh.createWritable) throw new Error('createWritable unavailable');
  const w = await fh.createWritable();
  try {
    const rd = blob.stream().getReader();     // chunked: a whole clip never sits in memory
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      await w.write(value);
    }
    await w.close();
  } catch (e) { await w.abort?.().catch(() => {}); throw e; }
  if ((await fh.getFile()).size !== blob.size) throw new Error('Short write');
}

const WORKER_SRC = `self.onmessage = async e => {
  const { dir, name, blob } = e.data;
  let h;
  try {
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle(dir, { create: true });
    const fh = await d.getFileHandle(name, { create: true });
    h = await fh.createSyncAccessHandle();
    h.truncate(0);
    let at = 0;
    const rd = blob.stream().getReader();
    for (;;) {
      const { done, value } = await rd.read();
      if (done) break;
      at += h.write(value, { at });
    }
    h.flush();
    h.close();
    self.postMessage({ size: at });
  } catch (err) {
    try { h && h.close(); } catch {}
    self.postMessage({ error: String(err && err.message || err) });
  }
};`;

function putWorker(name, blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    const w = new Worker(url);
    const done = fn => arg => { w.terminate(); URL.revokeObjectURL(url); fn(arg); };
    w.onmessage = done(e => (e.data.error || e.data.size !== blob.size ? reject(new Error(e.data.error || 'Short write')) : resolve()));
    w.onerror = done(e => reject(new Error(e.message)));
    w.postMessage({ dir: DIR, name, blob });
  });
}

async function putMedia(id, kind, blob) {
  const name = fileName(id, kind);
  try {                                      // same clip analysed again: already stored
    const f = await (await (await opfsDir(false)).getFileHandle(name)).getFile();
    if (kind === 'clip' && f.size === blob.size) return 'opfs';
  } catch { /* not stored yet */ }
  for (const put of [putWritable, putWorker]) {
    try { await put(name, blob); return 'opfs'; }
    catch (e) { console.warn(`OPFS ${put.name} failed`, e); }
  }
  try { await tx('readwrite', s => s.put(blob, name), BLOBS); return 'idb'; }
  catch (e) { console.warn('Clip not stored', e); return null; }
}

async function getMedia(id, kind) {
  const name = fileName(id, kind);
  try { return await (await (await opfsDir(false)).getFileHandle(name)).getFile(); }
  catch { /* not in OPFS */ }
  try { return (await tx('readonly', s => s.get(name), BLOBS)) ?? null; } catch { return null; }
}

async function removeMedia(id) {
  for (const kind of ['clip', 'pose']) {
    const name = fileName(id, kind);
    try { await (await opfsDir(false)).removeEntry(name); } catch { /* not there */ }
    try { await tx('readwrite', s => s.delete(name), BLOBS); } catch { /* not there */ }
  }
}

// A clip held for a server job the app may have to resume after being closed.
export const storeClip = (id, clip) => putMedia(id, 'clip', clip);
export async function dropIfOrphan(id) {
  if (!(await getAttempt(id))) await removeMedia(id);
}

// Typed arrays would otherwise serialise as objects with numeric keys.
const poseBlob = pose => new Blob([JSON.stringify(pose, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v))], { type: 'application/json' });

export async function loadMedia(id) {
  const [clip, raw] = await Promise.all([getMedia(id, 'clip'), getMedia(id, 'pose')]);
  let pose = null;
  try { pose = raw ? fromWire(JSON.parse(await raw.text())) : null; } catch (e) { console.warn('Pose unreadable', e); }
  return { clip, pose };
}

// ---------- Progres screen ----------

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtDate = iso => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return '–';
  return `${d.getDate()}. ${d.getMonth() + 1}. ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const metres = x => `${x.toFixed(2).replace('.', ',')} m`;

// The bar spans the last 2 m below the goal: from zero, every athlete sits at 90 %.
export function pbBarHtml({ pb, goal }, emptyNote) {
  if (pb == null || goal == null) return `<div class="pb-track"></div><div class="pb-ends"></div><p class="pb-note">${esc(emptyNote)}</p>`;
  const lo = Math.min(goal - 2, pb - 0.5);
  const pct = Math.max(0, Math.min(100, (100 * (pb - lo)) / (goal - lo)));
  const gap = goal - pb;
  return `<div class="pb-track"><div style="width:${pct.toFixed(1)}%"></div></div>
    <div class="pb-ends"><span>${metres(lo)}</span><span>${metres(goal)}</span></div>
    <p class="pb-note">${gap > 0.004 ? `Do cieľa chýba <b>${metres(gap)}</b>.` : 'Cieľ je splnený.'}</p>`;
}

function sparkline(values) {
  const pts = values.map((v, i) => [i, v]).filter(([, v]) => v != null);
  if (pts.length < 2) return '<span class="spark-none">málo pokusov</span>';
  const W = 120, H = 32;
  const x = i => (i / (values.length - 1)) * (W - 8) + 4, y = v => H - 4 - (v / 100) * (H - 8);
  const d = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const [li, lv] = pts.at(-1);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${x(li).toFixed(1)}" cy="${y(lv).toFixed(1)}" r="4" fill="currentColor" stroke="var(--card)" stroke-width="2"/></svg>`;
}

// Score over attempts on a fixed 0-100 axis, so two weeks can be compared by eye.
function trendChart(records) {
  const pts = records.map(r => ({ v: r.score, t: fmtDate(r.recordedAt) }));
  const readout = p => `<b>${Math.round(p.v)}</b> · ${esc(p.t)}`;
  const last = pts.at(-1);
  if (pts.length < 2) return `<div class="trend-read">${last ? readout(last) : ''}</div><p class="note">Po druhom pokuse tu pribudne krivka.</p>`;
  const W = 320, H = 124, L = 24, R = 12, T = 8, B = 8;
  const x = i => L + (i / (pts.length - 1)) * (W - L - R), y = v => T + (1 - v / 100) * (H - T - B);
  const grid = [0, 50, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/><text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" class="axis">${v}</text>`).join('');
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const data = pts.map((p, i) => ({ x: +x(i).toFixed(1), y: +y(p.v).toFixed(1), v: Math.round(p.v), t: p.t }));
  return `<div class="trend-read" data-read>${readout(last)}</div>
    <div class="trend-chart" data-pts="${esc(JSON.stringify(data))}" data-w="${W}">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Skóre podľa pokusov, posledné ${Math.round(last.v)}">
        ${grid}
        <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <line class="guide" x1="${x(pts.length - 1)}" x2="${x(pts.length - 1)}" y1="${T}" y2="${H - B}"/>
        <circle class="pick" cx="${x(pts.length - 1)}" cy="${y(last.v)}" r="5"/>
      </svg>
    </div>`;
}

// Finger or mouse over the chart reads off the nearest attempt.
export function wireTrend(root) {
  const el = root.querySelector('.trend-chart');
  if (!el) return;
  const pts = JSON.parse(el.dataset.pts), W = +el.dataset.w;
  const read = root.querySelector('[data-read]'), guide = el.querySelector('.guide'), pick = el.querySelector('.pick');
  const move = e => {
    const r = el.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * W;
    const p = pts.reduce((a, b) => (Math.abs(b.x - x) < Math.abs(a.x - x) ? b : a));
    guide.setAttribute('x1', p.x); guide.setAttribute('x2', p.x);
    pick.setAttribute('cx', p.x); pick.setAttribute('cy', p.y);
    read.innerHTML = `<b>${p.v}</b> · ${esc(p.t)}`;
  };
  el.addEventListener('pointerdown', move);
  el.addEventListener('pointermove', move);
}

const fmtTime = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

// n: the attempt's number in its training day.
function attemptRow(r, n) {
  const legacy = !(r.schema >= SCHEMA);
  const waiting = needsFeel(r);
  const sub = waiting ? 'Čaká na tvoj pocit'
    : [r.runup ? `${r.runup} ${r.runup <= 4 ? "kroky" : "krokov"}` : null, r.feel ? `Pocit ${r.feel}/5` : null, legacy ? 'starší pokus, bez záznamu' : null, r.cue ? `„${r.cue}“` : null].filter(Boolean).join(' · ');
  const body = `<b class="att-score">${waiting || r.score == null ? '–' : Math.round(r.score)}</b>
    <span class="att-meta"><span>${n}. skok${fmtTime(r.recordedAt) ? ` · ${esc(fmtTime(r.recordedAt))}` : ''}</span><small>${esc(sub)}</small></span>`;
  return `<div class="att">
    ${legacy ? `<div class="att-open">${body}</div>` : `<button class="att-open" data-open="${esc(r.id)}">${body}<span class="att-go" aria-hidden="true">›</span></button>`}
    <button class="att-del" data-del="${esc(r.id)}" aria-label="Zmazať pokus">Zmazať</button>
  </div>`;
}

const metresField = x => (x == null ? '' : x.toFixed(2).replace('.', ','));

// One athlete's block on Progres (both are shown, one after the other). id: the athlete's key,
// for the PB and goal fields.
export function progressHtml(records, profile, name, id) {
  const seen = records.filter(r => !needsFeel(r));
  const scored = seen.filter(r => r.score != null);
  const rows = PHASE_LABELS.map(([id, label]) => {
    const vals = seen.map(r => r.phases?.find(p => p.id === id)?.score ?? null);
    const last = vals.findLast(v => v != null);
    return `<div class="trend"><span>${label}</span>${sparkline(vals)}<b>${last == null ? '–' : Math.round(last)}</b></div>`;
  }).join('');
  // Newest training first, one heading per day with its jump count.
  const list = records.length
    ? sessions(records).reverse().map(s => `<div class="sess"><b>${esc(dayLabel(s.day))}</b><span>${skoky(s.records.length)}</span></div>`
      + s.records.map((r, i) => attemptRow(r, i + 1)).reverse().join('')).join('')
    : `<p class="note">${esc(name)} zatiaľ nemá žiadny pokus.</p>`;
  const field = (key, label) => `<label><span>${label}</span><input data-pb="${esc(id)}" data-key="${key}" type="text" inputmode="decimal" autocomplete="off" placeholder="zadaj" value="${metresField(profile[key])}"></label>`;
  const note = profile.goal == null ? `${name}, aký je tvoj cieľ? Zapíš ho sem.` : 'Zapíš PB a uvidíš, koľko chýba.';
  return `<section class="stack ath" data-ath="${esc(id)}">
    <h2 class="ath-name">${esc(name)}</h2>
    <div class="card"><h2>Skóre</h2>${trendChart(scored)}</div>
    <div class="card"><h2>PB a cieľ</h2><div class="pb-fields">${field('pb', 'PB (m)')}${field('goal', 'Cieľ (m)')}</div>${pbBarHtml(profile, note)}</div>
    <div class="card"><h2>Fázy</h2><div class="trends">${rows}</div></div>
    <div class="card"><h2>Tréningy</h2><div class="atts">${list}</div></div>
  </section>`;
}
