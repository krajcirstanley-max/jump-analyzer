// The Freelap tab: Start listens for the chips, Stop stops taking anything in, and every run a chip
// sends shows up at the top with whose chip it is. Kept in this phone (times only) until cleared.
import { createListener, nativeBle } from './freelap/listen.js';

const KEY = 'jump.freelap';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = x => Number(x).toFixed(2).replace('.', ',');
const clock = t => new Date(t).toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const day = t => new Date(t).toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'numeric' });
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const save = list => { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 300))); } catch { /* storage blocked */ } };

const STATE = {
  none: 'Freelap ide len v appke Skok v iPhone. Safari nemá Bluetooth.',
  off: 'Nepočúva. Časy z čipov sa neprijímajú.',
  starting: 'Zapínam Bluetooth…',
  on: 'Počúvam čipy. Prebehni cez cieľ a čas sa ukáže tu.',
};

// The plugin's messages, in words.
const ERRORS = {
  'BLE powered off': 'Bluetooth je vypnutý. Zapni ho v Ovládacom centre a stlač Start znova.',
  'BLE permission denied': 'Skok nemá povolený Bluetooth. Zapni ho v Nastavenia → Skok → Bluetooth.',
  'BLE unsupported': 'Toto zariadenie nemá Bluetooth.',
};
const errorText = e => ERRORS[e] ?? `Bluetooth sa nepodarilo zapnúť (${e}).`;

export function initFreelap({ root, athletes, ble = nativeBle() }) {
  let reps = load(), error = null, packets = 0, lastHex = '', armed = false;
  const listener = createListener(ble, {
    rep(r) {
      reps.unshift({ chip: r.chip, who: r.who, lap: r.lap, legs: r.legs, at: r.at, key: r.key });
      save(reps);
      draw();
      navigator.vibrate?.(60);
    },
    packet(n, hex) { packets = n; lastHex = hex; drawCount(); },
    state(s, err) { error = err; if (s === 'on') packets = 0; draw(); },
  }, new Set(reps.map(r => r.key)));

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip;

  function repsHtml() {
    if (!reps.length) return '<p class="note">Zatiaľ žiadny čas.</p>';
    let html = '', lastDay = '';
    for (const r of reps) {
      const d = day(r.at);
      if (d !== lastDay) { html += `<h3 class="fl-day">${esc(d)}</h3>`; lastDay = d; }
      const legs = r.legs.length > 1 ? `<span class="fl-legs">${r.legs.map(sec).join(' · ')}</span>` : '';
      html += `<div class="fl-rep"><div class="fl-who"><b>${esc(name(r))}</b><small>${esc(r.chip)} · ${clock(r.at)}</small></div>`
        + `<div class="fl-time"><b>${sec(r.lap)}</b> s${legs}</div></div>`;
    }
    return html;
  }

  function draw() {
    const s = listener.state, on = s === 'on' || s === 'starting';
    root.innerHTML = `
      <div class="card fl-head">
        <div class="fl-status"><span class="fl-dot${s === 'on' ? ' live' : ''}"></span><span>${esc(STATE[s])}</span></div>
        ${error ? `<p class="banner bad">${esc(errorText(error))}</p>` : ''}
        ${ble ? `<button class="btn go ${on ? 'fl-stop' : 'fl-start'}" data-fl="${on ? 'stop' : 'start'}">${on ? 'Stop' : 'Start'}</button>` : ''}
        <p class="note" id="fl-count"></p>
      </div>
      <div class="card"><h2>Časy</h2>${repsHtml()}</div>
      ${reps.length ? `<button class="btn danger${armed ? ' armed' : ''}" data-fl="clear">${armed ? 'Naozaj vymazať všetky časy?' : 'Vymazať časy'}</button>` : ''}
      ${lastHex ? `<details class="card"><summary>Posledné vysielanie z čipu</summary><p class="fl-hex">${esc(lastHex)}</p></details>` : ''}`;
    drawCount();
  }
  function drawCount() {
    const el = root.querySelector('#fl-count');
    if (el) el.textContent = listener.state === 'on' ? `Prijaté vysielania z čipov: ${packets}` : '';
  }

  root.addEventListener('click', e => {
    const b = e.target.closest('[data-fl]');
    if (!b) return;
    const act = b.dataset.fl;
    if (act === 'start') listener.start();
    else if (act === 'stop') listener.stop();
    else if (act === 'clear') {
      if (!armed) { armed = true; draw(); setTimeout(() => { armed = false; draw(); }, 4000); return; }
      // The keys stay remembered, so a chip still repeating its last run doesn't bring it back.
      armed = false; reps = []; save(reps);
      draw();
    }
  });

  draw();
  return { shown: draw, listener };
}
