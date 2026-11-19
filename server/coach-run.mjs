// The coaching text for one jump, outside the GPU job (worker.process_coach).
// node server/coach-run.mjs in.json out.json, with the athlete's Claude token on stdin (never in
// argv or env, where other processes can read it). No token: the template coach.
import { readFileSync, writeFileSync } from 'node:fs';
import { writeCoaching } from './coach.mjs';
import { cliClient } from './claude-cli.mjs';

const [inp, out] = process.argv.slice(2);
let token = '';
try { token = readFileSync(0, 'utf8').trim(); } catch { /* no stdin */ }
const { coachFallback, ...a } = JSON.parse(readFileSync(inp, 'utf8'));
let coach = null;
try { coach = await writeCoaching({ ...a, client: token ? cliClient({ token }) : undefined }); }
catch (e) { console.error('coaching failed:', e?.message || e); coach = coachFallback ?? null; }
writeFileSync(out, JSON.stringify({ coach }));
