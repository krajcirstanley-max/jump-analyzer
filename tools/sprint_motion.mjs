// Toe and track motion for a clip whose pose was already run locally (tools/run_pipeline.mjs),
// so the sprint contact detector can be tuned without the server.
// node tools/sprint_motion.mjs <clip> <pose.json> <out.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { probe, openFrames } from '../server/frames.mjs';
import { measureMotion } from '../server/sprint.mjs';

const [clip, poseFile, out] = process.argv.slice(2);
const pose = JSON.parse(readFileSync(poseFile, 'utf8'));
const asArr = k => (k == null ? null : Float32Array.from(Array.isArray(k) ? k : Object.keys(k).sort((a, b) => a - b).map(i => k[i] ?? NaN), v => (v == null ? NaN : v)));
const track = pose.clean.map(asArr);
const meta = probe(clip);
const frames = openFrames(clip, meta);
const t0 = Date.now();
const it = frames.sequential(pose.first, pose.last, 1);
let at = -1, cur = null;
const getRGBA = async f => { while (at < f) { const r = await it.next(); if (r.done) throw new Error('clip ended'); at = r.value.i; cur = r.value.rgba; } return cur; };
const motion = await measureMotion({ getRGBA, W: meta.W, H: meta.H, track, from: pose.first, to: pose.last });
await it.return?.();
frames.close();
writeFileSync(out, JSON.stringify({ first: pose.first, last: pose.last, fps: meta.fps, ts: meta.ts, motion }));
console.error(`motion for ${motion.length} frames in ${Date.now() - t0} ms`);
