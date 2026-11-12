#!/usr/bin/env node
// dev-team-kit statusLine: 플랜 사용량(rate_limits) 수집
//
// Claude Code statusLine 명령으로 실행된다. stdin JSON의 rate_limits(구독 계정만 있음)에서
// five_hour·seven_day의 used_percentage·resets_at만 골라 관찰 서버로 보낸다.
// - 기존 statusLine 명령이 있으면 같은 stdin으로 실행해 그 출력을 그대로 보여 준다(2초 제한).
// - 작업 중일 때만 동작한다. 세션마다 stdin 지문을 직전 실행과 비교해 같으면 "멈춤": 감싼 명령을
//   실행하지 않고 직전 출력을 그대로 보여 주며 보내지 않는다. 바뀌면 바로 재개한다.
// - 전송은 값이 바뀌었을 때만, 같은 PC에서 최대 1분에 1회. 값이 같으면 다시 보내지 않는다.
// - 전송은 분리된 자식 프로세스가 한다. 출력은 전송을 기다리지 않는다.
// - 작업 폴더, 세션 ID, transcript 경로, 모델, 비용은 보내지 않는다.
// - 어떤 경우에도 exit 0.
//
// 환경 변수: observe.mjs와 같다.
//   AGENT_OBSERVER_URL, AGENT_OBSERVER_TOKEN, AGENT_OBSERVER_DISABLE, AGENT_OBSERVER_DEBUG
//   (DEBUG=1이면 받은 stdin을 tmpdir의 statusline-stdin-<세션 키>.log에도 덧붙인다. 진단 전용)
//   AGENT_OBSERVER_STATUSLINE_INNER  감싼 명령을 실행할 때 내부적으로 붙인다(자기 자신 재실행 방지)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SELF_MARK = '/.claude/team/observe/statusline.mjs';
export const WRAP_TIMEOUT_MS = 2000;
export const MIN_INTERVAL_MS = 60_000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;
// 한가한 동안에도 바뀌는 stdin 필드. 지문에서 뺀다.
// Claude Code 2.1.322에서 확인: 한가할 때 바뀌는 것은 세션 경과 시간뿐이었다.
export const FINGERPRINT_IGNORE = [['cost', 'total_duration_ms']];
const STDIN_LIMIT = 64 * 1024;
const STDIN_WAIT_MS = 1000;
const LOCK_STALE_MS = 10_000;
const WINDOWS = ['five_hour', 'seven_day'];

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);

// ---------- pure functions ----------

/** { five_hour?: {used_percentage, resets_at}, seven_day?: {...} } — invalid windows are treated as absent. */
export function extractRateLimits(input) {
  const out = {};
  const rl = input && typeof input === 'object' ? input.rate_limits : null;
  if (!rl || typeof rl !== 'object') return out;
  for (const w of WINDOWS) {
    const v = rl[w];
    if (!v || typeof v !== 'object') continue;
    const pct = v.used_percentage;
    const reset = v.resets_at;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) continue;
    if (!Number.isInteger(reset) || reset <= 0) continue;
    out[w] = { used_percentage: pct, resets_at: reset };
  }
  return out;
}

/**
 * Whether to send now: only when a value changed, at most once per minIntervalMs. No periodic resend.
 * state = { lastSentAt: ms, lastSent: {window: {used_percentage, resets_at}} } | null
 */
export function decideSend(state, current, nowMs, { minIntervalMs = MIN_INTERVAL_MS } = {}) {
  if (!current || Object.keys(current).length === 0) return false;
  let elapsed = state && Number.isFinite(state.lastSentAt) ? nowMs - state.lastSentAt : Infinity;
  if (elapsed < 0) elapsed = Infinity; // clock went backwards
  if (elapsed < minIntervalMs) return false;
  const last = (state && state.lastSent) || {};
  const changed = !state || Object.entries(current).some(([w, v]) =>
    !last[w] || last[w].used_percentage !== v.used_percentage || last[w].resets_at !== v.resets_at);
  return changed;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** File-name-safe key per Claude Code session: session_id if present, otherwise the working folder. */
export function sessionKeyOf(input, cwd = process.cwd()) {
  const sid = input && typeof input === 'object' ? input.session_id : null;
  if (typeof sid === 'string' && sid.length >= 1 && sid.length <= 256) return 's-' + sha256(sid).slice(0, 32);
  return 'c-' + sha256(String(cwd)).slice(0, 32);
}

function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

/**
 * Fingerprint compared between runs of the same session. JSON input is normalized (sorted keys) with
 * FINGERPRINT_IGNORE fields removed; anything else is hashed as is.
 */
export function inputFingerprint(raw) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return sha256('raw:' + raw); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return sha256('raw:' + raw);
  for (const keys of FINGERPRINT_IGNORE) {
    let o = obj;
    for (let i = 0; i < keys.length - 1 && o && typeof o === 'object'; i++) o = o[keys[i]];
    if (o && typeof o === 'object') delete o[keys[keys.length - 1]];
  }
  return sha256('json:' + canonical(obj));
}

/** Default one-line output: "5h 42% · 7d 13%", only present windows, empty line if none. */
export function formatDefault(current) {
  const parts = [];
  if (current && current.five_hour) parts.push(`5h ${Math.round(current.five_hour.used_percentage)}%`);
  if (current && current.seven_day) parts.push(`7d ${Math.round(current.seven_day.used_percentage)}%`);
  return parts.join(' · ') + '\n';
}

/** Request body. Built from scratch so nothing else from stdin can leak in. */
export function buildBody(current, env = process.env, now = new Date()) {
  const rate_limits = {};
  for (const w of WINDOWS) {
    if (current[w]) rate_limits[w] = { used_percentage: current[w].used_percentage, resets_at: current[w].resets_at };
  }
  return { v: 1, ts: now.toISOString(), remote: env.CLAUDE_CODE_REMOTE === 'true', rate_limits };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function commandOf(statusLine) {
  if (!statusLine || typeof statusLine !== 'object') return null;
  if (statusLine.type !== 'command' || typeof statusLine.command !== 'string' || !statusLine.command.trim()) return null;
  return statusLine.command;
}

/**
 * Which existing statusLine command to wrap, or null.
 * 1) INNER run → none  2) statusline.json next to this script  3) user settings statusLine
 * A candidate that runs this script is skipped.
 */
export function resolveWrapCommand(env = process.env, scriptDir = SCRIPT_DIR) {
  if (env.AGENT_OBSERVER_STATUSLINE_INNER === '1') return null;
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
  const candidates = [
    () => commandOf(readJson(path.join(scriptDir, 'statusline.json'))?.wrap),
    () => commandOf(readJson(path.join(configDir, 'settings.json'))?.statusLine),
  ];
  for (const get of candidates) {
    const cmd = get();
    if (cmd && !cmd.replace(/\\/g, '/').includes(SELF_MARK)) return cmd;
  }
  return null;
}

// ---------- stdin ----------

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, STDIN_WAIT_MS);
    if (process.stdin.isTTY) return finish();
    process.stdin.on('data', (c) => {
      if (size < STDIN_LIMIT) { chunks.push(c.subarray(0, STDIN_LIMIT - size)); size += c.length; }
      if (size >= STDIN_LIMIT) finish();
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// ---------- wrapped command ----------

/** Run the wrapped command with the same stdin. Resolves to its stdout, or null on failure/timeout. */
export function runWrapped(command, raw, env, timeoutMs = WRAP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let child;
    const posix = process.platform !== 'win32';
    try {
      child = spawn(command, {
        // Claude Code runs statusLine through bash (Git Bash on Windows). Prefer the same shell.
        shell: posix ? '/bin/sh' : (env.SHELL || true),
        cwd: process.cwd(),
        env: { ...env, AGENT_OBSERVER_STATUSLINE_INNER: '1' },
        detached: posix,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch { return resolve(null); }
    const out = [];
    let size = 0;
    let settled = false;
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const timer = setTimeout(() => {
      try { posix ? process.kill(-child.pid, 'SIGKILL') : child.kill(); } catch { /* ignore */ }
      settle(null);
    }, timeoutMs);
    child.on('error', () => settle(null));
    child.stdout.on('data', (c) => { if (size < STDIN_LIMIT) { out.push(c); size += c.length; } });
    child.on('close', (code) => settle(code === 0 ? Buffer.concat(out).toString('utf8') : null));
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
  });
}

// ---------- send decision with shared state ----------

function stateDir(env) {
  return path.join(env.TMPDIR || os.tmpdir(), 'dev-team-kit-observe');
}

function sessionsDir(env) {
  return path.join(stateDir(env), 'statusline-sessions');
}

/** { fp, output } of the previous run of this session, or null. */
export function readSession(key, env = process.env) {
  const s = readJson(path.join(sessionsDir(env), key + '.json'));
  if (!s || typeof s.fp !== 'string' || typeof s.output !== 'string') return null;
  return s;
}

/** Store only the fingerprint and the printed output (never the stdin). Failures are ignored. */
export function saveSession(key, fp, output, env = process.env, nowMs = Date.now()) {
  try {
    const dir = sessionsDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, key + '.json');
    const body = JSON.stringify({ v: 1, fp, output: output.slice(0, STDIN_LIMIT), at: nowMs });
    fs.writeFileSync(file + '.tmp', body, { mode: 0o600 });
    fs.chmodSync(file + '.tmp', 0o600);
    fs.renameSync(file + '.tmp', file);
    pruneSessions(dir, key, nowMs);
  } catch { /* next run simply resumes again */ }
}

/** Delete other sessions' files older than 24h, at most once an hour. */
export function pruneSessions(dir, keepKey, nowMs = Date.now()) {
  const marker = path.join(dir, '.last-prune');
  try {
    if (nowMs - fs.statSync(marker).mtimeMs < PRUNE_EVERY_MS) return;
  } catch { /* no marker yet */ }
  try { fs.writeFileSync(marker, ''); } catch { return; }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.endsWith('.json') || name === keepKey + '.json') continue;
    const f = path.join(dir, name);
    try { if (nowMs - fs.statSync(f).mtimeMs > SESSION_TTL_MS) fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}

function debugLogStdin(key, raw, env) {
  try {
    const dir = stateDir(env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, `statusline-stdin-${key}.log`),
      JSON.stringify({ t: new Date().toISOString(), raw }) + '\n', { mode: 0o600 });
  } catch { /* ignore */ }
}

function tryLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.closeSync(fs.openSync(lockFile, 'wx'));
      return true;
    } catch {
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs < LOCK_STALE_MS) return false;
        fs.rmSync(lockFile, { force: true });
      } catch { return false; }
    }
  }
  return false;
}

/** Decide under a lock and record the send before it happens. Returns true if the caller should send. */
export function claimSend(current, env = process.env, nowMs = Date.now()) {
  const dir = stateDir(env);
  const stateFile = path.join(dir, 'plan-usage.json');
  if (!decideSend(readJson(stateFile), current, nowMs)) return false;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return false; }
  const lockFile = path.join(dir, 'plan-usage.lock');
  if (!tryLock(lockFile)) return false;
  try {
    if (!decideSend(readJson(stateFile), current, nowMs)) return false;
    const next = { v: 1, lastSentAt: nowMs, lastSent: current };
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(next));
    fs.renameSync(stateFile + '.tmp', stateFile);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
  }
}

function spawnSender(body, env) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [SCRIPT_PATH, '--send'], {
        detached: true, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env,
      });
    } catch { return resolve(); }
    child.on('error', () => {});
    const timer = setTimeout(done, 200);
    function done() { clearTimeout(timer); try { child.unref(); } catch { /* ignore */ } resolve(); }
    child.stdin.on('error', done);
    child.stdin.end(body, done);
  });
}

// ---------- send (keep identical to observe.mjs send/fetchFallback) ----------

function send(url, token, body) {
  return new Promise((resolve) => {
    const args = ['-sS', '-m', '5', '-o', '/dev/null', '-X', 'POST', '-H', 'Content-Type: application/json'];
    if (token) args.push('-H', `Authorization: Bearer ${token}`);
    args.push('--data-binary', '@-', url);
    let child;
    try {
      // curl follows HTTPS_PROXY, which cloud sessions require
      child = spawn('curl', args, { stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      return resolve(fetchFallback(url, token, body));
    }
    child.on('error', () => resolve(fetchFallback(url, token, body)));
    child.on('close', () => resolve());
    child.stdin.end(body);
  });
}

async function fetchFallback(url, token, body) {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body,
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* ignore */ }
}

async function senderMain(env) {
  const base = (env.AGENT_OBSERVER_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  await send(`${base}/api/plan-usage/report`, env.AGENT_OBSERVER_TOKEN || '', Buffer.concat(chunks).toString('utf8'));
}

// ---------- main ----------

export async function main(env = process.env) {
  const raw = await readStdin();
  let input = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed;
  } catch { /* not JSON */ }
  const current = extractRateLimits(input);
  const inner = env.AGENT_OBSERVER_STATUSLINE_INNER === '1';

  // 1a. pause while idle: same stdin as this session's last run → reprint, no wrapped command, no send
  let key = null;
  let fp = null;
  if (!inner) {
    try {
      key = sessionKeyOf(input);
      if (env.AGENT_OBSERVER_DEBUG === '1') debugLogStdin(key, raw, env);
      fp = inputFingerprint(raw);
      const prev = readSession(key, env);
      if (prev && prev.fp === fp) {
        await new Promise((resolve) => process.stdout.write(prev.output, resolve));
        return;
      }
    } catch { key = null; }
  }

  const wrapCmd = resolveWrapCommand(env);
  const wrapped = wrapCmd ? runWrapped(wrapCmd, raw, env) : Promise.resolve(null);

  try {
    const base = (env.AGENT_OBSERVER_URL || '').replace(/\/+$/, '');
    if (!inner && env.AGENT_OBSERVER_DISABLE !== '1' && base && Object.keys(current).length && claimSend(current, env)) {
      const body = JSON.stringify(buildBody(current, env));
      if (env.AGENT_OBSERVER_DEBUG === '1') process.stderr.write(body + '\n');
      await spawnSender(body, env);
    }
  } catch { /* ignore */ }

  const out = await wrapped;
  const text = out !== null ? out : formatDefault(current);
  // wait for the write to flush before process.exit
  await new Promise((resolve) => process.stdout.write(text, resolve));
  if (key && fp) saveSession(key, fp, text, env);
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const run = process.argv[2] === '--send' ? senderMain : main;
  run(process.env).catch(() => {}).finally(() => process.exit(0));
}
