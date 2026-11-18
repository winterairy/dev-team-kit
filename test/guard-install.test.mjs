import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { install, mergeSettings, kitFiles, GUARD_MARK, OBSERVE_MARK } from '../bin/cli.mjs';

const fragment = JSON.parse(fs.readFileSync(new URL('../kit/settings.json', import.meta.url), 'utf8'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-gh-'));
const opts = { log: () => {}, version: 'test', env: { CLAUDE_CONFIG_DIR: home } };
const project = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-g-')); fs.mkdirSync(path.join(d, '.git')); return d; };
const readSettings = (d) => JSON.parse(fs.readFileSync(path.join(d, '.claude', 'settings.json'), 'utf8'));
const guardGroups = (s) => s.hooks.PreToolUse.filter((g) => g.hooks.some((h) => (h.args || []).some((a) => a.includes(GUARD_MARK))));

test('the kit ships the guard and registers it once as a synchronous Bash PreToolUse hook', () => {
  assert.ok(kitFiles().some((f) => f.rel === 'team/guard/guard.mjs'));
  const groups = guardGroups(fragment);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, 'Bash');
  assert.ok(!groups[0].hooks[0].async, 'a blocking hook must not be async');
  assert.ok(groups[0].hooks[0].timeout <= 30);
  const observe = fragment.hooks.PreToolUse.find((g) => !g.matcher);
  assert.ok(observe.hooks[0].args[0].includes(OBSERVE_MARK), 'observe stays on every tool');
});

test('install adds the guard once; reinstalling does not duplicate it; user hooks stay', () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, '.claude'));
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  }));
  install(dir, opts);
  install(dir, opts);
  const s = readSettings(dir);
  assert.equal(guardGroups(s).length, 1);
  assert.ok(s.hooks.PreToolUse.some((g) => g.matcher === 'Write'), 'user hook kept');
  assert.ok(fs.existsSync(path.join(dir, '.claude/team/guard/guard.mjs')));
});

test('settings from an older kit (observe hook only) gain the guard on update', () => {
  const old = JSON.parse(JSON.stringify(fragment));
  old.hooks.PreToolUse = old.hooks.PreToolUse.filter((g) => !g.matcher);
  const merged = mergeSettings(old, fragment).settings;
  assert.equal(guardGroups(merged).length, 1);
  assert.equal(merged.hooks.PreToolUse.length, 2);
});

test('the static deny rules stay as a second layer', () => {
  const deny = fragment.permissions.deny;
  for (const r of ['Bash(git push --force *)', 'Bash(git push origin main)', 'Bash(vercel --prod *)', 'Bash(npm publish *)', 'Bash(gh pr merge *)', 'Bash(gh release create *)']) {
    assert.ok(deny.includes(r), r);
  }
});
