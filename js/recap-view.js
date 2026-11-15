// "Video z tréningu": the button on a day's list, the progress, the video and "Uložiť do Fotiek".
// The cut itself is js/recap.js; the drawing is the server's (server/recap_render.py).
import { story } from './recap.js';
import { analyzeJump, cleanEdges } from './analysis/jump.js';
import { recapInCloud, cloudReady } from './cloud.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayKey = t => new Date(t).toLocaleDateString('sv-SE');
const dayOfYear = t => { const d = new Date(t); return Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 864e5); };

// The buttons for one day: one per athlete who jumped that day (items from the feed).
export function recapButtons(items, day) {
  const by = new Map();
  for (const it of items) if (it.kind === 'skok' && dayKey(it.at) === day) by.set(it.who, (by.get(it.who) ?? 0) + 1);
  return [...by].map(([who, n]) => `<button class="recap-btn" data-recap="${esc(who)}" data-day="${esc(day)}"><span>▶</span> Video z tréningu<small>${esc(nameOf(items, who))} · ${n} ${n === 1 ? 'skok' : n < 5 ? 'skoky' : 'skokov'}</small></button>`).join('');
}
const nameOf = (items, who) => (items.find(it => it.who === who)?.title ?? '').split(' · ')[0];

export function initRecap({ hist, athletes, profiles }) {
  let busy = null;
  const sheet = document.createElement('div');
  sheet.className = 'recap-sheet hidden';
  document.body.appendChild(sheet);
  const show = html => { sheet.innerHTML = `<div class="recap-card">${html}</div>`; sheet.classList.remove('hidden'); };
  const close = () => { busy?.abort(); busy = null; const v = sheet.querySelector('video'); if (v?.src) URL.revokeObjectURL(v.src); sheet.classList.add('hidden'); sheet.innerHTML = ''; };
  let last = null;

  sheet.addEventListener('click', async e => {
    if (e.target.closest('[data-recap-close]')) return close();
    const save = e.target.closest('[data-recap-save]');
    if (save && last) {
      const plug = globalThis.Capacitor?.Plugins?.SprintCamera;
      save.disabled = true; save.textContent = 'Ukladám…';
      try {
        if (plug?.saveVideo) { await plug.saveVideo({ url: last.url, auth: last.token }); save.textContent = 'Uložené vo Fotkách ✓'; }
        else { const a = document.createElement('a'); a.href = sheet.querySelector('video').src; a.download = `trening-${last.day}.mp4`; a.click(); save.textContent = 'Stiahnuté ✓'; }
      } catch (err) { save.disabled = false; save.textContent = 'Uložiť do Fotiek'; alert(`Nepodarilo sa uložiť: ${err?.message ?? err}`); }
    }
  });

  document.addEventListener('click', async e => {
    const b = e.target.closest('[data-recap]');
    if (!b || busy) return;
    if (!cloudReady()) { alert('Najprv ulož prístupový kľúč v nastaveniach.'); return; }
    const who = b.dataset.recap, day = b.dataset.day, a = athletes[who];
    busy = new AbortController();
    const stage = t => !busy || busy.signal.aborted ? null : show(`<h2>Video z tréningu</h2><p class="recap-stage"><span class="spin"></span>${esc(t)}…</p><p class="note">${esc(a?.name ?? '')} · ${esc(new Date(day).toLocaleDateString('sk-SK', { weekday: 'long', day: 'numeric', month: 'numeric' }))}</p><button class="btn" data-recap-close>Zrušiť</button>`);
    try {
      stage('Pripravujem video');
      const recs = (await hist.listAttempts(who)).filter(r => dayKey(Date.parse(r.recordedAt || r.analysedAt)) === day)
        .sort((x, y) => Date.parse(x.recordedAt || x.analysedAt) - Date.parse(y.recordedAt || y.analysedAt));
      const jumps = [], clips = [];
      for (const r of recs) {
        const m = await hist.loadMedia(r.id);
        if (!m?.clip || !m?.pose) continue;
        // read again with today's code and the athlete's corrections (tape, Freelap, hand-set frames)
        const split = r.split != null ? r.split : null;
        const j = analyzeJump(m.pose, a.sex, m.pose.ts ?? null, { height: a.height, pb: profiles[who]?.pb ?? null, runup: r.runup ?? null, tape: r.measured ?? null, tapeFrom: r.tapeFrom ?? null, split, edges: cleanEdges(r.edges) });
        if (j.error) continue;
        Object.assign(j, { coach: r.jump?.coach ?? j.coach, split, runup: r.runup ?? null });
        jumps.push({ jump: j, pose: m.pose, at: Date.parse(r.recordedAt || r.analysedAt) });
        clips.push(m.clip);
      }
      if (!jumps.length) throw new Error('K tomuto dňu nemám v telefóne video ani jedného skoku.');
      const s = story(jumps, { athlete: a, date: jumps.at(-1).at, sex: a.sex, height: a.height });
      if (!s) throw new Error('Z týchto skokov sa video nedá zostaviť.');
      s.music = dayOfYear(day);
      const out = await recapInCloud(clips, s, { onStage: stage, signal: busy.signal });
      last = { ...out, day };
      const src = URL.createObjectURL(out.blob);
      show(`<h2>Video z tréningu</h2><video class="recap-video" src="${src}" controls playsinline autoplay></video>
        <div class="row recap-actions"><button class="btn primary" data-recap-save>Uložiť do Fotiek</button><button class="btn" data-recap-close>Zavrieť</button></div>`);
      busy = null;
    } catch (err) {
      if (err?.name === 'AbortError') return;
      busy = null;
      show(`<h2>Video z tréningu</h2><p class="banner bad">${esc(err?.message ?? String(err))}</p><button class="btn" data-recap-close>Zavrieť</button>`);
    }
  });
  return { close };
}
