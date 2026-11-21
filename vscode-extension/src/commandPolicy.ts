// Rizo — Copyright (c) 2026 Chaitanya Aggarwal
// Licensed under the Apache License, Version 2.0, modified by the
// Commons Clause (no resale) — see LICENSE for the full terms.

// Understands a shell command well enough to warn about the destructive
// ones, keeps secrets out of the environment commands run with, and caps
// their output. No 'vscode' import: tested in commandPolicy.test.ts.
//
// Regexes over the raw string (destructiveCommands.ts) are easy to get
// around: quoting ('rm' -rf), line continuations, "git -C . push -f",
// "rm -r -f", "sudo"/"env"/"xargs" wrappers, interpreter one-liners. So
// the command is tokenized like a POSIX shell would, split into its simple
// commands (; && || | & newline and subshells), and each one is checked
// on its real words. Anything whose effect can't be seen statically
// (command substitution, a command name taken from a variable, inline
// interpreter code, code piped into an interpreter) counts as destructive:
// an extra confirmation is the safe failure.

import * as path from 'path';

// ---------- tokenizing ----------

export interface SimpleCommand {
  argv: string[];
  // true when this command reads the previous one's output through a pipe
  pipedFrom: boolean;
  // true when it reads a here-document (<<EOF ... EOF)
  heredoc?: boolean;
}

export interface ParsedCommand {
  commands: SimpleCommand[];
  // Reasons the command can't be fully analysed (substitutions, unclosed quotes).
  opaque: string[];
}

export function parseShellCommand(input: string): ParsedCommand {
  const s = input.replace(/\\\r?\n/g, ''); // line continuations join lines
  const commands: SimpleCommand[] = [];
  const opaque: string[] = [];
  let argv: string[] = [];
  let word = '';
  let inWord = false;
  let pipedFrom = false;
  let skipNextWord = false; // the target of a redirection isn't an argument
  let heredoc = false;
  let heredocDelimiter: string | undefined;
  let heredocStripTabs = false;

  const pushWord = () => {
    if (inWord) {
      if (skipNextWord) skipNextWord = false;
      else argv.push(word);
    }
    word = '';
    inWord = false;
  };
  const endCommand = (nextPiped: boolean) => {
    pushWord();
    if (argv.length) commands.push(heredoc ? { argv, pipedFrom, heredoc } : { argv, pipedFrom });
    argv = [];
    pipedFrom = nextPiped;
    heredoc = false;
  };
  // At the end of the line that started a here-document, skip its body up
  // to the delimiter line: the body is input text, not commands.
  const skipHeredocBody = (lineEnd: number): number => {
    const delim = heredocDelimiter as string;
    heredocDelimiter = undefined;
    let pos = lineEnd + 1;
    while (pos <= s.length) {
      const nl = s.indexOf('\n', pos);
      const line = s.slice(pos, nl === -1 ? s.length : nl).replace(/\r$/, '');
      if ((heredocStripTabs ? line.replace(/^\t+/, '') : line) === delim) return nl === -1 ? s.length : nl;
      if (nl === -1) return s.length;
      pos = nl + 1;
    }
    return s.length;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];

    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) {
        opaque.push('unclosed quote');
        word += s.slice(i + 1);
        inWord = true;
        break;
      }
      word += s.slice(i + 1, end);
      inWord = true;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j++) {
        if (s[j] === '\\' && j + 1 < s.length) {
          word += s[j + 1];
          j++;
          continue;
        }
        if (s[j] === '`' || (s[j] === '$' && s[j + 1] === '(')) opaque.push('command substitution');
        word += s[j];
      }
      if (j >= s.length) opaque.push('unclosed quote');
      inWord = true;
      i = j;
      continue;
    }
    if (c === '\\') {
      if (i + 1 < s.length) {
        word += next;
        i++;
        inWord = true;
      }
      continue;
    }
    if (c === '`') {
      opaque.push('command substitution');
      word += c;
      inWord = true;
      continue;
    }
    if (c === '$' && next === '(') {
      opaque.push('command substitution');
      word += c;
      inWord = true;
      continue;
    }
    if ((c === '<' || c === '>') && next === '(') {
      opaque.push('process substitution');
      word += c;
      inWord = true;
      continue;
    }
    if (c === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (c === ' ' || c === '\t') {
      pushWord();
      continue;
    }
    if (c === '\n' && heredocDelimiter !== undefined) {
      endCommand(false);
      i = skipHeredocBody(i);
      continue;
    }
    if (c === '\n' || c === '\r' || c === ';') {
      endCommand(false);
      continue;
    }
    if (c === '(' || c === ')') {
      endCommand(false);
      continue;
    }
    if (c === '|') {
      if (next === '|') {
        i++;
        endCommand(false);
      } else {
        if (next === '&') i++; // |&
        endCommand(true);
      }
      continue;
    }
    if (c === '&') {
      if (next === '&') {
        i++;
        endCommand(false);
      } else if (next === '>') {
        pushWord();
        i++;
        if (s[i + 1] === '>') i++;
        skipNextWord = true;
      } else {
        endCommand(false);
      }
      continue;
    }
    if (c === '<' && next === '<' && s[i + 2] !== '<') {
      // Here-document: remember the delimiter; its body is skipped at the
      // end of this line.
      pushWord();
      i += 2;
      heredocStripTabs = s[i] === '-';
      if (heredocStripTabs) i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      let delim = '';
      while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
        if (s[i] !== "'" && s[i] !== '"' && s[i] !== '\\') delim += s[i];
        i++;
      }
      i--;
      heredoc = true;
      if (delim) heredocDelimiter = delim;
      continue;
    }
    if (c === '>' || c === '<') {
      // "2>" / "2>&1": a bare file-descriptor number before the operator
      // belongs to the redirection, not the argument list.
      if (inWord && /^\d+$/.test(word)) {
        word = '';
        inWord = false;
      } else {
        pushWord();
      }
      while (s[i + 1] === '>' || s[i + 1] === '<' || s[i + 1] === '|') i++;
      if (s[i + 1] === '&') {
        i++;
        while (/[0-9-]/.test(s[i + 1] ?? '')) i++; // >&2, <&-
      } else {
        skipNextWord = true;
      }
      continue;
    }
    word += c;
    inWord = true;
  }
  endCommand(false);
  return { commands, opaque: [...new Set(opaque)] };
}

// ---------- unwrapping ----------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'csh', 'tcsh']);
const INTERPRETERS = new Set([
  'node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'pypy', 'pypy3', 'perl', 'ruby', 'php', 'lua',
  'osascript', 'powershell', 'pwsh', 'powershell.exe', 'pwsh.exe', 'cmd', 'cmd.exe',
]);

function programName(word: string): string {
  return path.basename(word.replace(/\\/g, '/')).toLowerCase();
}

// Strips leading VAR=value assignments and wrapper commands (sudo, env,
// xargs, nohup, timeout, ...) to find the command that actually runs.
export function unwrapCommand(argv: readonly string[]): string[] {
  let a = [...argv];
  for (let guard = 0; guard < 20 && a.length; guard++) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a[0])) {
      a = a.slice(1);
      continue;
    }
    const prog = programName(a[0]);
    const skipFlags = (withValue: string[]) => {
      let i = 1;
      while (i < a.length && a[i].startsWith('-')) {
        if (a[i] === '--') {
          i++;
          break;
        }
        i += withValue.includes(a[i]) ? 2 : 1;
      }
      return i;
    };
    if (prog === 'sudo' || prog === 'doas') {
      a = a.slice(skipFlags(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T']));
      continue;
    }
    if (prog === 'env') {
      let i = skipFlags(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']);
      while (i < a.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a[i])) i++;
      a = a.slice(i);
      continue;
    }
    if (prog === 'xargs') {
      a = a.slice(skipFlags(['-I', '-i', '-n', '-P', '-L', '-l', '-d', '-s', '-E', '-e', '-a', '--max-args', '--max-procs', '--delimiter', '--arg-file']));
      continue;
    }
    if (prog === 'timeout' || prog === 'gtimeout') {
      const i = skipFlags(['-s', '-k', '--signal', '--kill-after']);
      a = a.slice(i + 1); // the duration
      continue;
    }
    if (prog === 'nice' || prog === 'ionice' || prog === 'stdbuf' || prog === 'chrt' || prog === 'taskset') {
      a = a.slice(skipFlags(['-n', '-c', '-i', '-o', '-e', '-p']));
      continue;
    }
    if (['command', 'builtin', 'exec', 'nohup', 'time', 'caffeinate', 'unbuffer', 'noglob', 'busybox', 'then', 'do', 'else', '!'].includes(prog)) {
      a = a.slice(skipFlags([]));
      continue;
    }
    break;
  }
  return a;
}

// ---------- checks ----------

function shortFlags(args: readonly string[]): string {
  return args.filter((x) => /^-[A-Za-z]+$/.test(x)).map((x) => x.slice(1)).join('');
}

function hasAny(args: readonly string[], ...flags: string[]): boolean {
  return args.some((x) => flags.includes(x));
}

const GIT_GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--exec-path']);

function gitReasons(argsAfterGit: readonly string[]): string[] {
  let i = 0;
  while (i < argsAfterGit.length && argsAfterGit[i].startsWith('-')) {
    i += GIT_GLOBAL_WITH_VALUE.has(argsAfterGit[i]) ? 2 : 1;
  }
  const sub = argsAfterGit[i];
  const args = argsAfterGit.slice(i + 1);
  const flags = shortFlags(args);
  const positional = args.filter((x) => !x.startsWith('-'));
  const reasons: string[] = [];
  switch (sub) {
    case 'push':
      if (hasAny(args, '--force', '--force-if-includes') || args.some((x) => x.startsWith('--force-with-lease')) || flags.includes('f')) {
        reasons.push('git push --force rewrites history on the remote');
      }
      if (hasAny(args, '--delete', '--mirror', '--prune') || flags.includes('d')) reasons.push('git push deletes remote branches or tags');
      if (positional.slice(1).some((r) => r.startsWith('+'))) reasons.push('git push +refspec force-pushes');
      if (positional.slice(1).some((r) => r.startsWith(':'))) reasons.push('git push :branch deletes a remote branch');
      break;
    case 'reset':
      if (hasAny(args, '--hard', '--merge')) reasons.push('git reset --hard throws away uncommitted changes');
      break;
    case 'branch':
      if (flags.includes('D') || flags.includes('M') || flags.includes('C') ||
          ((flags.includes('d') || hasAny(args, '--delete')) && (flags.includes('f') || hasAny(args, '--force')))) {
        reasons.push('git branch force-deletes or overwrites a branch');
      }
      break;
    case 'clean':
      if (flags.includes('f') || hasAny(args, '--force')) reasons.push('git clean deletes untracked files');
      break;
    case 'checkout':
      if (flags.includes('f') || hasAny(args, '--force', '.') || args.includes('--')) {
        reasons.push('git checkout can discard uncommitted changes');
      }
      break;
    case 'restore':
      if (!hasAny(args, '--staged', '-S') || hasAny(args, '--worktree', '-W')) reasons.push('git restore discards uncommitted changes');
      break;
    case 'stash':
      if (args[0] === 'drop' || args[0] === 'clear') reasons.push('git stash drop/clear deletes stashed work');
      break;
    case 'reflog':
      if (args[0] === 'expire' || args[0] === 'delete') reasons.push('git reflog expire/delete removes recovery points');
      break;
    case 'update-ref':
      if (flags.includes('d')) reasons.push('git update-ref -d deletes a ref');
      break;
    case 'gc':
      if (args.some((x) => x.startsWith('--prune=now'))) reasons.push('git gc --prune=now removes unreachable commits');
      break;
    case 'filter-branch':
    case 'filter-repo':
      reasons.push(`git ${sub} rewrites history`);
      break;
  }
  return reasons;
}

const DELETING_PROGRAMS = new Set(['rm', 'unlink', 'shred', 'rmdir', 'srm', 'wipe']);

function simpleCommandReasons(cmd: SimpleCommand): string[] {
  const a = unwrapCommand(cmd.argv);
  if (!a.length) return [];
  const reasons: string[] = [];
  const rawName = a[0];
  const prog = programName(rawName);
  const args = a.slice(1);
  const flags = shortFlags(args);
  const positional = args.filter((x) => !x.startsWith('-'));

  if (rawName !== '[' && rawName !== '[[' && /[$*?[\]{}]/.test(rawName)) reasons.push('the command name comes from a variable or pattern, so what runs can\'t be seen');
  if (prog === 'eval') reasons.push('eval runs text as a command');

  if (SHELLS.has(prog) || INTERPRETERS.has(prog)) {
    const inline =
      (SHELLS.has(prog) && args.some((x) => /^-[A-Za-z]*c[A-Za-z]*$/.test(x) || x === '--command')) ||
      (['node', 'nodejs', 'bun'].includes(prog) && hasAny(args, '-e', '--eval', '-p', '--print')) ||
      (prog === 'deno' && (args[0] === 'eval' || hasAny(args, '-e', '--eval'))) ||
      (/^(python|pypy)/.test(prog) && hasAny(args, '-c')) ||
      (['perl', 'ruby', 'lua'].includes(prog) && args.some((x) => /^-[A-Za-z]*[eE]$/.test(x))) ||
      (prog === 'php' && hasAny(args, '-r')) ||
      (prog === 'osascript' && hasAny(args, '-e')) ||
      (/^(powershell|pwsh)/.test(prog) && args.some((x) => /^-(c|command|e|ec|enc|encodedcommand)$/i.test(x))) ||
      (/^cmd(\.exe)?$/.test(prog) && args.some((x) => /^\/[ck]$/i.test(x)));
    const readsStdinScript = positional.length === 0 || positional[0] === '-' || (SHELLS.has(prog) && flags.includes('s'));
    if (inline) reasons.push(`${prog} runs inline code that can't be checked`);
    else if (cmd.heredoc && readsStdinScript) reasons.push(`${prog} runs a script given inline (here-document)`);
    else if (cmd.pipedFrom && readsStdinScript) reasons.push(`${prog} runs code piped in from another command`);
  }

  switch (prog) {
    case 'git':
      reasons.push(...gitReasons(args));
      break;
    case 'rm':
      if (/[rR]/.test(flags) || hasAny(args, '--recursive')) reasons.push('rm -r deletes folders and everything in them');
      else if ((flags.includes('f') || hasAny(args, '--force')) && positional.some((p) => /[*?[]/.test(p))) {
        reasons.push('rm -f with a wildcard deletes matching files without asking');
      }
      if (hasAny(args, '--no-preserve-root')) reasons.push('rm --no-preserve-root');
      break;
    case 'find':
      if (hasAny(args, '-delete')) reasons.push('find -delete deletes the files it finds');
      args.forEach((x, i) => {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(x)) {
          const target = programName(args[i + 1] ?? '');
          if (DELETING_PROGRAMS.has(target) || SHELLS.has(target) || INTERPRETERS.has(target)) {
            reasons.push(`find ${x} ${target} runs on every file found`);
          }
        }
      });
      break;
    case 'shred':
    case 'srm':
    case 'wipe':
    case 'wipefs':
    case 'fdisk':
    case 'sfdisk':
    case 'parted':
    case 'truncate':
    case 'format':
    case 'format.com':
      reasons.push(`${prog} destroys data`);
      break;
    case 'dd':
      if (args.some((x) => x.startsWith('of='))) reasons.push('dd of= overwrites its target');
      break;
    case 'diskutil':
      if (args.some((x) => /^(erase|zero|secureErase|partitionDisk|reformat)/i.test(x))) reasons.push('diskutil erases a disk');
      break;
    case 'remove-item':
    case 'ri':
      if (args.some((x) => /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(x))) reasons.push('Remove-Item -Recurse deletes folders');
      break;
    case 'del':
    case 'erase':
      if (args.some((x) => /^\/[sq]$/i.test(x))) reasons.push(`${prog} /s deletes files in every subfolder`);
      break;
    case 'rd':
      if (args.some((x) => /^\/s$/i.test(x))) reasons.push('rd /s deletes a folder tree');
      break;
    case 'rmdir':
      if (args.some((x) => /^\/s$/i.test(x))) reasons.push('rmdir /s deletes a folder tree');
      break;
  }
  if (prog.startsWith('mkfs')) reasons.push('mkfs formats a disk');
  return reasons;
}

// Why a command needs the destructive-command warning; empty when it doesn't.
export function analyzeCommand(command: string): string[] {
  const parsed = parseShellCommand(command);
  const reasons = parsed.opaque.map((o) =>
    o === 'unclosed quote' ? 'the command has an unclosed quote, so it can\'t be read reliably' : `it uses ${o}, so what actually runs can't be seen`,
  );
  for (const cmd of parsed.commands) reasons.push(...simpleCommandReasons(cmd));
  return [...new Set(reasons)];
}

// ---------- environment ----------

// Environment variables that usually carry credentials. Commands the model
// runs get the editor's environment minus these, unless the user lists a
// name in rizo.permissions.passEnvironmentVariables. SSH_AUTH_SOCK is kept
// (it's a socket path, and git over SSH needs it).
const SECRET_ENV_NAME = /(TOKEN|SECRET|PASSW(OR)?D|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|SESSION|COOKIE|_PAT$|^PAT_|_AUTH$|^AUTH_|SIGNING_KEY|CONNECTION_STRING|DATABASE_URL|DSN$)/i;
const SECRET_ENV_PREFIX = /^(AWS_|AZURE_|ARM_CLIENT|GOOGLE_APPLICATION_CREDENTIALS|GCLOUD_|OPENROUTER|ANTHROPIC|OPENAI|GEMINI|GH_|GITHUB_TOKEN|GITLAB_|NPM_TOKEN|NODE_AUTH_TOKEN|HF_|HUGGING|STRIPE_|TWILIO_|SENDGRID_|SLACK_|DOCKER_AUTH|VAULT_|CI_JOB_TOKEN)/i;
const ALWAYS_KEEP = new Set(['SSH_AUTH_SOCK', 'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR']);

export function filterEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  allow: readonly string[] = [],
): { env: Record<string, string>; removed: string[] } {
  const allowed = new Set(allow.map((n) => n.toUpperCase()));
  const out: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (!ALWAYS_KEEP.has(upper) && !allowed.has(upper) && (SECRET_ENV_NAME.test(name) || SECRET_ENV_PREFIX.test(name))) {
      removed.push(name);
      continue;
    }
    out[name] = value;
  }
  return { env: out, removed: removed.sort() };
}

// ---------- output ----------

export const OUTPUT_HEAD_CHARS = 60_000;
export const OUTPUT_TAIL_CHARS = 20_000;

// Keeps the start and the end of long output (where errors and summaries
// usually are) and says how much was left out.
export function capOutput(text: string, head = OUTPUT_HEAD_CHARS, tail = OUTPUT_TAIL_CHARS): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n…(${omitted.toLocaleString('en-US')} characters omitted)…\n${text.slice(text.length - tail)}`;
}
