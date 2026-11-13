// The Sprint tab: film a sprint in the app at 120 fps. If Freelap is listening, every run it hears
// while filming goes onto the video as an overlay in the corner (Stanley, 2026-11-13). The camera
// and the overlay are native (ios/App/App/SprintCamera.swift); this page opens it, passes the runs
// and keeps a short list of what was filmed. The videos themselves go to Photos.

const KEY = 'jump.sprint';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sec = x => Number(x).toFixed(2).replace('.', ',');
const when = t => new Date(t).toLocaleString('sk-SK', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } };
const store = v => { try { localStorage.setItem(KEY, JSON.stringify(v.slice(0, 100))); } catch { /* storage blocked */ } };

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
  let clips = load(), unsub = null, armed = null;

  const name = r => (r.who ? athletes[r.who]?.name : null) ?? r.chip ?? '';
  const send = (_, run) => cam.run({ key: run.key, name: name(run), lap: run.lap, legs: run.legs ?? [] }).catch(() => {});

  if (cam) {
    cam.on('saved', d => {
      clips.unshift({ at: Date.now(), message: d.message, burned: !!d.burned, fps: d.fps, times: d.times ?? [] });
      store(clips);
      draw();
    });
    cam.on('closed', () => { unsub?.(); unsub = null; draw(); });
  }

  async function film() {
    const on = freelap.listening();
    unsub?.();
    if (on) unsub = freelap.onRun(send);   // runs heard while the camera is open go to it
    try { await cam.open({ fps: 120, freelap: on }); } catch (e) { unsub?.(); unsub = null; alert(`Kameru sa nepodarilo otvoriť: ${e?.message ?? e}`); }
  }

  function clipsHtml() {
    if (!clips.length) return '<p class="note">Zatiaľ nič natočené.</p>';
    return clips.map((c, i) => {
      const times = c.times.map(t => `<span><b>${esc(t.name)}</b> ${sec(t.lap)} s${t.legs?.length > 1 ? ` <small>(${t.legs.map(sec).join(' · ')})</small>` : ''}</span>`).join('');
      return `<div class="sp-clip">
        <div class="sp-head"><b>${esc(when(c.at))}</b><small>${c.fps ? `${Math.round(c.fps)} fps · ` : ''}${c.burned ? 's časmi vo videu' : 'bez časov'}</small>
          <button class="fl-del${armed === i ? ' armed' : ''}" data-sp="del" data-i="${i}" aria-label="Zmazať zo zoznamu">${armed === i ? 'Zmazať' : '×'}</button></div>
        ${times ? `<div class="sp-times">${times}</div>` : ''}
      </div>`;
    }).join('');
  }

  function draw() {
    const on = freelap.listening();
    root.innerHTML = cam ? `
      <div class="card sp-go">
        <button class="btn go primary" data-sp="film">Natáčať šprint</button>
        <div class="fl-status"><span class="fl-dot${on ? ' live' : ''}"></span>
          <span>${on ? 'Freelap počúva: časy pôjdu do videa v ľavom hornom rohu.' : 'Freelap nepočúva: video bude bez časov.'}</span></div>
        ${on ? '' : '<button class="btn" data-sp="freelap">Zapnúť Freelap</button>'}
        <p class="note">Natáča sa 120 snímok za sekundu. Video sa uloží do Fotiek. S Freelapom v ňom bežia stopky od štartu, potom medzičasy a výsledný čas.</p>
      </div>
      <div class="card"><h2>Natočené</h2>${clipsHtml()}</div>`
      : '<div class="card"><p class="note">Natáčanie ide len v appke Skok v iPhone.</p></div>';
  }

  root.addEventListener('click', async e => {
    const b = e.target.closest('[data-sp]');
    if (!b) return;
    if (b.dataset.sp === 'film') film();
    else if (b.dataset.sp === 'freelap') { await freelap.listener.start(); draw(); }
    else if (b.dataset.sp === 'del') {
      const i = +b.dataset.i;
      if (armed !== i) { armed = i; draw(); setTimeout(() => { if (armed === i) { armed = null; draw(); } }, 4000); return; }
      armed = null; clips.splice(i, 1); store(clips); draw();
    }
  });

  draw();
  return { shown: draw };
}
