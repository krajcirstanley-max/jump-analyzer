// The Sprint tab, top part: film a sprint in the app at 120 fps. If Freelap is listening (its card
// sits right under this one, Stanley 2026-11-13: "tie podstatné veci vedľa seba"), every run it
// hears while filming goes onto the video as a ring timer. The camera and the overlay are native
// (ios/App/App/SprintCamera.swift); this page opens it and passes the runs. Videos go to Photos.

import { CHIPS } from './freelap/listen.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The app's own camera plugin, through Capacitor's bridge. null in Safari.
function camera(cap = globalThis.Capacitor) {
  if (!cap?.isNativePlatform?.() || !cap.nativePromise || !cap.addListener) return null;
  return {
    open: o => cap.nativePromise('SprintCamera', 'open', o),
    run: r => cap.nativePromise('SprintCamera', 'run', r),
    on: (ev, f) => cap.addListener('SprintCamera', ev, d => d && f(d)),
  };
}

export function initSprint({ root, athletes, freelap, cam = camera() }) {
  let unsub = null, last = '';

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip ?? '';
  const send = (_, run) => cam.run({ key: run.key, name: name(run), lap: run.lap, legs: run.legs ?? [] }).catch(() => {});

  if (cam) {
    cam.on('saved', d => { last = d.message ?? ''; draw(); });
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

  function draw() {
    root.innerHTML = cam ? `
      <div class="card sp-go">
        <button class="btn go primary" data-sp="film">Natáčať šprint</button>
        <p class="note">120 snímok za sekundu, uloží sa do Fotiek. Keď Freelap nižšie počúva, vo videu bežia stopky od štartu, medzičasy a výsledný čas.</p>
        ${last ? `<p class="sp-last">${esc(last)}</p>` : ''}
      </div>`
      : '<div class="card"><p class="note">Natáčanie a Freelap idú len v appke Skok v iPhone.</p></div>';
  }

  root.addEventListener('click', e => {
    if (e.target.closest('[data-sp="film"]')) film();
  });

  draw();
  return { shown: draw };
}
