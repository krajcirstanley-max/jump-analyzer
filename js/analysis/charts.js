// Charts for the result screen, as SVG/HTML strings plus one function that wires the hover.
// Mark specs from the house data-viz rules: 2px lines, >= 8px markers with a surface ring,
// hairline solid grid, text in text colours (never the data colour), one series = no legend.
const num = (x, dp) => Number(x).toFixed(dp).replace('.', ',').replace(/^-/, '−');
const G = 9.81;

// Side view of the last three contacts and the jump: the centre of mass as measured (solid) up to
// toe-off, then the flight from the take-off speeds (dashed, a model), the planted toes on the
// ground, the take-off line and the sand. Heights are to scale against the y axis; the ground
// strip under the plot is the runway itself (the y axis does not start at zero).
export function profileHtml(p) {
  if (!p?.series?.length) return '';
  const W = 340, H = 228, L = 34, R = 10, T = 18, PH = 120, GY = T + PH + 10; // GY: ground strip top
  const model = [];
  if (p.flight) {
    const { xTO, hTO, vx, vy, T: ft } = p.flight;
    for (let k = 1; k <= 24; k++) { const t = (ft * k) / 24; model.push({ x: xTO - vx * t, h: hTO + vy * t - (G * t * t) / 2, t: (p.series.at(-1).t + t), model: true }); }
  }
  const all = [...p.series, ...model];
  const xMax = Math.max(...all.map(q => q.x), ...p.toes.map(t => t.x)) + 0.3;
  const xMin = Math.min(...all.map(q => q.x), Number.isFinite(p.landX) ? p.landX : Infinity, 0) - 0.4;
  const hs = all.map(q => q.h).filter(Number.isFinite);
  const yLo = Math.floor((Math.min(...hs) - 0.04) * 10) / 10, yHi = Math.ceil((Math.max(...hs) + 0.04) * 10) / 10;
  const sx = x => L + ((xMax - x) / (xMax - xMin)) * (W - L - R);
  const sy = h => T + ((yHi - h) / (yHi - yLo)) * PH;
  const path = pts => pts.map((q, k) => `${k ? 'L' : 'M'}${sx(q.x).toFixed(1)},${sy(q.h).toFixed(1)}`).join('');
  const grid = []; for (let h = yLo; h <= yHi + 1e-9; h += 0.2) grid.push(h);
  const sand0 = sx(0), line = sx(p.lineX);
  const lbl = { third: '3.', pen: 'P', take: 'O' };
  const toes = p.toes.filter(t => Number.isFinite(t.x));
  const stepLen = toes.slice(0, -1).map((t, k) => ({ a: t, b: toes[k + 1], d: t.x - toes[k + 1].x }));
  const to = p.series.at(-1);
  const svg = `<svg class="viz-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Profil ťažiska v posledných krokoch a v lete">
    ${grid.map(h => `<line class="viz-grid" x1="${L}" x2="${W - R}" y1="${sy(h).toFixed(1)}" y2="${sy(h).toFixed(1)}"/><text class="viz-tick" x="${L - 6}" y="${(sy(h) + 4).toFixed(1)}" text-anchor="end">${Math.round(h * 100)}</text>`).join('')}
    <text class="viz-tick" x="${L - 6}" y="${T - 7}" text-anchor="end">cm</text>
    <rect class="viz-sand" x="${sand0.toFixed(1)}" y="${GY}" width="${(W - R - sand0).toFixed(1)}" height="8" rx="2"/>
    <rect class="viz-runway" x="${L}" y="${GY}" width="${(sand0 - L - 2).toFixed(1)}" height="8" rx="2"/>
    <line class="viz-mark" x1="${line.toFixed(1)}" x2="${line.toFixed(1)}" y1="${T}" y2="${GY + 8}"/>
    <text class="viz-note" x="${(line + 4).toFixed(1)}" y="${T + 9}">čiara odrazu</text>
    <text class="viz-note" x="${(sand0 + 4).toFixed(1)}" y="${GY - 4}">piesok</text>
    <path class="viz-line" d="${path(p.series)}"/>
    ${model.length ? `<path class="viz-line viz-model" d="${path([to, ...model])}"/>` : ''}
    ${toes.map(t => t.com ? `<circle class="viz-dot" cx="${sx(t.com.x).toFixed(1)}" cy="${sy(t.com.h).toFixed(1)}" r="4"/>` : '').join('')}
    <circle class="viz-dot" cx="${sx(to.x).toFixed(1)}" cy="${sy(to.h).toFixed(1)}" r="4"/>
    ${toes.map(t => `<rect class="viz-foot" x="${(sx(t.x) - 7).toFixed(1)}" y="${GY + 1}" width="10" height="6" rx="3"/><text class="viz-label" x="${(sx(t.x) - 2).toFixed(1)}" y="${GY + 20}" text-anchor="middle">${lbl[t.id]}</text>`).join('')}
    ${stepLen.map(s => `<path class="viz-bracket" d="M${(sx(s.a.x) - 2).toFixed(1)},${GY + 26}V${GY + 29}H${(sx(s.b.x) - 2).toFixed(1)}V${GY + 26}"/><text class="viz-tick" x="${((sx(s.a.x) + sx(s.b.x)) / 2 - 2).toFixed(1)}" y="${GY + 41}" text-anchor="middle">${num(s.d, 2)} m</text>`).join('')}
    ${Number.isFinite(p.landX) && Number.isFinite(p.toeTO) ? (() => { const a = sx(p.toeTO), b = sx(p.landX); return `<rect class="viz-foot" x="${(b - 5).toFixed(1)}" y="${GY + 1}" width="10" height="6" rx="3"/>
      <path class="viz-bracket" d="M${(a - 2).toFixed(1)},${GY + 50}V${GY + 53}H${b.toFixed(1)}V${GY + 50}"/>
      <text class="viz-value" x="${((a + b) / 2).toFixed(1)}" y="${GY + 66}" text-anchor="middle">${num(p.jump, 2)} m od špičky po dopad</text>`; })() : ''}
    <line class="viz-cross" x1="0" x2="0" y1="${T}" y2="${GY}" visibility="hidden"/>
    <circle class="viz-dot viz-hover" r="5" visibility="hidden"/>
    <rect class="viz-hit" x="${L}" y="${T}" width="${W - L - R}" height="${GY - T}"/>
  </svg>`;
  const pts = all.map(q => ({ X: +sx(q.x).toFixed(1), Y: +sy(q.h).toFixed(1), h: q.h, x: q.x, t: q.t, m: !!q.model }));
  return `<figure class="viz" data-viz="profile" data-w="${W}">
    <figcaption><b>Profil ťažiska</b><span>Plná čiara je zmeraná, prerušovaná je let vypočítaný z rýchlosti pri odraze. Značky na zemi sú špičky pri dotykoch: 3. od konca, P predposledný, O odraz.</span></figcaption>
    <div class="viz-wrap">${svg}<div class="viz-tip" hidden></div></div>
    ${p.parts ? partsHtml(p.parts) : ''}
    <script type="application/json" class="viz-data">${JSON.stringify(pts)}</script>
  </figure>`;
}

// Where the jump came from (Hay's partition): toe to CoM at toe-off, the flight, CoM to the heel at
// the landing. One whole split in three: a tall segmented bar, value inside where it fits.
function partsHtml(q) {
  const total = q.takeoff + q.flight + q.landing;
  const seg = [['takeoff', 'Odraz', q.takeoff], ['flight', 'Let', q.flight], ['landing', 'Dopad', q.landing]];
  return `<div class="parts" role="img" aria-label="Rozdelenie skoku: odraz ${num(q.takeoff, 2)} m, let ${num(q.flight, 2)} m, dopad ${num(q.landing, 2)} m">
    ${seg.map(([k, l, v]) => { const w = (v / total) * 100; return `<div class="pt-${k}" style="width:${w.toFixed(2)}%">${w >= 16 ? `${l} ${num(v, 2)} m` : ''}</div>`; }).join('')}
  </div>
  <p class="viz-sub">Odraz ${num(q.takeoff, 2)} m (${Math.round((q.takeoff / total) * 100)} %) · let ${num(q.flight, 2)} m (${Math.round((q.flight / total) * 100)} %) · dopad ${num(q.landing, 2)} m (${Math.round((q.landing / total) * 100)} %). U elity zhruba 5 / 90 / 5 % (Hay 1986).</p>`;
}

// Rhythm of the last three contacts: one bar, contacts solid, flights as a wash, widths to time.
export function rhythmHtml(p) {
  const tl = p?.timeline; if (!tl?.length) return '';
  const parts = [];
  const lbl = { third: '3. od konca', pen: 'Predposl.', take: 'Odraz' };
  tl.forEach(s => { parts.push({ kind: 'c', ms: s.contactMs, label: lbl[s.id] }); if (Number.isFinite(s.flightMs)) parts.push({ kind: 'f', ms: s.flightMs }); });
  const total = parts.reduce((a, q) => a + q.ms, 0);
  const blocks = parts.map(q => {
    const w = (q.ms / total) * 100;
    // every block carries its number: narrow ones centred in a smaller size, the rest at the start
    const txt = `${Math.round(q.ms)}`;
    const name = q.kind === 'c' ? `${q.label}: kontakt ${Math.round(q.ms)} ms` : `let ${Math.round(q.ms)} ms`;
    return `<div class="rh-${q.kind}${w < 11 ? ' rh-narrow' : ''}" style="width:${w.toFixed(2)}%" title="${name}" aria-label="${name}">${txt}</div>`;
  }).join('');
  const heads = parts.map(q => `<div style="width:${((q.ms / total) * 100).toFixed(2)}%">${q.kind === 'c' ? q.label : ''}</div>`).join('');
  return `<figure class="viz">
    <figcaption><b>Rytmus</b><span>Kontakt a let v ms, šírka podľa času. Spolu ${Math.round(total)} ms od dotyku 3. kroku od konca po odraz.</span></figcaption>
    <div class="rh-heads" aria-hidden="true">${heads}</div>
    <div class="rh-bar" role="img" aria-label="Rytmus posledných dotykov">${blocks}</div>
    <div class="viz-legend"><span><i class="rh-c"></i>kontakt</span><span><i class="rh-f"></i>let</span></div>
  </figure>`;
}

// Hover/touch on the profile: a crosshair snaps to the nearest frame, the tooltip leads with the value.
export function wireCharts(root) {
  root.querySelectorAll('[data-viz="profile"]').forEach(fig => {
    const pts = JSON.parse(fig.querySelector('.viz-data').textContent);
    const svg = fig.querySelector('svg'), hit = fig.querySelector('.viz-hit'), cross = fig.querySelector('.viz-cross');
    const dot = fig.querySelector('.viz-hover'), tip = fig.querySelector('.viz-tip'), W = +fig.dataset.w;
    const show = e => {
      const r = svg.getBoundingClientRect(), X = ((e.clientX - r.left) / r.width) * W;
      const q = pts.reduce((b, p) => (Math.abs(p.X - X) < Math.abs(b.X - X) ? p : b), pts[0]);
      cross.setAttribute('x1', q.X); cross.setAttribute('x2', q.X); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', q.X); dot.setAttribute('cy', q.Y); dot.setAttribute('visibility', 'visible');
      tip.hidden = false; tip.replaceChildren();
      const b = document.createElement('b'); b.textContent = `${Math.round(q.h * 100)} cm`;
      const s = document.createElement('span');
      const where = q.x >= 0 ? `${num(q.x, 2)} m pred pieskom` : `${num(-q.x, 2)} m nad pieskom`;
      s.textContent = `${q.m ? 'let (výpočet)' : 'ťažisko'} · ${where} · ${q.t >= 0 ? '+' : '−'}${Math.abs(Math.round(q.t * 1000))} ms od dotyku na doske`;
      tip.append(b, s);
      // on the far side of the crosshair, so the curve under the finger stays visible
      tip.style.left = q.X > W / 2 ? '36px' : `${r.width - 160}px`;
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', hide);
  });
}
