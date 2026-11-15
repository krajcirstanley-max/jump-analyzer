// Advice under a sprint (Stanley, 2026-11-15, mockup approved): one line on the run, its strong
// point, and one thing for the next run told as how it looks now, how it should look instead and one
// cue to feel it by ("je to aj o vnímaní"). Only from what was measured: the Freelap 10s, the steps,
// contact and flight, the foot against the hips seen from the side, left and right, and the
// athlete's own earlier runs. Cues are external or images, never joints ("vysoké koleno", "točiť
// nohami" focus on the limb and work worse: Wulf; Porter on sprints), one per run (Coaching SOP).
// Said as the improvement, never the fault.

const n2 = x => Number(x).toFixed(2).replace('.', ',');
const n3 = x => Number(x).toFixed(3).replace('.', ',');
const n1 = x => Number(x).toFixed(1).replace('.', ',');
const cm = x => `${Math.round(x)} cm`;
const ord = k => `${k + 1}.`;
// standing start, measured from the side: the ankle this many degrees in front of the knee at
// touchdown is a step out in front; a trunk under this many degrees of lean over the first 10 m is
// already upright (first steps lean about 40-45°, upright by 20-30 m: Nagahara 2014).
const ACCEL = { shinAhead: 3, trunkUp: 25 };

// Cues by phase (research 2026-11-15, vault docs 25, 34, 48): pushing back is the acceleration
// mechanism (Morin, force orientation); at top speed the net horizontal force is about zero and the
// force is vertical, so the max-velocity cues are about hitting down in a short contact, the foot under
// the body. External focus beats internal on average (Li 2022, g 0,28), most of all in less trained
// runners; one cue set before the run, nothing to think about during it.
export const SPRINT_CUES = {
  push: { phase: 'accel', cue: 'tlač zem dozadu', why: 'V akcelerácii rozhoduje smer sily: kto ju dá do zeme viac dozadu, ten zrýchľuje (Morin). Holeň naklonená dopredu a chodidlo pod telom alebo za ním to umožní, chodidlo pred kolenom brzdí. Platí len pre rozbeh z miesta, nie pre maximálnu rýchlosť.' },
  plane: { phase: 'transition', cue: 'ako lietadlo pri vzlete', why: 'Z predklonu sa telo dvíha postupne, krok po kroku, a vzpriamené je až okolo 20–30 m. Kto sa vzpriami hneď, prestane tlačiť dozadu skôr, ako dosiahne rýchlosť. Lietadlo nestúpa kolmo, ale stále rovnomerne.' },
  bag: { phase: 'maxv', cue: 'udri zem ako ťažké vrece', why: 'Pri maximálnej rýchlosti ide sila do zeme takmer celá zvislo, 4–5-násobok telesnej hmotnosti za 0,08–0,10 s (Weyand 2000; doc 48). Dlhší krok príde z väčšieho úderu dole, nie z naťahovania nohy dopredu, a frekvencia z neho vyplynie sama. Ťažké vrece nikto neudiera mäkkým členkom (McMillan); počuť to na zvuku dopadu.' },
  hot: { phase: 'maxv', cue: 'bež po horúcom piesku', why: 'Kratší dotyk pri tej istej sile je rýchlejší krok: tuhá noha vráti energiu, mäkká ju stratí. Obraz horúceho piesku skráti dotyk bez toho, aby si myslel na členok.' },
  under: { phase: 'maxv', cue: 'stlač zem pod seba', why: 'Chodidlo ďaleko pred bokmi brzdí každý krok. Pri vzpriamenom behu ide tlak dole, pod telo; dopad bližšie pod bokmi znamená menej brzdenia a kratší kontakt.' },
  spring: { phase: 'maxv', cue: 'tvrdá pružina', why: 'Tuhá noha pri dopade skráti kontakt a vráti viac energie do ďalšieho kroku. Pružina je obraz pre celé telo, nie pre jeden kĺb.' },
};

// a: analyzeSprint(); others: the athlete's earlier analyses' summaries ({ contact, freq, stepLen, aheadCm, flightLR }).
export function sprintAdvice(a, { others = [], bestFirst10 = null } = {}) {
  if (!a || a.tooFew || !a.steps?.length) return null;
  const L = a.legStats ?? [], looks = a.looks;
  const fly = a.kind === 'fly';
  // ----- the line on the run -----
  let take;
  if (a.legs?.length && L.length) {
    const lap = a.legs.reduce((x, y) => x + y, 0);
    const best = L.reduce((b, l, k) => (l.time < L[b].time ? k : b), 0);
    const bl = L[best];
    take = fly
      ? `Letmých ${a.distance} m za ${n2(lap)} s.${L.length > 1 && bl.stepLength != null ? ` Najrýchlejšia bola ${ord(best)} desiatka: ${n2(bl.time)} s, krok ${n2(bl.stepLength)} m${bl.freq != null ? ` pri ${n2(bl.freq)} kr/s` : ''}.` : ''}`
      : `Akcelerácia ${a.distance} m za ${n2(lap)} s, 0–10 m za ${n2(L[0].time)} s.`;
  } else take = fly ? `Frekvencia ${n2(a.freq)} kroku/s, na zemi ${n3(a.contact)} s, vo vzduchu ${n3(a.flight)} s.` : `Na zemi ${n2(a.contactFrom)} → ${n2(a.contactTo)} s, kroky sa predlžujú.`;

  // ----- the strong point -----
  const med = list => { const s = list.filter(Number.isFinite).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const myContact = med(others.map(o => o.contact));
  let strength = null;
  if (fly && Number.isFinite(a.contact) && myContact != null && a.contact <= myContact - 0.004) strength = `Kratší kontakt ako zvyčajne: ${n3(a.contact)} s na zemi (tvoj bežný ${n3(myContact)} s).`;
  else if (a.sides?.l?.n >= 2 && a.sides?.r?.n >= 2 && Math.abs(a.sides.l.flight - a.sides.r.flight) < 0.01 && Math.abs(a.sides.l.contact - a.sides.r.contact) < 0.01) strength = 'Ľavá a pravá rovnako: na zemi aj vo vzduchu do 0,01 s.';
  else if (fly && Number.isFinite(a.contact) && Number.isFinite(a.flight) && a.contact / (a.contact + a.flight) <= 0.46) strength = `Krátky a tuhý kontakt: ${n3(a.contact)} s na zemi, len ${Math.round((100 * a.contact) / (a.contact + a.flight))} % kroku.`;
  else if (!fly && looks?.legs?.[0]?.n >= 2 && looks?.legs?.[1]?.n >= 2 && looks.legs[0].trunk >= ACCEL.trunkUp + 5 && looks.legs[1].trunk <= looks.legs[0].trunk - 5) strength = `Postupné vzpriamenie: trup ${Math.round(looks.legs[0].trunk)}° v 0–10 m, ${Math.round(looks.legs[1].trunk)}° v 10–20 m.`;
  else if (!fly && Number.isFinite(a.contactFrom) && Number.isFinite(a.contactTo) && a.contactFrom - a.contactTo >= 0.03) strength = `Kontakt sa skracuje, ako rastie rýchlosť: ${n2(a.contactFrom)} → ${n2(a.contactTo)} s.`;

  // ----- the one thing: the 10 m that gave time away against the faster one -----
  let fix = null;
  if (fly && L.length >= 2 && L.every(l => l.stepLength != null && l.freq != null)) {
    const slow = L.reduce((b, l, k) => (l.time > L[b].time ? k : b), 0), fast = L.reduce((b, l, k) => (l.time < L[b].time ? k : b), 0);
    const S = L[slow], F = L[fast], lS = looks?.legs?.[slow], lF = looks?.legs?.[fast];
    const cS = contactIn(a, slow), cF = contactIn(a, fast);
    if (S.time - F.time >= 0.02) {
      const foot = lS?.aheadCm != null && lF?.aheadCm != null && lS.aheadCm - lF.aheadCm >= 5 ? `, chodidlo dopadá ${cm(lS.aheadCm)} pred bokmi (v ${ord(fast)} desiatke ${cm(lF.aheadCm)})` : '';
      if (S.stepLength < F.stepLength - 0.04 && S.freq > F.freq) {
        fix = { ...SPRINT_CUES.bag, title: `Rovnako silný úder do zeme aj v ${ord(slow)} desiatke`,
          looks: `V ${ord(slow)} desiatke nohy točia rýchlejšie (${n2(S.freq)} kroku/s) a krok je kratší (${n2(S.stepLength)} m)${foot}.`,
          should: `Ako v ${ord(fast)} desiatke: krok ${n2(F.stepLength)} m z úderu dole do zeme${foot ? ' pod bokmi' : ''}, nie z naťahovania nohy dopredu. Nohy pôsobia pokojnejšie a rýchlosť je vyššia.` };
      } else if (cS != null && cF != null && cS - cF >= 0.008) {
        fix = { ...SPRINT_CUES.hot, title: `Kratší dotyk aj v ${ord(slow)} desiatke`,
          looks: `V ${ord(slow)} desiatke je chodidlo na zemi dlhšie: ${n3(cS)} s oproti ${n3(cF)} s${foot}.`,
          should: `Krátky, tuhý dotyk ako v ${ord(fast)} desiatke: zem len odraziť, nie na nej stáť.` };
      } else if (foot) {
        fix = { ...SPRINT_CUES.under, title: `Dopad bližšie pod boky aj v ${ord(slow)} desiatke`,
          looks: `V ${ord(slow)} desiatke ${foot.slice(2)}.`,
          should: `Ako v ${ord(fast)} desiatke: chodidlo dopadá pod telom a hneď ide dozadu.` };
      } else if (S.stepLength < F.stepLength - 0.04) {
        fix = { ...SPRINT_CUES.bag, title: `Dlhý krok aj v ${ord(slow)} desiatke`,
          looks: `V ${ord(slow)} desiatke je krok kratší (${n2(S.stepLength)} m oproti ${n2(F.stepLength)} m) pri podobnej frekvencii.`,
          should: `Krok ${n2(F.stepLength)} m ako v ${ord(fast)} desiatke: každý dotyk udrie zem naplno dole, krok sa predĺži sám.` };
      }
    }
  }
  // the foot against the athlete's own runs, when the 10s do not say more
  const myAhead = med(others.map(o => o.aheadCm));
  if (!fix && fly && looks?.all?.aheadCm != null && myAhead != null && looks.all.aheadCm - myAhead >= 6) {
    fix = { ...SPRINT_CUES.under, title: 'Dopad bližšie pod boky',
      looks: `Chodidlo dopadá ${cm(looks.all.aheadCm)} pred bokmi, v tvojich predošlých behoch ${cm(myAhead)}.`,
      should: 'Ako v tvojich lepších behoch: dopad bližšie pod telom, chodidlo hneď ide dozadu.' };
  }
  // standing start, from the side: the first 10 m's touchdowns and trunk (stepLooks)
  const a0 = !fly ? looks?.legs?.[0] : null, a1 = !fly ? looks?.legs?.[1] : null;
  const slower = !fly && L.length && Number.isFinite(bestFirst10) && L[0].time - bestFirst10 >= 0.03
    ? `0–10 m za ${n2(L[0].time)} s, tvoj najlepší je ${n2(bestFirst10)} s. ` : '';
  if (!fix && a0?.n >= 2 && a0.shin >= ACCEL.shinAhead) {
    // the ankle lands in front of the knee: a brake on every step out of the start
    fix = { ...SPRINT_CUES.push, title: 'Prvé kroky za seba, nie pred seba',
      looks: `${slower}V 0–10 m chodidlo dopadá pred kolenom: holeň je pri dopade ${Math.round(a0.shin)}° dozadu.`,
      should: 'Chodidlo dopadá pod kolenom alebo kúsok za ním, holeň naklonená dopredu, a každý krok tlačí zem dozadu.' };
  } else if (!fix && a0?.n >= 2 && a0.trunk < ACCEL.trunkUp) {
    fix = { ...SPRINT_CUES.plane, title: 'Vzpriamiť sa postupne',
      looks: `${slower}V 0–10 m je telo už skoro vzpriamené: trup ${Math.round(a0.trunk)}° v predklone${a1?.n >= 2 ? `, v 10–20 m ${Math.round(a1.trunk)}°` : ''}.`,
      should: 'Telo vpredu a dvíha sa krok po kroku, ako lietadlo pri vzlete. Vzpriamené až okolo 20–30 m.' };
  } else if (!fix && slower) {
    fix = { ...SPRINT_CUES.push, title: 'Prvé kroky viac dozadu',
      looks: `${slower.trim()}${L[0].steps ? ` Na 10 m ${n1(L[0].steps)} kroku.` : ''}`,
      should: 'Prvé kroky s telom vpredu a tlakom dozadu, každý dotyk posúva telo dopredu.' };
  }

  // ----- then: left and right -----
  const then = [];
  const l = a.sides?.l, r = a.sides?.r;
  if (l?.n >= 2 && r?.n >= 2) {
    const df = r.flight - l.flight, dc = r.contact - l.contact;
    const same = others.filter(o => Number.isFinite(o.flightLR) && Math.sign(o.flightLR) === Math.sign(df) && Math.abs(o.flightLR) >= 0.01).length;
    if (Math.abs(df) >= 0.015) then.push({ title: `Po ${df > 0 ? 'pravej' : 'ľavej'} letíš o ${n2(Math.abs(df))} s dlhšie`, body: same ? `Rovnako to bolo aj v ${same} ${same === 1 ? 'predošlom behu' : 'predošlých behoch'}, takže je to tvoj stály rozdiel. Sleduj, či sa mení.` : 'Zatiaľ len v tomto behu. Sleduj, či sa zopakuje.' });
    else if (Math.abs(dc) >= 0.015) then.push({ title: `Na ${dc > 0 ? 'pravej' : 'ľavej'} si na zemi o ${n2(Math.abs(dc))} s dlhšie`, body: 'Sleduj, či sa zopakuje aj v ďalších behoch.' });
  }
  return { take, strength, fix, then };
}

// mean contact of the steps inside one 10 m
function contactIn(a, k) {
  const s = (a.steps ?? []).filter(x => x.leg === k && Number.isFinite(x.contact));
  return s.length ? s.reduce((x, y) => x + y.contact, 0) / s.length : null;
}

// One earlier analysis as the advice compares it.
export function runSummary(a) {
  if (!a || a.tooFew) return null;
  return { contact: a.contact ?? null, freq: a.freq ?? null, aheadCm: a.looks?.all?.aheadCm ?? null,
    flightLR: a.sides?.l?.n >= 2 && a.sides?.r?.n >= 2 ? a.sides.r.flight - a.sides.l.flight : null };
}
