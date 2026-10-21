#!/usr/bin/env node
/**
 * PreToolUse hook for Bash — blocks git commit on main/master.
 *
 * Exit code 2 blocks the tool call. Writes reason to stderr.
 *
 * The branch is read from the directory each commit ACTUALLY runs in, taken from the command itself
 * (cd, git -C, VAR=value, subshells, pipelines, && / ||) — not from the command text and not only from a leading `cd`.
 * Old behaviour read it from a leading `cd` or the session cwd and searched the raw text, so
 * `W=/wt; cd $W && <commit>`, `(cd /wt && <commit>)` or a quoted/heredoc mention were judged against the wrong
 * directory or the wrong text.
 *
 * Model: the hook cannot run the shell, so it tracks the SET of directories a commit may run in.
 * A `cd` whose outcome is certain (existing directory, nothing unknown before it in the chain) replaces the set; when the
 * outcome is uncertain (`make && cd X; <commit>`, `X || cd Y`) both possibilities stay in the set and the commit is judged in
 * every one — one main/master directory is enough to block. A directory that cannot be resolved at all (unknown variable,
 * command substitution) is not judged: the hook lets it through, same as "branch unknown".
 *
 * Known limit (documented, not modelled): the bodies of conditional compounds (`if/then/else`, `while/do`, `case`) are
 * treated as if they always run. `if false; then cd /wt; fi; <commit>` is therefore judged in /wt although the `cd` never
 * happened. This is a guard rail against honest mistakes, not a security boundary; the deliberate constructed case is out of scope.
 */

'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const BILINMEZ = false; // directory could not be resolved from the command
const LIT = '\u0001';    // marks a `$` that came from single quotes (literal, never expanded)
const SARMAL = new Set(['sudo', 'nohup', 'exec', 'setsid', 'nice', 'ionice']); // wrappers that run their argument unchanged
const KABUK = new Set(['bash', 'sh', 'zsh', 'dash']);                          // `<shell> -c "<command>"`
const ANAHTAR = new Set(['if', 'then', 'else', 'elif', 'while', 'until', 'do', '!', 'time', '{']); // shell keywords that prefix a command

/** Split a command into simple commands: quote- and escape-aware, heredoc bodies skipped, ( ) tracked.
 *  Each part: { metin, ac, kapa, sep, on } — sep = separator FOLLOWING it, on = separator BEFORE it. */
function bol(command) {
  const parcalar = [];
  let cur = '';
  let tirnak = null;
  let acan = false;
  let onceki = ';';
  const bas = (sep) => { parcalar.push({ metin: cur, ac: acan, kapa: false, sep: sep || ';', on: onceki }); cur = ''; acan = false; onceki = sep || ';'; };
  const heredoc = [];
  let satirBasi = true;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (heredoc.length && satirBasi) {
      const son = command.indexOf('\n', i);
      const satir = command.slice(i, son === -1 ? command.length : son).trim();
      if (satir === heredoc[0]) heredoc.shift();
      if (son === -1) break;
      i = son;
      satirBasi = true;
      continue;
    }
    satirBasi = false;
    if (tirnak) {
      cur += c;
      if (c === '\\' && tirnak === '"' && i + 1 < command.length) cur += command[++i];
      else if (c === tirnak) tirnak = null;
      continue;
    }
    if (c === '\\' && i + 1 < command.length) { cur += c + command[++i]; continue; }
    if (c === "'" || c === '"') { tirnak = c; cur += c; continue; }
    if (c === '<' && command[i + 1] === '<' && command[i + 2] !== '<') {
      const m = command.slice(i + 2).match(/^-?\s*(?:'([^']+)'|"([^"]+)"|(\w+))/);
      if (m) heredoc.push(m[1] || m[2] || m[3]);
      cur += c;
      continue;
    }
    if (c === '#' && (cur === '' || /\s/.test(cur[cur.length - 1]))) {
      // shell comment: an unquoted `#` at the start of a word runs to the end of the line (`$#`, `a#b`, `${#x}` are not comments)
      const son = command.indexOf('\n', i);
      if (son === -1) break;
      i = son - 1;
      continue;
    }
    if (c === '\n') { bas(';'); satirBasi = true; continue; }
    if (c === ';') { bas(';'); continue; }
    if (c === '&' || c === '|') {
      // redirections (2>&1, >&2, <&3, &>file) keep the `&` inside the word
      if (c === '&' && (command[i - 1] === '>' || command[i - 1] === '<' || command[i + 1] === '>')) { cur += c; continue; }
      if (command[i + 1] === c) { bas(c + c); i++; continue; }   // && or ||
      bas(c);                                                      // single & (background) or | (pipe)
      continue;
    }
    if (c === '(') { bas(';'); acan = true; continue; }
    if (c === ')') { bas(';'); parcalar.push({ metin: '', ac: false, kapa: true, sep: ';', on: ';' }); continue; }
    cur += c;
  }
  bas(';');
  return parcalar;
}

/** Split one simple command into words, removing quotes. A `$` inside single quotes becomes LIT (never expanded). */
function kelimeler(metin) {
  const out = [];
  let cur = '';
  let var_ = false;
  let tirnak = null;
  for (let i = 0; i < metin.length; i++) {
    const c = metin[i];
    if (tirnak) {
      if (c === tirnak) tirnak = null;
      else if (c === '\\' && tirnak === '"' && i + 1 < metin.length) cur += metin[++i];
      else cur += (tirnak === "'" && c === '$') ? LIT : c;
      continue;
    }
    if (c === "'" || c === '"') { tirnak = c; var_ = true; continue; }
    if (c === '\\' && metin[i + 1] === '\n') { i++; continue; }   // line continuation
    if (c === '\\' && i + 1 < metin.length) { cur += metin[++i] === '$' ? LIT : metin[i]; var_ = true; continue; }
    if (/\s/.test(c)) { if (var_ || cur) out.push(cur); cur = ''; var_ = false; continue; }
    cur += c;
    var_ = true;
  }
  if (var_ || cur) out.push(cur);
  return out;
}

/** Expand $X / ${X} from earlier assignments. Unknown variable or command substitution -> null. LIT dollars stay literal. */
function genislet(deger, vars) {
  if (/\$\(|`/.test(deger)) return null;
  let bilinmiyor = false;
  const r = deger.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => {
    const ad = a || b;
    if (Object.prototype.hasOwnProperty.call(vars, ad)) return vars[ad];
    if (ad === 'HOME' && process.env.HOME) return process.env.HOME;
    bilinmiyor = true;
    return '';
  });
  return bilinmiyor ? null : r.split(LIT).join('$');
}

/** Resolve a directory word against the current directory. null -> BILINMEZ. */
function coz(dizin, taban) {
  if (dizin === null || dizin === undefined) return BILINMEZ;
  if (dizin === '~' || dizin.startsWith('~/')) dizin = (process.env.HOME || '') + dizin.slice(1);
  if (dizin.startsWith('/')) return path.resolve(dizin);
  if (taban === BILINMEZ) return BILINMEZ;
  return taban ? path.resolve(taban, dizin) : BILINMEZ;
}

function dizinMi(d) {
  try { return fs.statSync(d).isDirectory(); } catch { return false; }
}

const esit = (a, b) => a === b;
function birlesim(...kumeler) {
  const out = [];
  for (const k of kumeler) for (const x of k) if (!out.some(y => esit(x, y))) out.push(x);
  return out;
}

/** Apply `cd target` to a set of possible directories. Returns { kume, durum }: durum true/false/null = exit status known/unknown. */
function cdUygula(kume, hedefKelime, vars, onceki) {
  if (hedefKelime === '-') {
    return { kume: onceki && onceki.length ? onceki : [BILINMEZ], durum: onceki && onceki.length ? true : null };
  }
  let basari = 0;
  let basarisiz = 0;
  const yeni = kume.map(c => {
    const t = hedefKelime === undefined
      ? (process.env.HOME || BILINMEZ)
      : coz(genislet(hedefKelime, vars), c);
    if (t === BILINMEZ || c === BILINMEZ) return BILINMEZ;
    if (dizinMi(t)) { basari++; return t; }
    basarisiz++;   // cd fails in a real shell -> directory unchanged
    return c;
  });
  const durum = basari && !basarisiz ? true : (basarisiz && !basari ? false : null);
  return { kume: birlesim(yeni), durum };
}

/**
 * For every real commit in the command, the directories it may run in.
 * Returns [{ cwd }] where cwd is an absolute path, null (= use the session/process directory) or BILINMEZ (false).
 */
function commitTargets(command, baseCwd, depth = 0) {
  const sonuc = [];
  let vars = {};
  const yigin = [];
  const pd = [];            // pushd stack (each entry a set)
  let cur = [baseCwd === BILINMEZ ? BILINMEZ : (baseCwd || null)];   // directories the NEXT part may run in (success path)
  let dur = [];             // extra possible directories if an earlier unknown command in the chain failed (early stop)
  let st = true;            // exit status of the previous part: true / false / null (unknown)
  let onceki = null;        // previous directory set, for `cd -`
  let geri = null;          // state to restore after a part that ran in a subshell (pipeline element or background job)

  const ekle = (kume) => { for (const c of kume) if (!sonuc.some(s => esit(s.cwd, c))) sonuc.push({ cwd: c }); };

  for (const p of bol(command || '')) {
    if (geri) { ({ cur, dur, st, vars, onceki } = geri); geri = null; }
    if (p.kapa) {
      if (yigin.length) { const y = yigin.pop(); cur = y.cur; dur = y.dur; vars = y.vars; onceki = y.onceki; st = null; }
      continue;
    }
    if (p.ac) yigin.push({ cur, dur, vars: { ...vars }, onceki });
    if (p.sep === '|' || p.sep === '&' || p.on === '|') geri = { cur, dur, st, vars: { ...vars }, onceki };

    // chain start (; newline after a group): the set a later command sees is everything the previous chain could end in
    if (p.on === ';') { cur = birlesim(cur, dur); dur = []; st = true; }

    // is this part executed? && needs a not-failed predecessor (success path; the failed predecessor is already in `dur`),
    // || needs a not-succeeded one; an unknown predecessor makes a || part "maybe": both outcomes stay possible
    let calisir = true;
    let belki = false;
    if (p.on === '&&' && st === false) calisir = false;
    if (p.on === '||') { if (st === true) calisir = false; else if (st === null) belki = true; }
    if (!calisir) continue;

    const w = kelimeler(p.metin);
    while (w.length && ANAHTAR.has(w[0])) w.shift();   // `then git ...`, `do git ...`, `! git ...` are still the command
    const atamalar = [];
    while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) atamalar.push(w.shift());
    if (!w.length) {
      for (const a of atamalar) {
        const k = a.indexOf('=');
        const v = genislet(a.slice(k + 1), vars);
        if (v !== null) vars[a.slice(0, k)] = v;
      }
      st = true;
      continue;
    }
    if (w[0] === 'env' || w[0] === 'command' || w[0] === 'builtin') {
      w.shift();
      while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w.shift();
    }
    while (w.length > 1 && SARMAL.has(w[0])) w.shift();   // `sudo git ...`, `nohup git ...` run the same command
    const ad = w[0];

    // `bash -c "cd x && git ..."`: the string is a command of its own; it runs in a child shell, so nothing leaks back
    if (KABUK.has(ad)) {
      const ci = w.findIndex(x => /^-[a-z]*c[a-z]*$/.test(x));
      if (ci > 0 && w[ci + 1] !== undefined && depth < 3) {
        for (const c of cur) {
          for (const t of commitTargets(w[ci + 1], c, depth + 1)) ekle([t.cwd]);
        }
      }
      st = null;
      dur = birlesim(dur, cur);
      continue;
    }

    if (ad === 'cd' || ad === 'pushd' || ad === 'popd') {
      let sonra;
      let durum;
      if (ad === 'popd') {
        const g = pd.pop();
        sonra = g || [BILINMEZ];
        durum = g ? true : null;
      } else {
        const hedef = w.slice(1).find(x => !x.startsWith('-') || x === '-');
        const r = cdUygula(cur, hedef, vars, onceki);
        sonra = r.kume;
        durum = r.durum;
        if (ad === 'pushd') pd.push(cur);
      }
      onceki = cur;
      cur = belki ? birlesim(cur, sonra) : sonra;
      st = belki ? null : durum;
      continue;
    }

    if (ad === 'git') {
      let i = 1;
      let efektif = cur;
      while (i < w.length && w[i].startsWith('-')) {
        if (w[i] === '-C' && i + 1 < w.length) {
          const d = w[i + 1];
          efektif = efektif.map(c => (c === BILINMEZ ? BILINMEZ : coz(genislet(d, vars), c)));
          i += 2;
          continue;
        }
        if ((w[i] === '-c' || w[i] === '--exec-path' || w[i] === '--namespace') && i + 1 < w.length) { i += 2; continue; }
        if (w[i].startsWith('--work-tree=')) {
          const d = w[i].slice(12);
          efektif = efektif.map(c => (c === BILINMEZ ? BILINMEZ : coz(genislet(d, vars), c)));
          i += 1;
          continue;
        }
        i += 1;
      }
      if (w[i] === 'commit') {
        // after `||` the commit runs when the predecessor FAILED, so the early-stop directories count too
        ekle(p.on === '||' ? birlesim(efektif, dur) : efektif);
      }
    }

    // any other command: exit status unknown; if it fails the chain stops here, so the current set is a possible END state
    if (ad === 'true' || ad === ':') st = true;
    else if (ad === 'false') st = false;
    else { st = null; dur = birlesim(dur, cur); }
  }
  return sonuc;
}

/** Kept for callers/tests: is there a real commit command, and is the given branch main/master? */
function isCommitOnMain(command, branch) {
  if (branch !== 'main' && branch !== 'master') return false;
  return commitTargets(command, null).length > 0;
}

module.exports = { isCommitOnMain, commitTargets, bol, kelimeler, BILINMEZ };

if (require.main === module && !process.stdin.isTTY) {
  let data = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => {
    try {
      const input = JSON.parse(data);
      const command = (input.tool_input && input.tool_input.command) || '';

      // Quick check: bail early if no commit word in the command
      if (!/git\b[\s\S]*\bcommit/.test(command)) {
        process.stdout.write(data);
        return;
      }

      // Session directory only: a leading `cd` is applied by commitTargets itself (applying it here too would resolve a
      // relative `cd sub` twice).
      for (const h of commitTargets(command, input.cwd || null)) {
        if (h.cwd === BILINMEZ) continue; // directory unknown -> not judged (same as "branch unknown")
        let branch;
        try {
          const opts = { encoding: 'utf8', timeout: 3000 };
          if (h.cwd) opts.cwd = h.cwd;
          branch = execSync('git branch --show-current', opts).trim();
        } catch {
          continue; // can't determine branch — let it through
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
