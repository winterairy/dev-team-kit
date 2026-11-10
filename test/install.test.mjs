import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { install, mergeSettings, kitFiles, OBSERVE_MARK } from '../bin/cli.mjs';

const quiet = { log: () => {}, version: 'test' };

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

test('kit ships 7 agents and 2 commands', () => {
  const rels = kitFiles().map((f) => f.rel);
  for (const a of ['planner', 'architect', 'designer', 'developer', 'qa', 'security', 'devops']) {
    assert.ok(rels.includes(`agents/${a}.md`), a);
  }
  assert.ok(rels.includes('commands/task.md'));
  assert.ok(rels.includes('commands/team-init.md'));
  assert.ok(!rels.includes('team/profile.md'), 'profile.md must never be shipped');
});

test('agents declare matching name frontmatter', () => {
  for (const f of kitFiles().filter((x) => x.rel.startsWith('agents/'))) {
    const text = fs.readFileSync(f.src, 'utf8');
    const name = path.basename(f.rel, '.md');
    assert.match(text, new RegExp(`^---\\nname: ${name}\\n`), f.rel);
    assert.match(text, /\ndescription: .+\n/, f.rel);
  }
});

test('fresh install creates files, settings and manifest', () => {
  const dir = tmpProject();
  install(dir, quiet);
  assert.ok(fs.existsSync(path.join(dir, '.claude/agents/qa.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/team/process.md')));
  assert.equal(fs.readFileSync(path.join(dir, '.claude/team/VERSION'), 'utf8'), 'test\n');
  const s = JSON.parse(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'));
  assert.ok(s.hooks.PreToolUse[0].hooks[0].args[0].includes(OBSERVE_MARK));
  assert.ok(s.permissions.deny.includes('Bash(git push --force *)'));
});

test('reinstall is idempotent', () => {
  const dir = tmpProject();
  install(dir, quiet);
  const before = fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8');
  const { actions } = install(dir, quiet);
  assert.equal(fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8'), before);
  assert.ok(actions.every((a) => a.action === 'same'));
});

test('user-edited kit file is skipped unless --force', () => {
  const dir = tmpProject();
  install(dir, quiet);
  const qa = path.join(dir, '.claude/agents/qa.md');
  fs.appendFileSync(qa, '\n내 규칙\n');
  const { actions } = install(dir, quiet);
  assert.equal(actions.find((a) => a.rel === 'agents/qa.md').action, 'skip');
  assert.match(fs.readFileSync(qa, 'utf8'), /내 규칙/);
  install(dir, { ...quiet, force: true });
  assert.doesNotMatch(fs.readFileSync(qa, 'utf8'), /내 규칙/);
});

test('pre-existing same-name agent is not overwritten', () => {
  const dir = tmpProject();
  fs.mkdirSync(path.join(dir, '.claude/agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude/agents/planner.md'), 'mine');
  const { actions } = install(dir, quiet);
  assert.equal(actions.find((a) => a.rel === 'agents/planner.md').action, 'skip');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/agents/planner.md'), 'utf8'), 'mine');
});

test('profile.md is preserved across installs', () => {
  const dir = tmpProject();
  install(dir, quiet);
  fs.writeFileSync(path.join(dir, '.claude/team/profile.md'), '# mine');
  install(dir, { ...quiet, force: true });
  assert.equal(fs.readFileSync(path.join(dir, '.claude/team/profile.md'), 'utf8'), '# mine');
});

test('file dropped from the kit is removed only if unmodified', () => {
  const dir = tmpProject();
  install(dir, quiet);
  const mf = path.join(dir, '.claude/team/.kit-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  // pretend an old version shipped two extra files
  for (const [rel, body] of [['agents/old.md', 'old'], ['agents/old2.md', 'old2']]) {
    fs.writeFileSync(path.join(dir, '.claude', rel), body);
    manifest.files[rel] = sha(body);
  }
  fs.writeFileSync(mf, JSON.stringify(manifest));
  fs.appendFileSync(path.join(dir, '.claude/agents/old2.md'), ' edited');
  const { actions } = install(dir, quiet);
  assert.equal(actions.find((a) => a.rel === 'agents/old.md').action, 'remove');
  assert.equal(actions.find((a) => a.rel === 'agents/old2.md').action, 'keep');
  assert.ok(!fs.existsSync(path.join(dir, '.claude/agents/old.md')));
  assert.ok(fs.existsSync(path.join(dir, '.claude/agents/old2.md')));
});

function sha(s) {
  return crypto.createHash('sha256').update(Buffer.from(s)).digest('hex');
}

test('mergeSettings keeps user hooks and permissions', () => {
  const existing = {
    model: 'x',
    permissions: { allow: ['Bash(pnpm test)'], deny: ['Read(./.env)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
  };
  const fragment = {
    permissions: { deny: ['Bash(npm publish *)'] },
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: [`x${OBSERVE_MARK}`] }] }] },
  };
  const once = mergeSettings(existing, fragment);
  const twice = mergeSettings(once, fragment);
  assert.deepEqual(twice, once);
  assert.equal(once.model, 'x');
  assert.deepEqual(once.permissions.allow, ['Bash(pnpm test)']);
  assert.deepEqual(once.permissions.deny, ['Read(./.env)', 'Bash(npm publish *)']);
  assert.equal(once.hooks.PreToolUse.length, 2);
  assert.equal(once.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
});
