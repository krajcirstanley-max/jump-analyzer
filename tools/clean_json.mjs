// Applies the cleaning stage to a saved pipeline result (adds clean/smooth + stats).
// Usage: node tools/clean_json.mjs <in.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { MODELS } from '../js/pose/models.js';
import { cleanTrack } from '../js/pose/clean.js';

const [inFile, outFile] = process.argv.slice(2);
const res = JSON.parse(readFileSync(inFile, 'utf8'));
const toF = a => a?.map(k => (k ? Float32Array.from(k) : null));
const fast = toF(res.fast), accurate = toF(res.accurate) ?? fast.map(() => null);
const raw = fast.map((f, i) => accurate[i] || f);
const minScore = i => MODELS[accurate[i] ? res.models.accurate : res.models.fast].minScore;
const fps = res.fps ?? 120;
const { clean, smooth, swapped, flagged } = cleanTrack(raw, minScore, fps);
const ser = a => a.map(k => (k ? Array.from(k, v => (Number.isNaN(v) ? null : +v.toFixed(2))) : null));
writeFileSync(outFile, JSON.stringify({ ...res, clean: ser(clean), smooth: ser(smooth) }));
console.log(JSON.stringify({ swappedLegs: [...swapped.legs].sort((a, b) => a - b), swappedArms: [...swapped.arms].sort((a, b) => a - b), spikes: flagged.size }));
