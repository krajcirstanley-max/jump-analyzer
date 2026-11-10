// Sends the coaching request through Claude Code (`claude -p`), so it draws on a subscription
// instead of an API key. With no token: the login on this machine, the owner's own Mac only.
// With a token: that person's own CLAUDE_CODE_OAUTH_TOKEN, as Anthropic's docs require for
// end users. It goes into this one child's env and nowhere else.
// Same shape as the SDK's `client.beta.messages.create`, so coach.mjs can't tell the difference.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Any of these would silently win over the subscription login in print mode.
const OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'];

// With a token the child gets a bare env and its own throwaway config dir: nothing from the
// server process can reach it, and nothing of one person's stays for the next job.
function childEnv(token) {
  if (!token) {
    const env = { ...process.env };
    for (const k of OVERRIDES) delete env[k];
    return { env, done() {} };
  }
  const dir = mkdtempSync(join(tmpdir(), 'jump-claude-'));
  const env = { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: dir, LANG: 'C.UTF-8', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_OAUTH_TOKEN: token };
  return { env, done() { rmSync(dir, { recursive: true, force: true }); } };
}

// The last `result` event in the stream, or null if the CLI died before printing one.
function finalResult(out) {
  let r = null;
  for (const line of out.split('\n')) {
    try { const ev = JSON.parse(line); if (ev?.type === 'result') r = ev; } catch {}
  }
  return r;
}

export function cliClient({ bin = 'claude', token } = {}) {
  const hide = s => (token ? String(s).split(token).join('[token]') : String(s));
  const create = (req, { signal } = {}) => new Promise((resolve, reject) => {
    const { env, done } = childEnv(token);
    const args = [
      '-p', '--safe-mode', '--tools', '', '--no-session-persistence', '--max-turns', '3',
      '--model', req.model, '--effort', req.output_config?.effort ?? 'high',
      // Images need stream-json input, which the CLI only accepts with stream-json output,
      // and that in print mode only with --verbose. The answer is the final `result` event.
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--system-prompt', req.system.map(b => b.text).join('\n\n'),
      '--json-schema', JSON.stringify(req.output_config.format.schema),
    ];
    const p = spawn(bin, args, { env, signal, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { done(); reject(new Error(hide(e.message))); });
    p.on('close', () => {
      done();
      const r = finalResult(out);
      if (!r) return reject(new Error(hide(`claude: ${(err || out).slice(0, 300)}`)));
      if (r.structured_output == null) return reject(new Error(hide(`claude: ${String(r.result ?? r.subtype ?? 'no output').slice(0, 300)}`)));
      resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(r.structured_output) }] });
    });
    p.stdin.on('error', () => {}); // the close handler reports a child that died early
    p.stdin.end(JSON.stringify({ type: 'user', message: req.messages[0], parent_tool_use_id: null }) + '\n');
  });
  return { beta: { messages: { create } } };
}
