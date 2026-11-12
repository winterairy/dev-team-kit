#!/usr/bin/env node
// dev-team-kit installer
//
//   npx --yes github:winterairy/dev-team-kit install [--target <dir>] [--force] [--dry-run]
//                                            [--statusline=wrap|skip]
//   npx --yes github:winterairy/dev-team-kit restore-statusline [--target <dir>]
//
// 각 프로젝트의 .claude/ 아래에 BOT 세트를 복사하고 .claude/settings.json에 hook, 거부 규칙,
// statusLine을 병합한다. 사용자가 고친 파일과 profile.md는 덮어쓰지 않는다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
export const KIT_DIR = path.join(ROOT, 'kit');
export const MANIFEST = 'team/.kit-manifest.json';
export const OBSERVE_MARK = '/.claude/team/observe/observe.mjs';
export const STATUSLINE_MARK = '/.claude/team/observe/statusline.mjs';
export const STATUSLINE_COMMAND = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/team/observe/statusline.mjs"';
export const STATUSLINE_SAVE = 'team/observe/statusline.json'; // under .claude/, not shipped by the kit

// kit/ 안의 위치 → 대상 .claude/ 안의 위치
const LAYOUT = [
  { from: 'agents', to: 'agents' },
  { from: 'commands', to: 'commands' },
  { from: 'team', to: 'team' },
];

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Files the kit ships, as { rel: path under .claude/, src: absolute source } */
export function kitFiles(kitDir = KIT_DIR) {
  const files = [];
  for (const { from, to } of LAYOUT) {
    const base = path.join(kitDir, from);
    if (!fs.existsSync(base)) continue;
    for (const src of walk(base)) {
      files.push({ rel: path.posix.join(to, path.relative(base, src).split(path.sep).join('/')), src });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

function isKitHookGroup(group) {
  return Array.isArray(group?.hooks) && group.hooks.some((h) =>
    (Array.isArray(h.args) && h.args.some((a) => String(a).includes(OBSERVE_MARK))) ||
    String(h.command || '').includes(OBSERVE_MARK));
}

export function isKitStatusLine(sl) {
  return !!sl && typeof sl === 'object' && typeof sl.command === 'string' &&
    sl.command.replace(/\\/g, '/').includes(STATUSLINE_MARK);
}

// refreshInterval is never added: the script pauses while idle, so timed re-runs would do nothing.
// A refreshInterval the user already had (wrap/keep) is carried over through `base`.
function kitStatusLine(base) {
  return { ...(base || {}), type: 'command', command: STATUSLINE_COMMAND };
}

/**
 * statusLine 처리. Pure.
 * mode: 'auto' | 'wrap' | 'skip'
 * @returns {{ statusLine: object|undefined, action: string, wrapSaved: object|null }}
 *   action: install | keep | wrap | confirm(auto라 묻기 필요, 변경 없음) | skip | unsupported
 */
export function planStatusLine(current, { mode = 'auto', now = new Date() } = {}) {
  if (mode === 'skip') return { statusLine: current, action: 'skip', wrapSaved: null };
  if (current === undefined || current === null) {
    return { statusLine: kitStatusLine(null), action: 'install', wrapSaved: null };
  }
  if (typeof current !== 'object' || current.type !== 'command' || typeof current.command !== 'string') {
    return { statusLine: current, action: 'unsupported', wrapSaved: null };
  }
  if (isKitStatusLine(current)) {
    return { statusLine: kitStatusLine(current), action: 'keep', wrapSaved: null };
  }
  if (mode !== 'wrap') return { statusLine: current, action: 'confirm', wrapSaved: null };
  const { type: _t, command: _c, ...rest } = current;
  return {
    statusLine: kitStatusLine(rest),
    action: 'wrap',
    wrapSaved: { v: 1, savedAt: now.toISOString(), wrap: structuredClone(current) },
  };
}

/** Merge the kit's settings fragment into existing project settings. Pure. */
export function mergeSettings(existing, fragment, { statusLine = 'auto', now } = {}) {
  const out = structuredClone(existing || {});
  // hooks: drop previous kit groups, then append current ones
  const hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).filter((g) => !isKitHookGroup(g));
    if (hooks[ev].length === 0) delete hooks[ev];
  }
  for (const [ev, groups] of Object.entries(fragment.hooks || {})) {
    hooks[ev] = [...(hooks[ev] || []), ...structuredClone(groups)];
  }
  if (Object.keys(hooks).length) out.hooks = hooks;
  // permissions.deny: union
  const deny = new Set(out.permissions?.deny || []);
  for (const r of fragment.permissions?.deny || []) deny.add(r);
  if (deny.size) out.permissions = { ...(out.permissions || {}), deny: [...deny] };
  // statusLine: never in the fragment, handled separately so an existing one is not silently replaced
  const sl = planStatusLine(out.statusLine, { mode: statusLine, now });
  if (sl.statusLine === undefined) delete out.statusLine;
  else out.statusLine = sl.statusLine;
  return { settings: out, statusLineAction: sl.action, wrapSaved: sl.wrapSaved };
}

/**
 * Plan what install would do. Pure apart from reading files.
 * @returns {{actions: Array<{rel, action, reason?}>, manifest: object}}
 */
export function planInstall(claudeDir, { force = false, kitDir = KIT_DIR } = {}) {
  const manifestPath = path.join(claudeDir, MANIFEST);
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { files: {} };
  const next = { files: {} };
  const actions = [];

  for (const { rel, src } of kitFiles(kitDir)) {
    const content = fs.readFileSync(src);
    const newHash = sha(content);
    const dest = path.join(claudeDir, rel);
    next.files[rel] = newHash;
    if (!fs.existsSync(dest)) { actions.push({ rel, action: 'create', src }); continue; }
    const curHash = sha(fs.readFileSync(dest));
    if (curHash === newHash) { actions.push({ rel, action: 'same' }); continue; }
    const owned = prev.files[rel] && prev.files[rel] === curHash; // unchanged since we installed it
    if (owned || force) actions.push({ rel, action: 'update', src });
    else {
      actions.push({ rel, action: 'skip', reason: prev.files[rel] ? '직접 수정한 파일' : 'kit 밖에서 만든 같은 이름의 파일' });
      next.files[rel] = prev.files[rel] || null;
    }
  }
  // files the kit no longer ships
  for (const [rel, h] of Object.entries(prev.files)) {
    if (next.files[rel] !== undefined) continue;
    const dest = path.join(claudeDir, rel);
    if (!fs.existsSync(dest)) continue;
    if (h && sha(fs.readFileSync(dest)) === h) actions.push({ rel, action: 'remove' });
    else actions.push({ rel, action: 'keep', reason: 'kit에서 빠졌지만 직접 수정한 파일' });
  }
  for (const rel of Object.keys(next.files)) if (next.files[rel] === null) delete next.files[rel];
  return { actions, manifest: next };
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  try { return JSON.parse(text); } catch (e) {
    throw new Error(`${file}을 JSON으로 읽을 수 없습니다: ${e.message}`);
  }
}

function readJsonQuiet(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function userSettingsPath(env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

/** Notices about statusLine values in files the installer never edits. */
export function statusLineNotices(target, env = process.env) {
  const notices = [];
  const local = readJsonQuiet(path.join(target, '.claude', 'settings.local.json'));
  if (local && local.statusLine) {
    notices.push('.claude/settings.local.json에 statusLine이 있습니다. 그 값이 우선이라 이 PC에서는 kit의 statusLine이 실행되지 않습니다(플랜 사용량이 전송되지 않음). 이 파일은 고치지 않았습니다.');
  }
  const user = readJsonQuiet(userSettingsPath(env));
  if (user && user.statusLine) {
    notices.push('사용자 설정(~/.claude/settings.json)에 statusLine이 있습니다. 이 프로젝트에서는 kit의 statusLine이 실행될 때 그 명령을 감싸서 원래 출력이 그대로 보입니다. 사용자 설정은 고치지 않았습니다.');
  }
  return notices;
}

export function install(target, {
  force = false, dryRun = false, kitDir = KIT_DIR, version, log = console.log,
  statusLine = 'auto', env = process.env,
} = {}) {
  const claudeDir = path.join(target, '.claude');
  const { actions, manifest } = planInstall(claudeDir, { force, kitDir });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const fragment = JSON.parse(fs.readFileSync(path.join(kitDir, 'settings.json'), 'utf8'));
  const merged = mergeSettings(readJson(settingsPath), fragment, { statusLine });
  const notices = statusLineNotices(target, env);

  const label = { create: '추가', update: '갱신', same: '변경 없음', skip: '건너뜀', remove: '삭제', keep: '유지' };
  for (const a of actions) {
    if (a.action === 'same') continue;
    log(`  ${label[a.action].padEnd(6)} .claude/${a.rel}${a.reason ? `  (${a.reason})` : ''}`);
  }
  log(`  병합    .claude/settings.json  (hook ${Object.keys(fragment.hooks || {}).length}개 이벤트, 거부 규칙)`);
  const slLabel = {
    install: 'statusLine 추가 (플랜 사용량 수집)',
    keep: 'statusLine 유지 (이미 kit 명령)',
    wrap: `statusLine 감싸기: 기존 명령을 .claude/${STATUSLINE_SAVE}에 보존하고 그 출력을 그대로 보여 줌`,
    confirm: 'statusLine 건너뜀: 기존 명령이 있어 확인이 필요합니다 (--statusline=wrap으로 다시 실행)',
    skip: 'statusLine 건너뜀 (--statusline=skip)',
    unsupported: 'statusLine 건너뜀: type이 command가 아니라 감쌀 수 없습니다',
  };
  log(`  ${merged.statusLineAction === 'install' || merged.statusLineAction === 'wrap' ? '병합   ' : '알림   '} ${slLabel[merged.statusLineAction]}`);
  for (const n of notices) log(`  알림    ${n}`);
  if (dryRun) return { actions, merged: merged.settings, statusLineAction: merged.statusLineAction, notices };

  for (const a of actions) {
    const dest = path.join(claudeDir, a.rel);
    if (a.action === 'create' || a.action === 'update') {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(a.src, dest);
    } else if (a.action === 'remove') {
      fs.rmSync(dest);
    }
  }
  fs.mkdirSync(path.join(claudeDir, 'team'), { recursive: true });
  if (merged.wrapSaved) {
    const savePath = path.join(claudeDir, STATUSLINE_SAVE);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, JSON.stringify(merged.wrapSaved, null, 2) + '\n');
  }
  fs.writeFileSync(settingsPath, JSON.stringify(merged.settings, null, 2) + '\n');
  fs.writeFileSync(path.join(claudeDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(claudeDir, 'team', 'VERSION'), `${version}\n`);
  return { actions, merged: merged.settings, statusLineAction: merged.statusLineAction, notices };
}

/** Undo the statusLine change. Returns a short description of what happened. */
export function restoreStatusLine(target, { dryRun = false } = {}) {
  const claudeDir = path.join(target, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const savePath = path.join(claudeDir, STATUSLINE_SAVE);
  const settings = readJson(settingsPath) || {};
  const saved = readJsonQuiet(savePath);
  if (!isKitStatusLine(settings.statusLine)) {
    return { action: 'none', message: '지금 statusLine이 kit 명령이 아니라서 바꾸지 않았습니다.' };
  }
  let action;
  if (saved && saved.wrap && typeof saved.wrap === 'object') {
    settings.statusLine = saved.wrap;
    action = 'restored';
  } else {
    delete settings.statusLine;
    action = 'removed';
  }
  if (!dryRun) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    if (saved) fs.rmSync(savePath, { force: true });
  }
  return {
    action,
    message: action === 'restored' ? '보존해 둔 원래 statusLine으로 되돌렸습니다.' : 'kit statusLine을 지웠습니다(원래 statusLine이 없었습니다).',
  };
}

export function parseArgs(argv, cwd = process.cwd()) {
  const opts = { cmd: argv[0] || 'help', target: cwd, force: false, dryRun: false, statusLine: 'auto' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const [key, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (key === '--target') opts.target = path.resolve(cwd, value());
    else if (key === '--force') opts.force = true;
    else if (key === '--dry-run') opts.dryRun = true;
    else if (key === '--statusline') {
      const v = value();
      if (v !== 'wrap' && v !== 'skip') throw new Error(`--statusline 값은 wrap 또는 skip입니다: ${v}`);
      opts.statusLine = v;
    } else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `dev-team-kit

사용법:
  dev-team-kit install [--target <프로젝트 폴더>] [--force] [--dry-run]
                       [--statusline=wrap|skip]
  dev-team-kit restore-statusline [--target <프로젝트 폴더>] [--dry-run]
  dev-team-kit version

install             .claude/ 아래에 BOT 세트를 설치하거나 업데이트한다
  --force             직접 수정한 kit 파일도 덮어쓴다
  --dry-run           바뀔 내용만 보여 준다
  --statusline=wrap   기존 statusLine 명령을 감싸서 그대로 보여 주고 플랜 사용량을 보낸다
  --statusline=skip   statusLine을 건드리지 않는다
                      (지정하지 않으면 기존 명령이 있을 때 터미널에서 묻고, 터미널이 아니면 건너뛴다)
restore-statusline  install이 바꾼 statusLine을 원래대로 되돌린다`;

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => { rl.close(); resolve(answer); });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (opts.cmd === 'version') return console.log(version);
  if (opts.cmd === 'restore-statusline') {
    const r = restoreStatusLine(opts.target, opts);
    return console.log(r.message + (opts.dryRun ? ' (dry-run: 실제로 바꾸지 않음)' : ''));
  }
  if (opts.cmd !== 'install') return console.log(HELP);

  if (!fs.existsSync(path.join(opts.target, '.git'))) {
    console.warn(`경고: ${opts.target}은 git 저장소 루트가 아닙니다.`);
  }

  // auto + existing non-kit statusLine: ask on a terminal, otherwise skip
  if (opts.statusLine === 'auto' && !opts.dryRun) {
    const existing = readJson(path.join(opts.target, '.claude', 'settings.json'));
    const plan = planStatusLine(existing?.statusLine, { mode: 'auto' });
    if (plan.action === 'confirm') {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const answer = await ask(`기존 statusLine \`${existing.statusLine.command}\`을 감싸서 그대로 보이게 하고 플랜 사용량을 보냅니다. 계속할까요? [y/N] `);
        opts.statusLine = /^y(es)?$/i.test(answer.trim()) ? 'wrap' : 'skip';
      }
    }
  }

  console.log(`dev-team-kit ${version} → ${opts.target}${opts.dryRun ? ' (dry-run)' : ''}`);
  const { actions, statusLineAction } = install(opts.target, { ...opts, version });
  const skipped = actions.filter((a) => a.action === 'skip');
  if (skipped.length) console.log(`\n${skipped.length}개 파일을 건너뛰었습니다. 덮어쓰려면 --force를 붙이세요.`);
  if (opts.dryRun) return;
  const hasProfile = fs.existsSync(path.join(opts.target, '.claude', 'team', 'profile.md'));
  console.log(`\n다음 단계:
  ${hasProfile ? '- profile.md가 이미 있습니다. 새 항목이 있는지 profile.template.md와 비교해 보세요.' : '- Claude Code에서 /team-init 을 실행해 프로젝트 설정을 만드세요.'}
  - 관찰 서버를 쓰려면 AGENT_OBSERVER_URL 환경 변수를 설정하세요 (README 참고).
  - 바뀐 .claude/ 파일을 커밋하세요.`);
  if (statusLineAction === 'install' || statusLineAction === 'wrap' || statusLineAction === 'keep') {
    console.log(`  - statusLine을 원래대로 되돌리려면: npx --yes github:winterairy/dev-team-kit restore-statusline${statusLineAction === 'wrap' ? `\n    (원래 값은 .claude/${STATUSLINE_SAVE}에 있습니다)` : ''}`);
  }
}

/** True when this file is the entry point, also through npx's bin symlink. */
export function isDirectRun(argv1 = process.argv[1], self = SCRIPT_PATH) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(self);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
