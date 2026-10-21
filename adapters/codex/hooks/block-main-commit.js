#!/usr/bin/env node
/**
 * PreToolUse hook for Bash — blocks git commit on main/master.
 *
 * Exit code 2 blocks the tool call (Codex respects this for PreToolUse,
 * matching Claude Code semantics). On pass-through emit `{}` so Codex's
 * stdout JSON contract is satisfied.
 *
 * The branch is read from the directory each commit ACTUALLY runs in, taken from the command itself
 * (cd, git -C, VAR=value, subshells) — not from the command text and not only from a leading `cd`.
 * Old behaviour read it from a leading `cd` or the session cwd and searched the raw text, so
 * `W=/wt; cd $W && <commit>`, `(cd /wt && <commit>)` or a quoted/heredoc mention were judged against the wrong
 * directory or the wrong text. A directory that cannot be resolved (unknown variable, command substitution)
 * is not judged: the hook lets it through, same as "branch unknown".
 */

'use strict';

const { execSync } = require('node:child_process');
const path = require('node:path');

const { extractCwdFromCommand } = require(path.join(__dirname, 'packages', 'git-status'));

const BILINMEZ = false; // directory could not be resolved from the command

/** Split a command into simple commands: quote- and escape-aware, heredoc bodies skipped, ( ) tracked. */
function bol(command) {
  const parcalar = [];
  let cur = '';
  let tirnak = null;
  let acan = false;
  const bas = () => { parcalar.push({ metin: cur, ac: acan, kapa: false }); cur = ''; acan = false; };
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
    if (c === '\n') { bas(); satirBasi = true; continue; }
    if (c === ';' || c === '&' || c === '|') { bas(); continue; }
    if (c === '(') { bas(); acan = true; continue; }
    if (c === ')') { bas(); parcalar.push({ metin: '', ac: false, kapa: true }); continue; }
    cur += c;
  }
  bas();
  return parcalar;
}

/** Split one simple command into words, removing quotes. */
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
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { tirnak = c; var_ = true; continue; }
    if (c === '\\' && i + 1 < metin.length) { cur += metin[++i]; var_ = true; continue; }
    if (/\s/.test(c)) { if (var_ || cur) out.push(cur); cur = ''; var_ = false; continue; }
    cur += c;
    var_ = true;
  }
  if (var_ || cur) out.push(cur);
  return out;
}

/** Expand $X / ${X} from earlier assignments. Unknown variable or command substitution -> null. */
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
  return bilinmiyor ? null : r;
}

/** Resolve a directory word against the current directory. null -> BILINMEZ. */
function coz(dizin, taban) {
  if (dizin === null || dizin === undefined) return BILINMEZ;
  if (dizin === '~' || dizin.startsWith('~/')) dizin = (process.env.HOME || '') + dizin.slice(1);
  if (dizin.startsWith('/')) return path.resolve(dizin);
  if (taban === BILINMEZ) return BILINMEZ;
  return taban ? path.resolve(taban, dizin) : BILINMEZ;
}

/**
 * For every real commit in the command, the directory it runs in.
 * Returns [{ cwd }] where cwd is an absolute path, null (= use the session/process directory) or BILINMEZ (false).
 */
function commitTargets(command, baseCwd) {
  const sonuc = [];
  const vars = {};
  const yigin = [];
  let cwd = baseCwd || null;
  for (const p of bol(command || '')) {
    if (p.kapa) { if (yigin.length) cwd = yigin.pop(); continue; }
    if (p.ac) yigin.push(cwd);
    const w = kelimeler(p.metin);
    const atamalar = [];
    while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) atamalar.push(w.shift());
    if (!w.length) {
      for (const a of atamalar) {
        const k = a.indexOf('=');
        const v = genislet(a.slice(k + 1), vars);
        if (v !== null) vars[a.slice(0, k)] = v;
      }
      continue;
    }
    if (w[0] === 'env' || w[0] === 'command' || w[0] === 'builtin') {
      w.shift();
      while (w.length && /^[A-Za-z_]\w*=/.test(w[0])) w.shift();
    }
    if (w[0] === 'cd' || w[0] === 'pushd') {
      const hedef = w.slice(1).find(x => !x.startsWith('-'));
      cwd = hedef === undefined ? (process.env.HOME || BILINMEZ) : coz(genislet(hedef, vars), cwd);
      continue;
    }
    if (w[0] !== 'git') continue;
    let i = 1;
    let efektif = cwd;
    while (i < w.length && w[i].startsWith('-')) {
      if (w[i] === '-C' && i + 1 < w.length) { efektif = coz(genislet(w[i + 1], vars), efektif); i += 2; continue; }
      if ((w[i] === '-c' || w[i] === '--exec-path' || w[i] === '--namespace') && i + 1 < w.length) { i += 2; continue; }
      if (w[i].startsWith('--work-tree=')) { efektif = coz(genislet(w[i].slice(12), vars), efektif); i += 1; continue; }
      i += 1;
    }
    if (w[i] === 'commit') sonuc.push({ cwd: efektif });
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
      const input = data.trim() ? JSON.parse(data) : {};
      const command = (input.tool_input && input.tool_input.command) || '';

      // Quick check: bail early if no commit word in the command
      if (!/git\b[\s\S]*\bcommit/.test(command)) {
        process.stdout.write('{}\n');
        return;
      }

      const sessionCwd = extractCwdFromCommand(command) || input.cwd || null;
      for (const h of commitTargets(command, sessionCwd)) {
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

      process.stdout.write('{}\n');
    } catch {
      process.stdout.write('{}\n');
    }
  });
}
