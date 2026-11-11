import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  extractRateLimits, decideSend, formatDefault, resolveWrapCommand, buildBody, runWrapped,
} from '../kit/team/observe/statusline.mjs';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit/team/observe/statusline.mjs');
const posixOnly = { skip: process.platform === 'win32' ? 'uses POSIX shell commands' : false };

const w = (p, r) => ({ used_percentage: p, resets_at: r });
const RL = { five_hour: w(42, 1794398400), seven_day: w(13, 1794700800) };
const stdinWith = (rate_limits, extra = {}) => JSON.stringify({
  session_id: 'sess-secret', cwd: '/home/me/secret-project', transcript_path: '/home/me/t.jsonl',
  model: { id: 'claude-x', display_name: 'X' }, cost: { total_cost_usd: 1.23 }, workspace: { project_dir: '/home/me/secret-project' },
  ...(rate_limits ? { rate_limits } : {}), ...extra,
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-slt-')); }

// ---------- pure ----------

test('extractRateLimits keeps only valid five_hour/seven_day windows', () => {
  assert.deepEqual(extractRateLimits({ rate_limits: RL }), RL);
  assert.deepEqual(extractRateLimits({ rate_limits: { seven_day: w(13, 1794700800) } }), { seven_day: w(13, 1794700800) });
  assert.deepEqual(extractRateLimits({ rate_limits: { spend_limit: w(10, 1794700800) } }), {});
  assert.deepEqual(extractRateLimits({ rate_limits: { five_hour: w(101, 1), seven_day: w(-1, 1) } }), {});
  assert.deepEqual(extractRateLimits({ rate_limits: { five_hour: w('42', 1), seven_day: w(5, 1.5) } }), {});
  assert.deepEqual(extractRateLimits({ rate_limits: { five_hour: w(23.5, 1794398400), seven_day: null } }), { five_hour: w(23.5, 1794398400) });
  assert.deepEqual(extractRateLimits(null), {});
  assert.deepEqual(extractRateLimits({}), {});
});

test('decideSend: first, 1-minute limit, change, 10-minute resend, clock going back', () => {
  const t0 = 1_000_000_000;
  const cur = { five_hour: w(42, 100) };
  const st = { lastSentAt: t0, lastSent: cur };
  assert.equal(decideSend(null, cur, t0), true, 'first send');
  assert.equal(decideSend(null, {}, t0), false, 'nothing to send');
  assert.equal(decideSend(st, cur, t0 + 30_000), false, 'same value within 1 min');
  assert.equal(decideSend(st, { five_hour: w(43, 100) }, t0 + 59_999), false, 'changed within 1 min');
  assert.equal(decideSend(st, { five_hour: w(43, 100) }, t0 + 60_000), true, 'changed after 1 min');
  assert.equal(decideSend(st, { five_hour: w(42, 200) }, t0 + 61_000), true, 'resets_at changed');
  assert.equal(decideSend(st, { five_hour: w(42, 100), seven_day: w(1, 9) }, t0 + 61_000), true, 'new window');
  assert.equal(decideSend(st, cur, t0 + 61_000), false, 'same after 1 min');
  assert.equal(decideSend(st, cur, t0 + 599_999), false, 'same just before 10 min');
  assert.equal(decideSend(st, cur, t0 + 600_000), true, 'same after 10 min');
  assert.equal(decideSend({ lastSentAt: t0, lastSent: { five_hour: w(42, 100), seven_day: w(1, 9) } }, cur, t0 + 61_000), false,
    'a window that disappeared is not a change');
  assert.equal(decideSend(st, cur, t0 - 5_000), true, 'clock went backwards → treat as long ago');
});

test('formatDefault', () => {
  assert.equal(formatDefault(RL), '5h 42% · 7d 13%\n');
  assert.equal(formatDefault({ seven_day: w(12.6, 1) }), '7d 13%\n');
  assert.equal(formatDefault({}), '\n');
});

test('buildBody has exactly v, ts, remote, rate_limits', () => {
  const b = buildBody(RL, { CLAUDE_CODE_REMOTE: 'true' }, new Date('2026-11-11T10:00:01.234Z'));
  assert.deepEqual(Object.keys(b).sort(), ['rate_limits', 'remote', 'ts', 'v']);
  assert.deepEqual(b, { v: 1, ts: '2026-11-11T10:00:01.234Z', remote: true, rate_limits: RL });
});

test('resolveWrapCommand: INNER, statusline.json, user settings, self excluded', () => {
  const dir = tmp();
  const scriptDir = path.join(dir, 'observe');
  const cfg = path.join(dir, 'cfg');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(cfg);
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.equal(resolveWrapCommand(env, scriptDir), null);
  fs.writeFileSync(path.join(cfg, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user' } }));
  assert.equal(resolveWrapCommand(env, scriptDir), 'echo user');
  fs.writeFileSync(path.join(scriptDir, 'statusline.json'), JSON.stringify({ v: 1, wrap: { type: 'command', command: 'echo saved' } }));
  assert.equal(resolveWrapCommand(env, scriptDir), 'echo saved');
  assert.equal(resolveWrapCommand({ ...env, AGENT_OBSERVER_STATUSLINE_INNER: '1' }, scriptDir), null);
  fs.writeFileSync(path.join(scriptDir, 'statusline.json'),
    JSON.stringify({ v: 1, wrap: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/team/observe/statusline.mjs"' } }));
  assert.equal(resolveWrapCommand(env, scriptDir), 'echo user', 'self is skipped, next candidate used');
  fs.writeFileSync(path.join(cfg, 'settings.json'),
    JSON.stringify({ statusLine: { type: 'command', command: 'node C:\\p\\.claude\\team\\observe\\statusline.mjs' } }));
  assert.equal(resolveWrapCommand(env, scriptDir), null, 'Windows-style self path is skipped too');
});

test('runWrapped: passes stdin, output unchanged, failure and timeout give null', posixOnly, async () => {
  assert.equal(await runWrapped('cat; printf "\\033[1mX\\033[0m  \\n"', 'IN-', process.env), 'IN-\x1b[1mX\x1b[0m  \n');
  assert.equal(await runWrapped('echo $AGENT_OBSERVER_STATUSLINE_INNER', '', process.env), '1\n');
  assert.equal(await runWrapped('echo out; exit 3', '', process.env), null);
  const t = Date.now();
  assert.equal(await runWrapped('sleep 5; echo late', '', process.env, 300), null);
  assert.ok(Date.now() - t < 2000);
  assert.equal(await runWrapped('definitely-not-a-command-xyz', '', process.env), null);
});

// ---------- end to end (installed layout: script + optional statusline.json) ----------

function layout({ wrap } = {}) {
  const dir = tmp();
  const obs = path.join(dir, 'proj', '.claude', 'team', 'observe');
  fs.mkdirSync(obs, { recursive: true });
  fs.copyFileSync(SRC, path.join(obs, 'statusline.mjs'));
  if (wrap) fs.writeFileSync(path.join(obs, 'statusline.json'), JSON.stringify({ v: 1, wrap: { type: 'command', command: wrap } }));
  fs.mkdirSync(path.join(dir, 'tmp'));
  fs.mkdirSync(path.join(dir, 'home'));
  return { dir, script: path.join(obs, 'statusline.mjs'), state: path.join(dir, 'tmp', 'dev-team-kit-observe', 'plan-usage.json') };
}

function receiver({ respond = true } = {}) {
  const got = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) });
      if (respond) res.end('ok');
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    got, url: `http://127.0.0.1:${server.address().port}`,
    close: () => { for (const s of sockets) s.destroy(); server.close(); },
  })));
}

function run(L, input, env = {}) {
  return new Promise((resolve) => {
    const t = Date.now();
    const c = spawn(process.execPath, [L.script], {
      cwd: path.dirname(L.script),
      env: {
        PATH: process.env.PATH, TMPDIR: path.join(L.dir, 'tmp'), HOME: path.join(L.dir, 'home'),
        CLAUDE_CONFIG_DIR: path.join(L.dir, 'home'), NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
        AGENT_OBSERVER_DEBUG: '1', ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t }));
    c.stdin.end(input);
  });
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); }
  return fn();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backdate = (L, ms) => {
  const s = JSON.parse(fs.readFileSync(L.state, 'utf8'));
  s.lastSentAt -= ms;
  fs.writeFileSync(L.state, JSON.stringify(s));
};

test('sends once, respects 1-minute limit, change and 10-minute resend; body has no stdin leftovers', async () => {
  const srv = await receiver();
  const L = layout();
  const env = { AGENT_OBSERVER_URL: srv.url + '/', AGENT_OBSERVER_TOKEN: 'tok' };
  try {
    let r = await run(L, stdinWith(RL), env);
    assert.equal(r.code, 0);
    assert.equal(r.out, '5h 42% · 7d 13%\n');
    assert.ok(await waitFor(() => srv.got.length === 1));
    const req = srv.got[0];
    assert.equal(req.url, '/api/plan-usage/report');
    assert.equal(req.auth, 'Bearer tok');
    assert.deepEqual(Object.keys(req.body).sort(), ['rate_limits', 'remote', 'ts', 'v']);
    assert.deepEqual(req.body.rate_limits, RL);
    for (const k of Object.keys(req.body.rate_limits)) assert.deepEqual(Object.keys(req.body.rate_limits[k]).sort(), ['resets_at', 'used_percentage']);
    const raw = JSON.stringify(req.body);
    for (const leak of ['secret', 'sess-', 't.jsonl', 'claude-x', '1.23']) assert.ok(!raw.includes(leak), leak);

    r = await run(L, stdinWith(RL), env); // same within 1 min
    assert.ok(!r.err.includes('"rate_limits"'));
    const changed = { ...RL, five_hour: w(50, 1794398400) };
    r = await run(L, stdinWith(changed), env); // changed within 1 min
    assert.ok(!r.err.includes('"rate_limits"'));
    await sleep(500);
    assert.equal(srv.got.length, 1);

    backdate(L, 61_000);
    r = await run(L, stdinWith(changed), env); // changed after 1 min
    assert.ok(await waitFor(() => srv.got.length === 2));
    assert.equal(srv.got[1].body.rate_limits.five_hour.used_percentage, 50);

    backdate(L, 61_000);
    await run(L, stdinWith(changed), env); // same after 1 min
    await sleep(500);
    assert.equal(srv.got.length, 2);

    backdate(L, 601_000);
    await run(L, stdinWith(changed), env); // same after 10 min
    assert.ok(await waitFor(() => srv.got.length === 3));
  } finally { srv.close(); }
});

test('no rate_limits, non-JSON, URL missing, DISABLE=1 → no send, default output, exit 0', async () => {
  const srv = await receiver();
  const env = { AGENT_OBSERVER_URL: srv.url };
  try {
    for (const [input, extra, out] of [
      [stdinWith(null), {}, '\n'],
      ['not json', {}, '\n'],
      [stdinWith(RL), { AGENT_OBSERVER_URL: '' }, '5h 42% · 7d 13%\n'],
      [stdinWith(RL), { AGENT_OBSERVER_DISABLE: '1' }, '5h 42% · 7d 13%\n'],
    ]) {
      const r = await run(layout(), input, { ...env, ...extra });
      assert.equal(r.code, 0);
      assert.equal(r.out, out);
      assert.ok(!r.err.includes('"rate_limits"'));
    }
    await sleep(500);
    assert.equal(srv.got.length, 0);
  } finally { srv.close(); }
});

test('seven_day only → only seven_day is sent', async () => {
  const srv = await receiver();
  try {
    const r = await run(layout(), stdinWith({ seven_day: w(13, 1794700800) }), { AGENT_OBSERVER_URL: srv.url });
    assert.equal(r.out, '7d 13%\n');
    assert.ok(await waitFor(() => srv.got.length === 1));
    assert.deepEqual(Object.keys(srv.got[0].body.rate_limits), ['seven_day']);
  } finally { srv.close(); }
});

test('a server that never responds does not delay output', async () => {
  const srv = await receiver({ respond: false });
  try {
    const r = await run(layout(), stdinWith(RL), { AGENT_OBSERVER_URL: srv.url });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 1000, `took ${r.ms}ms`);
    assert.ok(await waitFor(() => srv.got.length === 1));
  } finally { srv.close(); }
});

test('three concurrent runs with a changed value send at most once', async () => {
  const srv = await receiver();
  const L = layout();
  try {
    await Promise.all([1, 2, 3].map(() => run(L, stdinWith(RL), { AGENT_OBSERVER_URL: srv.url })));
    await sleep(1000);
    assert.equal(srv.got.length, 1);
  } finally { srv.close(); }
});

test('wrapping: output unchanged and sent; failure and timeout fall back; user settings; self', posixOnly, async () => {
  const srv = await receiver();
  const env = { AGENT_OBSERVER_URL: srv.url };
  try {
    let r = await run(layout({ wrap: "printf 'MY-LINE\\n'" }), stdinWith(RL), env);
    assert.equal(r.out, 'MY-LINE\n');
    assert.ok(await waitFor(() => srv.got.length === 1));

    r = await run(layout({ wrap: 'exit 3' }), stdinWith(RL), env);
    assert.equal(r.out, '5h 42% · 7d 13%\n');
    assert.ok(await waitFor(() => srv.got.length === 2), 'send still happens');

    r = await run(layout({ wrap: 'sleep 5' }), stdinWith(RL), env);
    assert.equal(r.code, 0);
    assert.equal(r.out, '5h 42% · 7d 13%\n');
    assert.ok(r.ms < 2500, `took ${r.ms}ms`);

    const L = layout();
    fs.writeFileSync(path.join(L.dir, 'home', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo FROM-USER' } }));
    r = await run(L, stdinWith(RL), env);
    assert.equal(r.out, 'FROM-USER\n');

    const S = layout({ wrap: `node "${'$'}{CLAUDE_PROJECT_DIR:-.}/.claude/team/observe/statusline.mjs"` });
    r = await run(S, stdinWith(RL), env);
    assert.equal(r.code, 0);
    assert.equal(r.out, '5h 42% · 7d 13%\n');
  } finally { srv.close(); }
});
