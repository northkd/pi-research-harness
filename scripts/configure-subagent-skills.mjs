import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const ROLE = 'research-theory';
const POLICY = {inheritSkills: false, skills: [], defaultContext: 'fresh'};
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

/** Return a copy; model, tools, prompts, other roles and parent skill discovery stay intact. */
export function normalizeSubagentSkillSettings(settings) {
  requireObject(settings, 'settings');
  const next = structuredClone(settings);
  if (!own(next, 'subagents')) next.subagents = {};
  const subagents = requireObject(next.subagents, 'subagents');
  if (!own(subagents, 'agentOverrides')) subagents.agentOverrides = {};
  const overrides = requireObject(subagents.agentOverrides, 'subagents.agentOverrides');
  const changes = [];

  function normalize(entries, source, provider) {
    const current = own(entries, ROLE)
      ? requireObject(entries[ROLE], `${source}.${ROLE}`)
      : {};
    const fields = [];
    if (current.inheritSkills !== false) fields.push('inheritSkills');
    if (!Array.isArray(current.skills) || current.skills.length !== 0) fields.push('skills');
    if (current.defaultContext !== 'fresh') fields.push('defaultContext');
    entries[ROLE] = {...current, ...POLICY, skills: []};
    if (fields.length) changes.push({source, ...(provider !== undefined ? {provider} : {}), fields});
  }

  normalize(overrides, 'agentOverrides');
  if (own(subagents, 'agentOverridesByProvider')) {
    const providers = requireObject(subagents.agentOverridesByProvider, 'subagents.agentOverridesByProvider');
    for (const [provider, value] of Object.entries(providers)) {
      const entries = requireObject(value, `subagents.agentOverridesByProvider.${provider}`);
      // A provider without this role already inherits the base override above.
      if (own(entries, ROLE)) normalize(entries, 'agentOverridesByProvider', provider);
    }
  }
  return {settings: next, changed: changes.length > 0, changes};
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.normalize(value);
}

/** Reject symlinks in the file and every existing ancestor, including dangling links. */
function inspectPath(file, {optional = false, directory = false} = {}) {
  const root = path.parse(file).root;
  const pieces = file.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let stat = fs.lstatSync(root);
  for (let index = 0; index < pieces.length; index++) {
    current = path.join(current, pieces[index]);
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return undefined;
      throw new Error(`Cannot inspect settings path: ${current}`);
    }
    if (stat.isSymbolicLink()) throw new Error(`Symlink rejected: ${current}`);
    if (index < pieces.length - 1 && !stat.isDirectory()) throw new Error(`Expected a directory: ${current}`);
  }
  if (directory ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Expected a ${directory ? 'directory' : 'regular file'}: ${file}`);
  }
  return stat;
}

function readSettings(candidate) {
  const stat = inspectPath(candidate.path, {optional: candidate.optional});
  if (!stat) return {...candidate, exists: false, changed: false, changes: []};
  const descriptor = fs.openSync(candidate.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`Settings changed while opening: ${candidate.path}`);
    }
    bytes = fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  let settings;
  try { settings = JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error(`Invalid JSON in settings: ${candidate.path}`); }
  let result;
  try { result = normalizeSubagentSkillSettings(settings); }
  catch (error) { throw new Error(`${candidate.path}: ${error.message}`); }
  return {...candidate, exists: true, stat, bytes, changed: result.changed, changes: result.changes,
    nextBytes: Buffer.from(JSON.stringify(result.settings, null, 2) + '\n')};
}

function assertUnchanged(plan) {
  const stat = inspectPath(plan.path);
  if (stat.dev !== plan.stat.dev || stat.ino !== plan.stat.ino || !fs.readFileSync(plan.path).equals(plan.bytes)) {
    throw new Error(`Settings changed during migration; retry after other writers stop: ${plan.path}`);
  }
}

function writeExclusive(file, bytes, mode) {
  const descriptor = fs.openSync(file, 'wx', mode);
  try {
    fs.fchmodSync(descriptor, mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } catch (error) {
    fs.closeSync(descriptor);
    removeOwned(file);
    throw error;
  }
  fs.closeSync(descriptor);
}

function removeOwned(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Validate all requested files first, then replace each settings file atomically. */
export function configureSubagentSkills(agentDir, {projectDir, dryRun = false, checkOnly = false} = {}) {
  if (dryRun && checkOnly) throw new Error('Choose either --dry-run or --check-only');
  const agentRoot = absolutePath(agentDir, 'AGENT_DIR');
  inspectPath(agentRoot, {directory: true});
  const candidates = [{path: path.join(agentRoot, 'settings.json'), scopes: ['agent'], optional: false}];
  if (projectDir !== undefined) {
    const projectRoot = absolutePath(projectDir, '--project-dir');
    inspectPath(projectRoot, {directory: true});
    const projectFile = path.join(projectRoot, '.pi', 'settings.json');
    const same = candidates.find(candidate => candidate.path === projectFile);
    if (same) same.scopes.push('project');
    else candidates.push({path: projectFile, scopes: ['project'], optional: true});
  }
  // Complete validation precedes any backup or write: a malformed project file
  // cannot leave a user's global configuration only partially migrated.
  const plans = candidates.map(readSettings);
  const changed = plans.filter(plan => plan.changed);
  const report = {
    ok: !checkOnly || changed.length === 0,
    role: ROLE,
    policy: structuredClone(POLICY),
    mode: dryRun ? 'dry-run' : checkOnly ? 'check-only' : 'apply',
    needsUpdate: changed.length > 0,
    updatedFiles: 0,
    files: plans.map(plan => ({path: plan.path, scopes: plan.scopes, exists: plan.exists,
      changed: plan.changed, changes: plan.changes, ...(!plan.exists ? {status: 'absent; not created'} : {})})),
  };
  if (dryRun || checkOnly || changed.length === 0) return report;

  const staged = [];
  const installed = [];
  try {
    for (const plan of changed) assertUnchanged(plan);
    for (const plan of changed) {
      const id = randomUUID();
      const entry = {...plan, backup: `${plan.path}.before-subagent-skills-${id}.bak`,
        temp: path.join(path.dirname(plan.path), `.${path.basename(plan.path)}.subagent-skills-${id}.tmp`)};
      staged.push(entry);
      // Backups may contain provider credentials from settings; always keep them private.
      writeExclusive(entry.backup, plan.bytes, 0o600);
      entry.backupCreated = true;
      writeExclusive(entry.temp, plan.nextBytes, plan.stat.mode & 0o777);
      entry.tempCreated = true;
    }
    for (const entry of staged) {
      assertUnchanged(entry);
      fs.renameSync(entry.temp, entry.path);
      entry.tempCreated = false;
      installed.push(entry);
    }
  } catch (error) {
    const recovery = [];
    for (const entry of installed.reverse()) {
      let restore;
      let restoreCreated = false;
      try {
        inspectPath(entry.path);
        if (!fs.readFileSync(entry.path).equals(entry.nextBytes)) {
          throw new Error('concurrent modification');
        }
        restore = `${entry.temp}.restore`;
        writeExclusive(restore, entry.bytes, entry.stat.mode & 0o777);
        restoreCreated = true;
        fs.renameSync(restore, entry.path);
        restoreCreated = false;
      } catch { recovery.push(entry.backup); }
      finally { if (restoreCreated) removeOwned(restore); }
    }
    for (const entry of staged) {
      if (entry.tempCreated) removeOwned(entry.temp);
      // Retain any backup needed for manual recovery, never overwrite later edits.
      if (entry.backupCreated && !recovery.includes(entry.backup)) removeOwned(entry.backup);
    }
    const suffix = recovery.length ? `; manual recovery backups: ${recovery.join(', ')}` : '; no configuration updates were retained';
    throw new Error(`Subagent skill migration failed: ${error.message}${suffix}`);
  }
  for (const entry of staged) {
    report.files.find(file => file.path === entry.path).backupPath = entry.backup;
  }
  report.updatedFiles = staged.length;
  report.needsUpdate = false;
  return report;
}

const USAGE = 'Usage: node scripts/configure-subagent-skills.mjs /absolute/AGENT_DIR [--project-dir /absolute/PROJECT_DIR] [--dry-run | --check-only]';
function parseArguments(args) {
  let agentDir;
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const value = args[index];
    if (value === '--project-dir') {
      if (options.projectDir !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(USAGE);
      options.projectDir = args[++index];
    } else if (value === '--dry-run' || value === '--check-only') {
      const key = value === '--dry-run' ? 'dryRun' : 'checkOnly';
      if (options[key]) throw new Error(USAGE);
      options[key] = true;
    } else if (value.startsWith('-') || agentDir !== undefined) throw new Error(USAGE);
    else agentDir = value;
  }
  if (!agentDir) throw new Error(USAGE);
  return {agentDir, options};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help') console.log(USAGE);
    else {
      const {agentDir, options} = parseArguments(process.argv.slice(2));
      const result = configureSubagentSkills(agentDir, options);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error.message}));
    process.exitCode = 1;
  }
}
