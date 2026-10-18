#!/usr/bin/env node
/**
 * Redirect the pinned dashboard's home-scoped paths in a BUILD COPY only.
 * TypeScript identifies executable calls; strings, comments and project paths
 * are never searched-and-replaced. No HOME/USERPROFILE value is changed.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const ENVIRONMENT = Object.freeze({
  dashboard: 'PI_RESEARCH_DASHBOARD_DIR',
  agent: 'PI_CODING_AGENT_DIR',
  managed: 'PI_RESEARCH_MANAGED_DIR',
});
const HOME_REFERENCE = /\b(?:homedir|HOME|USERPROFILE|home|homeDir)\b/;
const PROJECT_REFERENCE = /\b(?:cwd|projectDir|projectRoot)\b/;
const EXCLUDED_PARTS = new Set(['test', 'tests', '__tests__', 'test-support', '__fixtures__', 'node_modules']);

/**
 * Reviewed exceptions to the generic join/resolve rule at the pinned revision.
 * Match exact AST source, not substrings in comments or arbitrary strings.
 * The adapter-version array also has an exact function/declaration anchor and
 * asserted fallback entries, allowing the generic prefix pass to run first.
 * The original target remains in the environment fallback so a second run
 * validates the same expected count while making zero additional edits.
 */
export const explicitKnownPathAdaptations = Object.freeze([
  Object.freeze({
    id: 'kb-default-source-cache', path: 'packages/kb/src/config.ts',
    kind: 'source-cache-default', targetSource: '"~/.pi/dashboard/kb/sources"', expectedMatches: 1,
    environment: ENVIRONMENT.dashboard, requiredNamedImport: { module: 'node:path', name: 'join' },
  }),
  Object.freeze({
    id: 'project-init-user-profiles', path: 'packages/extension/src/project-init/profiles.ts',
    kind: 'profiles-directory', targetSource: 'path.join(os.homedir(), ".pi", "project-profiles")', expectedMatches: 1,
    environment: ENVIRONMENT.managed,
  }),
  Object.freeze({
    id: 'automation-entry-global-bases', path: 'packages/automation-plugin/src/server/index.ts',
    kind: 'global-home-call', targetSource: 'os.homedir()', expectedMatches: 3, environment: ENVIRONMENT.managed,
  }),
  Object.freeze({
    id: 'automation-routes-global-bases', path: 'packages/automation-plugin/src/server/routes.ts',
    kind: 'global-home-call', targetSource: 'os.homedir()', expectedMatches: 2, environment: ENVIRONMENT.managed,
  }),
  Object.freeze({
    id: 'automation-engine-global-base', path: 'packages/automation-plugin/src/server/engine.ts',
    kind: 'global-home-call', targetSource: 'os.homedir()', expectedMatches: 1, environment: ENVIRONMENT.managed,
  }),
  Object.freeze({
    id: 'mcp-adapter-bundled-version', path: 'packages/mcp-server-plugin/src/server/index.ts',
    kind: 'adapter-version-candidates', targetSource: 'candidates', functionName: 'readInstalledAdapterVersion', expectedMatches: 1,
    environment: 'PI_RESEARCH_RESOURCE_ROOT', requiredDefaultImport: { module: 'node:path', name: 'path' },
    prependSource: '...(process.env.PI_RESEARCH_RESOURCE_ROOT ? [path.join(process.env.PI_RESEARCH_RESOURCE_ROOT, "node_modules", "pi-mcp-adapter", "package.json")] : [])',
    fallbackCandidates: Object.freeze([
      'path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "npm", "node_modules", "pi-mcp-adapter", "package.json")',
      'path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "node_modules", "pi-mcp-adapter", "package.json")',
    ]),
  }),
]);

function sourceName(fileName) {
  const normalized = fileName.replaceAll('\\', '/');
  const packageBoundary = normalized.indexOf('/packages/');
  return packageBoundary < 0 ? normalized : normalized.slice(packageBoundary + 1);
}

function reviewedAudit(fileName, expression) {
  if (['packages/server/src/routes/file-routes.ts', 'packages/server/src/lib/resolve-file-mention.ts'].includes(fileName)
      && expression === 'path.join(os.homedir(), ".pi")') {
    return { blocking: false, disposition: 'intentional-user-file-access',
      review: 'Explicit user file access retains the real home allowlist; this is not a settings or automation discovery root.' };
  }
  if (fileName === 'packages/shared/src/doctor-core.ts'
      && ['"~/.pi/agent/settings.json"', '"~/.pi/agent/auth.json"'].includes(expression)) {
    return { blocking: false, disposition: 'display-only', review: 'Doctor fallback labels; no filesystem read is performed from these literals.' };
  }
  if (fileName === 'packages/electron/src/lib/window-state.ts'
      && expression === 'path.join(os.homedir(), ".pi" + "-dashboard", "window-state.json")') {
    return { blocking: false, disposition: 'unused-upstream-electron',
      review: 'Legacy upstream Electron window-state migration is not used by the independent desktop main entry.' };
  }
  return { blocking: true, disposition: 'requires-review' };
}

function isSourceFile(fileName) {
  const normalized = fileName.replaceAll('\\', '/');
  return /\.(?:ts|tsx|js|mjs)$/.test(normalized)
    && !/\.(?:d|test|spec)\.(?:ts|tsx|js|mjs)$/.test(normalized)
    && !normalized.split('/').some((part) => EXCLUDED_PARTS.has(part));
}

function pathCallee(node) {
  if (!ts.isCallExpression(node) || node.questionDotToken) return null;
  const callee = node.expression;
  if (ts.isIdentifier(callee) && ['join', 'resolve'].includes(callee.text)) return callee.text;
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
      && callee.expression.text === 'path' && ['join', 'resolve'].includes(callee.name.text)) {
    return `path.${callee.name.text}`;
  }
  return null;
}

function isHomeExpression(node, sourceFile) {
  if (!node || ts.isStringLiteralLike(node)) return false;
  const text = node.getText(sourceFile);
  return HOME_REFERENCE.test(text) && !PROJECT_REFERENCE.test(text);
}

function stringValue(node) {
  // A template is deliberately left for the audit, even without substitutions.
  return node && ts.isStringLiteral(node) ? node.text : null;
}

function categoryLiteral(value, prefix) {
  if (value === prefix) return { prefix, suffix: '' };
  if (value?.startsWith(`${prefix}/`)) {
    // Repeated separators inside a relative literal are not absolute tails.
    return { prefix, suffix: value.slice(prefix.length).replace(/^\/+/, '') };
  }
  return null;
}

function matchPrefix(node, sourceFile) {
  const callee = pathCallee(node);
  if (!callee || !isHomeExpression(node.arguments[0], sourceFile)) return null;
  const second = stringValue(node.arguments[1]);
  const choices = second === '.pi'
    ? [['dashboard', 'dashboard'], ['agent', 'agent']]
    : [['.pi/dashboard', 'dashboard'], ['.pi/agent', 'agent'], ['.pi-dashboard', 'managed']];
  const argumentIndex = second === '.pi' ? 2 : 1;
  const value = stringValue(node.arguments[argumentIndex]);
  for (const [prefix, category] of choices) {
    const literal = categoryLiteral(value, prefix);
    if (literal) return { callee, argumentIndex, value, ...literal, environment: ENVIRONMENT[category] };
  }
  return null;
}

function unwrap(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)
      || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function isEnvironmentFallback(node, environment) {
  node = unwrap(node);
  if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(node.operatorToken.kind)) {
    return isEnvironmentFallback(node.left, environment) || isEnvironmentFallback(node.right, environment);
  }
  if (ts.isPropertyAccessExpression(node) && node.name.text === environment) {
    const owner = node.expression;
    return ts.isPropertyAccessExpression(owner) && owner.name.text === 'env'
      && ts.isIdentifier(owner.expression) && owner.expression.text === 'process';
  }
  if (ts.isElementAccessExpression(node) && stringValue(node.argumentExpression) === environment) {
    const owner = node.expression;
    return ts.isPropertyAccessExpression(owner) && owner.name.text === 'env'
      && ts.isIdentifier(owner.expression) && owner.expression.text === 'process';
  }
  return false;
}

function alreadyGuarded(node, environment) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isBinaryExpression(parent) && child === parent.right
        && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(parent.operatorToken.kind)
        && isEnvironmentFallback(parent.left, environment)) return true;
    if (ts.isConditionalExpression(parent) && child === parent.whenFalse
        && isEnvironmentFallback(parent.condition, environment)) return true;
    if (ts.isFunctionLike(parent) || ts.isStatement(parent)) break;
  }
  return false;
}

function applyEdits(source, start, end, edits) {
  const contained = edits.filter((edit) => edit.start >= start && edit.end <= end)
    .sort((left, right) => left.start - right.start);
  let cursor = start;
  let output = '';
  for (const edit of contained) {
    if (edit.start < cursor) throw new Error('Overlapping dashboard path edits');
    output += source.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return output + source.slice(cursor, end);
}

function location(node, sourceFile) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: line + 1, column: character + 1 };
}

function matchesKnownTarget(node, rule, sourceFile) {
  if (rule.kind === 'adapter-version-candidates') {
    if (!ts.isArrayLiteralExpression(node) || !ts.isVariableDeclaration(node.parent)
        || node.parent.initializer !== node || node.parent.name.getText(sourceFile) !== rule.targetSource) return false;
    let owner = node.parent;
    while (owner && !ts.isFunctionLike(owner)) owner = owner.parent;
    return owner && ts.isFunctionDeclaration(owner) && owner.name?.text === rule.functionName;
  }
  if (rule.kind === 'source-cache-default') {
    if (!ts.isStringLiteral(node)) return false;
    let initializer = node;
    while (ts.isParenthesizedExpression(initializer.parent)
        || (ts.isConditionalExpression(initializer.parent) && initializer.parent.whenFalse === initializer
          && isEnvironmentFallback(initializer.parent.condition, rule.environment))) initializer = initializer.parent;
    const property = initializer.parent;
    if (!ts.isPropertyAssignment(property) || property.initializer !== initializer
        || property.name.getText(sourceFile) !== 'sourceCacheDir') return false;
    const declaration = property.parent.parent;
    if (!ts.isVariableDeclaration(declaration) || declaration.name.getText(sourceFile) !== 'DEFAULTS') return false;
  } else if (!ts.isCallExpression(node)) return false;
  return node.getText(sourceFile) === rule.targetSource;
}

function canonicalTokens(source) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, source);
  const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push([token, scanner.getTokenText()]);
  }
  return JSON.stringify(tokens);
}

function validateAdapterCandidates(node, rule, sourceFile) {
  const entries = [...node.elements];
  const prepended = entries.length > 0 && ts.isSpreadElement(entries[0])
    && canonicalTokens(entries[0].getText(sourceFile)) === canonicalTokens(rule.prependSource);
  if (prepended) entries.shift();
  if (entries.length !== rule.fallbackCandidates.length || entries.some((entry, index) => {
    // Normalize only with this module's generic rule; no file-specific rules
    // run for this isolated expression, and string token values remain exact.
    const normalized = adaptDashboardSource(entry.getText(sourceFile)).source;
    return canonicalTokens(normalized) !== canonicalTokens(rule.fallbackCandidates[index]);
  })) {
    throw new Error(`Known adaptation ${rule.id}: fallback candidates changed; pinned source drift requires review`);
  }
  return { prepended };
}

function assertRequiredImport(sourceFile, rule) {
  if (rule.requiredDefaultImport) {
    const { module, name } = rule.requiredDefaultImport;
    const found = sourceFile.statements.some((statement) => ts.isImportDeclaration(statement)
      && stringValue(statement.moduleSpecifier) === module && !statement.importClause?.isTypeOnly
      && statement.importClause?.name?.text === name);
    if (!found) throw new Error(`Known adaptation ${rule.id} requires the existing default ${name} import from ${module}`);
  }
  if (!rule.requiredNamedImport) return;
  const { module, name } = rule.requiredNamedImport;
  const found = sourceFile.statements.some((statement) => {
    if (!ts.isImportDeclaration(statement) || stringValue(statement.moduleSpecifier) !== module
        || !statement.importClause || statement.importClause.isTypeOnly) return false;
    const bindings = statement.importClause.namedBindings;
    return bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) =>
      !element.isTypeOnly && element.name.text === name && (!element.propertyName || element.propertyName.text === name));
  });
  if (!found) throw new Error(`Known adaptation ${rule.id} requires the existing named ${name} import from ${module}`);
}

function unresolvedReason(node, sourceFile) {
  if (pathCallee(node) && isHomeExpression(node.arguments[0], sourceFile)
      && node.arguments.slice(1).some((argument) => /[.]pi(?:\b|-dashboard)/.test(argument.getText(sourceFile)))) {
    return 'Home path outside the supported literal dashboard/agent/managed prefixes';
  }
  if (ts.isTemplateExpression(node) && /[.]pi(?:\b|-dashboard)/.test(node.getText(sourceFile))
      && node.templateSpans.some((span) => isHomeExpression(span.expression, sourceFile))) {
    return 'Home path constructed with a template expression; requires explicit review';
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken
      && !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
      && HOME_REFERENCE.test(node.getText(sourceFile)) && /[.]pi(?:\b|-dashboard)/.test(node.getText(sourceFile))) {
    return 'Home path constructed with string concatenation; requires explicit review';
  }
  if (ts.isStringLiteralLike(node) && /^(?:~|\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)[/\\]\.pi(?:[/\\]|-dashboard)(?:[^\s]*)$/.test(node.text)) {
    return 'Home path literal (possibly display-only); retained for explicit review';
  }
  return null;
}

/** Pure source adapter. `changes` and `unresolved` use original source locations. */
export function adaptDashboardSource(source, fileName = 'source.ts') {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  if (!isSourceFile(fileName)) return { source, changes: [], unresolved: [], knownAdaptations: [], skipped: true };
  fileName = sourceName(fileName);
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.(?:js|mjs)$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);
  if (sourceFile.parseDiagnostics.length) {
    const diagnostic = sourceFile.parseDiagnostics[0];
    throw new Error(`Cannot adapt invalid source ${fileName}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
  }
  const changes = [];
  const unresolved = [];
  const knownRules = explicitKnownPathAdaptations.filter((rule) => rule.path === fileName);
  const knownAdaptations = knownRules.map((rule) => ({ id: rule.id, expectedMatches: rule.expectedMatches, matchedCount: 0, appliedCount: 0 }));
  for (const rule of knownRules) assertRequiredImport(sourceFile, rule);
  function visit(node) {
    const childEdits = [];
    ts.forEachChild(node, (child) => { childEdits.push(...visit(child)); });
    const knownIndex = knownRules.findIndex((rule) => matchesKnownTarget(node, rule, sourceFile));
    if (knownIndex >= 0) {
      const rule = knownRules[knownIndex];
      const count = knownAdaptations[knownIndex];
      count.matchedCount += 1;
      if (rule.kind === 'adapter-version-candidates' && validateAdapterCandidates(node, rule, sourceFile).prepended) return childEdits;
      if (alreadyGuarded(node, rule.environment)) return childEdits;
      count.appliedCount += 1;
      const start = node.getStart(sourceFile);
      const original = applyEdits(source, start, node.end, childEdits);
      let replacement;
      if (rule.kind === 'source-cache-default') {
        replacement = `(process.env.${rule.environment} ? join(process.env.${rule.environment}, "kb", "sources") : ${original})`;
      } else if (rule.kind === 'profiles-directory') {
        replacement = `(process.env.${rule.environment} ? path.join(process.env.${rule.environment}, ".pi", "project-profiles") : ${original})`;
      } else if (rule.kind === 'adapter-version-candidates') {
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        const indent = /^\s*/.exec(source.slice(lineStart, start))[0] + '  ';
        const newline = source.includes('\r\n') ? '\r\n' : '\n';
        const tail = original.slice(1);
        replacement = `[${newline}${indent}${rule.prependSource},${/^[\r\n]/.test(tail) ? '' : newline + indent}${tail}`;
      } else {
        replacement = `(process.env.${rule.environment} || ${original})`;
      }
      changes.push({ ...location(node, sourceFile), kind: 'known-path', id: rule.id,
        environment: rule.environment, from: node.getText(sourceFile), to: replacement });
      return [{ start, end: node.end, replacement }];
    }
    const match = matchPrefix(node, sourceFile);
    if (!match) {
      const reason = unresolvedReason(node, sourceFile);
      if (reason) {
        const expression = node.getText(sourceFile);
        unresolved.push({ ...location(node, sourceFile), reason, expression, ...reviewedAudit(fileName, expression) });
      }
      return childEdits;
    }
    if (alreadyGuarded(node, match.environment)) return childEdits;
    const start = node.getStart(sourceFile);
    const prefixArgument = node.arguments[match.argumentIndex];
    const hasTail = match.suffix || node.arguments.length > match.argumentIndex + 1;
    let replacement;
    if (!hasTail) {
      replacement = `(process.env.${match.environment} || ${applyEdits(source, start, node.end, childEdits)})`;
    } else {
      const baseEdits = [...childEdits];
      if (match.value !== match.prefix) {
        baseEdits.push({ start: prefixArgument.getStart(sourceFile), end: prefixArgument.end, replacement: JSON.stringify(match.prefix) });
      }
      const baseCall = `${applyEdits(source, start, prefixArgument.end, baseEdits)})`;
      const tail = applyEdits(source, prefixArgument.end, node.end, childEdits);
      const literalTail = match.suffix ? `, ${JSON.stringify(match.suffix)}` : '';
      replacement = `${match.callee}(process.env.${match.environment} || ${baseCall}${literalTail}${tail}`;
    }
    changes.push({ ...location(node, sourceFile), kind: 'path-prefix', environment: match.environment, from: node.getText(sourceFile), to: replacement });
    return [{ start, end: node.end, replacement }];
  }
  const edits = visit(sourceFile);
  for (const record of knownAdaptations) {
    if (record.matchedCount !== record.expectedMatches) {
      throw new Error(`Known adaptation ${record.id} in ${fileName}: expected ${record.expectedMatches} exact source target(s), found ${record.matchedCount}; pinned source drift requires review`);
    }
  }
  return {
    source: applyEdits(source, 0, source.length, edits),
    changes: changes.sort((left, right) => left.line - right.line || left.column - right.column),
    unresolved: unresolved.sort((left, right) => left.line - right.line || left.column - right.column),
    knownAdaptations,
    skipped: false,
  };
}

async function* runtimeSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    // Never follow a symlink out of the explicit build copy.
    if (entry.isDirectory() && !EXCLUDED_PARTS.has(entry.name)) yield* runtimeSources(fullPath);
    else if (entry.isFile() && isSourceFile(entry.name)) yield fullPath;
  }
}

/** Adapt packages/<package>/src, with deterministic audit output. Check mode is read-only. */
export async function adaptDashboardDirectory(root, { check = false, requireKnownPaths = true } = {}) {
  root = path.resolve(root);
  const packageRoot = path.join(root, 'packages');
  const packages = await readdir(packageRoot, { withFileTypes: true });
  packages.sort((left, right) => left.name.localeCompare(right.name));
  const files = [];
  const unresolved = [];
  const knownAdaptations = [];
  const pendingWrites = [];
  let scannedFiles = 0;
  for (const entry of packages) {
    if (!entry.isDirectory()) continue;
    const sourceRoot = path.join(packageRoot, entry.name, 'src');
    let present;
    try { present = await readdir(path.dirname(sourceRoot), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!present.some((child) => child.name === 'src' && child.isDirectory())) continue;
    for await (const fullPath of runtimeSources(sourceRoot)) {
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      const source = await readFile(fullPath, 'utf8');
      const adapted = adaptDashboardSource(source, relativePath);
      scannedFiles += 1;
      if (adapted.changes.length) {
        files.push({ path: relativePath, count: adapted.changes.length, changes: adapted.changes });
        if (!check) pendingWrites.push({ fullPath, source: adapted.source });
      }
      unresolved.push(...adapted.unresolved.map((item) => ({ path: relativePath, ...item })));
      knownAdaptations.push(...adapted.knownAdaptations.map((item) => ({ path: relativePath, ...item })));
    }
  }
  if (requireKnownPaths) {
    const seen = new Set(knownAdaptations.map((record) => record.id));
    const missing = explicitKnownPathAdaptations.filter((rule) => !seen.has(rule.id));
    if (missing.length) throw new Error(`Missing pinned source files for known path adaptations: ${missing.map((rule) => rule.path).join(', ')}`);
  }
  // All parse, exact-target and import assertions pass before any file changes.
  for (const pending of pendingWrites) await writeFile(pending.fullPath, pending.source, 'utf8');
  const changeCount = files.reduce((sum, file) => sum + file.count, 0);
  return { root, check, scannedFiles, changedFiles: files.length, changeCount, files, unresolved, knownAdaptations,
    needsChanges: changeCount > 0, needsReview: unresolved.some((item) => item.blocking) };
}

async function main(argv) {
  const positional = argv.filter((argument) => !argument.startsWith('--'));
  if (positional.length !== 1 || argv.some((argument) => argument.startsWith('--') && argument !== '--check')) {
    throw new Error('Usage: node adapt-dashboard.mjs <dashboard-build-copy> [--check]');
  }
  const report = await adaptDashboardDirectory(positional[0], { check: argv.includes('--check') });
  console.log(JSON.stringify(report, null, 2));
  if (report.check && (report.needsChanges || report.needsReview)) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 2; });
}
