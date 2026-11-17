// How far the app is from the hand-checked frames (tests/truth.json), clip by clip.
//   node tools/bench.mjs            replays every stored server answer with the current code (free)
//   node tools/bench.mjs --server   first sends every video to the server again (2 at a time, ~0.2 € a clip)
//   node tools/bench.mjs --server 4954 4940   only those clips
// Every server answer is kept in tests/real/bench/history/<id>-<time>.json (local, never committed).
// The offline run replays the server's choice of key frames (server/locate.mjs nameEvents) on
// Claude's stored reading, then the app's analysis, so one bad Claude answer stays a test for good:
// 2026-11-17, three server runs in a row each broke a different clip. Exit code 1 past the gate.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { analyzeJump } from '../js/analysis/jump.js';
import { nameEvents, locateGuess } from '../server/locate.mjs';

const root = new URL('../', import.meta.url);
const T = JSON.parse(readFileSync(new URL('tests/truth.json', root)));
const REAL = new URL('tests/real/', root), BENCH = new URL('tests/real/bench/', root), HIST = new URL('tests/real/bench/history/', root);
const args = process.argv.slice(2), server = args.includes('--server');
const only = args.filter(a => /^\d+$/.test(a));
const ids = Object.keys(T.clips).filter(id => !only.length || only.includes(id));

const BASE = 'https://krajcir-stanley--jump-analyzer-web.eu-west.modal.run';
async function analyse(id) {
  const tok = readFileSync(new URL('server/.app-tokens.txt', root), 'utf8').match(/stanley:\s*(\S+)/)?.[1];
  if (!tok) throw new Error('no app token');
  const a = T.athletes[T.clips[id].who];
  const roster = Object.entries(T.athletes).map(([k, v]) => ({ id: k, ...v, history: [] }));
  const q = new URLSearchParams({ sex: a.sex, name: a.name, height: a.height, mode: 'jump', athletes: JSON.stringify(roster) });
  const H = { Authorization: `Bearer ${tok}` };
  const body = readFileSync(new URL(`IMG_${id}.MOV`, REAL));
  const job = await (await fetch(`${BASE}/jobs?${q}`, { method: 'POST', body, headers: { ...H, 'Content-Type': 'application/octet-stream' } })).json();
  const jid = job.jobId ?? job.id;
  for (let t = 0; t < 120; t++) {
    await new Promise(r => setTimeout(r, 10_000));
    const j = await (await fetch(`${BASE}/jobs/${jid}`, { headers: H })).json();
    if (j.state === 'done' || j.state === 'error') return j;
  }
  return { state: 'error', error: 'timeout' };
}

if (server) {
  mkdirSync(HIST, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const queue = ids.filter(id => existsSync(new URL(`IMG_${id}.MOV`, REAL)));
  const worker = async () => {
    for (let id; (id = queue.shift());) {
      const j = await analyse(id).catch(e => ({ state: 'error', error: String(e.message) }));
      writeFileSync(new URL(`${id}.json`, BENCH), JSON.stringify(j));
      writeFileSync(new URL(`${id}-${stamp}.json`, HIST), JSON.stringify(j));
      console.log(`server ${id}: ${j.state}${j.error ? ' ' + j.error : ''}`);
    }
  };
  await Promise.all([worker(), worker()]);
}

// Every stored answer for a clip, oldest first; the saved one from before the benchmark if none.
const runsOf = id => {
  const h = existsSync(HIST) ? readdirSync(HIST).filter(f => f.startsWith(`${id}-`)).sort().map(f => new URL(f, HIST)) : [];
  const list = h.length ? h : [new URL(`r${id}.json`, REAL)].filter(existsSync);
  return list.map(u => ({ d: JSON.parse(readFileSync(u)), from: h.length ? u.pathname.split('/').pop().slice(id.length + 1, id.length + 17) : 'saved' }));
};
const span = x => Array.from({ length: x.to - x.td + 1 }, (_, k) => x.td + k);
// The server's naming again with the current code, on what Claude read that time.
function replay(d, a) {
  const r = structuredClone(d.result), L = r.locate;
  if (!L?.windows) return r;
  const r0 = { ...r }; delete r0.events; delete r0.locate; delete r0.ground; delete r0.groundError;
  const guess = locateGuess(r0, a.sex, r.ts, { height: a.height });
  const seen = L.seen ? { ...L.seen, T: L.windows.T }
    : { ground: (L.runs ?? []).flatMap(span), sand: r.events?.landing ?? null, runThrough: r.events?.kind === 'runthrough', T: L.windows.T };
  const n = nameEvents(seen, guess, r.fps);
  if (n.events.TD != null) r.events = n.events; else delete r.events;
  r.locate = { ...L, edges: n.edges };
  return r;
}

const K = ['penTD', 'penTO', 'TD', 'TO', 'landing'];
const rows = [], bad = [], near = [], checks = [];
let edges = 0, exact = 0;
let runs = 0;
const judge = (id, r, from, t, a) => {
  const j = analyzeJump(r, a.sex, r.ts, { height: a.height });
  if (t.noJump) return { id, from, text: j.error ? `ok, no jump` : `WRONG: a jump at ${j.takeoff.td}`, bad: j.error ? [] : [`${id} jump found`] };
  if (j.error) return { id, from, text: `ERROR ${j.error}`, bad: [`${id} ${j.error}`] };
  const app = { penTD: j.pen?.td, penTO: j.pen?.to, TD: j.takeoff.td, TO: j.takeoff.to, landing: j.landing };
  const out = { id, from, j, bad: [], near: [], err: {} };
  for (const k of K) {
    if (t[k] == null) continue;
    if (app[k] == null) { out.bad.push(`${id} ${k} missing`); continue; }
    const e = Math.round(app[k] - t[k]), land = k === 'landing';
    const aim = land ? T.tolerance.landing : T.tolerance.contact, gate = land ? T.tolerance.landing : T.tolerance.gateContact;
    out.err[k] = e;
    if (Math.abs(e) > gate) out.bad.push(`${id}@${from} ${k} ${e > 0 ? '+' : ''}${e}`);
    else if (Math.abs(e) > aim) out.near.push(`${id}@${from} ${k} ${e > 0 ? '+' : ''}${e}`);
  }
  return out;
};
for (const id of ids) {
  const t = T.clips[id], a = T.athletes[t.who], list = runsOf(id);
  if (!list.length) { rows.push([id, 'no result']); continue; }
  const res = list.map(({ d, from }) => {
    runs++;
    if (!d.result) return { id, from, text: `server: ${d.error ?? d.state}`, bad: [`${id}@${from} no result`] };
    return judge(id, replay(d, a), from, t, a);
  });
  for (const x of res) { bad.push(...x.bad); near.push(...(x.near ?? [])); for (const k of K) if (x.err?.[k] != null && k !== 'landing') { edges++; if (Math.abs(x.err[k]) <= T.tolerance.contact) exact++; } }
  // worst error over all runs per key frame, metres from the latest run
  const worst = K.map(k => {
    if (t.noJump) return '';
    if (t[k] == null) return '  ok';
    const es = res.map(x => x.err?.[k]).filter(e => e != null);
    if (!es.length) return '   -';
    const e = es.reduce((w, x) => (Math.abs(x) > Math.abs(w) ? x : w), 0), land = k === 'landing';
    const gate = land ? T.tolerance.landing : T.tolerance.gateContact, aim = land ? T.tolerance.landing : T.tolerance.contact;
    return (Math.abs(e) > gate ? '!' : Math.abs(e) > aim ? '~' : ' ') + String(e > 0 ? '+' + e : e).padStart(3);
  });
  const last = res.at(-1);
  if (t.noJump || !last.j) { rows.push([id, (t.noJump ? res.map(x => x.text).join(', ') : last.text), `${res.length} run(s)`]); continue; }
  const m = Object.fromEntries(last.j.metrics.map(x => [x.key, x]));
  const v = (k, d = 2) => (m[k] && m[k].status !== 'hidden' ? (+m[k].value).toFixed(d) : '-');
  rows.push([id, worst.join(' '), `${t.who.padEnd(7)} ${String(res.length).padStart(2)} run(s)  ${v('speedLast')} m/s  ${v('takeoffAngle', 1)}°  ${v('estDistance')} m   ${t.setup}`]);
  // independent checks of the metres: Freelap's 1-11 m time and the tape
  if (t.freelap && m.speedApproach) checks.push(`${id} 1-11 m: app ${(10 / m.speedApproach.value).toFixed(3)} s, Freelap ${t.freelap.toFixed(2)} s (${(((10 / m.speedApproach.value) / t.freelap - 1) * 100).toFixed(1)} %)`);
  if (t.tape && m.estDistance) checks.push(`${id} distance: app ${(+m.estDistance.value).toFixed(2)} m, tape ${t.tape.toFixed(2)} m (${((m.estDistance.value / t.tape - 1) * 100).toFixed(1)} %)`);
}
console.log(`\nworst frames off over every stored server run (app − hand)\n${''.padEnd(37)}${K.join(' ')}`);
for (const r of rows) console.log(`${r[0].padEnd(6)} ${r[1].padEnd(30)} ${r[2] ?? ''}`);
console.log(`\n${runs} server runs; contact edges within ${T.tolerance.contact} frame: ${exact} of ${edges}${near.length ? ` (off by more: ${near.join(', ')})` : ''}`);
if (checks.length) console.log(`against Freelap and tape (only clips that have them):\n  ${checks.join('\n  ')}`);
console.log(bad.length ? `\nFAIL, past contact ±${T.tolerance.gateContact} or landing ±${T.tolerance.landing}: ${bad.join(', ')}` : `\npass (no contact past ±${T.tolerance.gateContact}, no landing past ±${T.tolerance.landing})`);
process.exitCode = bad.length ? 1 : 0;
