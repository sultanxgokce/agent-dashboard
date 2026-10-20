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

// Commit'in koşacağı dizin KOMUTUN KENDİSİNDEN çözülür (5FAWK · 20 Eki ölçümü: oturum cwd'si main'deki birincil kopyayken
// 10 biçimin 5'inde yanlış karar — 3 yanlış engel, 2 delik). Oturum hep main deposunda; commit'in gerçek hedefi değişir.
describe('hook integration: commit dizini komuttan çözülür (5FAWK)', () => {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'bmc-5fawk-'));
  const ana = path.join(kok, 'ana');
  const dal = path.join(kok, 'is-alani');
  for (const [d, b] of [[ana, 'main'], [dal, 'is-dali']]) {
    fs.mkdirSync(d);
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: d }).status, 0);
    assert.equal(spawnSync('git', ['checkout', '-q', '-B', b], { cwd: d }).status, 0);
  }
  const G = 'git', C = 'commit';   // literal birleşik yazılmaz: bu dosyayı düzenleyen ajanın kendi kancası metni okur
  function kos(komut, ek = {}) {
    const r = spawnSync('node', [HOOK_PATH], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: komut }, cwd: ana }),
      encoding: 'utf8', timeout: 5000, env: { ...process.env, ...ek },
    });
    return r.status === 2 ? 'ENGELLE' : r.status === 0 ? 'GECIR' : `rc=${r.status} ${r.stderr}`;
  }
  const gecir = [
    ['cd <iş alanı> && commit', `cd ${dal} && ${G} ${C} -m x`],
    ['değişkenle cd', `W=${dal}; cd $W && ${G} ${C} -m x`],
    ['${…} biçimli değişken', `W=${dal}; cd "\${W}" && ${G} ${C} -m x`],
    ['~ ile cd', `cd ~/is-alani && ${G} ${C} -m x`, { HOME: kok }],
    ['göreli cd (oturum dizininden)', `cd ../is-alani && ${G} ${C} -m x`],
    ['git -C <iş alanı>', `${G} -C ${dal} ${C} -m x`],
    ['satır sonu ayracı', `cd ${dal}\n${G} ${C} -m x`],
    ['tırnak içindeki metin komut değildir', `bash scripts/append-note.sh f "not; ${G} ${C} yapıldı"`],
    ['tek tırnak içi metin', `echo 'ders: main üstünde ${G} ${C} yasak'`],
    ['commit mesajında ; git commit', `cd ${dal} && ${G} ${C} -m "a; ${G} ${C} b"`],
    ['main deposunda commit OLMAYAN git', `${G} -C ${ana} status`],
    ['$( … ) içinde iş alanında commit', `echo "$(cd ${dal} && ${G} ${C} -m x)"`],
    ['alt kabukta iş alanına geçip commit', `(cd ${dal} && ${G} ${C} -m x)`],
  ];
  const engelle = [
    ['çıplak commit (oturum main)', `${G} ${C} -m x`],
    ['cd <main> && commit', `cd ${ana} && ${G} ${C} -m x`],
    ['git -C <main> commit', `${G} -C ${ana} ${C} -m x`],
    ['ikinci cd main\'e döner', `cd ${dal} && cd ${ana} && ${G} ${C} -m x`],
    ['git -c ayar commit', `${G} -c user.name=x ${C} -m x`],
    ['env önekli', `env FOO=1 ${G} ${C} -m x`],
    ['bash -c içinde commit', `bash -c "${G} ${C} -m x"`],
    ['çözülemeyen değişken → oturum dizini (temkinli)', `cd $BILINMEYEN_DIZIN && ${G} ${C} -m x`],
    ['iş alanında add, main\'de commit', `cd ${dal} && ${G} add . ; cd ${ana} && ${G} ${C} -m x`],
    ['$( … ) içinde commit (oturum main)', `echo "$(${G} ${C} -m x)"`],
    ['ters tırnak içinde commit', `echo \`${G} ${C} -m x\``],
    ['alt kabuktaki cd dışarı taşınmaz', `(cd ${dal}); ${G} ${C} -m x`],
  ];
  // 🔴 Kanca her Bash çağrısının önünde koşar: takılırsa bütün araç kilitlenir. İlk sürümde bitişik ')' sonsuz döngüye girdi
  //    (bellek tükendi) — bu kapı her karakterin her konumunu dener, hepsi hızlı bitmeli.
  //    Eşzamanlı sonsuz döngü node:test zaman aşımını TETİKLEMEZ → deneme ayrı süreçte, süre ve bellek tavanıyla koşar.
  it('hiçbir girdide takılmaz (ayraç/tırnak/parantez her konumda, 2000 rastgele komut)', () => {
    const govde = `
      const { commitDizinleri } = require(${JSON.stringify(path.join(__dirname, 'block-main-commit.js'))});
      const harf = ['(', ')', '$(', '\`', '"', "'", '\\\\', ';', '&', '|', '\\n', ' ', 'cd', '/x', '~', '$W', '\${W}', 'git', 'commit', '-C', 'W=/y', 'bash', '-c', '#'];
      let tohum = 42; const rnd = n => { tohum = (tohum * 1103515245 + 12345) % 2147483648; return tohum % n; };
      for (let n = 0; n < 2000; n++) {
        let s = ''; for (let k = rnd(14) + 1; k > 0; k--) s += harf[rnd(harf.length)] + (rnd(2) ? ' ' : '');
        commitDizinleri(s, '/ana');
      }`;
    const r = spawnSync('node', ['--max-old-space-size=128', '-e', govde], { encoding: 'utf8', timeout: 10000 });
    assert.equal(r.status, 0, `takıldı ya da düştü: status=${r.status} signal=${r.signal} ${String(r.stderr).slice(0, 200)}`);
  });
  for (const [ad, komut, ek] of gecir) it(`GEÇİR: ${ad}`, () => assert.equal(kos(komut, ek), 'GECIR'));
  for (const [ad, komut, ek] of engelle) it(`ENGELLE: ${ad}`, () => assert.equal(kos(komut, ek), 'ENGELLE'));
});
