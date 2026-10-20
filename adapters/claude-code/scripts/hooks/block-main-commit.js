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
 * Conditional execution is modelled (&&, ||, |, &, ( … )): the directory is a SET of possible
 * directories, and the commit is blocked if ANY directory it may run in is on main — a cd that may
 * not run cannot hide a commit on main (independent review, round 2).
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

// Shell-like lexer → [{ words: [[{t, q}]], subs: [string], bag, arka, boru } | { paren, bag }]
//   q: '' unquoted · '"' · "'" (no expansion) · bag: connector BEFORE the command — 'bas' (start, ;, newline, &) · '&&' · '||' · '|'
//   arka: followed by a single & (background subshell) · boru: followed by | (pipeline element, subshell)
function lex(src) {
  const cmds = [];
  let words = [], subs = [], parts = null, i = 0, bag = 'bas';
  const kelime = () => { if (parts) { words.push(parts); parts = null; } };
  const komut = (bayrak) => {
    kelime();
    if (words.length || subs.length) cmds.push({ words, subs, bag });
    if (bayrak && cmds.length) cmds[cmds.length - 1][bayrak] = true;
    words = []; subs = [];
  };
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
    if (c === ';' || c === '\n') { komut(); bag = 'bas'; i++; continue; }
    if (c === '&') { if (src[i + 1] === '&') { komut(); bag = '&&'; i += 2; } else { komut('arka'); bag = 'bas'; i++; } continue; }
    if (c === '|') { if (src[i + 1] === '|') { komut(); bag = '||'; i += 2; } else { komut('boru'); bag = '|'; i++; } continue; }
    if (c === '(') { komut(); cmds.push({ paren: '(', bag }); bag = 'bas'; i++; continue; }   // alt kabuk girişi
    if (c === ')') { komut(); cmds.push({ paren: ')' }); i++; continue; }
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

const birlesim = (...kumeler) => [...new Set(kumeler.flat())];
const coz = (taban, hedef) => (hedef === BILINMEZ ? BILINMEZ : path.isAbsolute(hedef) ? path.resolve(hedef)
  : taban === BILINMEZ ? BILINMEZ : path.resolve(taban, hedef));

/**
 * Directories `git commit` would run in. Entry: absolute path · BILINMEZ (unresolved).
 *
 * The working directory is tracked as a SET of possible directories (göz tur 2): a cd that may not run
 * (`false && cd X; …`, `true || cd X; …`) or that runs in a subshell (pipeline element, background &,
 * ( … )) must not hide a commit that runs in the old directory. A commit is reported for EVERY
 * directory it may run in; the caller blocks if any of them is on main.
 *   · bag 'bas' (start of an and-or list): runs for sure, in the list-start set
 *   · '&&': runs only if the previous command succeeded → the set after that command
 *   · '||': runs after some failure → every set reached so far in the list
 *   · '|' / arka: subshell — its cd never reaches the parent
 * A cd to an existing directory succeeds; to a missing one it fails and changes nothing (göz tur 1).
 */
function commitDizinleri(command, cwd, env = process.env, derinlik = 0) {
  const sonuc = [];
  if (!command || derinlik > 3) return sonuc;
  let S = [cwd ? path.resolve(cwd) : BILINMEZ];
  let L;   // and-or list: A = set if the last command succeeded · U = every reachable set · det = all cds surely ran
  const yeniListe = () => { L = { A: S, U: S, det: true, kosuKesin: true, basariKesin: true, boruR: S }; };
  const listeyiKapat = () => { S = L.det ? L.A : L.U; };
  yeniListe();
  const vars = {}, yigin = [];
  const kosul = bag => ({
    R: bag === 'bas' ? S : bag === '&&' ? L.A : bag === '||' ? L.U : L.boruR,
    kesin: bag === 'bas' || (bag === '&&' && L.kosuKesin && L.basariKesin),
  });
  const genel = (R, kesin, basari) => { L.A = R; L.kosuKesin = kesin; L.basariKesin = basari; };
  for (const it of lex(command)) {
    if (it.paren === '(') {
      if (it.bag === 'bas') { listeyiKapat(); yeniListe(); }
      const { R, kesin } = kosul(it.bag);
      yigin.push({ S, L, vars: { ...vars }, R, kesin });
      S = R; yeniListe();
      continue;
    }
    if (it.paren === ')') {   // ( … ) alt kabuktur: içerdeki cd ve değişkenler dışarı TAŞINMAZ
      if (!yigin.length) continue;
      const f = yigin.pop();
      S = f.S; L = f.L; for (const a of Object.keys(vars)) delete vars[a]; Object.assign(vars, f.vars);
      genel(f.R, f.kesin, false);
      continue;
    }
    const { words, subs, bag, arka, boru } = it;
    if (bag === 'bas') { listeyiKapat(); yeniListe(); }
    const { R, kesin } = kosul(bag);
    if (boru && bag !== '|') L.boruR = R;   // boru hattının ilk öğesi: hattın her öğesi bu kümede başlar
    const altKabuk = arka || boru || bag === '|';
    for (const b of subs) for (const r of R) sonuc.push(...commitDizinleri(b, r === BILINMEZ ? null : r, { ...env, ...vars }, derinlik + 1));
    let k = 0;
    while (k < words.length && atamaMi(words[k])) k++;
    if (k === words.length) {   // VAR=değer satırı: aynı komut satırının sonrası için kabuk değişkeni
      for (const w of words) {
        const ad = w[0].t.slice(0, w[0].t.indexOf('='));
        vars[ad] = genislet([{ t: w[0].t.slice(ad.length + 1), q: '' }, ...w.slice(1)], vars, env);
      }
      genel(R, kesin, true);
      continue;
    }
    while (k < words.length && SARMALAYICI.has(ham(words[k]))) {
      k++;
      while (k < words.length && (atamaMi(words[k]) || ham(words[k]).startsWith('-'))) k++;
    }
    if (k >= words.length) { genel(R, kesin, false); continue; }
    const ad = genislet(words[k], vars, env);
    if ((ad === 'cd' || ad === 'pushd') && !altKabuk) {
      let a = k + 1;
      while (a < words.length && /^-[LPe@]*$/.test(ham(words[a])) && ham(words[a]) !== '-') a++;
      if (a < words.length && ham(words[a]) === '--') a++;
      let hedef = a < words.length ? genislet(words[a], vars, env) : (env.HOME || BILINMEZ);
      if (hedef === '-') hedef = BILINMEZ;
      // Kabukta olmayan dizine cd BAŞARISIZ olur ve dizin DEĞİŞMEZ: `cd /yok; git commit` eski dizinde koşar (göz tur 1)
      let hepsiVar = true;
      const yeni = birlesim(R.map(r => { const y = coz(r, hedef); if (y !== BILINMEZ && !dizinMi(y)) { hepsiVar = false; return r; } return y; }));
      L.A = yeni;
      L.U = kesin ? birlesim(yeni) : birlesim(L.U, yeni);   // kesin koşan cd'den önceki dizine artık dönülemez
      if (!kesin) L.det = false;
      L.kosuKesin = kesin; L.basariKesin = hepsiVar;
      continue;
    }
    if (KABUK.has(ad)) {
      let a = k + 1;
      while (a < words.length && /^-[a-z]*$/.test(ham(words[a])) && !ham(words[a]).includes('c')) a++;
      if (a < words.length && /^-[a-z]*c[a-z]*$/.test(ham(words[a])) && a + 1 < words.length) {
        const ic = genislet(words[a + 1], vars, env);
        if (ic === BILINMEZ) { if (/\bcommit\b/.test(ham(words[a + 1]))) sonuc.push(BILINMEZ); }
        else for (const r of R) sonuc.push(...commitDizinleri(ic, r === BILINMEZ ? null : r, { ...env, ...vars }, derinlik + 1));
      }
      genel(R, kesin, false);
      continue;
    }
    if (ad === 'git') {
      let a = k + 1, C = null, belirsiz = false;
      while (a < words.length) {
        const s = ham(words[a]);
        if (s === '-C' && a + 1 < words.length) { C = C === null ? [] : C; C.push(genislet(words[a + 1], vars, env)); a += 2; }
        else if (DEGERLI_GIT_SECENEGI.has(s)) { if (s !== '-c') belirsiz = true; a += 2; }
        else if (/^--(git-dir|work-tree)=/.test(s)) { belirsiz = true; a++; }
        else if (s.startsWith('-')) a++;
        else break;
      }
      if (a < words.length && genislet(words[a], vars, env) === 'commit') {
        for (const r of R) {
          let d = r;
          for (const c of C || []) d = coz(d, c);
          sonuc.push(belirsiz ? BILINMEZ : d);
        }
      }
    }
    genel(R, kesin, false);
  }
  return birlesim(sonuc);
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
