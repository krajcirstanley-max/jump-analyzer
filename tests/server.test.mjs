// Server side and cloud client: no GPU, no network, nothing deployed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProbe, probe, openFrames, jpeg } from '../server/frames.mjs';

// cloud.js reads a constant from config.js; point it at a fake server for these tests.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === './config.js' && ctx.parentURL?.endsWith('/js/cloud.js')) {
      return { url: `data:text/javascript,export const CLOUD_URL='https://srv.test/'`, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

const data = new Map();
globalThis.localStorage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
const cloud = await import('../js/cloud.js');
const CLIP = fileURLToPath(new URL('./fixtures/bar240_portrait.mov', import.meta.url));

test('the coaching SDK resolves, or every job would silently use the template', async () => {
  const sdk = await import(new URL('../server/node_modules/@anthropic-ai/sdk/index.mjs', import.meta.url).href);
  assert.equal(typeof sdk.default, 'function');
});

test('server/coach.mjs exports writeCoaching and onnxruntime-node resolves', async () => {
  const { writeCoaching } = await import('../server/coach.mjs');
  assert.equal(typeof writeCoaching, 'function');
  const ort = await import(new URL('../server/node_modules/onnxruntime-node/dist/index.js', import.meta.url).href);
  assert.ok(ort.InferenceSession ?? ort.default?.InferenceSession);
});

test('parseProbe swaps sides for rotated clips and sorts packets into frame order', () => {
  const pts = [0, 2, 1, 3].map(t => ({ pts_time: String(t / 100) }));
  const r = parseProbe({ width: 1920, height: 1080, side_data_list: [{ side_data_type: 'x' }, { rotation: -90 }] }, pts);
  assert.deepEqual([r.W, r.H, r.N], [1080, 1920, 4]);
  assert.deepEqual(r.ts, [0, 0.01, 0.02, 0.03]);
  assert.equal(Math.round(r.fps), 100);
  const flat = parseProbe({ width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] }, pts);
  assert.deepEqual([flat.W, flat.H], [1920, 1080]);
  assert.throws(() => parseProbe({ width: 0, height: 0 }, []));
});

test('wire format restores Float32Array and NaN, and rounds like the fixtures', () => {
  const f = Float32Array.from([1.234, NaN, 0.5]);
  const w = cloud.toWire({ fast: [f, null], accurate: [null, null], clean: [f, null], smooth: [f, null], boxes: [[1.26, 2, 3, 4], null], W: 1 }, [0, 0.00833333333]);
  assert.deepEqual(w.fast[0], [1.23, null, 0.5]);
  assert.deepEqual(w.boxes[0], [1.3, 2, 3, 4]);
  assert.deepEqual(w.ts, [0, 0.008333]);
  const back = cloud.fromWire(JSON.parse(JSON.stringify(w)));
  assert.ok(back.clean[0] instanceof Float32Array);
  assert.ok(Number.isNaN(back.clean[0][1]));
  assert.equal(back.fast[1], null);
  assert.equal(back.W, 1);
});

test('both decode paths give the same frames and need no ffmpeg per get', async () => {
  const meta = probe(CLIP);
  const mem = openFrames(CLIP, meta, { budget: Infinity });
  const str = openFrames(CLIP, meta, { budget: 0 });
  assert.equal(mem.mode, 'memory');
  assert.equal(str.mode, 'stream');
  try {
    const sample = async (fr, from, to, step) => { const a = []; for await (const { i, rgba } of fr.sequential(from, to, step)) a.push([i, Buffer.from(rgba).toString('latin1').slice(0, 2000)]); return a; };
    const m = await sample(mem, 0, meta.N - 1, 8);
    const s = await sample(str, 0, meta.N - 1, 8);
    assert.deepEqual(m.map(x => x[0]), s.map(x => x[0]));
    assert.ok(m.every((x, k) => x[1] === s[k][1]), 'sampled frames differ between the paths');
    const before = Date.now();
    const again = await str.get(8);            // cached from the sampling pass
    assert.ok(Date.now() - before < 20, 'get of a sampled frame must not start ffmpeg');
    assert.ok((await mem.get(8)).equals(again));
    assert.ok((await mem.get(meta.N - 1)).length === meta.W * meta.H * 4);
    const win = await sample(str, 5, 9, 1);
    assert.deepEqual(win.map(x => x[0]), [5, 6, 7, 8, 9]);
    const picked = await str.pick([9, 3]);
    assert.ok(picked.get(3).equals(await mem.get(3)));
    assert.ok(picked.get(9).equals(await mem.get(9)));
  } finally { mem.close(); str.close(); }
});

test('frame index matches the plain single-frame ffmpeg path used for the local tests', async () => {
  const meta = probe(CLIP);
  const fr = openFrames(CLIP, meta, { budget: Infinity });
  try {
    const single = execFileSync('ffmpeg', ['-v', 'error', '-i', CLIP, '-vf', 'select=eq(n\\,7)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: meta.W * meta.H * 4 + 1024 });
    assert.ok(single.equals(await fr.get(7)));
  } finally { fr.close(); }
});

test('a missing clip fails with an error instead of hanging', async () => {
  const fr = openFrames('/nonexistent.mov', { N: 3, W: 2, H: 2, ts: [0, 1, 2], fps: 1 }, { budget: Infinity });
  await assert.rejects(() => fr.get(0), /ffmpeg/);
});

test('jpeg produces a real JPEG with the long side capped', async () => {
  const W = 40, H = 80, rgba = Buffer.alloc(W * H * 4, 128);
  const j = await jpeg(rgba, W, H, { maxSide: 20 });
  assert.deepEqual([...j.subarray(0, 2)], [0xff, 0xd8]);
  const dir = mkdtempSync(join(tmpdir(), 'ja-'));
  try {
    const f = join(dir, 'a.jpg');
    (await import('node:fs')).writeFileSync(f, j);
    const size = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
    assert.equal(size, '10,20');
  } finally { rmSync(dir, { recursive: true }); }
});

test('analyzeClip wires pose, analysis and the result shape with a stubbed engine', async () => {
  const { analyzeClip } = await import('../server/analyze.mjs');
  const K = 21;
  const engine = {
    ms: {},
    async detect(rgba, W, H) { return [[W * 0.3, H * 0.2, W * 0.7, H * 0.8, 0.9]]; },
    async pose(rgba, W, H, box) {
      const kp = new Float32Array(K * 3);
      for (let j = 0; j < K; j++) { kp[j * 3] = box[0] + j; kp[j * 3 + 1] = box[1] + j * 2; kp[j * 3 + 2] = 0.9; }
      return kp;
    },
  };
  const seen = [];
  const out = await analyzeClip(engine, { clip: CLIP, sex: 'female', name: 'Test', onProgress: p => seen.push(p.stage) });
  assert.ok(out.result, JSON.stringify(out).slice(0, 200));
  const { result: r } = out;
  for (const k of ['W', 'H', 'N', 'fps', 'first', 'last', 'fast', 'accurate', 'clean', 'smooth', 'boxes', 'track', 'models', 'stats', 'ts']) assert.ok(k in r, k);
  assert.equal(r.ts.length, r.N);
  assert.ok(r.clean.some(Array.isArray) && !JSON.stringify(r).includes('"0":'), 'typed arrays must be plain arrays on the wire');
  assert.ok(seen.includes('analysis'));
  assert.equal(JSON.parse(JSON.stringify(out)).result.N, r.N);
});

test('coachClient: own token, then nothing; the local login only when asked for', async () => {
  const { coachClient } = await import('../server/analyze.mjs');
  assert.ok(coachClient({ token: 't' }).beta.messages.create);
  assert.equal(coachClient({}), undefined);
  assert.ok(coachClient({ localLogin: true }).beta.messages.create);
});

function fakeClaude(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ja-bin-'));
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!/usr/bin/env node\n${script}`);
  chmodSync(bin, 0o755);
  return { dir, bin, seen: join(dir, 'seen.json') };
}
const REQ = { model: 'm', output_config: { format: { schema: {} } }, system: [{ text: 's' }], messages: [{ role: 'user', content: 'x' }] };

test('cliClient gives the token to the child alone, in a bare env with a throwaway config', async () => {
  const { cliClient } = await import('../server/claude-cli.mjs');
  const f = fakeClaude(`const fs = require('fs');
fs.writeFileSync(require('path').join(__dirname, 'seen.json'), JSON.stringify({ env: process.env, argv: process.argv, config: process.env.CLAUDE_CONFIG_DIR, configExists: fs.existsSync(process.env.CLAUDE_CONFIG_DIR) }));
process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ type: 'result', structured_output: { ok: 1 } })));`);
  process.env.JUMP_CLAUDE_TOKENS = '{"miska":"someone-elses"}';
  process.env.ANTHROPIC_API_KEY = 'fake-api-key';
  try {
    const r = await cliClient({ bin: f.bin, token: 'fake-token-123' }).beta.messages.create(REQ);
    assert.deepEqual(JSON.parse(r.content[0].text), { ok: 1 });
    const seen = JSON.parse(readFileSync(f.seen, 'utf8'));
    assert.equal(seen.env.CLAUDE_CODE_OAUTH_TOKEN, 'fake-token-123');
    assert.equal(seen.env.JUMP_CLAUDE_TOKENS, undefined);
    assert.equal(seen.env.ANTHROPIC_API_KEY, undefined);
    assert.ok(!seen.argv.join(' ').includes('fake-token-123'), 'a token in argv is visible to other processes');
    assert.ok(seen.argv.includes('--safe-mode'));
    assert.equal(seen.configExists, true);
    assert.equal(existsSync(seen.config), false, 'the throwaway config must be gone afterwards');
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'the server process itself must not hold it');
  } finally {
    delete process.env.JUMP_CLAUDE_TOKENS; delete process.env.ANTHROPIC_API_KEY;
    rmSync(f.dir, { recursive: true });
  }
});

test('cliClient keeps the token out of error messages, and a usage limit rejects for the template', async () => {
  const { cliClient } = await import('../server/claude-cli.mjs');
  const leaky = fakeClaude(`process.stdin.resume(); process.stdin.on('end', () => { console.error('bad credential fake-token-123'); process.exit(1); });`);
  await assert.rejects(cliClient({ bin: leaky.bin, token: 'fake-token-123' }).beta.messages.create(REQ), e => !e.message.includes('fake-token-123') && e.message.includes('[token]'));
  rmSync(leaky.dir, { recursive: true });
  const limited = fakeClaude(`process.stdin.resume(); process.stdin.on('end', () => console.log(JSON.stringify({ result: 'Usage limit reached' })));`);
  await assert.rejects(cliClient({ bin: limited.bin, token: 'some-test-token' }).beta.messages.create(REQ), /Usage limit/);
  rmSync(limited.dir, { recursive: true });
});

// Local only: needs the real clip, which stays out of git. Saved keypoints stand in for inference.
const REAL = fileURLToPath(new URL('./real/IMG_4390.MOV', import.meta.url));
const SAVED = fileURLToPath(new URL('./fixtures/_real_IMG_4390_pose.json', import.meta.url));
test('the result is out before the coaching call starts, and a locate or coaching failure cannot touch it', { skip: !existsSync(REAL) || !existsSync(SAVED) }, async () => {
  const { analyzeClip } = await import('../server/analyze.mjs');
  const fx = JSON.parse(readFileSync(SAVED, 'utf8'));
  const toF = a => Float32Array.from(a, v => (v == null ? NaN : v));
  const boxes = new Map(fx.track.map(p => [p.frame, p.box]));
  const fastAt = fx.fast.flatMap((v, i) => (v ? [i] : [])), accAt = fx.accurate.flatMap((v, i) => (v ? [i] : []));
  let s = 0, f = 0, a = 0;
  const engine = {
    ms: {},
    async detect(rgba, W, H, roi) { if (roi) return []; const b = boxes.get(s); s += 8; return b ? [b] : []; },
    async pose(rgba, W, H, box, key) { return toF(key === 'rtmpose-m' ? fx.fast[fastAt[f++]] : fx.accurate[accAt[a++]]); },
  };
  const order = [];
  // The same client first names the key frames (locate), then writes the coaching.
  const client = { beta: { messages: { create: async req => { order.push(req.system[0].text.includes('contact sheet') ? 'locate call' : 'coach call'); throw new Error('Usage limit reached'); } } } };
  const out = await analyzeClip(engine, {
    clip: REAL, sex: 'female', name: 'Miška', client,
    onResult: r => { order.push('result'); assert.ok(r.result.clean.length === fx.N && r.coachFallback?.source === 'template'); },
  });
  // A failed locate leaves the pose track's key frames; the numbers still come before coaching.
  // Overview and frame reading run side by side, so there are two locate calls.
  const r = order.indexOf('result');
  assert.ok(r > 0 && order.slice(0, r).every(x => x === 'locate call'), order.join());
  assert.equal(order[r + 1], 'coach call');
  assert.equal(out.coach.source, 'template', 'a usage limit falls back to the template');
  assert.equal(out.result.N, fx.N);
});

// ---------- cloud client against a fake server ----------
class FakeXHR {
  static plan = [];
  static opened = [];
  upload = {};
  headers = {};
  open(m, u) { this.url = u; FakeXHR.opened.push(this); }
  setRequestHeader(k, v) { this.headers[k] = v; }
  abort() { clearTimeout(this.t); this.onabort?.(); }
  send(file) {
    const step = FakeXHR.plan.shift() ?? { status: 200, body: { jobId: 'J1' } };
    this.t = setTimeout(() => {
      if (step.net) return this.onerror?.();
      if (step.hold) return;
      this.upload.onprogress?.({ lengthComputable: true, loaded: file.size, total: file.size });
      this.status = step.status;
      this.responseText = JSON.stringify(step.body ?? {});
      this.onload?.();
    }, 1);
  }
}
globalThis.XMLHttpRequest = FakeXHR;

const json = (status, body) => new Response(JSON.stringify(body), { status });
function fakeFetch(steps) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    if (/\/warm(\?|$)/.test(String(url))) return json(200, { ok: true });
    if (opts.signal?.aborted) throw new DOMException('x', 'AbortError');
    const s = steps.length > 1 ? steps.shift() : steps[0];
    if (s === 'net') throw new TypeError('Load failed');
    return json(s.status ?? 200, s.body ?? s);
  };
  return calls;
}
const FILE = { size: 1000, name: 'a.mov' };
const wire = { W: 2, H: 2, N: 1, fast: [[1, null, 0.5]], accurate: [null], clean: [[1, null, 0.5]], smooth: [[1, null, 0.5]], boxes: [null], ts: [0] };
const reset = () => { FakeXHR.plan = []; FakeXHR.opened = []; data.clear(); cloud.setCloudToken('tok'); };

test('cloudReady needs the token; token is stored and cleared', () => {
  data.clear();
  assert.equal(cloud.cloudReady(), false);
  cloud.setCloudToken('  abc ');
  assert.equal(cloud.getCloudToken(), 'abc');
  assert.equal(cloud.cloudReady(), true);
  cloud.setCloudToken('');
  assert.equal(cloud.cloudReady(), false);
});

test('a broken localStorage does not throw', () => {
  const saved = globalThis.localStorage;
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  try { assert.equal(cloud.getCloudToken(), ''); cloud.setCloudToken('x'); }
  finally { globalThis.localStorage = saved; }
});

test('analyzeInCloud uploads, follows the job and hydrates the result', async () => {
  reset();
  const calls = fakeFetch([{ state: 'running', stage: 'Tracking pose', done: 3, total: 9 }, { state: 'done', result: wire, coach: { source: 'claude' } }]);
  const stages = [];
  const r = await cloud.analyzeInCloud(FILE, { sex: 'female', name: 'Miška', history: [{ score: 1 }], onProgress: p => stages.push(p) });
  assert.ok(r.result.clean[0] instanceof Float32Array && Number.isNaN(r.result.clean[0][1]));
  assert.equal(r.coach.source, 'claude');
  assert.ok(r.ms >= 0);
  const url = new URL(FakeXHR.opened[0].url);
  assert.equal(url.origin + url.pathname, 'https://srv.test/jobs');
  assert.equal(url.searchParams.get('name'), 'Miška');
  assert.deepEqual(JSON.parse(url.searchParams.get('history')), [{ score: 1 }]);
  assert.equal(FakeXHR.opened[0].headers.Authorization, 'Bearer tok');
  assert.equal(stages[0].stage, 'Nahrávam video');
  assert.ok(stages.some(s => s.stage === 'Sledujem pohyb' && s.done === 3 && s.total === 9), 'server stages reach the athlete in Slovak');
  assert.ok(calls.some(c => /\/warm(\?|$)/.test(c.url)), 'the warm-up goes out with the upload');
  assert.equal(cloud.pendingCloudJob(), null);
});

test('upload retries network failures and 5xx, then succeeds', async () => {
  reset();
  FakeXHR.plan = [{ net: true }, { status: 503 }, { status: 200, body: { jobId: 'J2' } }];
  fakeFetch([{ state: 'done', result: wire }]);
  await cloud.analyzeInCloud(FILE, {});
  assert.equal(FakeXHR.opened.length, 3);
});

test('upload gives up after three tries with a Slovak message', async () => {
  reset();
  FakeXHR.plan = [{ net: true }, { net: true }, { net: true }];
  fakeFetch([{ state: 'done', result: wire }]);
  await assert.rejects(cloud.analyzeInCloud(FILE, {}), /pripojenie/);
  assert.equal(FakeXHR.opened.length, 3);
});

test('auth and size errors do not retry', async () => {
  reset();
  FakeXHR.plan = [{ status: 401 }];
  fakeFetch([{}]);
  await assert.rejects(cloud.analyzeInCloud(FILE, {}), /kľúč/);
  assert.equal(FakeXHR.opened.length, 1);
  await assert.rejects(cloud.analyzeInCloud({ size: cloud.MAX_UPLOAD + 1 }, {}), /300 MB/);
});

test('polling survives network failures and reports server errors as written', async () => {
  reset();
  fakeFetch(['net', 'net', { state: 'running', stage: 'coach' }, { state: 'error', error: 'Vo videu som nenašiel skokana.' }]);
  await assert.rejects(cloud.analyzeInCloud(FILE, {}), /nenašiel skokana/);
  assert.equal(cloud.pendingCloudJob(), null);
});

test('abort cancels during upload', async () => {
  reset();
  FakeXHR.plan = [{ hold: true }];
  fakeFetch([{}]);
  const ac = new AbortController();
  const p = cloud.analyzeInCloud(FILE, { signal: ac.signal });
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, e => e.name === 'AbortError');
});

test('abort cancels during polling and leaves the job resumable', async () => {
  reset();
  fakeFetch([{ state: 'running', stage: 'Tracking pose' }]);
  const ac = new AbortController();
  const p = cloud.analyzeInCloud(FILE, { signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, e => e.name === 'AbortError');
  assert.equal(cloud.pendingCloudJob().jobId, 'J1');
  fakeFetch([{ state: 'done', result: wire }]);
  const r = await cloud.resumeCloudJob('J1');
  assert.equal(r.result.N, 1);
  assert.equal(cloud.pendingCloudJob(), null);
});

test('history is trimmed to fit a query string, newest kept', async () => {
  reset();
  fakeFetch([{ state: 'done', result: wire }]);
  const big = Array.from({ length: 5 }, (_, i) => ({ i, pad: 'x'.repeat(2500) }));
  await cloud.analyzeInCloud(FILE, { history: big });
  const h = JSON.parse(new URL(FakeXHR.opened[0].url).searchParams.get('history'));
  assert.deepEqual(h.map(x => x.i), [3, 4]);
});

test('onResult fires once, before coaching ends, and the result is not downloaded twice', async () => {
  reset();
  const calls = fakeFetch([
    { state: 'running', stage: 'Tracking pose', done: 1, total: 2 },
    { state: 'running', stage: 'coach', done: 0, total: 1, result: wire },
    { state: 'running', stage: 'coach', done: 0, total: 1 },
    { state: 'done', coach: { source: 'claude' } },
  ]);
  const got = [], stages = [];
  const r = await cloud.analyzeInCloud(FILE, { onResult: x => got.push(x), onProgress: p => stages.push(p.stage) });
  assert.equal(got.length, 1);
  assert.ok(got[0].result.clean[0] instanceof Float32Array);
  assert.ok(got[0].ms >= 0);
  assert.equal(r.coach.source, 'claude');
  assert.equal(r.result, got[0].result, 'the promise resolves with the same result');
  assert.ok(stages.includes('Píšem odporúčania'));
  const polls = calls.filter(c => c.url.includes('/jobs/'));
  assert.ok(!polls[1].url.includes('omit=result'));
  assert.ok(polls[2].url.includes('omit=result') && polls[3].url.includes('omit=result'));
});

test('a job that goes straight to done still calls onResult, and resume supports it', async () => {
  reset();
  fakeFetch([{ state: 'done', result: wire, coach: null }]);
  const got = [];
  const r = await cloud.resumeCloudJob('J9', { onResult: x => got.push(x) });
  assert.equal(got.length, 1);
  assert.equal(r.coach, null);
});

test('a failure after the result still resolves with the result', async () => {
  reset();
  fakeFetch([{ state: 'running', stage: 'coach', result: wire }, { state: 'error', error: 'x' }]);
  const r = await cloud.analyzeInCloud(FILE, {});
  assert.equal(r.result.N, 1);
  assert.equal(r.coach, null);
});

test('back-to-back jobs each keep their own pending entry', async () => {
  reset();
  FakeXHR.plan = [{ status: 200, body: { jobId: 'A' } }, { status: 200, body: { jobId: 'B' } }];
  // A finishes only after B has been uploaded and is still running.
  let aDone = false;
  globalThis.fetch = async url => {
    const u = String(url);
    if (/\/warm(\?|$)/.test(u)) return json(200, { ok: true });
    if (u.includes('/jobs/A')) return json(200, aDone ? { state: 'done', result: wire, coach: null } : { state: 'running', stage: 'coach' });
    return json(200, { state: 'running', stage: 'coach' });
  };
  const acB = new AbortController();
  const a = cloud.analyzeInCloud(FILE, {});
  await new Promise(r => setTimeout(r, 20));
  const b = cloud.analyzeInCloud(FILE, { signal: acB.signal });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(cloud.pendingCloudJobs().map(j => j.jobId), ['A', 'B']);
  assert.equal(cloud.pendingCloudJob().jobId, 'B', 'no argument means the newest');
  assert.equal(cloud.pendingCloudJob('A').jobId, 'A');
  assert.equal(cloud.pendingCloudJob('nope'), null);
  assert.equal(cloud.pendingCloudJob(null), null, 'an attempt with no job must not match the newest');
  aDone = true;
  await a;
  assert.deepEqual(cloud.pendingCloudJobs().map(j => j.jobId), ['B'], 'A finishing must not touch B');
  acB.abort();
  await assert.rejects(b, e => e.name === 'AbortError');
  assert.equal(cloud.pendingCloudJob('B').jobId, 'B', 'an aborted job stays resumable');
});

test('a pending entry from the old single-job format is still found, and old entries expire', () => {
  reset();
  data.set('ja-cloud-job', JSON.stringify({ jobId: 'OLD', at: Date.now() }));
  assert.equal(cloud.pendingCloudJob('OLD').jobId, 'OLD');
  data.set('ja-cloud-jobs', JSON.stringify([{ jobId: 'ANCIENT', at: Date.now() - 8 * 24 * 3600_000 }]));
  assert.deepEqual(cloud.pendingCloudJobs().map(j => j.jobId), ['OLD']);
  data.set('ja-cloud-jobs', '{broken');
  assert.deepEqual(cloud.pendingCloudJobs().map(j => j.jobId), ['OLD']);
});

test('a result carrying an error is a failure, not an empty analysis', async () => {
  reset();
  fakeFetch([{ state: 'done', result: { error: 'Chyba.' } }]);
  await assert.rejects(cloud.analyzeInCloud(FILE, {}), /Chyba/);
});
