// Rozbeh: a full run-up with its take-off and never a landing (Stanley 2026-11-19: "nikdy inak
// nedopadneme, z celého je tam odraz ale nikdy nie s dopadom"), filmed from the side like an
// acceleration. Its own tab, storage and history, so Skok is never touched: it sends the clip as a
// jump job and reads the answer with the same analyzeJump, as a run-through. Freelap gives the
// splits (cones 1 · 6 · 11 · 21 m from the board), the video the steps and the take-off.
import { analyzeJump } from './analysis/jump.js';
import { detectContacts } from './analysis/events.js';
import { pairRun } from './analysis/sprint.js';
import { analyzeInCloud, resumeCloudJob, cloudReady, pendingCloudJob } from './cloud.js';

const KEY = 'jump.rozbeh';
// Bumped when the reading changes: saved run-ups are read again from their stored answer on start.
const RB_ALGO = 4;
export const RUNUP_STEPS = 18;   // Stanley 2026-11-19: "rozbehy sú vždy 18 krokov"
const MAX = 120;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (x, dp) => (Number.isFinite(x) ? Number(x).toFixed(dp).replace('.', ',') : '–');
const n3 = x => num(x, 3).replace(/^0/, '');
const FOOT = { l: 'Ľ', r: 'P' };

// The Freelap splits of a run-up, nearest the board last: [21→11, 11→6, 6→1] with a cone at 6 m,
// [21→11, 11→1] without. Times in s, speeds in m/s; null where a split is missing.
export function splitsOf(legs) {
  const L = (legs ?? []).filter(Number.isFinite);
  if (!L.length) return null;
  if (L.length >= 3) {
    const [a, b, c] = L.slice(-3);
    return { s21_11: a, s11_6: b, s6_1: c, s1_11: b + c, v21_11: 10 / a, v11_6: 5 / b, v6_1: 5 / c, v1_11: 10 / (b + c), keep: (5 / c) / (5 / b) - 1 };
  }
  if (L.length === 2) { const [a, b] = L; return { s21_11: a, s1_11: b, v21_11: 10 / a, v1_11: 10 / b, keep: (10 / b) / (10 / a) - 1 }; }
  return { s1_11: L[0], v1_11: 10 / L[0] };
}

// What a run-up keeps from the jump analysis: the steps it saw, the last two contacts and the
// take-off. A rozbeh never lands, so the answer is read as a run-through whatever the server said.
// The steps of the run-up's end, walked back from the take-off by the running rhythm: a contact one
// step period before the next is the step before; two periods means a step the pose missed (kept as
// "nezachytený" so the numbers from the board stay right). Stops where the rhythm breaks or past
// `backS` seconds before the take-off (the Freelap zone). A single short miss had cut every step
// before it from the jump timeline (2026-11-19, IMG_4656: 3 of about 9 steps shown).
export function stepsBack(clean, first, last, fps, takeoff, pen, { backS = 2.6 } = {}) {
  const raw = detectContacts(clean, first, last, fps).filter(c => c.to >= c.td && c.td < takeoff.td - 2).sort((a, b) => a.td - b.td);
  const cs = [];
  for (const c of raw) { const p = cs.at(-1); if (p && c.td <= p.to + 1) { if (c.to - c.td > p.to - p.td) cs[cs.length - 1] = c; continue; } cs.push(c); }
  // the running rhythm from the contacts of the last 2.5 s (one pair can be wrong: IMG_4658's pen and
  // take-off were named 18 frames apart for a 28-frame step, and the walk stopped after one step)
  const near = cs.filter(c => (takeoff.td - c.td) / fps < 2.5);
  const gaps = near.slice(1).map((c, i) => c.td - near[i].td).filter(g => g / fps > 0.17 && g / fps < 0.36).sort((a, b) => a - b);
  let period = gaps.length >= 3 ? gaps[gaps.length >> 1] : pen ? takeoff.td - pen.td : Math.round(0.26 * fps);
  const out = [{ td: takeoff.td, to: takeoff.to, foot: takeoff.foot }];
  // the last step is short (IMG_4658: 0.15 s against 0.24 s for the steps before), so the pen counts from half a period
  if (pen && takeoff.td - pen.td > 0.45 * period) out.unshift({ td: pen.td, to: pen.to, foot: pen.foot });
  for (let k = cs.length - 1; k >= 0; k--) {
    const c = cs[k], next = out[0];
    if (c.td >= next.td - 2) continue;
    const gap = next.td - c.td, n = Math.round(gap / period);
    if ((takeoff.td - c.td) / fps > backS) break;
    if (n < 1 || Math.abs(gap - n * period) > 0.35 * period || n > 3) { if (gap < 0.6 * period) continue; break; }
    for (let m = n - 1; m >= 1; m--) out.unshift({ td: Math.round(next.td - m * gap / n), to: null, foot: null, missing: true });
    out.unshift({ td: c.td, to: c.to, foot: c.foot });
    if (n === 1) period = 0.7 * period + 0.3 * gap;
  }
  return out.map((s, i) => ({ ...s, contact: s.to != null ? (s.to - s.td + 1) / fps : null, air: i < out.length - 1 && s.to != null ? (out[i + 1].td - s.to - 1) / fps : null }));
}

// Per Freelap split: the steps in it, their rate from the video, the step length from the split's
// speed. The cones are passed by the chip on the hip; the 1 m cone about 1 m before the take-off
// touchdown at the 6-1 m speed. Steps at a boundary can fall either side, so the counts are shown "≈".
export function splitSteps(steps, ts, splits) {
  if (!splits || !steps?.length) return null;
  const take = steps.at(-1), tTD = ts[take.td], v1 = splits.v6_1 ?? splits.v1_11;
  if (!Number.isFinite(tTD) || !Number.isFinite(v1)) return null;
  const t1 = tTD - 1 / v1;
  const segs = splits.s11_6 != null
    ? [['21–11 m', t1 - splits.s6_1 - splits.s11_6 - splits.s21_11, t1 - splits.s6_1 - splits.s11_6, splits.v21_11], ['11–6 m', t1 - splits.s6_1 - splits.s11_6, t1 - splits.s6_1, splits.v11_6], ['6–1 m', t1 - splits.s6_1, t1, splits.v6_1]]
    : [['21–11 m', t1 - splits.s1_11 - (splits.s21_11 ?? NaN), t1 - splits.s1_11, splits.v21_11], ['11–1 m', t1 - splits.s1_11, t1, splits.v1_11]];
  return segs.filter(([, a, b]) => Number.isFinite(a) && Number.isFinite(b)).map(([label, a, b, v]) => {
    const inside = steps.filter(s => ts[s.td] >= a && ts[s.td] < b);
    const periods = [];
    for (let i = 0; i < steps.length - 1; i++) if (ts[steps[i].td] >= a && ts[steps[i].td] < b) periods.push(ts[steps[i + 1].td] - ts[steps[i].td]);
    const rate = periods.length ? periods.length / periods.reduce((x, y) => x + y, 0) : null;
    const seen = ts[steps[0].td] <= a + 0.05;   // the steps go back to the split's start
    return { label, steps: inside.length, rate, length: rate && v ? v / rate : null, seen, contact: inside.filter(s => s.contact != null).reduce((x, s, _, l) => x + s.contact / l.length, 0) || null };
  });
}

// Both athletes take off from the right foot (Stanley 2026-11-19: "odraz je z pravej"); the pose
// swaps left and right in a side view, so the feet are named from the take-off back, alternating.
export const TAKEOFF_FOOT = { stanley: 'r', miska: 'r' };
export const footOf = (i, len, who) => { const t = TAKEOFF_FOOT[who] ?? 'r'; return (len - 1 - i) % 2 === 0 ? t : (t === 'r' ? 'l' : 'r'); };

export function rozbehNumbers(result, sex, height) {
  const res = { ...result, events: result?.events ? { ...result.events, kind: 'runthrough' } : result?.events };
  const j = analyzeJump(res, sex, res.ts ?? null, { height, trustTakeoff: true });
  if (j.error) return { error: j.error };
  const m = Object.fromEntries((j.metrics ?? []).map(x => [x.key, x.status === 'hidden' ? null : x.value]));
  const g = j.flight?.ground && !j.flight.ground.error ? j.flight.ground : null;
  const sp = id => g?.steps?.find(s => s.id === id)?.speed ?? null;
  const back = stepsBack(res.clean, res.first ?? 0, res.last ?? res.clean.length - 1, j.fps, { ...j.takeoff, foot: j.takeoffFoot }, j.pen);
  return {
    steps: back.map(r => ({ foot: r.foot, contact: r.contact, air: r.air, td: r.td, missing: !!r.missing })),
    ts: back.map(r => res.ts?.[r.td] ?? r.td / j.fps),
    stepCount: j.stepCount?.count ?? null, stepSeen: !!j.stepCount?.seen,
    pen: { contact: m.contactPen != null ? m.contactPen / 1000 : null, knee: m.penKnee },
    take: { contact: m.contactTO != null ? m.contactTO / 1000 : null, kneeTD: m.kneeTD, kneeTO: m.kneeTO, angle: m.takeoffAngle },
    speeds: g ? { third: sp('third'), pen: sp('pen'), take: sp('take') } : null,
    frames: { penTD: j.pen?.td ?? null, TD: j.takeoff?.td ?? null, TO: j.takeoff?.to ?? null },
  };
}

export function initRozbeh({ root, athletes, freelap, getAthlete, roster, inspect, onProgress = () => {}, onChange = () => {}, onDeleted = () => {}, saveClip, loadClip, loadOriginal, dropClip, storePose, loadPose, makePlayer }) {
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const store = l => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch { /* storage full or blocked */ } };
  const patch = (id, f) => { const l = load(), x = l.find(r => r.id === id); if (x) { f(x); store(l); } onChange(); return x; };
  const inFlight = new Set();
  const queue = [];
  let running = 0, current = null, player = null;

  const runOf = rec => {
    if (rec.typed?.length) return { legs: rec.typed, typed: true };
    if (rec.noFreelap) return null;
    const all = freelap?.runs?.() ?? [];
    const byKey = rec.runKey ? all.find(r => r.key === rec.runKey) : null;
    if (byKey) return byKey;
    const ups = all.filter(r => r.type === 'rozbeh');
    return pairRun(ups.length ? ups : all, { recordedAt: rec.recordedAt, duration: rec.duration ?? 0 }, rec.who) ?? null;
  };

  // ---------- upload ----------
  async function upload(file, { quiet = false } = {}) {
    if (!cloudReady()) { onProgress('Najprv ulož prístupový kľúč v nastaveniach.'); return; }
    let info = null;
    try { info = await inspect(file); } catch { onProgress(`Video ${file.name} sa nedá prečítať.`); return; }
    if (info.fps < 100) { onProgress(`${file.name}: video má len ${num(info.fps, 0)} fps, rozbeh potrebuje spomalené (120 fps).`); return; }
    const me = getAthlete();
    const id = `rb${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const rec = { id, at: Date.now(), recordedAt: info.recordedAt ?? file.lastModified ?? Date.now(), duration: info.duration ?? null, file: file.name, size: file.size, who: me?.id ?? null, pending: true, stage: 'čaká v rade', jobId: null };
    const l = load(); l.unshift(rec);
    for (const old of l.slice(MAX)) if (old.hasClip) dropClip?.(old.id);
    store(l); onChange();
    try { await saveClip(id, file); patch(id, x => { x.hasClip = true; }); } catch { /* the upload still goes */ }
    queue.push({ id, file, quiet });
    pump();
    return id;
  }
  // Every clip goes to the server at once and waits in its queue there (2026-11-19: sent two at a
  // time, three run-ups waited half an hour on a locked phone while the server sat idle).
  function pump() {
    while (running < 8 && queue.length) {
      const job = queue.shift();
      running++;
      run(job).finally(() => { running--; pump(); });
    }
  }
  async function run({ id, file, jobId = null }) {
    if (inFlight.has(id)) return;
    inFlight.add(id);
    const rec0 = load().find(r => r.id === id);
    const me = athletes[rec0?.who] ? { id: rec0.who, ...athletes[rec0.who] } : getAthlete();
    let saved = false;
    const take = result => {
      if (saved || !result) return;
      saved = true;
      const who = result.who?.id in athletes ? result.who.id : me.id, a = athletes[who];
      const nums = rozbehNumbers(result, a.sex, a.height);
      storePose?.(id, result).catch(() => {});
      patch(id, x => Object.assign(x, nums.error
        ? { who, pending: false, error: 'Odraz sa vo videu nenašiel. Ťukni a skús znova.', stage: null, hasPose: true, algo: RB_ALGO }
        : { who, pending: false, error: null, stage: null, ...nums, hasPose: true, algo: RB_ALGO }));
    };
    try {
      patch(id, x => { x.stage = jobId ? 'server počíta' : 'posiela sa'; x.error = null; });
      const opts = {
        onJob: j => patch(id, x => { x.jobId = j; x.stage = 'čaká na server'; }),
        onProgress: q => { if (!saved) patch(id, x => { x.stage = q?.stage === 'queued' ? 'čaká na server' : 'server počíta'; }); },
        onResult: ({ result }) => take(result),
      };
      let out;
      if (jobId) out = await resumeCloudJob(jobId, opts);
      else {
        const all = await roster();
        out = await analyzeInCloud(file, { sex: me.sex, name: me.name, height: me.height, history: [], athletes: all, mode: 'rozbeh', ...opts });
      }
      take(out?.result);
      patch(id, x => { x.jobId = null; });
    } catch (e) {
      console.warn('Rozbeh failed', e);
      if (!saved) patch(id, x => { x.pending = false; x.stage = null; x.error = 'Analýza sa nepodarila. Ťukni a skús znova.'; x.jobId = null; });
    } finally { inFlight.delete(id); }
  }
  // After iOS closed the app: jobs on the server are followed again, clips that never left go now.
  async function resume() {
    // read again with today's code from the stored answer (no new upload)
    for (const r of load().filter(x => !x.pending && (x.hasPose || x.error) && (x.algo ?? 1) < RB_ALGO)) {
      const pose = await loadPose?.(r.id).catch(() => null);
      if (!pose) continue;
      const a = athletes[r.who] ?? getAthlete();
      const nums = rozbehNumbers(pose, a.sex, a.height);
      patch(r.id, x => Object.assign(x, nums.error ? { error: 'Odraz sa vo videu nenašiel. Ťukni a skús znova.', algo: RB_ALGO } : { ...nums, error: null, hasPose: true, algo: RB_ALGO }));
    }
    for (const r of load().filter(x => x.pending)) {
      if (inFlight.has(r.id)) continue;
      // a job already on the server is followed first: it is the nearest to done
      if (r.jobId && pendingCloudJob(r.jobId)) { queue.unshift({ id: r.id, file: null, jobId: r.jobId }); continue; }
      const file = r.hasClip ? await loadOriginal(r.id) : null;
      if (file) queue.push({ id: r.id, file });
      else patch(r.id, x => { x.pending = false; x.stage = null; x.error = 'Video sa v telefóne nenašlo. Nahraj ho znova.'; });
    }
    pump();
  }
  async function retry(id) {
    const r = load().find(x => x.id === id);
    if (!r || inFlight.has(id) || r.pending) return;
    const file = r.hasClip ? await loadOriginal(id) : null;
    if (!file) { patch(id, x => { x.error = 'Video sa v telefóne nenašlo. Nahraj ho znova.'; }); return; }
    patch(id, x => { x.pending = true; x.error = null; x.stage = 'čaká v rade'; });
    queue.push({ id, file }); pump();
    if (current === id) draw();
  }

  // ---------- list line ----------
  function summary(rec) {
    const name = athletes[rec.who]?.name ?? '';
    const at = rec.pending || rec.error ? rec.at : rec.recordedAt ?? rec.at;
    if (rec.pending || rec.error) return { kind: 'rozbeh', id: rec.id, who: rec.who, at, title: `Rozbeh · ${rec.file ?? ''}`, sub: rec.error ? 'nepodarilo sa · ťukni a skús znova' : rec.stage ?? 'analýza beží…', value: rec.error ? '!' : '…', valueSub: '' };
    const s = splitsOf(runOf(rec)?.legs);
    const n = runOf(rec)?.steps, steps = n ? ` ${n} kr.` : '';
    const sub = [s?.s21_11 != null ? `11–21 ${num(s.s21_11, 2)}` : null, rec.take?.contact != null ? `odraz ${num(rec.take.contact, 3)} s` : null].filter(Boolean).join(' · ');
    return { kind: 'rozbeh', id: rec.id, who: rec.who, at, title: `${name}${name ? ' · ' : ''}rozbeh${steps}`, sub, value: s?.s1_11 != null ? num(s.s1_11, 2) : '–', valueSub: s?.s1_11 != null ? '1–11 m' : 'bez Freelapu' };
  }

  // ---------- detail ----------
  const card = (title, body) => `<section class="card sp-card"><h2>${title}</h2>${body}</section>`;
  const cell = (lb, big, small = '') => `<div class="sp-cd"><p class="sp-lb">${lb}</p><p class="sp-mid">${big}</p>${small ? `<p class="sp-lb">${small}</p>` : ''}</div>`;
  function freelapHtml(rec) {
    const run = runOf(rec), s = splitsOf(run?.legs);
    const form = `<details class="rb-type"${s ? '' : ' open'}><summary>${s ? 'Upraviť časy' : 'Zadať časy z Freelapu'}</summary>
      <div class="sp-g3">${[['21–11 m', 's21_11'], ['11–6 m', 's11_6'], ['6–1 m', 's6_1']].map(([lb, k]) => `<label class="sp-cd"><span class="sp-lb">${lb}</span><input class="rb-in" inputmode="decimal" data-rb-leg="${k}" value="${s?.[k] != null ? num(s[k], 2) : ''}" placeholder="0,00"></label>`).join('')}</div>
      <p class="note s">Bez kužeľa na 6 m nechaj 11–6 prázdne a do 6–1 daj celých 11–1.</p>
      <button class="btn" data-rb-save="${esc(rec.id)}">Uložiť časy</button></details>`;
    if (!s) return card('Freelap · posledných 21 m', `<p class="note">K tomuto rozbehu sa nenašiel beh z Freelapu.</p>${form}`);
    const cells = s.s11_6 != null
      ? cell('21–11 m', `${num(s.s21_11, 2)} s`, `${num(s.v21_11, 2)} m/s`) + cell('11–6 m', `${num(s.s11_6, 2)} s`, `${num(s.v11_6, 2)} m/s`) + cell('6–1 m', `${num(s.s6_1, 2)} s`, `${num(s.v6_1, 2)} m/s`)
      : (s.s21_11 != null ? cell('21–11 m', `${num(s.s21_11, 2)} s`, `${num(s.v21_11, 2)} m/s`) : '') + cell('11–1 m', `${num(s.s1_11, 2)} s`, `${num(s.v1_11, 2)} m/s`);
    const keep = Number.isFinite(s.keep) ? `<span class="chg ${s.keep >= 0 ? 'up' : 'down'}">${s.keep >= 0 ? '+' : '−'}${num(Math.abs(s.keep) * 100, 1)} % ${s.s11_6 != null ? 'na posledných 5 m' : 'na posledných 10 m'}</span>` : '';
    const what = Number.isFinite(s.keep) ? (s.keep >= 0
      ? `Do dosky si zrýchlil o ${num(Math.abs(s.s11_6 != null ? s.v6_1 - s.v11_6 : s.v1_11 - s.v21_11), 2)} m/s.`
      : `Na konci si spomalil o ${num(Math.abs(s.s11_6 != null ? s.v6_1 - s.v11_6 : s.v1_11 - s.v21_11), 2)} m/s. Cieľ: rýchlosť udržať až do dosky.`) : '';
    const per = rec.ts?.length ? splitSteps(rec.steps.map((x, i) => ({ ...x, td: i })), rec.ts, s) : null;
    const perHtml = per?.length ? `<div class="rb-per">${per.map(p => `<div class="sp-row rb-row"><span style="width:64px">${p.label}</span><span class="sp-n" style="width:auto;flex:1;text-align:left">${p.seen ? `≈ ${p.steps} ${p.steps === 1 ? 'krok' : p.steps < 5 ? 'kroky' : 'krokov'}` : 'začiatok mimo videa'}</span><span class="sp-n" style="width:64px">${p.rate ? `${num(p.rate, 2)} kr/s` : '–'}</span><span class="sp-n" style="width:64px">${p.length ? `${num(p.length, 2)} m` : '–'}</span></div>`).join('')}<p class="note s">Frekvencia z videa, dĺžka kroku z rýchlosti Freelapu a frekvencie.</p></div>` : '';
    return card(`Freelap · posledných 21 m${run.typed ? ' (zadané ručne)' : ''}`, `<div class="${s.s11_6 != null ? 'sp-g3' : 'sp-g2'}">${cells}</div>
      <div class="rb-sum"><span><span class="sp-lb">1–11 m</span> <b>${num(s.s1_11, 2)} s</b> <span class="sp-lb">· ${num(s.v1_11, 2)} m/s</span></span>${keep}</div>
      ${what ? `<p class="note s">${what}</p>` : ''}${perHtml}${form}`);
  }
  function takeoffHtml(rec) {
    const t = rec.take ?? {};
    return card('Odraz', `<div class="sp-g3">${cell('Na doske', t.contact != null ? `${num(t.contact, 3)} s` : '–', rec.pen?.contact != null ? `predposl. ${num(rec.pen.contact, 3)} s` : '')}
      ${cell('Koleno pri odraze', t.kneeTO != null ? `${num(t.kneeTO, 0)}°` : '–', t.kneeTD != null ? `dopad ${num(t.kneeTD, 0)}°` : '')}
      ${cell('Uhol odrazu', t.angle != null ? `${num(t.angle, 0)}°` : '–', t.angle != null ? '' : 'let je príliš krátky')}</div>
      ${rec.speeds?.pen != null ? `<p class="note s">Rýchlosť z dráhy: predposledný ${num(rec.speeds.pen, 2)} m/s, odraz ${num(rec.speeds.take, 2)} m/s.</p>` : '<p class="note s">Rýchlosť posledných krokov len keď appka nájde dosku a čiary dráhy.</p>'}`);
  }
  function stepsHtml(rec) {
    const steps = rec.steps ?? [];
    if (!steps.length) return '';
    const total = runOf(rec)?.steps ?? RUNUP_STEPS, scale = 520;
    // contact and flight only near the board: further back the athlete is small and a touchdown came
    // 8 frames late by eye (IMG_4654, 718 for about 710); there the step itself and its rhythm stand
    const tTake = rec.ts?.at(-1);
    const nearBoard = i => !(Number.isFinite(tTake) && Number.isFinite(rec.ts?.[i])) || tTake - rec.ts[i] <= 1.05;
    const sureAt = (c, i) => c != null && c >= 0.07 && nearBoard(i);
    const rows = steps.map((s, i) => {
      const n = total - (steps.length - 1 - i), last = i === steps.length - 1, pen = i === steps.length - 2;
      if (s.missing) return `<div class="sp-row rb-row"><span class="sp-i">${n}</span><span class="sp-f"></span><span class="sp-bar"></span><span class="sp-n" style="width:84px">nezachytený</span></div>`;
      return `<div class="sp-row rb-row${last || pen ? ' hl' : ''}"><span class="sp-i">${n}</span><span class="sp-f">${FOOT[footOf(i, steps.length, rec.who)]}</span>
        <span class="sp-bar">${sureAt(s.contact, i) ? `<span class="c" style="width:${(s.contact * scale).toFixed(0)}px"></span>` : ''}${!last && s.air != null && sureAt(s.contact, i) ? `<span class="fl" style="width:${(s.air * scale).toFixed(0)}px"></span>` : ''}</span>
        <span class="sp-n">${sureAt(s.contact, i) ? n3(s.contact) : '–'}</span><span class="sp-n">${last ? 'odraz' : s.air != null && sureAt(s.contact, i) ? n3(s.air) : '–'}</span></div>`;
    }).join('');
    return card(`Kroky ${total - steps.length + 1}–${total}`, `<p class="sp-legend"><i class="c"></i>na zemi <i class="fl"></i>let</p>
      <div class="sp-row rb-row sp-head"><span class="sp-i">#</span><span class="sp-f"></span><span class="sp-bar"></span><span class="sp-n">zem</span><span class="sp-n">let</span></div>${rows}
      <p class="note s">Rozbeh ${total} krokov${runOf(rec)?.steps ? ' (Freelap)' : ''}: ${total} odraz, ${total - 1} predposledný. Čas na zemi a let len pri posledných krokoch, ďalej od dosky je postava na videu príliš malá.</p>`);
  }
  let shownSig = '';
  function draw() {
    const rec = load().find(r => r.id === current);
    if (rec) shownSig = `${!!rec.pending}|${rec.error ?? ''}|${(rec.typed ?? []).join(',')}`;
    if (!rec) { root.innerHTML = '<div class="card"><p class="note">Rozbeh sa nenašiel.</p></div>'; return; }
    const name = athletes[rec.who]?.name ?? '';
    const video = rec.hasClip ? `<section class="card sp-card sp-video"><div class="sp-vbox player" data-rb-clip="${esc(rec.id)}"><p class="note">Načítavam video…</p></div></section>` : '';
    const state = rec.pending ? `<section class="card"><p class="note" data-rb-state>◌ ${esc(rec.stage ?? 'analýza beží')}… Video si môžeš pozrieť hneď, čísla sa doplnia samé.</p></section>`
      : rec.error ? `<section class="card"><p class="banner bad">${esc(rec.error)}</p><button class="btn" data-rb-retry="${esc(rec.id)}">Skúsiť znova</button></section>` : '';
    const n = runOf(rec)?.steps ?? RUNUP_STEPS;
    root.innerHTML = `<h2 class="ath-name">${esc(name)}${name ? ' · ' : ''}rozbeh${n ? ` ${n} kr.` : ''}</h2>${video}${state}
      ${rec.pending || rec.error ? '' : freelapHtml(rec) + takeoffHtml(rec) + stepsHtml(rec)}
      <section class="card"><button class="btn danger" data-rb-del="${esc(rec.id)}">Zmazať rozbeh</button></section>`;
    mountVideo(rec);
  }
  async function mountVideo(rec) {
    const box = root.querySelector('[data-rb-clip]');
    if (!box) return;
    if (player?.id === rec.id && player.el?.isConnected) return;
    const blob = await loadClip(rec.id).catch(() => null);
    if (!blob || current !== rec.id) { if (!blob) box.innerHTML = '<p class="note">Video sa v telefóne nenašlo.</p>'; return; }
    box.innerHTML = '';
    try {
      const p = await makePlayer(box, blob);
      player = { id: rec.id, el: box, p };
      // opens at the last steps: the start of the clip is the far, empty run-up
      const at = rec.frames?.penTD ?? rec.frames?.TD;
      if (Number.isFinite(at)) await p.player?.show?.(Math.max(0, at - 90));
    } catch { box.innerHTML = '<p class="note">Video sa nedá prehrať.</p>'; }
  }
  const parse = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) && v > 0.3 && v < 3 ? v : null; };
  root.addEventListener('click', e => {
    const save = e.target.closest('[data-rb-save]');
    if (save) {
      const v = k => parse(root.querySelector(`[data-rb-leg="${k}"]`)?.value);
      const a = v('s21_11'), b = v('s11_6'), c = v('s6_1');
      const legs = b != null && c != null ? [a, b, c].filter(x => x != null) : [a, c].filter(x => x != null);
      patch(save.dataset.rbSave, x => { x.typed = legs.length ? legs : null; });
      draw(); return;
    }
    const rt = e.target.closest('[data-rb-retry]');
    if (rt) return void retry(rt.dataset.rbRetry);
    const del = e.target.closest('[data-rb-del]');
    if (del) {
      if (del.dataset.armed !== '1') { del.dataset.armed = '1'; del.textContent = 'Naozaj?'; setTimeout(() => { del.dataset.armed = ''; del.textContent = 'Zmazať rozbeh'; }, 3000); return; }
      const id = del.dataset.rbDel;
      store(load().filter(r => r.id !== id)); dropClip?.(id); current = null; onChange(); onDeleted();
    }
  });

  return {
    upload, resume, retry, summary,
    records: () => load(),
    open(id) { current = id; player = null; draw(); },
    // while it is on its way only the state line changes, so the video keeps playing
    refresh() {
      if (!current || !root.isConnected) return;
      const r = load().find(x => x.id === current);
      if (!r) return;
      const sig = `${!!r.pending}|${r.error ?? ''}|${(r.typed ?? []).join(',')}`;
      const line = root.querySelector('[data-rb-state]');
      if (sig === shownSig && r.pending && line) { line.textContent = `◌ ${r.stage ?? 'analýza beží'}… Video si môžeš pozrieť hneď, čísla sa doplnia samé.`; return; }
      if (sig !== shownSig) draw();
    },
    busy: () => running > 0 || queue.length > 0,
  };
}
