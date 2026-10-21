#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isCommitOnMain } = require('./block-main-commit');

const HOOK_PATH = path.join(__dirname, 'block-main-commit.js');

describe('isCommitOnMain', () => {
  describe('should block git commit on main/master', () => {
    it('git commit -m "msg" on main', () =>
      assert.equal(isCommitOnMain('git commit -m "msg"', 'main'), true));
    it('git commit -am "msg" on main', () =>
      assert.equal(isCommitOnMain('git commit -am "msg"', 'main'), true));
    it('git commit on master', () =>
      assert.equal(isCommitOnMain('git commit -m "msg"', 'master'), true));
    it('chained: git add . && git commit -m "msg" on main', () =>
      assert.equal(isCommitOnMain('git add . && git commit -m "msg"', 'main'), true));
    it('semicolon: git add .; git commit -m "msg" on main', () =>
      assert.equal(isCommitOnMain('git add .; git commit -m "msg"', 'main'), true));
  });

  describe('should NOT block', () => {
    it('git commit on feature branch', () =>
      assert.equal(isCommitOnMain('git commit -m "msg"', 'feat/my-feature'), false));
    it('git commit on fix branch', () =>
      assert.equal(isCommitOnMain('git commit -m "msg"', 'fix/bug'), false));
    it('git status on main', () =>
      assert.equal(isCommitOnMain('git status', 'main'), false));
    it('git log on main', () =>
      assert.equal(isCommitOnMain('git log', 'main'), false));
    it('git diff on main', () =>
      assert.equal(isCommitOnMain('git diff', 'main'), false));
    it('git push on main', () =>
      assert.equal(isCommitOnMain('git push origin main', 'main'), false));
    it('echo "git commit" on main (not actual git)', () =>
      assert.equal(isCommitOnMain('echo "git commit"', 'main'), false));
  });
});

describe('hook integration: cwd resolution', () => {
  // Run the hook as a subprocess with JSON on stdin.
  // The worktree is on a feature branch, so git commit should NOT be blocked
  // even though the hook process itself runs from the main repo (on main).
  function runHook(input) {
    const result = spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
    });
    return result;
  }

  it('uses input.cwd to resolve branch (feature branch → allowed)', () => {
    // This worktree is on feat/hook-blocked-state, not main
    const worktreeCwd = path.resolve(__dirname, '..', '..', '..', '..');
    const result = runHook({
      session_id: 'test-123',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: worktreeCwd,
    });
    // Should pass through (exit 0), not block (exit 2)
    assert.equal(result.status, 0, `expected pass-through but got exit ${result.status}: ${result.stderr}`);
  });

  it('blocks when input.cwd points to a main branch repo', t => {
    const mainRepoCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dashboard-main-'));
    t.after(() => fs.rmSync(mainRepoCwd, { recursive: true, force: true }));
    const init = spawnSync('git', ['init'], { cwd: mainRepoCwd, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);
    const branch = spawnSync('git', ['checkout', '-B', 'main'], { cwd: mainRepoCwd, encoding: 'utf8' });
    assert.equal(branch.status, 0, branch.stderr);

    const result = runHook({
      session_id: 'test-123',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git commit -m "test"' },
      cwd: mainRepoCwd,
    });
    assert.equal(result.status, 2, `expected block but got exit ${result.status}`);
  });
});

describe('command parsing: the directory a commit actually runs in (Z5FAWK)', () => {
  const { commitTargets, BILINMEZ } = require('./block-main-commit');

  // Real repos: `anaRepo` is on main; `isAgaci` is a worktree of it on a feature branch.
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-cwd-'));
  const anaRepo = path.join(kok, 'ana');
  const isAgaci = path.join(kok, 'is-agaci');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  };
  fs.mkdirSync(anaRepo);
  git(anaRepo, 'init', '-b', 'main');
  git(anaRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'ilk');
  git(anaRepo, 'worktree', 'add', '-b', 'feat/x', isAgaci);
  require('node:test').after(() => fs.rmSync(kok, { recursive: true, force: true }));

  function calistir(command, cwd) {
    return spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd }),
      encoding: 'utf8',
      timeout: 5000,
    }).status;
  }

  // Session sits in the main repo (the real false-positive setting). Commits aimed at the worktree must pass.
  describe('worktree commits are NOT blocked', () => {
    it('plain commit in the main repo is blocked (control)', () =>
      assert.equal(calistir('git commit -m x', anaRepo), 2));
    it('variable + cd in a later statement', () =>
      assert.equal(calistir(`W=${isAgaci}; cd $W && git commit -m x`, anaRepo), 0));
    it('cd after other statements', () =>
      assert.equal(calistir(`echo hi; cd ${isAgaci} && git add -A && git commit -m x`, anaRepo), 0));
    it('subshell: (cd worktree && commit)', () =>
      assert.equal(calistir(`(cd ${isAgaci} && git commit -m x)`, anaRepo), 0));
    it('git -C <worktree> commit', () =>
      assert.equal(calistir(`git -C ${isAgaci} commit -m x`, anaRepo), 0));
    it('git -C "$W" commit with W set earlier', () =>
      assert.equal(calistir(`W=${isAgaci}\ngit -C "$W" commit -m x`, anaRepo), 0));
    it('relative leading cd into the worktree (resolved once)', () =>
      assert.equal(calistir('cd is-agaci && git commit -m x', kok), 0));
    it('cd with a stderr redirect keeps its effect (2>&1 is not a background job)', () =>
      assert.equal(calistir(`cd ${isAgaci} 2>&1 && git commit -m x`, anaRepo), 0));
    it('cd followed by || still moves the shell', () =>
      assert.equal(calistir(`cd ${isAgaci} || true; git commit -m x`, anaRepo), 0));
    it('commit piped into another command runs where the shell is', () =>
      assert.equal(calistir(`cd ${isAgaci} && git commit -m x | cat`, anaRepo), 0));
    it('unknown command before the cd, commit guarded by && (runs only after the cd)', () =>
      assert.equal(calistir(`git add -A && cd ${isAgaci} && git commit -m x`, anaRepo), 0));
    it('cd chain: main then worktree then commit', () =>
      assert.equal(calistir(`cd ${anaRepo} && cd ${isAgaci} && git commit -m x`, anaRepo), 0));
    it('pushd into the worktree', () =>
      assert.equal(calistir(`pushd ${isAgaci} && git commit -m x`, anaRepo), 0));
    it('unresolvable variable is not judged (branch unknown -> pass)', () =>
      assert.equal(calistir('cd $NOT_SET_ANYWHERE && git commit -m x', anaRepo), 0));
  });

  describe('real commits on main are still blocked', () => {
    it('git -C <main repo> commit from a worktree session', () =>
      assert.equal(calistir(`git -C ${anaRepo} commit -m x`, isAgaci), 2));
    it('cd to the worktree, then back to main, then commit', () =>
      assert.equal(calistir(`cd ${isAgaci} && cd ${anaRepo} && git commit -m x`, anaRepo), 2));
    it('variable pointing at main with -C', () =>
      assert.equal(calistir(`W=${anaRepo}; git -C "$W" commit -m x`, isAgaci), 2));
    it('a cd inside a subshell does not leak out', () =>
      assert.equal(calistir(`(cd ${isAgaci}); git commit -m x`, anaRepo), 2));
    it('a cd in a pipeline does not move the parent shell (reviewer case)', () =>
      assert.equal(calistir(`cd ${isAgaci} | cat; git commit -m x`, anaRepo), 2));
    it('a cd in a background job does not move the parent shell', () =>
      assert.equal(calistir(`cd ${isAgaci} & git commit -m x`, anaRepo), 2));
    it('the later element of a pipeline is a subshell too', () =>
      assert.equal(calistir(`echo a | cd ${isAgaci}; git commit -m x`, anaRepo), 2));
    it('a relative leading cd is applied once (not twice)', () =>
      assert.equal(calistir('cd ana && git commit -m x', kok), 2));
    it('short-circuited cd: false && cd worktree; commit (reviewer case)', () =>
      assert.equal(calistir(`false && cd ${isAgaci}; git commit -m x`, anaRepo), 2));
    it('short-circuited cd: true || cd worktree; commit (reviewer case)', () =>
      assert.equal(calistir(`true || cd ${isAgaci}; git commit -m x`, anaRepo), 2));
    it('uncertain predecessor: make && cd worktree; commit (make may fail, commit stays in main)', () =>
      assert.equal(calistir(`make && cd ${isAgaci}; git commit -m x`, anaRepo), 2));
    it('single-quoted variable is literal, so the cd fails and the commit stays in main (reviewer case)', () =>
      assert.equal(calistir(`W=${isAgaci}; cd '$W'; git commit -m x`, anaRepo), 2));
    it('cd to a directory that does not exist leaves the shell where it was', () =>
      assert.equal(calistir('cd /no/such/dir/anywhere; git commit -m x', anaRepo), 2));
    it('cd - goes back (worktree session, cd main then back would be main)', () =>
      assert.equal(calistir(`cd ${anaRepo}; cd ${isAgaci}; cd -; git commit -m x`, isAgaci), 2));
    it('popd returns to main', () =>
      assert.equal(calistir(`pushd ${isAgaci}; popd; git commit -m x`, anaRepo), 2));
    it('commit after a shell keyword (if/then, do, !) is still a commit', () =>
      assert.equal(calistir('if true; then git commit -m x; fi', anaRepo), 2));
    it('commit in a for loop body', () =>
      assert.equal(calistir('for i in 1; do git commit -m x; done', anaRepo), 2));
    it('sudo / nohup prefix still runs the commit', () =>
      assert.equal(calistir('sudo git commit -m x', anaRepo), 2));
    for (const c of ['sudo -u bob git commit -m x', 'sudo -H git commit -m x', 'sudo -- git commit -m x', 'sudo -n -u root -- git commit -m x', 'nice -n 5 git commit -m x', 'ionice -c 2 git commit -m x', 'exec -a foo git commit -m x'])
      it('wrapper options are skipped: ' + c, () => assert.equal(calistir(c, anaRepo), 2));
    it('wrapper option value is not mistaken for the command: sudo -u git echo hi', () =>
      assert.equal(calistir('sudo -u git echo hi', anaRepo), 0));
    it('bash -c "..." runs a commit in a child shell', () =>
      assert.equal(calistir('bash -c "git commit -m x"', anaRepo), 2));
    it('bash -c with its own cd into the worktree is allowed', () =>
      assert.equal(calistir(`bash -c "cd ${isAgaci} && git commit -m x"`, anaRepo), 0));
    it('line continuation inside the git command', () =>
      assert.equal(calistir('git \\\ncommit -m x', anaRepo), 2));
    it('one blocked commit among several is enough', () =>
      assert.equal(calistir(`git -C ${isAgaci} commit -m a && git -C ${anaRepo} commit -m b`, isAgaci), 2));
  });

  describe('text is not a command', () => {
    it('quoted mention with a semicolon', () =>
      assert.equal(calistir('echo "run; git commit -m x"', anaRepo), 0));
    it('heredoc body', () =>
      assert.equal(calistir("cat <<'EOF'\ngit commit -m x\nEOF", anaRepo), 0));
    it('grep for the phrase', () =>
      assert.equal(calistir("grep -rn 'git commit' docs", anaRepo), 0));
    it('shell comment hides the rest of the line (reviewer case)', () =>
      assert.equal(calistir('echo ok # ; git commit -m x', anaRepo), 0));
    it('a comment on its own line, then a real commit on the next line, is still judged', () =>
      assert.equal(calistir('# explain\ngit commit -m x', anaRepo), 2));
    it('a # inside quotes or a $# is not a comment', () =>
      assert.equal(calistir("echo '# x'; echo $#; git commit -m x", anaRepo), 2));
    it('commit-like words that are not the git subcommand', () =>
      assert.equal(calistir('git log --grep=commit', anaRepo), 0));
  });

  describe('commitTargets (pure)', () => {
    it('finds the effective directory per commit', () =>
      assert.deepEqual(commitTargets(`cd ${isAgaci} && git commit -m x; git -C ${anaRepo} commit -m y`, '/s'), [{ cwd: isAgaci }, { cwd: anaRepo }]));
    it('a cd to a missing directory fails: the directory stays', () =>
      assert.deepEqual(commitTargets('cd /a; git commit -m x', '/s'), [{ cwd: '/s' }]));
    it('a failed cd skips the && commit entirely (it never runs)', () =>
      assert.deepEqual(commitTargets('cd /a && git commit -m x', '/s'), []));
    it('an uncertain cd keeps both possibilities', () =>
      assert.deepEqual(commitTargets(`make && cd ${isAgaci}; git commit -m x`, anaRepo).map(t => t.cwd).sort(), [anaRepo, isAgaci].sort()));
    it('relative -C resolves against the current directory', () =>
      assert.deepEqual(commitTargets('git -C sub commit -m x', '/s'), [{ cwd: '/s/sub' }]));
    it('unknown variable -> BILINMEZ', () =>
      assert.deepEqual(commitTargets('cd $NOPE && git commit -m x', '/s'), [{ cwd: BILINMEZ }]));
    it('no commit -> empty', () =>
      assert.deepEqual(commitTargets('git status && echo "git commit"', '/s'), []));
    it('git config values and -c options are skipped', () =>
      assert.deepEqual(commitTargets('git -c user.name=t commit -m x', '/s'), [{ cwd: '/s' }]));
  });
});
