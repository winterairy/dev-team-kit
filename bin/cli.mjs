#!/usr/bin/env node
// dev-team-kit installer
//
//   npx --yes github:winterairy/dev-team-kit install [--target <dir>] [--force] [--dry-run]
//   node bin/cli.mjs install --target ../my-project
//
// 각 프로젝트의 .claude/ 아래에 BOT 세트를 복사하고 .claude/settings.json에 hook과
// 거부 규칙을 병합한다. 사용자가 고친 파일과 profile.md는 덮어쓰지 않는다.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const KIT_DIR = path.join(ROOT, 'kit');
export const MANIFEST = 'team/.kit-manifest.json';
export const OBSERVE_MARK = '/.claude/team/observe/observe.mjs';

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

/** Merge the kit's settings fragment into existing project settings. Pure. */
export function mergeSettings(existing, fragment) {
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
  return out;
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

export function install(target, { force = false, dryRun = false, kitDir = KIT_DIR, version, log = console.log } = {}) {
  const claudeDir = path.join(target, '.claude');
  const { actions, manifest } = planInstall(claudeDir, { force, kitDir });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const fragment = JSON.parse(fs.readFileSync(path.join(kitDir, 'settings.json'), 'utf8'));
  const merged = mergeSettings(readJson(settingsPath), fragment);

  const label = { create: '추가', update: '갱신', same: '변경 없음', skip: '건너뜀', remove: '삭제', keep: '유지' };
  for (const a of actions) {
    if (a.action === 'same') continue;
    log(`  ${label[a.action].padEnd(6)} .claude/${a.rel}${a.reason ? `  (${a.reason})` : ''}`);
  }
  log(`  병합    .claude/settings.json  (hook ${Object.keys(fragment.hooks || {}).length}개 이벤트, 거부 규칙)`);
  if (dryRun) return { actions, merged };

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
  fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2) + '\n');
  fs.writeFileSync(path.join(claudeDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(claudeDir, 'team', 'VERSION'), `${version}\n`);
  return { actions, merged };
}

function parseArgs(argv) {
  const opts = { cmd: argv[0] || 'help', target: process.cwd(), force: false, dryRun: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') opts.target = path.resolve(argv[++i]);
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

const HELP = `dev-team-kit

사용법:
  dev-team-kit install [--target <프로젝트 폴더>] [--force] [--dry-run]
  dev-team-kit version

install   .claude/ 아래에 BOT 세트를 설치하거나 업데이트한다
  --force    직접 수정한 kit 파일도 덮어쓴다
  --dry-run  바뀔 내용만 보여 준다`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (opts.cmd === 'version') return console.log(version);
  if (opts.cmd !== 'install') return console.log(HELP);

  if (!fs.existsSync(path.join(opts.target, '.git'))) {
    console.warn(`경고: ${opts.target}은 git 저장소 루트가 아닙니다.`);
  }
  console.log(`dev-team-kit ${version} → ${opts.target}${opts.dryRun ? ' (dry-run)' : ''}`);
  const { actions } = install(opts.target, { ...opts, version });
  const skipped = actions.filter((a) => a.action === 'skip');
  if (skipped.length) console.log(`\n${skipped.length}개 파일을 건너뛰었습니다. 덮어쓰려면 --force를 붙이세요.`);
  if (opts.dryRun) return;
  const hasProfile = fs.existsSync(path.join(opts.target, '.claude', 'team', 'profile.md'));
  console.log(`\n다음 단계:
  ${hasProfile ? '- profile.md가 이미 있습니다. 새 항목이 있는지 profile.template.md와 비교해 보세요.' : '- Claude Code에서 /team-init 을 실행해 프로젝트 설정을 만드세요.'}
  - 관찰 서버를 쓰려면 AGENT_OBSERVER_URL 환경 변수를 설정하세요 (README 참고).
  - 바뀐 .claude/ 파일을 커밋하세요.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
