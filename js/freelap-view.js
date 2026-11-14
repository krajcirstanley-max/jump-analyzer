// The Freelap tab: Start listens for the chips, Stop stops taking anything in, and every run a chip
// sends shows up at the top with whose chip it is. Runs are grouped into trainings: one runs until
// "Ukončiť tréning" or the next day (Stanley, 2026-11-13: "koniec tréningu, vymazať všetko, a
// jednotlivé časy nech sa dajú vymazať tiež"). Kept in this phone (times only).
import { createListener, nativeBle } from './freelap/listen.js';
import { modeOfRun } from './analysis/sprint.js';

const KEY = 'jump.freelap';
const SESSION_KEY = 'jump.freelap.session';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = x => Number(x).toFixed(2).replace('.', ',');
const hm = t => new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
const hms = t => new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayName = t => new Date(t).toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'numeric' });
const dayKey = t => new Date(t).toLocaleDateString('sv-SE');
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };
const behy = n => `${n} ${n === 1 ? 'beh' : n < 5 ? 'behy' : 'behov'}`;
const FILTER_KEY = 'jump.freelap.filter';

// What a run was (Stanley 2026-11-14: "filtrovať akcel, letmý úsek, rozbeh… koľko krokov rozbeh").
// Akcel and letmý are told apart from the splits; a run-up only he can name, with its steps.
export const TYPES = { accel: 'Akcel', fly: 'Letmý', rozbeh: 'Rozbeh' };
export const STEP_CHOICES = Array.from({ length: 21 }, (_, i) => i + 4);   // 4–24 steps
export function typeLabel(r) {
  const t = modeOfRun(r);
  return t === 'rozbeh' ? `rozbeh${r.steps ? ` ${r.steps} kr.` : ''}` : t === 'accel' ? 'akcel' : 'letmý';
}
// filter: { type: 'all' | 'accel' | 'fly' | 'rozbeh', steps: number | null }
export function matches(r, f) {
  if (!f || f.type === 'all') return true;
  if (modeOfRun(r) !== f.type) return false;
  return f.type !== 'rozbeh' || f.steps == null || r.steps === f.steps;
}

const STATE = {
  none: 'Freelap ide len v appke Skok v iPhone. Safari nemá Bluetooth.',
  off: 'Nepočúva. Časy z čipov sa neprijímajú.',
  starting: 'Zapínam Bluetooth…',
  on: 'Počúvam čipy. Časy sa ukážu nižšie a pri natáčaní aj vo videu.',
};

// The plugin's messages, in words.
const ERRORS = {
  'BLE powered off': 'Bluetooth je vypnutý. Zapni ho v Ovládacom centre a stlač Start znova.',
  'BLE permission denied': 'Skok nemá povolený Bluetooth. Zapni ho v Nastavenia → Skok → Bluetooth.',
  'BLE unsupported': 'Toto zariadenie nemá Bluetooth.',
};
const errorText = e => ERRORS[e] ?? `Bluetooth sa nepodarilo zapnúť (${e}).`;

// The training a new run joins: the open one, unless it was ended or is from another day.
export function sessionFor(open, at) {
  if (open && !open.ended && dayKey(open.start) === dayKey(at)) return open;
  return { id: `s${at}`, start: at, ended: false };
}

// Runs grouped by training, newest training first, each with the best run per athlete.
export function trainings(reps) {
  const map = new Map();
  for (const r of reps) {
    const id = r.session ?? `d${dayKey(r.at)}`;   // runs from before trainings existed: one per day
    if (!map.has(id)) map.set(id, { id, runs: [] });
    map.get(id).runs.push(r);
  }
  return [...map.values()].map(t => {
    const best = {};
    for (const r of t.runs) {
      const k = r.who ?? r.chip;
      if (!best[k] || r.lap < best[k].lap) best[k] = r;
    }
    const ats = t.runs.map(r => r.at);
    return { ...t, from: Math.min(...ats), to: Math.max(...ats), best };
  }).sort((a, b) => b.to - a.to);
}

export function initFreelap({ root, athletes, ble = nativeBle(), detailRoot = null, onOpen = () => {}, onChange = () => {} }) {
  let reps = load(KEY, []), open = load(SESSION_KEY, null);
  let filter = { type: 'all', steps: null, ...load(FILTER_KEY, {}) };
  let linker = () => null;             // run key → its sprint analysis (with the video), set by the app
  let detailKey = null;                // the run open on the detail screen
  let error = null, packets = 0, lastHex = '', heard = null, lastChip = '';
  let armed = null, armTimer = null;   // the delete button waiting for its second tap
  const subs = new Set();              // the Sprint tab listens for runs while it films
  const save = () => store(KEY, reps.slice(0, 500));

  const listener = createListener(ble, {
    rep(r) {
      open = sessionFor(open, r.at);
      store(SESSION_KEY, open);
      const run = { chip: r.chip, who: r.who, lap: r.lap, legs: r.legs, at: r.at, key: r.key, session: open.id };
      if (open.plan?.type) { run.type = open.plan.type; if (open.plan.type === 'rozbeh') run.steps = open.plan.steps; }
      reps.unshift(run);
      save();
      draw();
      navigator.vibrate?.(60);
      for (const f of subs) f('run', run);
    },
    update(r) {   // the same run, now with its intermediate
      const i = reps.findIndex(x => x.key === r.key);
      if (i < 0) return;
      reps[i] = { ...reps[i], lap: r.lap, legs: r.legs };
      save();
      draw();
      for (const f of subs) f('update', reps[i]);
    },
    packet(n, hex) { packets = n; lastHex = hex; drawCount(); },
    heard(h) {
      heard = h;
      if (h.md !== undefined) lastChip = JSON.stringify(h.md);
      drawCount();
    },
    state(s, err) { error = err; if (s === 'on') { packets = 0; heard = null; } draw(); },
  }, new Map(reps.map(r => [r.key, r.legs?.length ?? 0])));

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip;

  // The legs as one bar, each part as wide as its share of the run; the split under each joint.
  function legsHtml(r) {
    if (!(r.legs?.length > 1)) return '';
    let acc = 0;
    const parts = r.legs.map((l, i) => {
      acc += l;
      const last = i === r.legs.length - 1;
      return `<div class="fl-leg" style="flex:${l}"><b>${sec(l)}</b>${last ? '' : `<small>${sec(acc)}</small>`}</div>`;
    }).join('');
    return `<div class="fl-legs" aria-label="Úseky">${parts}</div>`;
  }

  function runHtml(r, best) {
    const isBest = best[r.who ?? r.chip] === r;
    const del = armed === r.key
      ? `<button class="fl-del armed" data-fl="del" data-key="${esc(r.key)}">Zmazať</button>`
      : `<button class="fl-del" data-fl="del" data-key="${esc(r.key)}" aria-label="Zmazať čas">×</button>`;
    const video = linker(r.key);
    return `<div class="fl-rep${isBest ? ' best' : ''}" data-fl="open" data-key="${esc(r.key)}">
      <div class="fl-row">
        <div class="fl-who"><b>${esc(name(r))}</b><small>${hms(r.at)}${r.who ? '' : ` · ${esc(r.chip)}`} · <span class="fl-type${r.type ? '' : ' auto'}">${esc(typeLabel(r))}</span>${video ? ' · <span class="fl-vid">▶ video</span>' : ''}</small></div>
        <div class="fl-time"><b>${sec(r.lap)}</b><span>s</span></div>
        ${del}
      </div>
      ${legsHtml(r)}
    </div>`;
  }

  function trainingsHtml() {
    if (!reps.length) return '<div class="card"><p class="note">Zatiaľ žiadny čas.</p></div>';
    const shown = reps.filter(r => matches(r, filter));
    if (!shown.length) return '<div class="card"><p class="note">Žiadny beh tohto typu.</p></div>';
    return trainings(shown).map(t => {
      const current = open && !open.ended && t.id === open.id;
      const summary = Object.values(t.best).map(b => {
        const n = t.runs.filter(r => (r.who ?? r.chip) === (b.who ?? b.chip)).length;
        return `<span><b>${esc(name(b))}</b> ${behy(n)} · najlepší ${sec(b.lap)} s</span>`;
      }).join('');
      const delT = armed === `t:${t.id}`;
      return `<section class="card fl-training${current ? ' current' : ''}">
        <header class="fl-thead">
          <div><h2>${current ? 'Tento tréning' : esc(dayName(t.from))}</h2>
            <small>${current ? esc(dayName(t.from)) + ' · ' : ''}${hm(t.from)}–${hm(t.to)} · ${behy(t.runs.length)}</small></div>
        </header>
        <div class="fl-sum">${summary}</div>
        ${current ? `<div class="fl-plan"><p class="sp-lb">Ďalšie behy v tomto tréningu</p>${planHtml()}</div>` : ''}
        ${t.runs.map(r => runHtml(r, t.best)).join('')}
        <div class="row fl-tactions">
          ${current ? '<button class="btn" data-fl="end">Ukončiť tréning</button>' : ''}
          <button class="btn danger${delT ? ' armed' : ''}" data-fl="del-t" data-id="${esc(t.id)}">${delT ? 'Naozaj zmazať tréning?' : 'Zmazať tréning'}</button>
        </div>
      </section>`;
    }).join('');
  }

  // What the next runs are, set once for a block of run-ups instead of on every run.
  function planHtml() {
    const p = open && !open.ended ? open.plan ?? null : null, t = p?.type ?? 'auto';
    const b = (v, l) => `<button data-plan-type="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    return `<div class="filt">${b('auto', 'Rozpoznať')}${Object.entries(TYPES).map(([v, l]) => b(v, l)).join('')}</div>
      ${t === 'rozbeh' ? `<label class="fl-steps">Krokov <select data-plan-steps>${STEP_CHOICES.map(n => `<option${n === p.steps ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}`;
  }
  function setPlan(type, steps) {
    open = sessionFor(open, Date.now());
    const prev = open.plan;
    open = { ...open, plan: type === 'auto' ? null : { type, steps: type === 'rozbeh' ? steps ?? prev?.steps ?? 12 : null } };
    store(SESSION_KEY, open);
    draw();
  }
  // Clicks and changes on a plan control, wherever it is drawn (also the Tréning card).
  function planEvent(e) {
    const t = e.target.closest?.('[data-plan-type]');
    if (t && e.type === 'click') { setPlan(t.dataset.planType); return true; }
    if (e.target.matches?.('[data-plan-steps]') && e.type === 'change') { setPlan('rozbeh', +e.target.value); return true; }
    return false;
  }

  function filterHtml() {
    const b = (v, l) => `<button data-fl="f" data-v="${v}" class="${filter.type === v ? 'on' : ''}">${l}</button>`;
    const steps = [...new Set(reps.filter(r => modeOfRun(r) === 'rozbeh' && r.steps).map(r => r.steps))].sort((a, z) => a - z);
    const sb = (v, l) => `<button data-fl="fs" data-v="${v}" class="${(filter.steps ?? 'all') === v ? 'on' : ''}">${l}</button>`;
    return `<div class="card"><div class="filt">${b('all', 'Všetko')}${Object.entries(TYPES).map(([v, l]) => b(v, l)).join('')}</div>
      ${filter.type === 'rozbeh' && steps.length ? `<div class="filt">${sb('all', 'všetky')}${steps.map(n => sb(n, `${n} krokov`)).join('')}</div>` : ''}</div>`;
  }

  // One run on the detail screen: its time and splits, and what it was.
  function drawDetail() {
    if (!detailRoot) return;
    const r = reps.find(x => x.key === detailKey);
    if (!r) { detailRoot.innerHTML = ''; return; }
    const t = r.type ?? 'auto', auto = modeOfRun({ ...r, type: undefined });
    const b = (v, l) => `<button data-run-type="${v}" class="${t === v ? 'on' : ''}">${l}</button>`;
    detailRoot.innerHTML = `<section class="card fl-detail">
      <p class="sp-bar-top"><span>Freelap</span><span>${esc(dayName(r.at))} · ${hms(r.at)}</span></p>
      <div class="fl-row"><div class="fl-who"><b>${esc(name(r))}</b><small>${esc(typeLabel(r))} · ${r.legs?.length ? `${r.legs.length * 10} m` : ''}</small></div>
        <div class="fl-time"><b>${sec(r.lap)}</b><span>s</span></div></div>
      ${legsHtml(r)}
      <p class="sp-lb">Čo to bol za beh</p>
      <div class="filt">${b('auto', `Rozpoznať (${TYPES[auto].toLowerCase()})`)}${Object.entries(TYPES).map(([v, l]) => b(v, l)).join('')}</div>
      ${modeOfRun(r) === 'rozbeh' ? `<label class="fl-steps">Krokov rozbehu <select data-run-steps>${STEP_CHOICES.map(n => `<option${n === r.steps ? ' selected' : ''}>${n}</option>`).join('')}</select></label>` : ''}
      ${linker(r.key) ? '' : '<p class="note">K tomuto behu nie je video. Šprint natočený v appke pri zapnutom Freelape sa s časom spojí sám.</p>'}
    </section>`;
  }
  function editRun(key, patch) {
    const i = reps.findIndex(x => x.key === key);
    if (i < 0) return;
    const r = { ...reps[i], ...patch };
    for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
    reps[i] = r;
    save(); draw(); drawDetail(); onChange(r);
  }
  detailRoot?.addEventListener('click', e => {
    const b = e.target.closest('[data-run-type]');
    if (!b) return;
    const v = b.dataset.runType, r = reps.find(x => x.key === detailKey);
    if (v === 'auto') editRun(detailKey, { type: undefined, steps: undefined });
    else editRun(detailKey, { type: v, steps: v === 'rozbeh' ? r?.steps ?? open?.plan?.steps ?? 12 : undefined });
  });
  detailRoot?.addEventListener('change', e => {
    if (e.target.matches('[data-run-steps]')) editRun(detailKey, { type: 'rozbeh', steps: +e.target.value });
  });

  function draw() {
    const s = listener.state, on = s === 'on' || s === 'starting';
    const allArmed = armed === 'all';
    root.innerHTML = `
      <div class="card fl-head">
        <h2>Freelap</h2>
        <div class="fl-status"><span class="fl-dot${s === 'on' ? ' live' : ''}"></span><span>${esc(STATE[s])}</span></div>
        ${error ? `<p class="banner bad">${esc(errorText(error))}</p>` : ''}
        ${ble ? `<button class="btn ${on ? 'fl-stop' : 'fl-start'}" data-fl="${on ? 'stop' : 'start'}">${on ? 'Stop' : 'Start'}</button>` : ''}
        <p class="note" id="fl-count"></p>
      </div>
      ${reps.length ? filterHtml() : ''}
      ${trainingsHtml()}
      ${reps.length ? `<button class="btn danger${allArmed ? ' armed' : ''}" data-fl="clear">${allArmed ? 'Naozaj vymazať všetky časy?' : 'Vymazať všetky časy'}</button>` : ''}
      <details class="card"><summary>Posledné vysielanie z čipu</summary><p class="fl-hex">${esc(lastHex || 'žiadne prečítané')}</p><p class="fl-hex" id="fl-raw">${esc(lastChip)}</p></details>`;
    drawCount();
  }
  function drawCount() {
    const el = root.querySelector('#fl-count');
    if (el) el.textContent = listener.state === 'on'
      ? `Bluetooth zariadení v okolí: ${heard?.devices ?? 0} · vysielaní Freelap: ${heard?.named ?? 0} · prečítaných: ${packets}` : '';
    const raw = root.querySelector('#fl-raw');
    if (raw && lastChip) raw.textContent = lastChip;
  }

  // Deleting takes two taps on the same button; the first one arms it for 4 s.
  function confirm(what) {
    if (armed === what) { armed = null; clearTimeout(armTimer); return true; }
    armed = what;
    clearTimeout(armTimer);
    armTimer = setTimeout(() => { armed = null; draw(); }, 4000);
    draw();
    return false;
  }

  // The keys of deleted runs stay remembered by the listener, so a chip still repeating its last
  // run doesn't bring it back.
  root.addEventListener('change', e => { planEvent(e); });
  root.addEventListener('click', e => {
    if (planEvent(e)) return;
    const b = e.target.closest('[data-fl]');
    if (!b) return;
    const act = b.dataset.fl;
    if (act === 'open') return onOpen(b.dataset.key);
    if (act === 'f' || act === 'fs') {
      if (act === 'f') filter = { type: b.dataset.v, steps: null };
      else filter = { ...filter, steps: b.dataset.v === 'all' ? null : +b.dataset.v };
      store(FILTER_KEY, filter);
      return draw();
    }
    if (act === 'start') listener.start();
    else if (act === 'stop') listener.stop();
    else if (act === 'end') {
      if (open) { open = { ...open, ended: true }; store(SESSION_KEY, open); }
      draw();
    } else if (act === 'del') {
      if (!confirm(b.dataset.key)) return;
      reps = reps.filter(r => r.key !== b.dataset.key); save(); draw();
    } else if (act === 'del-t') {
      if (!confirm(`t:${b.dataset.id}`)) return;
      reps = reps.filter(r => (r.session ?? `d${dayKey(r.at)}`) !== b.dataset.id); save(); draw();
    } else if (act === 'clear') {
      if (!confirm('all')) return;
      reps = []; save(); draw();
    }
  });

  draw();
  return {
    shown: draw, listener,
    listening: () => listener.state === 'on',
    runs: () => reps.slice(),   // the Sprint tab pairs uploaded videos with these
    onRun(f) { subs.add(f); return () => subs.delete(f); },
    setLinker(f) { linker = f; draw(); },
    openRun(key) { detailKey = key; drawDetail(); return !!reps.find(x => x.key === key); },
    planHtml, planEvent,
  };
}
