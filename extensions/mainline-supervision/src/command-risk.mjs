import path from 'node:path';

const dangerous = new Set(['rm', 'dd', 'mkfs', 'shutdown', 'reboot', 'sudo']);
const shells = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh']);
const sensitive = /\b(?:raw|trajectories|credentials|secrets)\//i;
const wrappers = new Set(['command', 'builtin', 'exec', 'nohup', 'env']);

// shortcut: a bounded lexer, not a shell/code verifier; unsupported syntax always needs direct UI.
function lex(text) {
  const segments = [], documents = [], pending = [];
  let words = [], value = '', started = false, dynamic = false, quote = '', opaque = false;
  const word = () => {
    if (started) words.push({ value, dynamic });
    value = ''; started = false; dynamic = false;
  };
  const segment = () => { word(); if (words.length) segments.push(words); words = []; };
  const lines = text.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote === "'") {
        if (c === "'") quote = ''; else value += c;
        continue;
      }
      if (c === '\\') {
        started = true;
        if (i + 1 === line.length) { opaque = true; continue; }
        if (quote === '"' && !['$', '`', '"', '\\'].includes(line[i + 1])) value += c;
        value += line[++i]; continue;
      }
      if (quote === '"') {
        if (c === '"') quote = '';
        else { value += c; if (c === '$' || c === '`') { dynamic = true; opaque = true; } }
        continue;
      }
      if (c === "'" || c === '"') { quote = c; started = true; continue; }
      if (c === '#' && !started) break;
      if (/\s/.test(c)) { word(); continue; }
      if (c === '<' && line[i + 1] === '<' && line[i + 2] !== '<') {
        word(); opaque = true;
        const m = /^<<(-)?[ \t]*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(line.slice(i));
        if (!m) { dynamic = true; started = true; value += c; continue; }
        const doc = { delimiter: m[2] ?? m[3] ?? m[4], stripTabs: !!m[1], quoted: !!(m[2] || m[3]), words, body: '' };
        documents.push(doc); pending.push(doc); i += m[0].length - 1; continue;
      }
      if ([';', '|', '&', '(', ')', '{', '}', '<', '>'].includes(c)) {
        segment(); opaque = true; continue;
      }
      if (c === '$' || c === '`' || ['*', '?', '['].includes(c) || c === '~' && !started) { dynamic = true; opaque = true; }
      value += c; started = true;
    }
    if (quote) { value += '\n'; opaque = true; continue; }
    segment();
    if (lineIndex < lines.length - 1) opaque = true;
    while (pending.length) {
      const doc = pending.shift(), body = [];
      let found = false;
      while (++lineIndex < lines.length) {
        const candidate = doc.stripTabs ? lines[lineIndex].replace(/^\t+/, '') : lines[lineIndex];
        if (candidate === doc.delimiter) { found = true; break; }
        body.push(lines[lineIndex]);
      }
      doc.body = body.join('\n');
      if (!found) opaque = true;
    }
  }
  segment();
  return { segments, documents, opaque: opaque || !!quote };
}
function executable(words) {
  let i = 0, wrapped = false;
  while (i < words.length) {
    const w = words[i];
    if (!w.dynamic && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value)) { wrapped = true; i++; continue; }
    const program = path.posix.basename(w.value);
    if (w.dynamic) return { program: '', args: [], opaque: true };
    if (!wrappers.has(program)) return { program, args: words.slice(i + 1), opaque: wrapped };
    wrapped = true; i++;
    while (words[i] && !words[i].dynamic && (words[i].value.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i].value))) i++;
  }
  return { program: '', args: [], opaque: true };
}
export function classifyCommand(command, depth = 0) {
  if (typeof command !== 'string' || command.length > 65536 || depth > 4 || command.includes('\0'))
    return { kind: 'unverified', reason: 'unsupported-command-shape', words: [] };
  const parsed = lex(command), visible = parsed.segments.flat().filter(w => !w.dynamic).map(w => w.value);
  // Preserve the original explicit protected-path refusal even inside opaque code/data.
  if (sensitive.test(command) || visible.some(w => sensitive.test(w))) return { kind: 'danger', reason: 'protected-path', words: visible };
  let opaque = parsed.opaque;
  for (const words of parsed.segments) {
    const { program, args, opaque: unknown } = executable(words);
    opaque ||= unknown || words.some(w => w.dynamic);
    if (dangerous.has(program) || /^mkfs\./.test(program)) return { kind: 'danger', reason: 'destructive-executable', words: visible };
    if (program === 'git' && args.some(w => !w.dynamic && ['reset', 'clean'].includes(w.value)))
      return { kind: 'danger', reason: 'destructive-git-operation', words: visible };
    if (['xargs', 'find'].includes(program) && args.some(w => !w.dynamic &&
      (dangerous.has(path.posix.basename(w.value)) || /^mkfs\./.test(path.posix.basename(w.value)))))
      return { kind: 'danger', reason: 'destructive-delegated-command', words: visible };
    if (['xargs', 'find', 'source', '.', 'trap', 'alias', 'busybox', 'timeout', 'nice', 'watch',
      'awk', 'gawk', 'mawk', 'nawk', 'sed', 'deno', 'bun', 'ts-node', 'tsx', 'js', 'jsc', 'd8', 'tclsh', 'wish', 'osascript'].includes(program)) opaque = true;
    if (shells.has(program) || program === 'eval') {
      opaque = true;
      const at = args.findIndex(w => /^-[^-]*c/.test(w.value) || w.value === '--command');
      const code = program === 'eval' ? args : at < 0 ? [] : args.slice(at + 1, at + 2);
      if (code.length && code.every(w => !w.dynamic) && classifyCommand(code.map(w => w.value).join(' '), depth + 1).kind === 'danger')
        return { kind: 'danger', reason: 'destructive-nested-shell', words: visible };
    }
    if (/^(?:node|nodejs|python\d*(?:\.\d+)?|perl|ruby|php|lua\d*(?:\.\d+)?|R|Rscript)$/.test(program) && args.some(w =>
      w.value.startsWith('-') && !/^(?:--test|--test-concurrency=\d+|--check|--version|--help|-v|-h)$/.test(w.value))) opaque = true;
  }
  for (const doc of parsed.documents) {
    const { program } = executable(doc.words);
    if (shells.has(program) && classifyCommand(doc.body, depth + 1).kind === 'danger')
      return { kind: 'danger', reason: 'destructive-shell-document', words: visible };
    // A quoted document is data to the outer shell, but may be code to its receiving program.
    opaque = true;
  }
  return { kind: opaque ? 'unverified' : 'static', reason: opaque ? 'opaque-or-compound-input' : 'visible-shell-words', words: visible };
}
