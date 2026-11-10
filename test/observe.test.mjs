import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUsage, currentTotals, buildPayload, repoFromRemote, resolveTranscript } from '../kit/team/observe/observe.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit/team/observe/observe.mjs');

const line = (o) => JSON.stringify(o) + '\n';
const asst = (id, usage, extra = {}) => line({ type: 'assistant', message: { id, model: 'claude-x', usage }, ...extra });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-obs-')); }

test('readUsage counts each message id once (last line wins) and skips sidechain', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f,
    line({ type: 'user', message: { content: 'hi' } }) +
    asst('m1', { input_tokens: 10, output_tokens: 1 }) +
    asst('m1', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }) +
    asst('s1', { input_tokens: 999, output_tokens: 999 }, { isSidechain: true }) +
    asst('m2', { input_tokens: 20, output_tokens: 2 }));
  const t = currentTotals(readUsage(f, null, { skipSidechain: true }));
  assert.deepEqual(t, { input: 30, output: 7, cache_creation: 0, cache_read: 100, model: 'claude-x', messages: 2 });
});

test('readUsage is incremental and ignores a partial last line', () => {
  const f = path.join(tmp(), 't.jsonl');
  fs.writeFileSync(f, asst('m1', { input_tokens: 1, output_tokens: 1 }) + '{"type":"assis');
  let st = readUsage(f, null, { skipSidechain: false });
  assert.equal(currentTotals(st).messages, 1);
  fs.writeFileSync(f, asst('m1', { input_tokens: 1, output_tokens: 1 }) +
    asst('m2', { input_tokens: 2, output_tokens: 2 }) + asst('m3', { input_tokens: 3, output_tokens: 3 }));
  st = readUsage(f, JSON.parse(JSON.stringify(st)), { skipSidechain: false });
  const t = currentTotals(st);
  assert.equal(t.input, 6);
  assert.equal(t.messages, 3);
});

test('resolveTranscript finds the subagent file and refuses to guess', () => {
  const dir = tmp();
  const main = path.join(dir, 'sess.jsonl');
  fs.writeFileSync(main, '');
  assert.equal(resolveTranscript({ transcript_path: main }), main);
  assert.equal(resolveTranscript({ transcript_path: main, session_id: 'sess', agent_id: 'a1' }), null);
  const sub = path.join(dir, 'sess', 'subagents', 'agent-a1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, '');
  assert.equal(resolveTranscript({ transcript_path: main, session_id: 'sess', agent_id: 'a1' }), sub);
});

test('repoFromRemote', () => {
  assert.equal(repoFromRemote('https://github.com/winterairy/epub-editor.git'), 'winterairy/epub-editor');
  assert.equal(repoFromRemote('git@github.com:winterairy/epub-editor.git'), 'winterairy/epub-editor');
  assert.equal(repoFromRemote('http://127.0.0.1:1234/git/a/b'), 'a/b');
  assert.equal(repoFromRemote(null), null);
});

test('buildPayload sends names only, never prompts or tool input bodies', () => {
  const info = { project: 'o/r', branch: 'main' };
  const p = buildPayload({
    hook_event_name: 'PreToolUse', session_id: 's', agent_id: 'a', agent_type: 'qa',
    tool_name: 'Skill', tool_input: { skill: 'playwright-cli', args: 'secret stuff' },
    prompt: 'do not send',
  }, info, null, { CLAUDE_CODE_REMOTE: 'true' });
  assert.equal(p.skill, 'playwright-cli');
  assert.equal(p.agent_type, 'qa');
  assert.equal(p.remote, true);
  assert.ok(!JSON.stringify(p).includes('secret'));
  assert.ok(!JSON.stringify(p).includes('do not send'));

  const a = buildPayload({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Agent',
    tool_input: { subagent_type: 'developer', prompt: 'long instructions' } }, info, null, {});
  assert.equal(a.subagent_type, 'developer');
  assert.ok(!JSON.stringify(a).includes('long instructions'));
});

function run(env, input) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'ignore', 'pipe'] });
    c.on('close', (code) => resolve(code));
    c.stdin.end(JSON.stringify(input));
  });
}

test('script posts to the observer and always exits 0', async () => {
  const got = [];
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end('ok'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const dir = tmp();
  const transcript = path.join(dir, 's.jsonl');
  fs.writeFileSync(transcript, asst('m1', { input_tokens: 5, output_tokens: 7 }));

  const code = await run({ AGENT_OBSERVER_URL: url, AGENT_OBSERVER_TOKEN: 'tok', TMPDIR: dir },
    { hook_event_name: 'Stop', session_id: `s-${Date.now()}`, cwd: dir, transcript_path: transcript });
  assert.equal(code, 0);
  assert.equal(got.length, 1);
  assert.equal(got[0].url, '/api/events');
  assert.equal(got[0].auth, 'Bearer tok');
  assert.equal(got[0].body.usage.output, 7);

  // unreachable server and no URL both exit 0
  assert.equal(await run({ AGENT_OBSERVER_URL: 'http://127.0.0.1:1', TMPDIR: dir }, { hook_event_name: 'Stop', session_id: 'x' }), 0);
  assert.equal(await run({ TMPDIR: dir }, { hook_event_name: 'Stop', session_id: 'x' }), 0);
  server.close();
});
