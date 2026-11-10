#!/usr/bin/env node
// dev-team-kit observe hook
//
// Claude Code hook 입력(JSON, stdin)을 받아 관찰 서버(agent-observer)로 요약 이벤트를 보낸다.
// - AGENT_OBSERVER_URL 이 없으면 아무것도 하지 않는다.
// - 프롬프트, 메시지 본문, 도구 입력 내용은 보내지 않는다. 도구 이름, 스킬 이름,
//   호출한 서브에이전트 종류, 토큰 합계만 보낸다.
// - 어떤 오류가 나도 exit 0 으로 끝나 Claude Code 작업을 막지 않는다.
//
// 환경 변수
//   AGENT_OBSERVER_URL      관찰 서버 주소 (예: https://agent-observer.vercel.app)
//   AGENT_OBSERVER_TOKEN    로컬용 인증 토큰. 클라우드에서는 Network secret이 대신 붙으므로 비워 둔다.
//   AGENT_OBSERVER_DISABLE  1 이면 비활성화
//   AGENT_OBSERVER_DEBUG    1 이면 보낼 내용을 stderr에 출력

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PAYLOAD_VERSION = 1;
const USAGE_EVENTS = new Set(['PostToolUse', 'Stop', 'SubagentStop', 'SessionEnd']);
const STATE_DIR = path.join(os.tmpdir(), 'dev-team-kit-observe');

// ---------- transcript usage (incremental) ----------

function emptyTotals() {
  return { input: 0, output: 0, cache_creation: 0, cache_read: 0, model: null, messages: 0 };
}

function addUsage(totals, usage, model) {
  totals.input += usage.input_tokens || 0;
  totals.output += usage.output_tokens || 0;
  totals.cache_creation += usage.cache_creation_input_tokens || 0;
  totals.cache_read += usage.cache_read_input_tokens || 0;
  if (model) totals.model = model;
  totals.messages += 1;
}

/**
 * Sum assistant-message usage in a transcript JSONL, continuing from saved state.
 * One API message can be written as several lines with the same message.id; only the
 * last line of each id is counted.
 * @param {string} file
 * @param {{offset:number, totals:object, pendingId:string|null, pendingUsage:object|null, pendingModel:string|null}|null} state
 * @param {{skipSidechain:boolean}} opts
 */
export function readUsage(file, state, { skipSidechain }) {
  const st = state && state.file === file ? state : {
    file, offset: 0, totals: emptyTotals(), pendingId: null, pendingUsage: null, pendingModel: null,
  };
  let size;
  try { size = fs.statSync(file).size; } catch { return st; }
  if (size < st.offset) {
    // file was rewritten; start over
    Object.assign(st, { offset: 0, totals: emptyTotals(), pendingId: null, pendingUsage: null, pendingModel: null });
  }
  if (size === st.offset) return st;

  const fd = fs.openSync(file, 'r');
  let text;
  try {
    const buf = Buffer.alloc(size - st.offset);
    fs.readSync(fd, buf, 0, buf.length, st.offset);
    text = buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  // only consume complete lines
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return st;
  const chunk = text.slice(0, lastNl);
  st.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');

  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type !== 'assistant' || !rec.message || !rec.message.usage) continue;
    if (skipSidechain && rec.isSidechain) continue;
    const id = rec.message.id || rec.uuid || null;
    if (st.pendingId !== null && id !== st.pendingId) {
      addUsage(st.totals, st.pendingUsage, st.pendingModel);
    }
    st.pendingId = id;
    st.pendingUsage = rec.message.usage;
    st.pendingModel = rec.message.model || null;
  }
  return st;
}

/** Totals including the last (pending) message. */
export function currentTotals(st) {
  const t = { ...st.totals };
  if (st.pendingId !== null && st.pendingUsage) addUsage(t, st.pendingUsage, st.pendingModel);
  return t;
}

/** Locate the transcript that belongs to this hook's agent. Returns null when unsure. */
export function resolveTranscript(input) {
  if (!input.agent_id) return input.transcript_path || null;
  if (input.agent_transcript_path) return input.agent_transcript_path;
  if (!input.transcript_path) return null;
  const dir = path.dirname(input.transcript_path);
  const candidates = [
    path.join(dir, input.session_id || '', 'subagents', `agent-${input.agent_id}.jsonl`),
    path.join(dir, `agent-${input.agent_id}.jsonl`),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ---------- state ----------

function stateFile(key) {
  return path.join(STATE_DIR, createHash('sha1').update(key).digest('hex') + '.json');
}

function loadState(key) {
  try { return JSON.parse(fs.readFileSync(stateFile(key), 'utf8')); } catch { return null; }
}

function saveState(key, value) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const f = stateFile(key);
    fs.writeFileSync(f + '.tmp', JSON.stringify(value));
    fs.renameSync(f + '.tmp', f);
  } catch { /* ignore */ }
}

// ---------- project info ----------

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).toString().trim();
  } catch { return null; }
}

/** "owner/repo" from a git remote URL, or null. */
export function repoFromRemote(url) {
  if (!url) return null;
  const m = url.replace(/\.git$/, '').match(/[:/]([^/:]+\/[^/]+)$/);
  return m ? m[1] : null;
}

function projectInfo(input) {
  const key = `project:${input.session_id}`;
  const cached = loadState(key);
  if (cached && input.hook_event_name !== 'SessionStart') return cached;
  const cwd = input.cwd || process.cwd();
  const info = {
    project: repoFromRemote(git(cwd, ['config', '--get', 'remote.origin.url'])) || path.basename(cwd),
    branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
  };
  saveState(key, info);
  return info;
}

// ---------- payload ----------

function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) if (typeof obj[k] === 'string' && obj[k]) return obj[k].slice(0, 120);
  return null;
}

/** Build the event sent to the observer. Pure except for the optional usage argument. */
export function buildPayload(input, { project, branch }, usage, env = process.env) {
  const event = input.hook_event_name;
  const p = {
    v: PAYLOAD_VERSION,
    event,
    ts: new Date().toISOString(),
    session_id: input.session_id || null,
    agent_id: input.agent_id || null,
    agent_type: input.agent_type || null,
    project,
    branch,
    remote: env.CLAUDE_CODE_REMOTE === 'true',
    remote_session_id: env.CLAUDE_CODE_REMOTE_SESSION_ID || null,
  };
  if (input.tool_name) p.tool = input.tool_name;
  if (input.tool_name === 'Skill') p.skill = pickString(input.tool_input, ['skill', 'name', 'command']);
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') {
    p.subagent_type = pickString(input.tool_input, ['subagent_type', 'agent_type']);
  }
  if (event === 'UserPromptExpansion') p.command = pickString(input, ['command_name']);
  if (event === 'Notification') p.notification_type = input.notification_type || null;
  if (event === 'SessionStart') { p.source = input.source || null; p.model = input.model || null; }
  if (event === 'SessionEnd') p.reason = input.reason || null;
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    // these fire in the parent context but describe the subagent
    p.agent_id = input.agent_id || null;
    p.agent_type = input.agent_type || null;
  }
  if (usage) p.usage = usage;
  return p;
}

function usageOf(file, skipSidechain) {
  const key = `usage:${file}`;
  const st = readUsage(file, loadState(key), { skipSidechain });
  saveState(key, st);
  return currentTotals(st);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function computeUsage(input) {
  if (!USAGE_EVENTS.has(input.hook_event_name)) return null;
  // SubagentStop can fire before the subagent transcript is flushed. The hook runs async,
  // so waiting briefly costs nothing.
  if (input.hook_event_name === 'SubagentStop') await sleep(1500);
  const file = resolveTranscript(input);
  if (!file) return null;
  return usageOf(file, !input.agent_id);
}

/**
 * When the parent's Agent tool call returns, the subagent transcript is complete.
 * Report that subagent's totals so the observer does not depend on SubagentStop timing.
 */
function computeSubagentUsage(input) {
  if (input.hook_event_name !== 'PostToolUse' || !['Agent', 'Task'].includes(input.tool_name)) return null;
  const r = input.tool_response;
  if (!r || typeof r !== 'object' || !r.agentId) return null;
  const file = resolveTranscript({ ...input, agent_id: r.agentId, agent_transcript_path: null });
  if (!file) return null;
  return {
    agent_id: String(r.agentId),
    agent_type: typeof r.agentType === 'string' ? r.agentType : null,
    status: typeof r.status === 'string' ? r.status : null,
    usage: usageOf(file, false),
  };
}

// ---------- send ----------

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

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(env = process.env) {
  if (env.AGENT_OBSERVER_DISABLE === '1') return;
  const base = (env.AGENT_OBSERVER_URL || '').replace(/\/+$/, '');
  if (!base) return;
  const input = JSON.parse(await readStdin());
  if (!input.hook_event_name) return;
  const payload = buildPayload(input, projectInfo(input), await computeUsage(input), env);
  const sub = computeSubagentUsage(input);
  if (sub) payload.subagent = sub;
  const body = JSON.stringify(payload);
  if (env.AGENT_OBSERVER_DEBUG === '1') process.stderr.write(body + '\n');
  await send(`${base}/api/events`, env.AGENT_OBSERVER_TOKEN || '', body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {}).finally(() => process.exit(0));
}
