#!/usr/bin/env node
// dev-team-kit guard: Bash 명령 안전장치 (PreToolUse hook)
//
// settings.json의 거부 규칙은 명령 문자열의 앞부분만 맞춰 보므로 `git push`(인자 없음, 지금 브랜치가 main),
// `git push origin HEAD:refs/heads/main`, `gh api -X PUT …/merge` 같은 형태를 놓친다. 이 hook은 명령을
// 단어로 나눠 실제로 무엇을 하려는지 보고, 아래를 막는다(exit 2 + 이유를 stderr로).
//   - 강제 push, --all/--mirror push, 태그 push
//   - 기본 브랜치(main, master, profile의 기본 브랜치)로의 push. 인자 없는 push는 지금 브랜치를 본다
//   - PR 병합·자동 병합, 릴리스 생성: gh 명령과 gh api(REST·GraphQL)
//   - 기본 브랜치·태그 ref를 API로 바꾸는 호출, 브랜치 지정 없는 contents API 쓰기
//   - 운영 배포·게시: vercel --prod/promote/rollback, npm·pnpm·yarn·bun publish, electron-builder --publish
//
// 사고를 줄이는 안전장치이지 보안 경계가 아니다. 스크립트 파일, 다른 언어, 다른 도구로 같은 일을 하는 것은
// 막지 못한다. 확인할 수 없는 경우(분석 오류, 현재 브랜치를 알 수 없음)에는 막지 않는다.
//
// 환경 변수: DEV_TEAM_KIT_GUARD=off  — 사용자가 Claude Code를 시작할 때 설정하면 이 hook이 아무것도 막지 않는다.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const REASONS = {
  force: '강제 push(--force, -f, --force-with-lease, +refspec)는 막혀 있습니다.',
  protectedBranch: (name) => `기본 브랜치(${name})로의 push는 막혀 있습니다. 작업 브랜치로 push하세요. 병합은 ★승인2 뒤 사용자가 합니다.`,
  all: '--all, --mirror, 와일드카드 refspec push는 기본 브랜치를 포함할 수 있어 막혀 있습니다. 브랜치를 하나씩 지정하세요.',
  tags: '태그 push는 릴리스를 시작할 수 있어 막혀 있습니다. ★승인2 뒤 사용자가 합니다.',
  merge: 'PR·브랜치 병합과 자동 병합 설정은 ★승인2 뒤 사용자가 직접 합니다.',
  release: '릴리스 생성·게시는 ★승인2 뒤 사용자가 직접 합니다.',
  ref: '기본 브랜치나 태그 ref를 API로 바꾸는 호출은 막혀 있습니다.',
  contents: '기본 브랜치에 직접 커밋하는 API 호출은 막혀 있습니다. branch 필드로 작업 브랜치를 지정하세요.',
  graphql: '병합·릴리스·ref 변경 GraphQL mutation은 ★승인2 뒤 사용자가 직접 합니다.',
  deploy: (what) => `${what}: 운영 배포·게시 명령은 막혀 있습니다. 명령을 문서에 적고 책임자를 통해 사용자 승인을 받으세요.`,
};

// ---------- shell-ish tokenizer ----------

function findClosingParen(s, from) {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j === -1) return s.length; i = j; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return s.length;
}

/**
 * Split a command into segments of words. Substitutions ($(…), `…`) are returned in `nested`
 * to be analyzed as commands of their own. Heredoc bodies and redirections are dropped.
 * @returns {{segments: string[][], nested: string[]}}
 */
export function tokenize(input) {
  const segments = [];
  const nested = [];
  const heredocs = [];
  let tokens = [];
  let cur = '';
  let started = false;
  const endToken = () => { if (started) tokens.push(cur); cur = ''; started = false; };
  const endSegment = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  const n = input.length;
  let i = 0;

  const skipWord = () => {
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i++;
    let word = '';
    while (i < n && !/[\s;|&()<>]/.test(input[i])) {
      const c = input[i];
      if (c === "'" || c === '"') {
        const j = input.indexOf(c, i + 1);
        const end = j === -1 ? n : j;
        word += input.slice(i + 1, end);
        i = end + 1;
      } else if (c === '\\' && i + 1 < n) { word += input[i + 1]; i += 2; } else { word += c; i++; }
    }
    return word;
  };

  while (i < n) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\r') { endToken(); i++; continue; }
    if (c === '\n') {
      endSegment(); i++;
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift();
        while (i < n) {
          let end = input.indexOf('\n', i);
          if (end === -1) end = n;
          let line = input.slice(i, end);
          i = Math.min(end + 1, n);
          if (strip) line = line.replace(/^\t+/, '');
          if (line === delim) break;
        }
      }
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') { endSegment(); i++; continue; }
    if (c === '#' && !started) { while (i < n && input[i] !== '\n') i++; continue; }
    if (c === '<' || c === '>') {
      if (c === '<' && input[i + 1] === '(') { endSegment(); i += 2; continue; } // process substitution
      if (started && /^\d+$/.test(cur)) { cur = ''; started = false; } // fd number before the operator
      else endToken();
      if (c === '<' && input[i + 1] === '<' && input[i + 2] !== '<') {
        i += 2;
        const strip = input[i] === '-';
        if (strip) i++;
        const delim = skipWord();
        if (delim) heredocs.push({ delim, strip });
        continue;
      }
      while (i < n && (input[i] === '<' || input[i] === '>' || input[i] === '|')) i++;
      if (input[i] === '&') { i++; while (i < n && /[\d-]/.test(input[i])) i++; continue; }
      skipWord();
      continue;
    }
    if (c === '$' && input[i + 1] === '(') {
      const end = findClosingParen(input, i + 2);
      nested.push(input.slice(i + 2, end));
      cur += '$SUBST'; started = true; i = end + 1; continue;
    }
    if (c === '`') {
      let j = input.indexOf('`', i + 1);
      if (j === -1) j = n;
      nested.push(input.slice(i + 1, j));
      cur += '$SUBST'; started = true; i = j + 1; continue;
    }
    if (c === "'") {
      const j = input.indexOf("'", i + 1);
      const end = j === -1 ? n : j;
      cur += input.slice(i + 1, end); started = true; i = end + 1; continue;
    }
    if (c === '"') {
      i++; started = true;
      while (i < n && input[i] !== '"') {
        const d = input[i];
        if (d === '\\' && i + 1 < n) { cur += input[i + 1]; i += 2; continue; }
        if (d === '$' && input[i + 1] === '(') {
          const end = findClosingParen(input, i + 2);
          nested.push(input.slice(i + 2, end)); cur += '$SUBST'; i = end + 1; continue;
        }
        if (d === '`') {
          let j = input.indexOf('`', i + 1);
          if (j === -1) j = n;
          nested.push(input.slice(i + 1, j)); cur += '$SUBST'; i = j + 1; continue;
        }
        cur += d; i++;
      }
      i++; continue;
    }
    if (c === '\\' && i + 1 < n) {
      if (input[i + 1] === '\n') { i += 2; continue; }
      cur += input[i + 1]; started = true; i += 2; continue;
    }
    cur += c; started = true; i++;
  }
  endSegment();
  return { segments, nested };
}

// ---------- command analysis ----------

const base = (t) => path.basename(String(t)).replace(/\.(exe|cmd)$/i, '');
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'doas', 'env', 'time', 'command', 'exec', 'nohup', 'nice', 'ionice', 'stdbuf', 'timeout', 'builtin', 'xargs']);
const WRAPPER_VALUE_OPTS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U'], doas: ['-u', '-C'], env: ['-u', '-C', '-S'],
  nice: ['-n'], ionice: ['-c', '-n', '-p'], timeout: ['-s', '-k'], xargs: ['-n', '-I', '-P', '-d', '-L', '-s', '-E', '-a'],
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PKG_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function unwrap(tokens) {
  const t = [...tokens];
  for (let guard = 0; guard < 8 && t.length; guard++) {
    if (ENV_ASSIGN.test(t[0])) { t.shift(); continue; }
    const name = base(t[0]);
    if (!WRAPPERS.has(name)) break;
    t.shift();
    const valueOpts = WRAPPER_VALUE_OPTS[name] || [];
    let durationDone = false;
    while (t.length) {
      if (t[0].startsWith('-') && t[0] !== '-' && t[0] !== '--') { const o = t.shift(); if (valueOpts.includes(o) && t.length) t.shift(); continue; }
      if (name === 'env' && ENV_ASSIGN.test(t[0])) { t.shift(); continue; }
      if (name === 'timeout' && !durationDone && /^[0-9.]+[smhd]?$/.test(t[0])) { durationDone = true; t.shift(); continue; }
      break;
    }
  }
  return t;
}

function checkGitPush(args, dir, ctx) {
  const flags = { force: false, all: false, mirror: false, tags: false };
  const pos = [];
  let repoOpt = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a : a.slice(0, eq);
      const hasValue = eq !== -1;
      if (k === '--force' || k === '--force-with-lease' || k === '--force-if-includes') flags.force = true;
      else if (k === '--all' || k === '--branches') flags.all = true;
      else if (k === '--mirror') flags.mirror = true;
      else if (k === '--tags' || k === '--follow-tags') flags.tags = true;
      else if (k === '--repo') { repoOpt = true; if (!hasValue) i++; }
      else if ((k === '--push-option' || k === '--receive-pack' || k === '--exec') && !hasValue) i++;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const cluster = a.slice(1);
      for (let j = 0; j < cluster.length; j++) {
        if (cluster[j] === 'f') flags.force = true;
        else if (cluster[j] === 'o') { if (j === cluster.length - 1) i++; break; }
      }
      continue;
    }
    pos.push(a);
  }
  if (flags.force) return REASONS.force;
  if (flags.all || flags.mirror) return REASONS.all;
  if (flags.tags) return REASONS.tags;

  const specs = repoOpt ? pos : pos.slice(1);
  if (specs.some((s) => s.startsWith('+'))) return REASONS.force;

  const protectedName = (name) => (name && ctx.protectedBranches.has(name) ? name : null);
  if (specs.length === 0) {
    const hit = protectedName(ctx.currentBranch(dir));
    return hit ? REASONS.protectedBranch(hit) : null;
  }
  for (const spec of specs) {
    const idx = spec.indexOf(':');
    const src = idx === -1 ? spec : spec.slice(0, idx);
    let dst = idx === -1 ? spec : spec.slice(idx + 1);
    if (dst.includes('*')) return REASONS.all;
    if (dst === 'HEAD' || dst === '@' || (idx === -1 && (src === 'HEAD' || src === '@'))) dst = ctx.currentBranch(dir) || '';
    if (dst.startsWith('refs/tags/')) return REASONS.tags;
    const hit = protectedName(dst.replace(/^refs\/heads\//, ''));
    if (hit) return REASONS.protectedBranch(hit);
  }
  return null;
}

function parseGhApi(args) {
  let method = null;
  let hasInput = false;
  let endpoint = null;
  const fields = {};
  const valueOpts = new Set(['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    let v;
    if (a.startsWith('--') && a.includes('=')) { v = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    else if (!a.startsWith('--') && /^-[A-Za-z]./.test(a)) { v = a.slice(2); a = a.slice(0, 2); }
    const next = () => (v !== undefined ? v : args[++i]);
    if (a === '-X' || a === '--method') method = String(next()).toUpperCase();
    else if (a === '-f' || a === '-F' || a === '--field' || a === '--raw-field') {
      const kv = String(next());
      const eq = kv.indexOf('=');
      if (eq > 0) fields[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === '--input') { hasInput = true; next(); }
    else if (valueOpts.has(a)) next();
    else if (a.startsWith('-')) { /* flag without value */ }
    else if (endpoint === null) endpoint = a;
  }
  if (!method) method = Object.keys(fields).length || hasInput ? 'POST' : 'GET';
  const ep = (endpoint || '').replace(/^\/+/, '').replace(/\?.*$/, '');
  return { method, endpoint: ep, fields };
}

function checkGhApi(args, ctx) {
  const { method, endpoint, fields } = parseGhApi(args);
  const text = args.join(' ');
  if (endpoint === 'graphql') {
    return /\bmutation\b/i.test(text) && /\b(mergePullRequest|enablePullRequestAutoMerge|createRef|updateRef|deleteRef|createCommitOnBranch|createRelease|mergeBranch)\b/.test(text)
      ? REASONS.graphql : null;
  }
  if (method === 'GET' || method === 'HEAD') return null;
  if (/\/pulls\/\d+\/merge$/.test(endpoint) || /\/pulls\/\d+\/(ccr\/)?auto_merge$/.test(endpoint) || /\/merges$/.test(endpoint)) return REASONS.merge;
  if (/\/releases$/.test(endpoint) && method === 'POST') return REASONS.release;
  if (/\/releases\/\d+$/.test(endpoint) && method !== 'DELETE') return REASONS.release;
  const refPath = endpoint.match(/\/git\/refs?\/(.+)$/);
  if (/\/git\/refs$/.test(endpoint) || refPath) {
    const ref = refPath ? refPath[1] : (fields.ref || '');
    const full = ref.startsWith('refs/') ? ref : (refPath && /^(heads|tags)\//.test(ref) ? `refs/${ref}` : ref);
    if (full.startsWith('refs/tags/')) return REASONS.ref;
    if (ctx.protectedBranches.has(full.replace(/^refs\/heads\//, ''))) return REASONS.ref;
  }
  if (/\/contents\/.+/.test(endpoint) && (method === 'PUT' || method === 'DELETE')) {
    const branch = fields.branch;
    if (!branch || ctx.protectedBranches.has(branch)) return REASONS.contents;
  }
  return null;
}

function checkGh(args, ctx) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += args[i] === '-R' || args[i] === '--repo' ? 2 : 1;
  const [sub, sub2] = [args[i], args[i + 1]];
  if (sub === 'pr' && sub2 === 'merge') return REASONS.merge;
  if (sub === 'release' && sub2 === 'create') return REASONS.release;
  if (sub === 'api') return checkGhApi(args.slice(i + 1), ctx);
  return null;
}

function checkDeploy(name, args) {
  if (name === 'vercel' || name === 'vc') {
    if (args.some((a) => a === '--prod' || a === '--production' || a.startsWith('--prod='))) return REASONS.deploy('vercel --prod');
    if (args.includes('promote') || args.includes('rollback')) return REASONS.deploy('vercel promote/rollback');
  }
  if (PKG_MANAGERS.has(name) && args.some((a) => a === 'publish' || a === 'unpublish')) return REASONS.deploy(`${name} publish`);
  if (name === 'electron-builder') {
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = a.startsWith('--publish=') ? a.slice(10) : (a === '--publish' || a === '-p') ? args[i + 1] : null;
      if (val !== null && val !== undefined && val !== 'never') return REASONS.deploy('electron-builder --publish');
    }
  }
  return null;
}

function parseGitGlobal(args) {
  let dir = null;
  let i = 0;
  const withValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-C') { dir = args[i + 1] ?? null; i += 2; continue; }
    if (withValue.has(a)) { i += 2; continue; }
    i++;
  }
  return { dir, sub: args[i], rest: args.slice(i + 1) };
}

function analyzeSegment(tokens, ctx, dir, depth) {
  const t = unwrap(tokens);
  if (!t.length) return null;
  const name = base(t[0]);
  const args = t.slice(1);

  if (SHELLS.has(name)) {
    const ci = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (ci !== -1 && args[ci + 1] !== undefined) return analyze(args[ci + 1], ctx, depth + 1, dir);
    return null;
  }
  if (name === 'eval') return analyze(args.join(' '), ctx, depth + 1, dir);
  if (name === 'git') {
    const g = parseGitGlobal(args);
    if (g.sub !== 'push') return null;
    return checkGitPush(g.rest, g.dir ? ctx.resolveDir(dir, g.dir) : dir, ctx);
  }
  if (name === 'gh') return checkGh(args, ctx);
  if (RUNNERS.has(name)) {
    let rest = [...args];
    while (rest.length && rest[0].startsWith('-')) rest.shift();
    return rest.length ? analyzeSegment(rest, ctx, dir, depth) : null;
  }
  if (PKG_MANAGERS.has(name)) {
    const ei = args.findIndex((a) => a === 'dlx' || a === 'exec');
    if (ei !== -1) {
      const rest = args.slice(ei + 1).filter((a, idx) => !(idx === 0 && a === '--'));
      const inner = rest.length ? analyzeSegment(rest, ctx, dir, depth) : null;
      if (inner) return inner;
    }
  }
  return checkDeploy(name, args);
}

/** Analyze a shell command. Returns the reason to block, or null. */
export function analyze(command, ctx, depth = 0, cwd = ctx.cwd) {
  if (depth > 4 || typeof command !== 'string') return null;
  const { segments, nested } = tokenize(command);
  let dir = cwd;
  for (const seg of segments) {
    if (base(seg[0]) === 'cd' && seg[1] && seg[1] !== '-') { dir = ctx.resolveDir(dir, seg[1]); continue; }
    const r = analyzeSegment(seg, ctx, dir, depth);
    if (r) return r;
  }
  for (const inner of nested) {
    const r = analyze(inner, ctx, depth + 1, dir);
    if (r) return r;
  }
  return null;
}

// ---------- context from the real environment ----------

function git(dir, args) {
  try {
    return execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim() || null;
  } catch { return null; }
}

export function makeContext(input, env = process.env) {
  const cwd = (input && input.cwd) || process.cwd();
  const projectDir = env.CLAUDE_PROJECT_DIR || cwd;
  const protectedBranches = new Set(['main', 'master']);
  try {
    const profile = fs.readFileSync(path.join(projectDir, '.claude', 'team', 'profile.md'), 'utf8');
    const m = profile.match(/기본 브랜치:\s*`?([A-Za-z0-9._/-]+)/);
    if (m) protectedBranches.add(m[1]);
  } catch { /* no profile */ }
  const head = git(projectDir, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']);
  if (head) protectedBranches.add(head.replace(/^[^/]+\//, ''));
  return {
    cwd,
    protectedBranches,
    resolveDir: (from, p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : path.resolve(from, p)),
    currentBranch: (dir) => git(dir, ['symbolic-ref', '--short', '-q', 'HEAD']),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(env = process.env) {
  if (env.DEV_TEAM_KIT_GUARD === 'off') return 0;
  let input;
  try { input = JSON.parse(await readStdin()); } catch { return 0; }
  if (!input || (input.tool_name && input.tool_name !== 'Bash')) return 0;
  const command = input.tool_input && input.tool_input.command;
  if (typeof command !== 'string') return 0;
  let reason = null;
  try { reason = analyze(command, makeContext(input, env)); } catch { return 0; }
  if (!reason) return 0;
  await new Promise((resolve) => process.stderr.write(`차단: ${reason}\n사용자 승인이 필요한 작업입니다. 실행하지 말고 사용자에게 알리세요.\n`, resolve));
  return 2;
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT_PATH); } catch { return false; }
}

if (isDirectRun()) {
  main().then((code) => process.exit(code), () => process.exit(0));
}
