#!/usr/bin/env node
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { isUngatedPRCreate } = require('./pr-skill-gate');

const HOOK_PATH = path.join(__dirname, 'pr-skill-gate.js');

describe('isUngatedPRCreate', () => {
  describe('should block direct gh pr create', () => {
    it('plain gh pr create', () =>
      assert.equal(isUngatedPRCreate('gh pr create --title foo'), true));
    it('chained: git push && gh pr create', () =>
      assert.equal(isUngatedPRCreate('git push && gh pr create --title foo'), true));
    it('with body heredoc', () =>
      assert.equal(isUngatedPRCreate('gh pr create --title "x" --body "y"'), true));
    it('after a cd on its own line', () =>
      assert.equal(isUngatedPRCreate('cd /tmp/wt\ngh pr create --title foo'), true));
    it('after VAR=... assignments on earlier lines', () =>
      assert.equal(isUngatedPRCreate('W=/tmp/wt; cd $W; S=x\ngh pr create --title foo'), true));
    it('after a blank line and CRLF-free multi-line script', () =>
      assert.equal(isUngatedPRCreate('git push -u origin foo\n\ngh pr create --title foo'), true));
  });

  describe('should NOT block when bypass marker present', () => {
    it('AGENT_DASHBOARD_PR_SKILL=1 prefix', () =>
      assert.equal(
        isUngatedPRCreate('AGENT_DASHBOARD_PR_SKILL=1 gh pr create --title x'),
        false
      ));
    it('marker on the line that opens the PR (earlier line is a cd)', () =>
      assert.equal(
        isUngatedPRCreate('cd /tmp/wt\nAGENT_DASHBOARD_PR_SKILL=1 gh pr create --title x'),
        false
      ));
    it('marker after env line', () =>
      assert.equal(
        isUngatedPRCreate('git push -u origin foo && AGENT_DASHBOARD_PR_SKILL=1 gh pr create --title x'),
        false
      ));
  });

  describe('should NOT match unrelated commands', () => {
    it('gh pr view', () =>
      assert.equal(isUngatedPRCreate('gh pr view 123'), false));
    it('gh pr list', () =>
      assert.equal(isUngatedPRCreate('gh pr list'), false));
    it('gh pr merge', () =>
      assert.equal(isUngatedPRCreate('gh pr merge --squash'), false));
    it('git commit', () =>
      assert.equal(isUngatedPRCreate('git commit -m "msg"'), false));
    it('gh pr view on a later line', () =>
      assert.equal(isUngatedPRCreate('cd /tmp/wt\ngh pr view 12'), false));
    it('echo with literal text', () =>
      assert.equal(isUngatedPRCreate('echo "gh pr create"'), false));
  });
});

describe('hook integration', () => {
  function runHook(input, env = {}) {
    return spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify(input),
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, ...env },
    });
  }

  it('blocks gh pr create with exit 2', () => {
    const result = runHook({
      session_id: 't1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title x' },
    });
    assert.equal(result.status, 2, `expected block, got ${result.status}: ${result.stderr}`);
    assert.match(result.stderr, /\/agent-dashboard:pr/);
  });

  it('passes through when bypass marker present', () => {
    const result = runHook({
      session_id: 't1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'AGENT_DASHBOARD_PR_SKILL=1 gh pr create --title x' },
    });
    assert.equal(result.status, 0, `expected pass-through, got ${result.status}: ${result.stderr}`);
  });

  it('passes through unrelated bash commands', () => {
    const result = runHook({
      session_id: 't1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'git status' },
    });
    assert.equal(result.status, 0);
  });

  it('passes through when SKIP_PR_SKILL_GATE=1', () => {
    const result = runHook(
      {
        session_id: 't1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --title x' },
      },
      { SKIP_PR_SKILL_GATE: '1' }
    );
    assert.equal(result.status, 0, `expected pass-through, got ${result.status}: ${result.stderr}`);
  });
});
