// Runs contact and key-frame detection on a cleaned pipeline result and prints them.
// Usage: node tools/events_json.mjs <result_clean.json> [male|female]
import { readFileSync } from 'node:fs';
import { detectContacts, keyFrames } from '../js/analysis/events.js';

const [file, sex = 'male'] = process.argv.slice(2);
const r = JSON.parse(readFileSync(file, 'utf8'));
const track = r.clean.map(k => (k ? Float64Array.from(k, v => (v == null ? NaN : v)) : null));
const fps = r.fps ?? 120;
const contacts = detectContacts(track, r.first, r.last, fps);
console.log('contacts:', contacts.map(c => `${c.foot} ${c.td}-${c.to} (${(c.contactTime * 1000).toFixed(0)} ms)`).join(' | '));
const k = keyFrames(track, contacts, fps, sex);
if (k.error) console.log(k.error);
else for (const f of k.keyFrames) console.log(`${f.label.padEnd(24)} frame ${f.frame}${f.sub ? ` (${f.sub.toFixed(1)})` : ''}`);

// Measurements at the key frames (smoothed track for angles).
import('../js/analysis/metrics.js').then(({ measure }) => {
  if (k.error) return;
  const sm = r.smooth.map(x => (x ? Float64Array.from(x, v => (v == null ? NaN : v)) : null));
  for (const m of measure(sm, k, fps, sex, contacts[0]?.dir ?? 1)) {
    const v = m.unit === 'ms' ? m.value.toFixed(0) : m.value.toFixed(1);
    console.log(`${m.label.padEnd(32)} ${(v + ' ' + m.unit).padStart(9)}  norm ${m.norm.join('–')}  ${m.status}${Number.isNaN(m.yaw) ? '' : `  (view ${m.yaw.toFixed(0)}° off side-on)`}`);
  }
});

// Score and coaching.
Promise.all([import('../js/analysis/metrics.js'), import('../js/analysis/coach.js')]).then(([{ measure }, { techniqueScore, coaching }]) => {
  if (k.error) return;
  const sm = r.smooth.map(x => (x ? Float64Array.from(x, v => (v == null ? NaN : v)) : null));
  const ms = measure(sm, k, fps, sex, contacts[0]?.dir ?? 1);
  const sc = techniqueScore(ms);
  console.log(`\nTECHNIQUE ${sc.score.toFixed(0)}/100  ` + sc.phases.map(p => `${p.label} ${p.score == null ? '–' : p.score.toFixed(0)}`).join(' · '));
  const c = coaching(ms, sex);
  console.log('STRENGTH:', c.strength);
  c.focus.forEach((f, i) => console.log(`FOCUS ${i + 1}: ${f.what}\n   cue: ${f.cue ?? '-'}   drill: ${f.drill}`));
  console.log('NEXT JUMP CUE:', c.nextCue);
});
