// Builds server/knowledge.md: what the "Opýtaj sa" chat knows besides the jump itself, pulled
// from the athletes' own notes (VAULT, default ~/Documents/Vault). The output is personal
// training knowledge, so it is gitignored and reaches the server only inside the Modal image.
// Run: node tools/build-knowledge.mjs   (then redeploy the server)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const VAULT = process.env.VAULT || join(homedir(), 'Documents', 'Vault');
const LIB = '50 Training/51 Coaching Library';
const CON = '70 Knowledge Graph/72 Concepts';

const body = t => t.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
// The "> [!abstract]" block right under the frontmatter, plus any warning callouts.
const abstract = t => {
  const lines = body(t).split('\n'), out = [];
  for (const l of lines) { if (l.startsWith('>') || (out.length && l.trim() === '' && out.at(-1) !== '')) out.push(l); else if (out.length) break; }
  const warn = body(t).match(/> \[!warning\][\s\S]*?(?=\n\n|$)/g) ?? [];
  const head = out.join('\n');
  return [head, ...warn.filter(w => !head.includes(w.slice(0, 60)))].join('\n\n').trim();
};
// One "## heading" section.
const section = (t, h) => { const m = body(t).split(/\n(?=## )/).find(s => s.startsWith(`## ${h}`)); return m?.trim() ?? ''; };

const parts = [
  ['Coaching SOP (session language: allowed and banned cues, order of feedback)', `${'50 Training/52 Sessions and Protocols'}/Coaching SOP - skok a rychlost.md`, 'all'],
  ['Training priorities', '50 Training/Training Priorities.md', 'abstract'],
  ...['Approach velocity', 'Penultimate step', 'COM lowering', 'Takeoff', 'Takeoff angle', 'Ground contact time', 'Landing']
    .map(c => [c, `${CON}/${c}.md`, 'all']),
  ...['08 - LJ Technical Model', '15 - Approach Calibration Protocol', '17 - Approach Velocity Analysis (Czech + Berlin data)',
    '21 - Lessons from the Video Library (24 videos, 15 hours)', '25 - What Actually Moves Speed (stride length, frequency, force)',
    '26 - Diagnosis and Training Philosophy (session 2026-07)', '42 - RFD, Eccentrics and What Actually Governs the Take-off',
    '44 - The Energy Model - vertical jump, flight time and the conversion', '46 - Benchmarks for 8.00 m and 6.70 m (derived)',
    '47 - Vertical Take-off - the High-Jump SDE and the Reactive-Strength Gap', '48 - Two Coach Hypotheses - Elastic Energy and the Push (tested)',
    '49 - The Swing Side - Hip Flexors, Recovery and Stride Frequency (tested)', '24 - Training Female Athletes (what changes, what does not)']
    .map(d => [d, `${LIB}/${d}.md`, 'abstract']),
  ['What-if levers and their verification', '60 App Builds/Jump Video Analyzer - speed and distance research.md', ['What-if levers', 'Verification of the what-if coefficients', 'Short run-ups']],
];

let out = '# What the athletes\' own notes say (built ' + new Date().toISOString().slice(0, 10) + ')\n';
for (const [title, rel, how] of parts) {
  const p = join(VAULT, rel);
  if (!existsSync(p)) { console.warn('missing', rel); continue; }
  const t = readFileSync(p, 'utf8');
  const text = how === 'all' ? body(t) : how === 'abstract' ? abstract(t) : how.map(h => section(t, h)).filter(Boolean).join('\n\n');
  if (text) out += `\n\n## ${title}\n\n${text}\n`;
}
const dest = new URL('../server/knowledge.md', import.meta.url);
writeFileSync(dest, out);
console.log(`server/knowledge.md: ${out.split(/\s+/).length} words`);
