#!/usr/bin/env node
/**
 * PreToolUse hook for Bash — blocks git commit on main/master.
 *
 * Exit code 2 blocks the tool call. Writes reason to stderr.
 *
 * The branch is read from the directory the commit will actually run in, resolved from the
 * command itself: cd (absolute, relative, ~, $VAR / ${VAR} incl. VAR=… set earlier in the same
 * line), git -C, env/command/nohup/time wrappers, bash -c "…", $(…) and `…`. Quoted text is data,
 * not a command. When the directory cannot be resolved (unknown variable, cd -, …) the session
 * cwd is used — the old, conservative behaviour.
 *
 * Measured 2026-10-20 (session cwd = primary checkout on main, 10 shapes): the old prefix-cd
 * heuristic got 5 wrong — it blocked `W=…; cd $W && git commit`, `cd ~/…`, and a note whose
 * quoted text contained "; git commit", and it let `git -C <main> commit` and
 * `cd <wt> && cd <main> && git commit` through.
 */

'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BILINMEZ = Symbol('unresolved');
const AYRAC = new Set([';', '\n', '&', '|']);
const SARMALAYICI = new Set(['env', 'command', 'nohup', 'time', 'exec', 'builtin', 'sudo']);
const KABUK = new Set(['bash', 'sh', 'zsh', 'dash']);
const DEGERLI_GIT_SECENEGI = new Set(['-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

// $( … ) / ` … ` body starting right after the opener; returns [body, index after closer].
function altKomut(src, i, kapanis) {
  if (kapanis === '`') {
    const j = src.indexOf('`', i);
    return j < 0 ? [src.slice(i), src.length] : [src.slice(i, j), j + 1];
  }
  let derinlik = 1, j = i, tirnak = null;
  for (; j < src.length; j++) {
    const c = src[j];
    if (tirnak) { if (c === tirnak) tirnak = null; else if (c === '\\' && tirnak === '"') j++; continue; }
    if (c === "'" || c === '"') tirnak = c;
    else if (c === '(') derinlik++;
    else if (c === ')' && --derinlik === 0) break;
  }
  return [src.slice(i, j), j + 1];
}

// Shell-like lexer → [{ words: [[{t, q}]], subs: [string] }]; q: '' unquoted · '"' · "'" (no expansion).
function lex(src) {
  const cmds = [];
  let words = [], subs = [], parts = null, i = 0;
  const kelime = () => { if (parts) { words.push(parts); parts = null; } };
  const komut = () => { kelime(); if (words.length || subs.length) cmds.push({ words, subs }); words = []; subs = []; };
  const ekle = (t, q) => { (parts = parts || []).push({ t, q }); };
  while (i < src.length) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      ekle(j < 0 ? src.slice(i + 1) : src.slice(i + 1, j), "'"); i = j < 0 ? src.length : j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, t = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { t += src[j + 1]; j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '(') { const [b, n] = altKomut(src, j + 2, ')'); subs.push(b); t += '$(…)'; j = n; continue; }
        if (src[j] === '`') { const [b, n] = altKomut(src, j + 1, '`'); subs.push(b); t += '$(…)'; j = n; continue; }
        t += src[j++];
      }
      ekle(t, '"'); i = j + 1; continue;
    }
    if (c === '\\' && i + 1 < src.length) { if (src[i + 1] !== '\n') ekle(src[i + 1], "'"); i += 2; continue; }
    if (c === '$' && src[i + 1] === '(') { const [b, n] = altKomut(src, i + 2, ')'); subs.push(b); ekle('$(…)', ''); i = n; continue; }
    if (c === '`') { const [b, n] = altKomut(src, i + 1, '`'); subs.push(b); ekle('$(…)', ''); i = n; continue; }
    if (AYRAC.has(c)) { komut(); i++; continue; }
    if (c === '(' || c === ')') { komut(); cmds.push({ paren: c }); i++; continue; }   // alt kabuk sınırı
    if (c === ' ' || c === '\t') { kelime(); i++; continue; }
    if (c === '#' && !parts) { while (i < src.length && src[i] !== '\n') i++; continue; }
    let j = i, t = '';
    while (j < src.length && !AYRAC.has(src[j]) && !` \t'"\\\`()`.includes(src[j]) && !(src[j] === '$' && src[j + 1] === '(')) t += src[j++];
    if (j === i) { t = src[i]; j = i + 1; }   // 🔴 her tur en az bir karakter: ilerlemeyen döngü bütün Bash çağrılarını kilitler
    ekle(t, ''); i = j;
  }
  komut();
  return cmds;
}

function genislet(parts, vars, env) {
  let out = '';
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.q === "'") { out += p.t; continue; }
    let s = p.t;
    if (s.includes('$(…)')) return BILINMEZ;
    if (k === 0 && p.q === '' && (s === '~' || s.startsWith('~/'))) {
      if (!env.HOME) return BILINMEZ;
      s = env.HOME + s.slice(1);
    }
    let eksik = false;
    s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, a, b) => {
      const ad = a || b;
      const v = Object.prototype.hasOwnProperty.call(vars, ad) ? vars[ad] : env[ad];
      if (v === undefined || v === BILINMEZ) { eksik = true; return ''; }
      return v;
    });
    if (eksik || /\$[{A-Za-z_?#@*!0-9-]/.test(s)) return BILINMEZ;
    out += s;
  }
  return out;
}

const dizinMi = d => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
const atamaMi = parts => parts[0] && parts[0].q === '' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[0].t);
const ham = parts => parts.map(p => p.t).join('');

/** Directories `git commit` would run in, in order. Entry: absolute path · BILINMEZ (unresolved). */
function commitDizinleri(command, cwd, env = process.env, derinlik = 0) {
  const sonuc = [];
  if (!command || derinlik > 3) return sonuc;
  let cur = cwd ? path.resolve(cwd) : BILINMEZ;
  const vars = {}, yigin = [];
  for (const { words, subs, paren } of lex(command)) {
    // ( … ) alt kabuktur: içerdeki cd ve değişkenler dışarı TAŞINMAZ — girişte sakla, çıkışta geri koy
    if (paren === '(') { yigin.push([cur, { ...vars }]); continue; }
    if (paren === ')') { if (yigin.length) { const [c, v] = yigin.pop(); cur = c; for (const a of Object.keys(vars)) delete vars[a]; Object.assign(vars, v); } continue; }
    for (const b of subs) sonuc.push(...commitDizinleri(b, cur === BILINMEZ ? null : cur, { ...env, ...vars }, derinlik + 1));
    let k = 0;
    while (k < words.length && atamaMi(words[k])) k++;
    if (k === words.length) {   // VAR=değer satırı: aynı komut satırının sonrası için kabuk değişkeni
      for (const w of words) {
        const ad = w[0].t.slice(0, w[0].t.indexOf('='));
        vars[ad] = genislet([{ t: w[0].t.slice(ad.length + 1), q: '' }, ...w.slice(1)], vars, env);
      }
      continue;
    }
    while (k < words.length && SARMALAYICI.has(ham(words[k]))) {
      k++;
      while (k < words.length && (atamaMi(words[k]) || ham(words[k]).startsWith('-'))) k++;
    }
    if (k >= words.length) continue;
    const ad = genislet(words[k], vars, env);
    if (ad === 'cd' || ad === 'pushd') {
      let a = k + 1;
      while (a < words.length && /^-[LPe@]*$/.test(ham(words[a])) && ham(words[a]) !== '-') a++;
      if (a < words.length && ham(words[a]) === '--') a++;
      const hedef = a < words.length ? genislet(words[a], vars, env) : (env.HOME || BILINMEZ);
      let yeni;
      if (hedef === BILINMEZ || hedef === '-') yeni = BILINMEZ;
      else if (path.isAbsolute(hedef)) yeni = path.resolve(hedef);
      else yeni = cur === BILINMEZ ? BILINMEZ : path.resolve(cur, hedef);
      // Kabukta olmayan dizine cd BAŞARISIZ olur ve dizin DEĞİŞMEZ: `cd /yok; git commit` eski dizinde koşar (göz tur 1)
      if (yeni !== BILINMEZ && !dizinMi(yeni)) continue;
      cur = yeni;
      continue;
    }
    if (KABUK.has(ad)) {
      let a = k + 1;
      while (a < words.length && /^-[a-z]*$/.test(ham(words[a])) && !ham(words[a]).includes('c')) a++;
      if (a < words.length && /^-[a-z]*c[a-z]*$/.test(ham(words[a])) && a + 1 < words.length) {
        const ic = genislet(words[a + 1], vars, env);
        if (ic === BILINMEZ) { if (/\bcommit\b/.test(ham(words[a + 1]))) sonuc.push(BILINMEZ); }
        else sonuc.push(...commitDizinleri(ic, cur === BILINMEZ ? null : cur, { ...env, ...vars }, derinlik + 1));
      }
      continue;
    }
    if (ad !== 'git') continue;
    let a = k + 1, dizin = cur;
    while (a < words.length) {
      const s = ham(words[a]);
      if (s === '-C' && a + 1 < words.length) {
        const v = genislet(words[a + 1], vars, env);
        dizin = v === BILINMEZ || dizin === BILINMEZ ? (path.isAbsolute(String(v)) ? path.resolve(v) : BILINMEZ)
          : path.resolve(dizin, v);
        a += 2;
      } else if (DEGERLI_GIT_SECENEGI.has(s)) { if (s !== '-c') dizin = BILINMEZ; a += 2; }
      else if (/^--(git-dir|work-tree)=/.test(s)) { dizin = BILINMEZ; a++; }
      else if (s.startsWith('-')) a++;
      else break;
    }
    if (a < words.length && genislet(words[a], vars, env) === 'commit') sonuc.push(dizin);
  }
  return sonuc;
}

function isCommitOnMain(command, branch) {
  if (branch !== 'main' && branch !== 'master') return false;
  return commitDizinleri(command, null).length > 0;
}

module.exports = { isCommitOnMain, commitDizinleri, BILINMEZ };

function dalOku(dizin) {
  const opts = { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] };
  if (dizin) opts.cwd = dizin;
  return execSync('git branch --show-current', opts).trim();
}

if (require.main === module && !process.stdin.isTTY) {
  let data = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(data);
      const command = (input.tool_input && input.tool_input.command) || '';

      // Quick check: bail early if the word commit never appears
      if (!/commit/.test(command)) {
        process.stdout.write(data);
        return;
      }

      const oturum = input.cwd || null;
      for (const hedef of commitDizinleri(command, oturum)) {
        let branch;
        try {
          branch = dalOku(hedef === BILINMEZ ? oturum : hedef);
        } catch {
          // Hedefin dalı okunamadı (dizin yok / depo değil): serbest geçiş DEĞİL — oturum dizinine düş (eski temkinli davranış)
          try { branch = dalOku(oturum); } catch { continue; }   // oturum da okunamıyorsa eski kanca gibi geçir
        }
        if (branch === 'main' || branch === 'master') {
          process.stderr.write(
            'Blocked: git commit on main/master is not allowed. ' +
            'Create a feature branch first.\n'
          );
          process.exit(2);
        }
      }

      process.stdout.write(data);
    } catch {
      process.stdout.write(data);
    }
  });
}
