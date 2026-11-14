// Technique score and coaching feedback from the measurements.
// Shape of the feedback: docs/v1-contract.md, `jump.coach`. Rules from the pair's Coaching SOP (vault: 50 Training/52 Sessions and
// Protocols/Coaching SOP - skok a rychlost.md): ONE external cue for the next jump,
// max 5 words, only from the approved list, quoted in the original Slovak; banned:
// „zdvihni koleno", „natiahni krok", „cykluj nohu", „odraz silnejšie", „vyššie".
// Faults → fixes from the SOP's short-approach section and doc 08 (technical model).

import { scoreMetric } from './metrics.js';

// Phases and the measurements that score them (weights: how much each phase counts).
export const PHASES = [
  { id: 'pen', label: 'Predposledný', weight: 0.2, keys: ['contactPen', 'flightToBoard', 'hipDrop', 'comDropBoard', 'penKnee', 'stepChange'] },
  { id: 'plant', label: 'Plant', weight: 0.35, keys: ['contactTO', 'kneeTD', 'legTD', 'inclTD', 'kneeMin', 'kneeVel', 'touchdownDist', 'speedLossTO'] },
  { id: 'toeoff', label: 'Odraz', weight: 0.25, keys: ['kneeTO', 'hipTO', 'takeoffAngle', 'kneeDrive', 'trunkTO', 'trunkRotBoard', 'toHeight'] },
  { id: 'flight', label: 'Let', weight: 0.05, keys: ['flight', 'peakHeight', 'trunkStability'] },
  { id: 'landing', label: 'Dopad', weight: 0.15, keys: ['landingReach', 'kneeLand', 'hipLand', 'estDistance'] },
];

// The same per-metric score as jump.js gives (metrics.js scoreMetric), for metrics that come
// without one.
export const metricScore = scoreMetric;

// A phase is its average pulled toward its worst metric (70 / 30), so one clear fault isn't
// averaged away by five measurements that were fine; the overall score weights the phases.
export function techniqueScore(metrics) {
  const by = Object.fromEntries(metrics.filter(m => m.status !== 'hidden').map(m => [m.key, m]));
  let total = 0, wsum = 0;
  const phases = PHASES.map(p => {
    const ms = p.keys.map(k => by[k]).filter(Boolean);
    if (!ms.length) return { ...p, score: null };
    const sc = ms.map(m => m.score ?? metricScore(m));   // m.score: from jump.js
    const score = 0.7 * (sc.reduce((a, b) => a + b, 0) / sc.length) + 0.3 * Math.min(...sc);
    total += score * p.weight; wsum += p.weight;
    return { ...p, score };
  });
  return { score: wsum ? total / wsum : null, phases };
}

// Titles and takes say what to do and what it brings, never what is wrong (Stanley, 2026-11-14:
// "pozitívne cues pomáhajú … zlepšenie, nie že si pomalý").
// Faults in priority order (coaching order from Training Priorities: precise takeoff,
// then full approach, then vertical, then speed). Coaching text is Slovak, written to
// be spoken: no gendered past tense, so it reads right for both athletes.

// Coaching SOP §2, verbatim, for the next jump. Left out on purpose: „tlač dozadu" (SOP:
// acceleration only), „ponad" (bounds only), and the two cues over the SOP's own 5-word
// limit, „očami na značku, nie na dosku" and „ruky dole pri dotyku, hore cez odraz".
export const APPROVED_CUES = ['vysoké boky', 'stlač zem pod seba', 'tvrdá pružina', 'predposledný naplocho', 'boky hore cez dosku', 'predposledný je float, nie krok'];
export const MISKA_ONLY_CUE = 'predposledný je float, nie krok';
export const PHASE_IDS = ['pen', 'plant', 'toeoff', 'flight', 'landing'];

const COMMA = v => v.replace('.', ',').replace('-', '−');
const DEC = { 'm/s': 1, m: 2 };
const num = (v, u) => COMMA(v.toFixed(DEC[u] ?? 0));
const unit = (s, u) => (u === '°' ? `${s}°` : u ? `${s} ${u}` : s);
const val = m => unit(num(m.value, m.unit), m.unit);
const norm = m => {
  const [lo, hi] = m.norm.map(x => num(x, m.unit));
  return unit(m.norm[0] < 0 ? `${lo} až ${hi}` : `${lo}–${hi}`, m.unit);
};

// How much to trust the order: full approach and vertical count less than the board.
const TIER = { board: 1, approach: 0.85, vertical: 0.7, rest: 0.5 };

// Margins are the old thresholds: out of the norm by less than the video can resolve
// (one frame is 8 ms at 120 fps) is no fault. Sides: which status counts.
const FAULTS = [
  {
    id: 'longContact', tier: 'board', phase: 'plant', cue: 'tvrdá pružina',
    keys: [['contactTO', 'high', 10]],
    title: 'Kratší kontakt na doske',
    take: 'z kratšieho kontaktu na doske si odnesieš viac rýchlosti',
    body: m => `Kontakt ${val(m)}, finalisti majú ${norm(m)}. Členok povolí až po dopade, takže zem ťa zabrzdí skôr, než ťa odhodí.`,
    why: 'Pri 0,12 s je odraz rozhodnutý ešte pred dotykom. Napätie v členku musí prísť pred doskou a dá sa počuť: ostrý dopad je dobre, plieskavý zle.',
  },
  {
    id: 'overReach', tier: 'board', phase: 'plant', cue: 'stlač zem pod seba',
    keys: [['legTD', 'low', 1], ['inclTD', 'low', 1]],
    title: 'Chodidlo bližšie pod telo',
    take: 'keď chodidlo dopadne bližšie pod telo, doska ťa nebude brzdiť',
    body: m => m.key === 'legTD'
      ? `Uhol nohy pri dotyku ${val(m)}, finalisti majú ${norm(m)}. Noha ide do zeme pred telom.`
      : `Telo je pri dotyku ${val(m)} za chodidlom, finalisti majú ${norm(m)}. Noha ide do zeme pred telom.`,
    why: 'Noha vystrčená pred ťažisko brzdí. Rýchlosť z rozbehu zostane na doske.',
  },
  {
    id: 'collapse', tier: 'board', phase: 'plant', cue: 'predposledný naplocho', cueF: 'predposledný je float, nie krok',
    keys: [['flexion', 'high', 0], ['kneeMin', 'low', 4]],
    title: 'Pevnejšie koleno na doske',
    take: 'pevnejšie koleno na doske dá odrazu viac pružiny',
    body: m => m.key === 'flexion'
      ? `Koleno na doske povolí o ${val(m)}, finalisti majú ${norm(m)}. Sadáš namiesto toho, aby noha pružila.`
      : `Koleno klesne až na ${val(m)}, finalisti držia ${norm(m)}. Sadáš namiesto toho, aby noha pružila.`,
    why: 'Hlboké sedanie predlžuje kontakt a rýchlosť sa mení na brzdenie. Keď je predposledný krok dobrý, koleno na doske skoro nepracuje.',
  },
  {
    id: 'stiffKneeTD', tier: 'board', phase: 'plant', cue: 'stlač zem pod seba',
    keys: [['kneeTD', 'low', 6]],
    title: 'Vystretejšia noha na dosku',
    take: 'vystretejšia noha pri dotyku prenesie viac rýchlosti do odrazu',
    body: m => `Koleno pri dotyku ${val(m)}, finalisti majú ${norm(m)}. Pokrčená noha sa pod záťažou ešte poddá.`,
    why: 'Vystretá a napätá noha prenesie rýchlosť do odrazu. Pokrčená ju stratí v kolene.',
  },
  {
    id: 'sitting', tier: 'approach', phase: 'pen', cue: 'predposledný naplocho', cueF: 'predposledný je float, nie krok',
    keys: [['contactPen', 'high', 15]],
    title: 'Prebehni predposledný krok',
    take: 'keď predposledný krok prebehneš, rytmus do dosky ostane rýchly',
    body: m => `Kontakt na predposlednom ${val(m)}, finalisti majú ${norm(m)}.`,
    why: 'Predposledný pripraví odraz, ale s dlhým kontaktom je z neho brzda. Treba ho prebehnúť, telo klesá len o pár centimetrov.',
  },
  {
    id: 'hipDropHigh', tier: 'approach', phase: 'pen', cue: 'predposledný naplocho', cueF: 'predposledný je float, nie krok',
    keys: [['hipDrop', 'high', 1.5]],
    title: 'Plytší predposledný krok',
    take: 'plytší predposledný krok ťa vynesie vyššie do odrazu',
    body: m => `Boky klesnú o ${val(m)}, cieľ je ${norm(m)}.`,
    why: 'Ťažisko má klesnúť asi o 9 cm. Viac už len brzdí a rozbeh sa míňa.',
  },
  {
    id: 'hipDropLow', tier: 'approach', phase: 'pen', cue: 'predposledný naplocho', cueF: 'predposledný je float, nie krok',
    keys: [['hipDrop', 'low', 1.5]],
    title: 'Trochu znížiť boky pred doskou',
    take: 'malé zníženie bokov pred doskou ti dá z čoho ísť hore',
    body: m => `Boky klesnú len o ${val(m)}, cieľ je ${norm(m)}.`,
    why: 'Bez malého zníženia niet z čoho ísť hore a rýchlosť ostane vodorovná.',
  },
  {
    id: 'flightToBoard', tier: 'approach', phase: 'pen', cue: 'predposledný naplocho', cueF: 'predposledný je float, nie krok',
    keys: [['flightToBoard', 'high', 10], ['flightToBoard', 'low', 10]],
    title: 'Rytmus dlhý – krátky',
    take: 'rytmus dlhý – krátky v posledných dvoch krokoch udrží rýchlosť až do dosky',
    body: m => `Let do dosky trvá ${val(m)}, finalisti majú ${norm(m)}.`,
    why: 'Dlhší predposledný a kratší posledný krok držia rýchlosť až do dosky. Keď sa rytmus rozsype, odraz to už nedorovná.',
  },
  {
    id: 'steep', tier: 'vertical', phase: 'toeoff', cue: 'boky hore cez dosku',
    keys: [['takeoffAngle', 'high', 0]],
    title: 'Viac dopredu cez dosku',
    take: 'odraz viac dopredu premení rýchlosť na dĺžku namiesto výšky',
    body: m => `Uhol odrazu ${val(m)}, cieľ je ${norm(m)}.`,
    why: 'Strmší odraz znamená dlhší kontakt a brzdenie. Väčší zisk je cez dosku než nad ňou.',
  },
  {
    id: 'flat', tier: 'vertical', phase: 'toeoff', cue: 'boky hore cez dosku',
    keys: [['takeoffAngle', 'low', 1]],
    title: 'Strmší odraz',
    take: 'strmší odraz ti dá viac času vo vzduchu',
    body: m => `Uhol odrazu ${val(m)}, cieľ je ${norm(m)}.`,
    why: 'Plochý odraz nedá čas vo vzduchu a rýchly rozbeh to sám nedotiahne.',
  },
  {
    id: 'diving', tier: 'vertical', phase: 'toeoff', cue: 'vysoké boky',
    keys: [['trunkTO', 'high', 5]],
    title: 'Vzpriamený trup cez dosku',
    take: 'vzpriamený trup cez dosku ti udrží let pokojný',
    body: m => `Trup pri odraze ${val(m)} vpred, finalisti majú ${norm(m)}.`,
    why: 'Predklon pridá rotáciu, ktorú v lete neopravíš, a doskok je potom kratší.',
  },
  {
    id: 'extension', tier: 'vertical', phase: 'toeoff', cue: 'stlač zem pod seba',
    keys: [['kneeTO', 'low', 4], ['hipTO', 'low', 5]],
    title: 'Dotiahnutý odraz',
    take: 'dotiahnutý odraz s vystretou nohou pridá rýchlosť z dosky',
    body: m => m.key === 'kneeTO'
      ? `Koleno pri odraze ${val(m)}, finalisti majú ${norm(m)}.`
      : `Bok pri odraze ${val(m)}, finalisti majú ${norm(m)}.`,
    why: 'Nedotiahnutý odraz znamená menej rýchlosti smerom hore z tej istej dosky.',
  },
  {
    id: 'freeSide', tier: 'vertical', phase: 'toeoff', cue: 'boky hore cez dosku',
    keys: [['kneeDrive', 'low', 3], ['thighTO', 'low', 3]],
    title: 'Švih a blok voľnej strany',
    take: 'švih a blok voľnej strany pridá odrazu výšku bez dlhšieho kontaktu',
    body: m => m.key === 'kneeDrive'
      ? `Švih voľnej nohy pri odraze ${val(m)}, finalisti majú ${norm(m)}.`
      : `Stehno voľnej nohy pri odraze ${val(m)}, finalisti majú ${norm(m)}.`,
    why: 'Blok voľnej strany pridá rýchlosť nahor bez predĺženia kontaktu.',
  },
  {
    id: 'speedLow', tier: 'rest', phase: 'pen', cue: 'vysoké boky',
    keys: [['speedLast', 'low', 0.1], ['speedTD', 'low', 0.1]],
    title: 'Rýchlejšie do dosky',
    take: 'rýchlejší príchod do dosky ti pridá dĺžku',
    body: m => `Rýchlosť na konci rozbehu ${val(m)}, cieľ je ${norm(m)}. Je to odhad z videa.`,
    why: 'Rozbeh určuje strop skoku. Cue to na doske nezmení, to robí sprint.',
  },
  {
    id: 'trunkAir', tier: 'rest', phase: 'flight', cue: null,
    keys: [['trunkStability', 'high', 0]],
    title: 'Pokojný trup v lete',
    take: 'pokojnejší trup v lete ťa pripraví na dlhší doskok',
    body: m => `Trup sa v lete pohne o ${val(m)}, cieľ je ${norm(m)}.`,
    why: 'Let dĺžku nepridá, len drží telo v polohe na doskok.',
  },
  {
    id: 'landing', tier: 'rest', phase: 'landing', cue: null,
    keys: [['landingReach', 'low', 0.05], ['kneeLand', 'high', 5], ['hipLand', 'high', 5]],
    title: 'Dlhší doskok',
    take: 'nohy ďalej dopredu pri doskoku ti pridajú centimetre, ktoré už máš z odrazu',
    body: m => m.key === 'landingReach'
      ? `Päty sú pri doskoku ${val(m)} pred bokmi, finalisti majú ${norm(m)}.`
      : m.key === 'kneeLand'
        ? `Koleno pri doskoku ${val(m)}, finalisti majú ${norm(m)}. Nohy idú do piesku tuhé.`
        : `Bok pri doskoku ${val(m)}, finalisti majú ${norm(m)}. Boky neprejdú cez päty.`,
    why: 'Nohy idú vpred a boky za nimi cez päty. Každé zasadnutie dozadu ide z dĺžky.',
  },
];

// Strengths: in-range measurements worth saying, in order of how much they matter.
const STRENGTHS = [
  ['legTD', m => `Noha dopadá pod správnym uhlom, ${val(m)}, presne ako u finalistov.`],
  ['contactTO', m => `Kontakt na doske ${val(m)}, to je rýchla noha.`],
  ['flexion', m => `Koleno na doske povolí len o ${val(m)}, odraz má pružinu.`],
  ['kneeMin', m => `Koleno na doske drží ${val(m)}, neprepadáš sa.`],
  ['inclTD', m => `Poloha tela pri dotyku ${val(m)} sedí s finalistami.`],
  ['contactPen', m => `Predposledný kontakt ${val(m)}, prebehneš ho bez sedenia.`],
  ['hipDrop', m => `Boky pred doskou klesnú o ${val(m)}, akurát na odraz.`],
  ['takeoffAngle', m => `Uhol odrazu ${val(m)}, cez dosku ideš tak, ako máš.`],
  ['kneeTO', m => `Koleno pri odraze ${val(m)}, odraz dotiahneš do konca.`],
  ['kneeDrive', m => `Švih voľnej nohy ${val(m)}, voľná strana robí svoju prácu.`],
  ['kneeLand', m => `Koleno pri doskoku ${val(m)}, piesok pohltíš ako finalisti.`],
];

const FEEL = ' Po pokuse najprv povedz, aký to bol pocit, až potom pozri čísla.';

// 0-1: the metric's own score when the metrics agent has set it, else distance from the norm.
const severity = m => {
  if (Number.isFinite(m.score)) return 1 - m.score / 100;
  const [lo, hi] = m.norm;
  const miss = m.value < lo ? lo - m.value : m.value - hi;
  return Math.min(1, miss / (2 * (hi - lo || 1)));
};
const phaseWeight = id => PHASES.find(p => p.id === id)?.weight ?? 0.1;

// A metric counts only when visible and beyond the norm by more than the margin.
function offending(fault, by) {
  const hits = [];
  for (const [key, side, margin] of fault.keys) {
    const m = by[key];
    if (!m || m.status !== side || !m.norm || !Number.isFinite(m.value)) continue;
    const miss = side === 'high' ? m.value - m.norm[1] : m.norm[0] - m.value;
    if (miss > margin) hits.push(m);
  }
  return hits;
}

export function coaching(metrics = [], sex = 'male', { name, all = false } = {}) {
  const who = name || (sex === 'female' ? 'Miška' : 'Stanley');
  const list = Array.isArray(metrics) ? metrics.filter(m => m && m.key) : [];
  const by = Object.fromEntries(list.map(m => [m.key, m]));
  const visible = list.filter(m => m.status !== 'hidden');

  const found = FAULTS.map(f => {
    const hits = offending(f, by);
    if (!hits.length) return null;
    const m = hits.reduce((a, b) => (severity(b) > severity(a) ? b : a));
    return { f, m, cost: severity(m) * phaseWeight(f.phase) * TIER[f.tier] };
  }).filter(Boolean).sort((a, b) => b.cost - a.cost);

  // The first fix carries the runway cue, so it has to be one that has a cue.
  const cued = found.findIndex(x => x.f.cue);
  if (cued > 0) found.unshift(found.splice(cued, 1)[0]);
  const top = found.slice(0, 3);

  const fixes = top.map(({ f, m }, i) => {
    const cue = sex === 'female' && f.cueF ? f.cueF : f.cue;
    return {
      title: f.title, body: f.body(m), phase: f.phase, metricKey: m.key,
      cue: i === 0 ? cue ?? null : null,   // one cue at a time, SOP §1
      why: i === 0 ? f.why + FEEL : f.why,
    };
  });

  const s = STRENGTHS.find(([k]) => by[k]?.status === 'ok' && Number.isFinite(by[k].value));
  let take;
  if (fixes.length) take = `${who}, ${top[0].f.take}.`;
  else if (visible.length) take = `${who}, v tomto skoku nie je nič mimo normy, cue nechaj taký, aký máš.`;
  else take = `${who}, z tohto záberu sa nedá nič spoľahlivo zmerať, nabudúce to natoč presne zboku.`;

  return {
    source: 'template', take,
    strength: s ? s[1](by[s[0]]) : null,
    fixes,
    nextCue: fixes[0]?.cue ?? null,
    // every fault found, in the same order, for the what-if card (whatif.js)
    ...(all ? { ranked: found.map(({ f, m }) => ({ id: f.id, m, cue: (sex === 'female' && f.cueF ? f.cueF : f.cue) ?? null })) } : {}),
  };
}

// Title per fault id, for the what-if card.
export const FAULT_INFO = Object.fromEntries(FAULTS.map(f => [f.id, { title: f.title, phase: f.phase, take: f.take }]));
