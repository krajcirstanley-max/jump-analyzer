// Two long jumps side by side (Stanley, 2026-11-15, design approved: "Takéto split view porovnanie
// by malo byť možné"): both videos with their skeleton and angles, played together and lined up on
// the jump's own moments (penultimate, board, deepest knee, take-off, apex, landing), the five phase
// scores with their change, and the selected phase's numbers from both jumps on the finalists' band.
// Only measured numbers and the norm: no made-up "ideal" figure. The newer jump is B, on the right.

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = (x, dp) => Number(x).toFixed(dp).replace('.', ',').replace(/^-/, '−');
const decimals = m => (m.unit === 'm' || m.unit === 'm/s' ? 2 : m.key === 'takeoffAngle' ? 1 : 0);
const withUnit = (m, s) => (m.unit === '°' ? `${s}°` : `${s} ${m.unit}`);
const fmt = (m, v) => withUnit(m, num(v, decimals(m)));
const band = s => (s == null ? 'none' : s >= 85 ? 'hi' : s >= 60 ? 'mid' : 'lo');
const shown = m => m && m.status !== 'hidden' && Number.isFinite(m.value);
const dateOf = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '' : `${d.getDate()}. ${d.getMonth() + 1}.`; };
const timeOf = iso => { const d = new Date(iso); return Number.isNaN(+d) ? '' : d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' }); };
const scoreOf = rec => Math.round(typeof rec?.score === 'number' ? rec.score : rec?.jump?.score?.score ?? rec?.jump?.score ?? NaN);
const distOf = rec => rec?.measured ?? rec?.jump?.measured ?? rec?.jump?.metrics?.find?.(m => m.key === 'estDistance' && m.status !== 'hidden')?.value ?? null;

// The moments both jumps are lined up on, in the order they happen.
export const ANCHORS = ['td3', 'penTD', 'penTO', 'TD', 'maxFlex', 'TO', 'apex', 'land'];
export const CHIPS = [['pen', 'Predposledný', ['penTD', 'penTO', 'td3']], ['plant', 'Plant', ['TD']], ['toeoff', 'Odraz', ['TO']], ['landing', 'Dopad', ['land']]];

// Key frames of a jump by id: { penTD: 412, TD: 470, ... }.
export function keyFramesOf(jump) {
  const out = {};
  for (const p of jump?.phases ?? []) for (const k of p.keyFrames ?? []) if (Number.isFinite(k.frame)) out[k.id] = k.frame;
  return out;
}

// Pairs of times (s from the clip's start) the two jumps share, increasing in both.
export function anchorPairs(jumpA, tsA, jumpB, tsB) {
  const a = keyFramesOf(jumpA), b = keyFramesOf(jumpB), pairs = [];
  for (const id of ANCHORS) {
    if (a[id] == null || b[id] == null || tsA[a[id]] == null || tsB[b[id]] == null) continue;
    const p = { id, a: tsA[a[id]] - tsA[0], b: tsB[b[id]] - tsB[0] };
    const last = pairs.at(-1);
    if (last && (p.a <= last.a || p.b <= last.b)) continue;
    pairs.push(p);
  }
  return pairs;
}

// B's time to A's: straight between the shared moments, at the same pace before the first and
// after the last, so the two jumps pass every moment together.
export function mapTime(pairs, tB) {
  if (!pairs.length) return tB;
  if (tB <= pairs[0].b) return pairs[0].a + (tB - pairs[0].b);
  const last = pairs.at(-1);
  if (tB >= last.b) return last.a + (tB - last.b);
  const i = pairs.findIndex(p => p.b > tB), p = pairs[i - 1], q = pairs[i];
  return p.a + ((tB - p.b) / (q.b - p.b)) * (q.a - p.a);
}

export function nearestFrame(ts, t) {
  const t0 = ts[0], want = t + t0;
  let lo = 0, hi = ts.length - 1;
  if (want <= ts[0]) return 0;
  if (want >= ts[hi]) return hi;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= want) lo = m; else hi = m; }
  return want - ts[lo] <= ts[hi] - want ? lo : hi;
}

// One measurement in both jumps: the change said as what moved, and toward the norm when it did.
// judge: false for two different athletes, whose norms differ (a woman's and a man's): then the
// change alone, never "do normy" against the other one's norm.
export function changeText(m, a, b, judge = true) {
  const [lo, hi] = (m.norm ?? []).map(Number), inNorm = v => Number.isFinite(lo) && v >= Math.min(lo, hi) && v <= Math.max(lo, hi);
  const d = b - a, dp = decimals(m), step = 10 ** -dp;
  if (Math.abs(d) < step / 2) return { text: 'rovnako', good: null };
  if (!judge) return { text: `o ${withUnit(m, num(Math.abs(d), dp))} ${d > 0 ? 'viac' : 'menej'}`, good: null };
  if (inNorm(a) && inNorm(b)) return { text: 'obe v norme', good: null };
  const size = withUnit(m, num(Math.abs(d), dp));
  const dist = v => (inNorm(v) ? 0 : Math.min(Math.abs(v - lo), Math.abs(v - hi)));
  if (!inNorm(a) && inNorm(b)) return { text: `o ${size} ${d > 0 ? 'viac' : 'menej'}, do normy`, good: true };
  if (dist(b) < dist(a)) return { text: `o ${size} ${d > 0 ? 'viac' : 'menej'}, bližšie k norme`, good: true };
  return { text: `o ${size} ${d > 0 ? 'viac' : 'menej'}`, good: false };
}

// The finalists' band with both jumps on it: grey dot the older, green the newer.
function bandHtml(m, a, b) {
  const [lo, hi] = m.norm ?? [];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  const vs = [a, b].filter(Number.isFinite), span = Math.abs(hi - lo) || 1;
  const x0 = Math.min(lo, hi, ...vs) - span * 0.4, x1 = Math.max(lo, hi, ...vs) + span * 0.4;
  const at = v => Math.max(2, Math.min(98, ((v - x0) / (x1 - x0)) * 100));
  const l = at(Math.min(lo, hi)), w = at(Math.max(lo, hi)) - l;
  return `<div class="cmp-band"><em style="left:${l.toFixed(1)}%;width:${w.toFixed(1)}%"></em>${Number.isFinite(a) ? `<span class="pa" style="left:${at(a).toFixed(1)}%"></span>` : ''}${Number.isFinite(b) ? `<span class="pb" style="left:${at(b).toFixed(1)}%"></span>` : ''}</div>`;
}
const rangeText = m => { const [lo, hi] = m.norm, dp = decimals(m); return withUnit(m, lo < 0 || hi < 0 ? `${num(lo, dp)} až ${num(hi, dp)}` : `${num(lo, dp)}–${num(hi, dp)}`); };

// The selected phase's measurements, both jumps; only those measured in at least one.
export function rowsFor(phaseId, jumpA, jumpB, { judge = true } = {}) {
  const pa = (jumpA.phases ?? []).find(p => p.id === phaseId), pb = (jumpB.phases ?? []).find(p => p.id === phaseId);
  const keys = [...new Set([...(pb?.metrics ?? []), ...(pa?.metrics ?? [])].map(m => m.key))];
  const byA = Object.fromEntries((pa?.metrics ?? []).map(m => [m.key, m])), byB = Object.fromEntries((pb?.metrics ?? []).map(m => [m.key, m]));
  return keys.map(k => {
    const ma = byA[k], mb = byB[k], m = mb ?? ma;
    const a = shown(ma) ? ma.value : null, b = shown(mb) ? mb.value : null;
    return { m, a, b, change: a != null && b != null ? changeText(m, a, b, judge) : null };
  }).filter(r => r.a != null || r.b != null);
}

// The phase that moved most, said with its clearest measured improvement.
export function headline(jumpA, jumpB, { judge = true } = {}) {
  const gains = (jumpB.phases ?? []).map(p => ({ p, a: (jumpA.phases ?? []).find(x => x.id === p.id)?.score, b: p.score }))
    .filter(x => Number.isFinite(x.a) && Number.isFinite(x.b)).map(x => ({ ...x, d: x.b - x.a })).sort((x, y) => y.d - x.d);
  const top = gains[0];
  if (!top || top.d < 3) return null;
  const best = rowsFor(top.p.id, jumpA, jumpB, { judge }).filter(r => r.change?.good).sort((x, y) => Math.abs(y.b - y.a) / (Math.abs(y.m.norm?.[1] - y.m.norm?.[0]) || 1) - Math.abs(x.b - x.a) / (Math.abs(x.m.norm?.[1] - x.m.norm?.[0]) || 1))[0];
  return `Najväčší posun je ${top.p.id === 'pen' ? 'v predposlednom kroku' : top.p.id === 'plant' ? 'pri pláne' : top.p.id === 'toeoff' ? 'na odraze' : top.p.id === 'flight' ? 'v lete' : 'pri dopade'} (+${Math.round(top.d)})${best ? `: ${best.m.label.toLowerCase()} ${best.change.text}` : ''}.`;
}

// ---------- Screen ----------
// loadPair(idA, idB) -> { a: { rec, clip, pose }, b }; makePane(root, side) -> { player, input };
// listAll() -> attempts of both athletes.
export function initCompare({ root, athletes, listAll, loadOne, makePane }) {
  let state = null;   // { a, b, pairs, sel, panes }
  let pickFor = null, pickFilter = 'mine';
  let gen = 0;        // bumped by close(): a load that finishes after it throws its players away

  function close() {
    gen++;
    for (const p of state?.panes ?? []) { p.player?.dispose?.(); p.input?.dispose?.(); }
    state = null;
  }

  // ----- picking the other jump -----
  async function pick(idB) {
    close();
    const my = gen;
    pickFor = idB;
    const all = (await listAll()).filter(r => r?.jump && !r.jump.error);
    if (my !== gen) return;
    const me = all.find(r => r.id === idB);
    if (!me) { root.innerHTML = '<div class="card"><p class="note">Tento pokus sa nenašiel.</p></div>'; return; }
    const others = all.filter(r => r.id !== idB && r.media?.clip && r.media?.pose);
    const mine = others.filter(r => r.athlete === me.athlete).sort((x, y) => String(y.recordedAt).localeCompare(String(x.recordedAt)));
    const theirs = others.filter(r => r.athlete !== me.athlete).sort((x, y) => String(y.recordedAt).localeCompare(String(x.recordedAt)));
    const bestOf = list => [...list].sort((x, y) => (distOf(y) ?? 0) - (distOf(x) ?? 0) || (scoreOf(y) || 0) - (scoreOf(x) || 0)).slice(0, 1);
    const otherName = Object.entries(athletes).find(([id]) => id !== me.athlete)?.[1]?.name ?? 'Druhý atlét';
    const list = pickFilter === 'mine' ? mine : pickFilter === 'theirs' ? theirs : bestOf(mine);
    const row = r => `<li><button class="cmp-pick" data-cmp-with="${esc(r.id)}"><span><b>${esc(athletes[r.athlete]?.name ?? '')} · ${dateOf(r.recordedAt)} ${timeOf(r.recordedAt)}</b>
      <small>${distOf(r) != null ? `${num(distOf(r), 2)} m · ` : ''}skóre ${Number.isFinite(scoreOf(r)) ? scoreOf(r) : '–'}${r.runup ? ` · rozbeh ${r.runup} kr.` : ''}</small></span><span class="cmp-go">›</span></button></li>`;
    root.innerHTML = `<section class="card">
      <h2>Porovnať s…</h2>
      <p class="note">Tento skok: ${esc(athletes[me.athlete]?.name ?? '')} · ${dateOf(me.recordedAt)} ${timeOf(me.recordedAt)}${distOf(me) != null ? ` · ${num(distOf(me), 2)} m` : ''}</p>
      <div class="filt cmp-filt"><button data-cmp-filter="mine" class="${pickFilter === 'mine' ? 'on' : ''}">Moje skoky</button><button data-cmp-filter="theirs" class="${pickFilter === 'theirs' ? 'on' : ''}">${esc(otherName)}</button><button data-cmp-filter="best" class="${pickFilter === 'best' ? 'on' : ''}">Najlepší</button></div>
      ${list.length ? `<ul class="cmp-list">${list.map(row).join('')}</ul>` : '<p class="note">Žiadny iný skok s videom tu nie je.</p>'}
    </section>`;
  }

  // ----- the comparison -----
  async function compare(idA, idB) {
    close();
    const my = gen;
    const gone = () => my !== gen;   // left, or another comparison began meanwhile
    root.innerHTML = '<div class="card"><p class="note">Otváram oba skoky…</p></div>';
    const [a, b] = await Promise.all([loadOne(idA), loadOne(idB)]);
    if (gone()) return;
    if (!a?.clip || !a?.pose || !b?.clip || !b?.pose) { root.innerHTML = '<div class="card"><p class="note">Pri jednom zo skokov už v telefóne nie je video.</p></div>'; return; }
    // the older on the left, the newer on the right
    const [L, R] = String(a.rec.recordedAt) <= String(b.rec.recordedAt) ? [a, b] : [b, a];
    const tag = (x, side) => `<span class="cmp-tag ${side}"><b>${dateOf(x.rec.recordedAt)} ${timeOf(x.rec.recordedAt)}</b>${esc(athletes[x.rec.athlete]?.name ?? '')}${distOf(x.rec) != null ? ` · ${num(distOf(x.rec), 2)} m` : ''}${Number.isFinite(scoreOf(x.rec)) ? ` · ${scoreOf(x.rec)}` : ''}</span>`;
    root.innerHTML = `<section class="card cmp">
      <div class="cmp-pair">
        <div class="cmp-pane"><div class="player cmp-player" data-side="a"></div>${tag(L, 'l')}<span class="cmp-ph" data-ph="a"></span></div>
        <div class="cmp-pane"><div class="player cmp-player" data-side="b"></div>${tag(R, 'r')}<span class="cmp-ph" data-ph="b"></span></div>
      </div>
      <div class="cmp-scrub"><button class="cmp-play" data-cmp="play" aria-label="Prehrať">▶</button><input type="range" class="cmp-range" min="0" value="0" step="1" aria-label="Čas"><button class="chip cmp-speed" data-cmp="speed">½×</button><button class="chip cmp-flip" data-cmp="flip" aria-label="Zrkadliť ľavé video" aria-pressed="false">⇋</button></div>
      <div class="filt cmp-chips">${CHIPS.map(([id, label]) => `<button data-cmp-ph="${id}">${label}</button>`).join('')}</div>
      <p class="note">Obe videá idú spolu a každú chvíľu skoku prejdú naraz. Ťuk na fázu ich zastaví na jej snímke.</p>
    </section>
    <section class="card"><p class="sp-lb">Fázy · ${dateOf(L.rec.recordedAt)} → ${dateOf(R.rec.recordedAt)}</p><div class="cmp-tiles" id="cmp-tiles"></div></section>
    <section class="card" id="cmp-rows"></section>
    <section class="card hidden" id="cmp-head"></section>`;
    const panes = [];
    const drop = () => { for (const p of panes) { p?.player?.dispose?.(); p?.input?.dispose?.(); } };
    try {
      panes[0] = await makePane(root.querySelector('[data-side="a"]'), L);
      if (gone()) return drop();
      panes[1] = await makePane(root.querySelector('[data-side="b"]'), R);
      if (gone()) return drop();
    } catch (e) {
      if (gone()) return drop();
      drop();
      root.innerHTML = `<div class="card"><p class="note">Video sa nepodarilo otvoriť: ${esc(e?.message ?? e)}</p></div>`;
      return;
    }
    const [pA, pB] = panes.map(p => p.player);
    // run the other way (one to the left, one to the right): the older one is mirrored so both run
    // the same way (Stanley, 2026-11-15); the button under the videos turns it over by hand
    const dirA = L.rec.jump?.dir, dirB = R.rec.jump?.dir;
    if (dirA && dirB && dirA !== dirB) setMirror(pA, true);
    const pairs = anchorPairs(L.rec.jump, pA.ts, R.rec.jump, pB.ts);
    state = { a: L, b: R, pairs, sel: 'toeoff', panes };
    pB.speed = 0.5;
    const range = root.querySelector('.cmp-range');
    range.max = String(pB.src.count - 1);
    // B leads; A follows to the same moment of its own jump
    const follow = i => {
      const tA = mapTime(pairs, pB.ts[i] - pB.ts[0]), j = nearestFrame(pA.ts, tA);
      if (j !== pA.target) pA.show(j);
      range.value = String(i);
      phaseLabels(i, j);
      const pl = root.querySelector('[data-cmp="play"]');
      if (pl) pl.textContent = pB.playing ? '❚❚' : '▶';   // the clip ending stops it too
    };
    pB.frameHooks.push(follow);
    const kfB = keyFramesOf(R.rec.jump);
    const start = kfB.td3 ?? kfB.penTD ?? kfB.TD ?? 0;
    await pB.show(Math.max(0, start - 10));
    follow(pB.index);
    drawNumbers();
  }

  function setMirror(p, on) {
    p.mirror = on;
    p.refresh?.();
    const b = root.querySelector('[data-cmp="flip"]'), t = root.querySelector('.cmp-tag.l');
    b?.classList.toggle('on', on); b?.setAttribute('aria-pressed', String(on));
    t?.classList.toggle('flipped', on);
  }

  // Which phase each pane is in, under it.
  function phaseLabels(iB, iA) {
    const lab = (jump, i) => (jump.phases ?? []).find(p => i >= p.from && i <= p.to)?.label ?? '';
    const a = root.querySelector('[data-ph="a"]'), b = root.querySelector('[data-ph="b"]');
    if (a) a.textContent = lab(state.a.rec.jump, iA);
    if (b) b.textContent = lab(state.b.rec.jump, iB);
  }

  function drawNumbers() {
    const { a, b, sel } = state, A = a.rec.jump, B = b.rec.jump;
    const tiles = (B.phases ?? []).map(p => {
      const sa = (A.phases ?? []).find(x => x.id === p.id)?.score, sb = p.score;
      const d = Number.isFinite(sa) && Number.isFinite(sb) ? Math.round(sb) - Math.round(sa) : null;
      return `<button class="cmp-tile b-${band(sb)}${p.id === sel ? ' on' : ''}" data-cmp-tile="${p.id}"><small>${p.id === 'pen' ? 'Predposl.' : esc(p.label)}</small><b>${Number.isFinite(sb) ? Math.round(sb) : '–'}</b><i class="${d == null ? 'eq' : d > 0 ? 'up' : d < 0 ? 'dn' : 'eq'}">${d == null ? '' : d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '±0'}</i></button>`;
    }).join('');
    root.querySelector('#cmp-tiles').innerHTML = tiles;
    // two different athletes: each has their own norm, so only the differences are said
    const judge = a.rec.athlete === b.rec.athlete, normOf = judge ? '' : ` (${athletes[b.rec.athlete]?.name ?? ''})`;
    const rows = rowsFor(sel, A, B, { judge });
    const label = (B.phases ?? []).find(p => p.id === sel)?.label ?? '';
    root.querySelector('#cmp-rows').innerHTML = `<div class="cmp-rowh"><span>${esc(label)}</span><span>${dateOf(a.rec.recordedAt)}</span><span>${dateOf(b.rec.recordedAt)}</span></div>
      ${rows.length ? rows.map(r => `<div class="cmp-row"><div class="cmp-rt"><span>${esc(r.m.label)}</span><b class="a">${r.a != null ? fmt(r.m, r.a) : '–'}</b><b>${r.b != null ? fmt(r.m, r.b) : '–'}</b></div>
        ${bandHtml(r.m, r.a, r.b)}<div class="cmp-rn"><span>${Array.isArray(r.m.norm) ? `norma ${rangeText(r.m)}${normOf}` : ''}</span><span class="${r.change?.good ? 'd' : 'd n'}">${r.change ? esc(r.change.text) : 'v jednom skoku sa nedalo zmerať'}</span></div></div>`).join('')
        : '<p class="note">Táto fáza sa v týchto skokoch nedala zmerať.</p>'}
      <div class="cmp-legend"><span><i class="pa"></i>${dateOf(a.rec.recordedAt)}</span><span><i class="pb"></i>${dateOf(b.rec.recordedAt)}</span><span><i class="nr"></i>norma finalistov${normOf}</span></div>`;
    const h = headline(A, B, { judge }), hb = root.querySelector('#cmp-head');
    hb.classList.toggle('hidden', !h);
    hb.innerHTML = h ? `<p class="banner ok">${esc(h)}</p>` : '';
  }

  root.addEventListener('click', e => {
    const f = e.target.closest('[data-cmp-filter]');
    if (f && pickFor) { pickFilter = f.dataset.cmpFilter; pick(pickFor); return; }
    const w = e.target.closest('[data-cmp-with]');
    if (w && pickFor) { compare(w.dataset.cmpWith, pickFor); return; }
    if (!state) return;
    const [pA, pB] = state.panes.map(p => p.player);
    if (e.target.closest('[data-cmp="play"]')) {
      if (pB.playing) { pB.pause(); e.target.textContent = '▶'; } else { pA.pause(); pB.play(); e.target.textContent = '❚❚'; }
      return;
    }
    if (e.target.closest('[data-cmp="flip"]')) { setMirror(pA, !pA.mirror); return; }
    if (e.target.closest('[data-cmp="speed"]')) {
      const s = { 0.5: 0.25, 0.25: 1, 1: 0.5 }[pB.speed] ?? 0.5;
      pB.speed = s; e.target.textContent = s === 1 ? '1×' : s === 0.5 ? '½×' : '¼×';
      if (pB.playing) pB.play();
      return;
    }
    const ph = e.target.closest('[data-cmp-ph]');
    if (ph) {
      const ids = CHIPS.find(c => c[0] === ph.dataset.cmpPh)[2], kf = keyFramesOf(state.b.rec.jump);
      const fr = ids.map(id => kf[id]).find(Number.isFinite);
      pB.pause();
      if (fr != null) pB.show(fr);
      root.querySelectorAll('[data-cmp-ph]').forEach(x => x.classList.toggle('on', x === ph));
      if (state.b.rec.jump.phases?.some(p => p.id === ph.dataset.cmpPh)) { state.sel = ph.dataset.cmpPh; drawNumbers(); }
      return;
    }
    const t = e.target.closest('[data-cmp-tile]');
    if (t) { state.sel = t.dataset.cmpTile; drawNumbers(); }
  });
  root.addEventListener('input', e => {
    if (!state || !e.target.matches('.cmp-range')) return;
    const pB = state.panes[1].player;
    pB.pause(); pB.show(+e.target.value);
  });

  return { pick, compare, close };
}
