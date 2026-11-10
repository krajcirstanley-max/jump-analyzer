import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliClient } from '../server/claude-cli.mjs';

const req = {
  model: 'claude-opus-5-5', output_config: { effort: 'high', format: { schema: { type: 'object' } } },
  system: [{ type: 'text', text: 'SYS' }],
  messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AA' } }, { type: 'text', text: 'hi' }] }],
};

// A stand-in `claude` that records what it was given and prints `reply`.
function fake(reply) {
  const dir = mkdtempSync(join(tmpdir(), 'fake-claude-'));
  const bin = join(dir, 'claude'), log = join(dir, 'log.json');
  writeFileSync(bin, `#!/usr/bin/env node
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{require('fs').writeFileSync(${JSON.stringify(log)},JSON.stringify({argv:process.argv.slice(2),stdin:s,key:process.env.ANTHROPIC_API_KEY??null}));process.stdout.write(${JSON.stringify(reply)})});`);
  chmodSync(bin, 0o755);
  return { bin, seen: () => JSON.parse(readFileSync(log, 'utf8')) };
}

// What the real CLI prints with --output-format stream-json: events, the answer last.
const stream = ev => [{ type: 'system', subtype: 'init' }, { type: 'assistant' }, { type: 'result', ...ev }].map(e => JSON.stringify(e)).join('\n') + '\n';

test('sends images over stdin, returns the structured output as SDK-shaped text', async () => {
  const f = fake(stream({ structured_output: { take: 'x' } }));
  const res = await cliClient({ bin: f.bin }).beta.messages.create(req);
  assert.deepEqual(JSON.parse(res.content[0].text), { take: 'x' });
  const { argv, stdin } = f.seen();
  assert.ok(argv.includes('--safe-mode'));
  // The real CLI rejects stream-json input with any other output, and stream-json output without --verbose.
  assert.equal(argv[argv.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(argv.includes('--verbose'));
  assert.equal(argv[argv.indexOf('--system-prompt') + 1], 'SYS');
  assert.equal(argv[argv.indexOf('--tools') + 1], '');
  const msg = JSON.parse(stdin);
  assert.equal(msg.type, 'user');
  assert.equal(msg.message.content[0].source.data, 'AA');
});

test('an API key in the environment never reaches the subscription call', async () => {
  const f = fake(stream({ structured_output: {} }));
  process.env.ANTHROPIC_API_KEY = 'test-value';
  try { await cliClient({ bin: f.bin }).beta.messages.create(req); }
  finally { delete process.env.ANTHROPIC_API_KEY; }
  assert.equal(f.seen().key, null);
});

test('a usage-limit reply rejects, so coach.mjs falls back to the template', async () => {
  const f = fake(stream({ is_error: true, result: "You've hit your session limit" }));
  await assert.rejects(cliClient({ bin: f.bin }).beta.messages.create(req), /session limit/);
});

test('garbage output and a missing binary reject', async () => {
  await assert.rejects(cliClient({ bin: fake('not json').bin }).beta.messages.create(req), /claude:/);
  await assert.rejects(cliClient({ bin: '/nonexistent/claude' }).beta.messages.create(req));
});
