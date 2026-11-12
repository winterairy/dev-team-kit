import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mergeSettings, planStatusLine, install, restoreStatusLine, parseArgs, isDirectRun,
  STATUSLINE_COMMAND, STATUSLINE_SAVE,
} from '../bin/cli.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.mjs');
const fragment = JSON.parse(fs.readFileSync(path.join(ROOT, 'kit', 'settings.json'), 'utf8'));
const now = new Date('2026-11-11T10:00:00Z');
const other = { type: 'command', command: 'bash ~/.claude/my-line.sh', padding: 1, refreshInterval: 5 };

function tmp(prefix = 'dtk-sl-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function project(settings) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, '.git'));
  if (settings) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify(settings));
  }
  return dir;
}
const home = tmp('dtk-home-');
const opts = (extra = {}) => ({ log: () => {}, version: 'test', env: { CLAUDE_CONFIG_DIR: home }, ...extra });
const readSettings = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

// ---------- statusLine table ----------

test('no statusLine → kit command is installed', () => {
  const r = mergeSettings({}, fragment, { now });
  assert.equal(r.statusLineAction, 'install');
  assert.deepEqual(r.settings.statusLine, { type: 'command', command: STATUSLINE_COMMAND });
  assert.equal(r.wrapSaved, null);
  assert.ok(!('statusLine' in fragment), 'statusLine must not be in the fragment');
});

test('already kit command → kept, command normalized, other fields kept', () => {
  const old = { type: 'command', command: 'node ./.claude/team/observe/statusline.mjs', padding: 2 };
  const r = mergeSettings({ statusLine: old }, fragment, { now });
  assert.equal(r.statusLineAction, 'keep');
  assert.deepEqual(r.settings.statusLine, { type: 'command', command: STATUSLINE_COMMAND, padding: 2 });
});

test('other command + auto → unchanged, needs confirmation', () => {
  const r = mergeSettings({ statusLine: other }, fragment, { now });
  assert.equal(r.statusLineAction, 'confirm');
  assert.deepEqual(r.settings.statusLine, other);
  assert.equal(r.wrapSaved, null);
});

test('other command + wrap → original saved, kit command keeps padding/refreshInterval', () => {
  const r = mergeSettings({ statusLine: other }, fragment, { statusLine: 'wrap', now });
  assert.equal(r.statusLineAction, 'wrap');
  assert.deepEqual(r.settings.statusLine, { type: 'command', command: STATUSLINE_COMMAND, padding: 1, refreshInterval: 5 });
  assert.deepEqual(r.wrapSaved, { v: 1, savedAt: now.toISOString(), wrap: other });
});

test('other command + skip, and no statusLine + skip → untouched', () => {
  assert.deepEqual(mergeSettings({ statusLine: other }, fragment, { statusLine: 'skip' }).settings.statusLine, other);
  const r = mergeSettings({}, fragment, { statusLine: 'skip' });
  assert.equal(r.statusLineAction, 'skip');
  assert.ok(!('statusLine' in r.settings));
});

test('non-command type → untouched with notice action', () => {
  const weird = { type: 'static', text: 'hi' };
  const r = mergeSettings({ statusLine: weird }, fragment, { statusLine: 'wrap' });
  assert.equal(r.statusLineAction, 'unsupported');
  assert.deepEqual(r.settings.statusLine, weird);
});

test('refreshInterval is never added; a user value is carried over when wrapping', () => {
  assert.ok(!('refreshInterval' in planStatusLine(undefined, {}).statusLine));
  assert.ok(!('refreshInterval' in mergeSettings({}, fragment).settings.statusLine));
  const kept = mergeSettings({ statusLine: { type: 'command', command: STATUSLINE_COMMAND } }, fragment).settings.statusLine;
  assert.ok(!('refreshInterval' in kept));
  assert.equal(mergeSettings({ statusLine: other }, fragment, { statusLine: 'wrap' }).settings.statusLine.refreshInterval, 5);
});

test('fresh install into a temp git folder has no refreshInterval', () => {
  const dir = project();
  install(dir, opts());
  assert.deepEqual(readSettings(dir).statusLine, { type: 'command', command: STATUSLINE_COMMAND });
});

// ---------- install / restore ----------

test('install with wrap writes statusline.json; reinstall keeps it; restore puts the original back', () => {
  const dir = project({ statusLine: other, model: 'x' });
  install(dir, opts({ statusLine: 'wrap' }));
  const save = path.join(dir, '.claude', STATUSLINE_SAVE);
  assert.deepEqual(JSON.parse(fs.readFileSync(save, 'utf8')).wrap, other);
  assert.equal(readSettings(dir).statusLine.command, STATUSLINE_COMMAND);

  install(dir, opts()); // auto: now it is already kit → keep, saved file untouched
  assert.deepEqual(JSON.parse(fs.readFileSync(save, 'utf8')).wrap, other);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.claude/team/.kit-manifest.json'), 'utf8'));
  assert.ok(!(STATUSLINE_SAVE in manifest.files), 'statusline.json is not a kit file');
  assert.ok('team/observe/statusline.mjs' in manifest.files);

  const r = restoreStatusLine(dir);
  assert.equal(r.action, 'restored');
  assert.deepEqual(readSettings(dir).statusLine, other);
  assert.equal(readSettings(dir).model, 'x');
  assert.ok(!fs.existsSync(save));
});

test('restore after a fresh install removes the kit statusLine; restore when not kit does nothing', () => {
  const dir = project();
  install(dir, opts());
  assert.equal(restoreStatusLine(dir).action, 'removed');
  assert.ok(!('statusLine' in readSettings(dir)));
  assert.equal(restoreStatusLine(dir).action, 'none');
});

test('auto install with an existing command leaves it alone', () => {
  const dir = project({ statusLine: other });
  const r = install(dir, opts());
  assert.equal(r.statusLineAction, 'confirm');
  assert.deepEqual(readSettings(dir).statusLine, other);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', STATUSLINE_SAVE)));
});

test('dry-run writes nothing', () => {
  const dir = project({ statusLine: other });
  install(dir, opts({ statusLine: 'wrap', dryRun: true }));
  assert.deepEqual(readSettings(dir).statusLine, other);
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'agents')));
});

test('notices for settings.local.json and user settings, without editing them', () => {
  const dir = project();
  const localSl = { statusLine: { type: 'command', command: 'echo local' } };
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify(localSl));
  const userHome = tmp('dtk-home-');
  fs.writeFileSync(path.join(userHome, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'echo user' } }));
  const r = install(dir, opts({ env: { CLAUDE_CONFIG_DIR: userHome } }));
  assert.equal(r.notices.length, 2);
  assert.match(r.notices[0], /settings\.local\.json/);
  assert.match(r.notices[1], /사용자 설정/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')), localSl);
  assert.equal(JSON.parse(fs.readFileSync(path.join(userHome, 'settings.json'), 'utf8')).statusLine.command, 'echo user');
});

// ---------- CLI ----------

test('parseArgs accepts --statusline in both forms and rejects bad values and --refresh-interval', () => {
  assert.equal(parseArgs(['install', '--statusline=wrap']).statusLine, 'wrap');
  assert.equal(parseArgs(['install', '--statusline', 'skip']).statusLine, 'skip');
  assert.equal(parseArgs(['install']).statusLine, 'auto');
  assert.throws(() => parseArgs(['install', '--statusline=yes']));
  assert.throws(() => parseArgs(['install', '--refresh-interval=60']), /알 수 없는 옵션/);
});

function cli(args, { via = CLI, env = {} } = {}) {
  return spawnSync(process.execPath, [via, ...args], {
    encoding: 'utf8', input: '', env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: home, ...env },
  });
}

test('non-TTY install with an existing command skips and tells how to wrap', () => {
  const dir = project({ statusLine: other });
  const r = cli(['install', '--target', dir]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--statusline=wrap/);
  assert.deepEqual(readSettings(dir).statusLine, other);
});

test('CLI --statusline=wrap and skip', () => {
  const a = project({ statusLine: other });
  assert.equal(cli(['install', '--target', a, '--statusline=wrap']).status, 0);
  assert.equal(readSettings(a).statusLine.command, STATUSLINE_COMMAND);
  const b = project({ statusLine: other });
  assert.equal(cli(['install', '--target', b, '--statusline=skip']).status, 0);
  assert.deepEqual(readSettings(b).statusLine, other);
});

test('regression: running through a symlink (as npx does) still installs', () => {
  const binDir = tmp('dtk-npx-');
  const link = path.join(binDir, 'dev-team-kit');
  fs.symlinkSync(CLI, link);
  assert.equal(isDirectRun(link, CLI), true);
  assert.equal(isDirectRun(path.join(binDir, 'missing'), CLI), false);
  const dir = project();
  const r = cli(['install', '--target', dir], { via: link });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /dev-team-kit .* →/);
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'agents', 'qa.md')));
  assert.match(cli(['version'], { via: link }).stdout, /^\d+\.\d+\.\d+\n$/);
});
