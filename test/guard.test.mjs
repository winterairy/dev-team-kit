import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, tokenize, REASONS } from '../kit/team/guard/guard.mjs';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit/team/guard/guard.mjs');

function ctxOn(branch, protectedExtra = []) {
  return {
    cwd: '/work',
    protectedBranches: new Set(['main', 'master', ...protectedExtra]),
    resolveDir: (from, p) => path.resolve(from, p),
    currentBranch: (dir) => (typeof branch === 'function' ? branch(dir) : branch),
  };
}
const blocked = (cmd, branch = 'feature/x', extra) => analyze(cmd, ctxOn(branch, extra));

// ---------- tokenizer ----------

test('tokenize: quotes, operators, redirects, substitutions, heredocs', () => {
  assert.deepEqual(tokenize(`git push origin 'a b' "c d"`).segments, [['git', 'push', 'origin', 'a b', 'c d']]);
  assert.deepEqual(tokenize('a && b || c; d | e\nf').segments.map((s) => s[0]), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(tokenize('git push origin main 2>&1 | tail').segments, [['git', 'push', 'origin', 'main'], ['tail']]);
  assert.deepEqual(tokenize('git push > out.txt origin main').segments, [['git', 'push', 'origin', 'main']]);
  assert.deepEqual(tokenize('echo "a && b"').segments, [['echo', 'a && b']]);
  const t = tokenize('echo "$(git push origin main)" `git push -f`');
  assert.deepEqual(t.nested, ['git push origin main', 'git push -f']);
  const h = tokenize("cat <<'EOF'\ngit push origin main\nEOF\ngit status");
  assert.deepEqual(h.segments, [['cat'], ['git', 'status']]);
  assert.deepEqual(tokenize('git push \\\n origin main').segments, [['git', 'push', 'origin', 'main']]);
  assert.deepEqual(tokenize('git status # git push origin main').segments, [['git', 'status']]);
});

// ---------- git push ----------

test('git push to the default branch is blocked in every spelling', () => {
  const cases = [
    ['git push', 'main'], ['git push origin', 'main'], ['git push -u origin', 'master'],
    ['git push origin main', 'feature/x'], ['git push -u origin main', 'feature/x'], ['git push origin master', 'feature/x'],
    ['git push origin HEAD', 'main'], ['git push origin HEAD:main', 'feature/x'],
    ['git push origin HEAD:refs/heads/main', 'feature/x'], ['git push origin feature:main', 'feature/x'],
    ['git push origin refs/heads/main', 'feature/x'], ['git push origin :main', 'feature/x'],
    ['git push --delete origin main', 'feature/x'], ['git push origin feature/x main', 'feature/x'],
    ['git push origin develop', 'feature/x', ['develop']], // profile default branch
  ];
  for (const [cmd, branch, extra] of cases) assert.ok(blocked(cmd, branch, extra), `${cmd} on ${branch}`);
  assert.equal(blocked('git push origin main', 'x'), REASONS.protectedBranch('main'));
});

test('force, all, mirror, tag and glob pushes are blocked', () => {
  for (const cmd of [
    'git push --force origin feature/x', 'git push -f', 'git push -fu origin feature/x', 'git push -uf origin feature/x',
    'git push --force-with-lease', 'git push --force-with-lease=feature/x:abc origin feature/x',
    'git push origin +feature/x', 'git push origin +HEAD:feature/x', 'git push --all', 'git push --mirror origin',
    'git push --tags', 'git push --follow-tags', 'git push origin refs/tags/v1', 'git push origin refs/heads/*:refs/heads/*',
  ]) assert.ok(blocked(cmd), cmd);
});

test('git push to work branches and unrelated commands are allowed', () => {
  for (const cmd of [
    'git push', 'git push origin', 'git push -u origin feature/x', 'git push origin HEAD', 'git push origin feature/x:feature/y',
    'git push origin feature/main-fix', 'git push origin mainline', 'git push --delete origin feature/x',
    'git push -o ci.skip origin feature/x', 'git push --repo=origin feature/x',
    'git status', 'git log main', 'git fetch origin main', 'git pull origin main', 'git merge main', 'git checkout main',
    'git commit -m "push origin main"', 'echo "git push origin main"', 'grep -r "git push -f" .', 'npm test',
  ]) assert.equal(blocked(cmd), null, cmd);
});

test('current branch decides bare pushes; unknown branch is allowed', () => {
  assert.ok(blocked('git push', 'main'));
  assert.equal(blocked('git push', 'feature/x'), null);
  assert.equal(blocked('git push', null), null, 'detached HEAD or unknown');
  assert.equal(blocked('git push origin HEAD', null), null);
});

test('wrappers, subshells, chains and cd are followed', () => {
  for (const cmd of [
    'FOO=1 git push origin main', 'sudo git push origin main', 'env GIT_TRACE=1 git push origin main', 'time git push origin main',
    'timeout 30 git push origin main', 'nohup git push origin main', '/usr/bin/git push origin main',
    'echo hi; git push origin master', 'git add . && git commit -m x && git push origin main', 'git push origin main 2>&1 | tail -3',
    'bash -c "git push origin main"', "sh -c 'git push -f'", 'bash -lc "cd x && git push origin main"', 'eval "git push origin main"',
    'echo "$(git push origin main)"', 'echo `git push origin main`', 'git push origin feature/x && git push origin main',
    'echo x | xargs git push origin main', '(git push origin main)',
  ]) assert.ok(blocked(cmd), cmd);
  // -C and cd change which branch a bare push looks at
  const byDir = (dir) => (dir === '/work/main-repo' ? 'main' : 'feature/x');
  assert.ok(analyze('git -C main-repo push', ctxOn(byDir)));
  assert.ok(analyze('cd main-repo && git push', ctxOn(byDir)));
  assert.equal(analyze('git -C other push', ctxOn(byDir)), null);
  assert.equal(analyze('cd other && git push', ctxOn(byDir)), null);
});

test('text inside a heredoc or a quoted argument is data, not a command', () => {
  assert.equal(blocked("git commit -F - <<'EOF'\ngit push origin main\nEOF"), null);
  assert.equal(blocked('gh pr create --title t --body "$(cat <<\'EOF\'\nRun: git push origin main\ngh pr merge 1\nEOF\n)"'), null);
  assert.equal(blocked("echo 'vercel --prod'"), null);
});

// ---------- gh ----------

test('gh merge and release are blocked, in every form', () => {
  for (const cmd of [
    'gh pr merge 3', 'gh pr merge --auto --squash', 'gh --repo o/r pr merge 3', 'gh release create v1 --notes x',
    'gh api -X PUT repos/o/r/pulls/1/merge', 'gh api repos/o/r/pulls/1/merge -X PUT', 'gh api --method PUT repos/o/r/pulls/1/merge',
    'gh api -XPUT repos/o/r/pulls/1/merge', 'gh api --method=PUT /repos/o/r/pulls/1/merge -f merge_method=merge',
    'gh api repos/o/r/pulls/1/merge -f merge_method=squash', 'gh api repos/o/r/merges -f base=main -f head=x',
    'gh api -X PUT repos/o/r/pulls/1/ccr/auto_merge', 'gh api -X POST repos/o/r/releases -f tag_name=v1',
    'gh api -X PATCH repos/o/r/releases/12 -F draft=false',
    'gh api -X PATCH repos/o/r/git/refs/heads/main -f sha=abc', 'gh api -X DELETE repos/o/r/git/refs/heads/main',
    'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/main -f sha=abc', 'gh api -X POST repos/o/r/git/refs -f ref=refs/tags/v1 -f sha=abc',
    'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=Yw==',
    'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=Yw== -f branch=main',
    `gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }'`,
    `gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{pullRequestId:"x"}) { clientMutationId } }'`,
  ]) assert.ok(blocked(cmd), cmd);
});

test('gh reads, PR creation and work-branch API writes are allowed', () => {
  for (const cmd of [
    'gh pr create --title t --body b', 'gh pr view 1', 'gh pr list', 'gh pr checks 1', 'gh release list', 'gh repo view',
    'gh api repos/o/r/pulls', 'gh api repos/o/r/pulls/1/merge', 'gh api -X GET repos/o/r/pulls/1/merge',
    'gh api -X POST repos/o/r/pulls -f title=t -f head=feature/x -f base=main',
    'gh api -X PATCH repos/o/r/pulls/1 -f title=t', 'gh api -X POST repos/o/r/issues -f title=t',
    'gh api -X PUT repos/o/r/pulls/1/ccr/ready_for_review', 'gh api -X PUT repos/o/r/pulls/1/update-branch',
    'gh api -X DELETE repos/o/r/git/refs/heads/feature/x', 'gh api -X POST repos/o/r/git/refs -f ref=refs/heads/feature/y -f sha=abc',
    'gh api -X PUT repos/o/r/contents/a.txt -f message=m -f content=Yw== -f branch=feature/x',
    `gh api graphql -f query='query { viewer { login } }'`, 'gh api graphql -f query=@q.graphql',
  ]) assert.equal(blocked(cmd), null, cmd);
});

// ---------- deploy and publish ----------

test('production deploy and package publishing are blocked', () => {
  for (const cmd of [
    'vercel --prod', 'vercel deploy --prod', 'vercel --yes --prod', 'vercel deploy --prod --yes', 'vc --prod', 'vercel --production',
    'npx vercel --prod', 'npx --yes vercel --prod', 'pnpm dlx vercel deploy --prod', 'bunx vercel --prod', 'npm exec -- vercel --prod',
    'pnpm exec vercel --prod', 'vercel promote https://x.vercel.app', 'vercel rollback',
    'npm publish', 'npm publish --access public', 'pnpm publish', 'pnpm -r publish', 'yarn publish', 'yarn npm publish',
    'bun publish', 'npm unpublish x', 'npm run publish', 'npx electron-builder --win --publish always', 'electron-builder -p onTagOrDraft',
    'cd app && npm publish', 'node_modules/.bin/vercel --prod',
  ]) assert.ok(blocked(cmd), cmd);
});

test('previews, builds and look-alikes are allowed', () => {
  for (const cmd of [
    'vercel', 'vercel deploy', 'vercel env ls', 'vercel pull --yes', 'vercel build', 'npx vercel',
    'npm run build', 'npm test', 'npm install publish-tool', 'npm run publish:docs', 'pnpm build', 'yarn install',
    'electron-builder --win', 'electron-builder --publish never', 'npm view x version', 'echo vercel --prod',
  ]) assert.equal(blocked(cmd), null, cmd);
});

// ---------- the hook itself ----------

function tmpRepo(branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtk-guard-'));
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: dir });
  return dir;
}
function hook(dir, payload, env = {}) {
  return spawnSync(process.execPath, [GUARD], {
    cwd: dir, encoding: 'utf8', input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { PATH: process.env.PATH, HOME: dir, ...env },
  });
}

test('hook: exit 2 with a reason on stderr when blocked, 0 otherwise', () => {
  const main = tmpRepo('main');
  const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: main });
  let r = hook(main, bash('git push'));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /차단: 기본 브랜치\(main\)/);
  assert.match(r.stderr, /사용자 승인/);
  assert.equal(hook(main, bash('git push origin feature/x')).status, 0);
  assert.equal(hook(main, bash('gh pr merge 1')).status, 2);
  assert.equal(hook(main, bash('ls -la')).status, 0);

  const feature = tmpRepo('feature/x');
  assert.equal(hook(feature, { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: feature }).status, 0);
  assert.equal(hook(feature, { tool_name: 'Bash', tool_input: { command: 'cd ' + main + ' && git push' }, cwd: feature }).status, 2);
});

test('hook: other tools, broken input and DEV_TEAM_KIT_GUARD=off never block', () => {
  const main = tmpRepo('main');
  const push = { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: main };
  assert.equal(hook(main, { ...push, tool_name: 'Write' }).status, 0);
  assert.equal(hook(main, { tool_name: 'Bash', tool_input: {}, cwd: main }).status, 0);
  assert.equal(hook(main, 'not json').status, 0);
  assert.equal(hook(main, '').status, 0);
  assert.equal(hook(main, push, { DEV_TEAM_KIT_GUARD: 'off' }).status, 0);
  assert.equal(hook(main, push).status, 2, 'still blocked without the switch');
});

test('hook: the default branch in profile.md is protected too', () => {
  const dir = tmpRepo('develop');
  fs.mkdirSync(path.join(dir, '.claude', 'team'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'team', 'profile.md'), '## 브랜치와 커밋\n- 기본 브랜치: develop\n');
  const r = hook(dir, { tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: dir }, { CLAUDE_PROJECT_DIR: dir });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /develop/);
});
