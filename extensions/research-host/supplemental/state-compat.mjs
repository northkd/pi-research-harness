import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const absolute = value => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value === '/') {
    throw new Error('supplemental-state-path-invalid');
  }
  return value;
};

/** Match the original config parser. Never reinterpret legacy top-level automation. */
export function supplementalConfigurationFromLegacy(config) {
  if (!object(config)) throw new Error('supplemental-legacy-config-invalid');
  const plugins = {};
  if (object(config.plugins)) {
    for (const [id, value] of Object.entries(config.plugins)) {
      if (object(value)) Object.defineProperty(plugins, id, { value: clone(value), enumerable: true, configurable: true, writable: true });
    }
  }
  const rawQuestions = object(config.questions) ? config.questions : {};
  const briefChars = typeof rawQuestions.minBriefChars === 'number' && Number.isFinite(rawQuestions.minBriefChars)
    ? Math.trunc(rawQuestions.minBriefChars) : 240;
  return {
    plugins,
    questions: {
      autoBrief: typeof rawQuestions.autoBrief === 'boolean' ? rawQuestions.autoBrief : true,
      minBriefChars: Math.min(4000, Math.max(0, briefChars)),
    },
    askUserPromptTimeoutSeconds: typeof config.askUserPromptTimeoutSeconds === 'number'
      ? config.askUserPromptTimeoutSeconds : 300,
  };
}

/** Pure mapping only. The parent migration owns copying, locking, hashing and commit. */
export function createSupplementalStateMappings({ homeDir, legacyDashboardDir, sessionsDir, projectCwds = [] }) {
  absolute(homeDir);
  const legacy = absolute(legacyDashboardDir ?? path.join(homeDir, '.pi/dashboard'));
  const sessions = absolute(sessionsDir ?? path.join(homeDir, '.pi/agent/sessions'));
  if (!Array.isArray(projectCwds)) throw new Error('supplemental-project-cwds-invalid');
  const roots = [...new Set(projectCwds.map(absolute))].sort();
  const copy = [
    ['goals', 'goals', 'goals'],
    ['questions', 'questions', 'questions'],
    ['kb-global-config', 'knowledge_base.json', 'knowledge_base.json'],
    ['kb-global-trust', 'kb-source-trust.json', 'kb-source-trust.json'],
    ['kb-global-cache', 'kb/sources', 'kb/sources'],
  ].map(([id, source, target]) => ({ id, source: path.join(legacy, source), target, optional: true }));
  const retain = [
    { id: 'native-sessions', source: sessions, optional: false, reason: 'Billing and goal links use original session identities, JSONL and metadata.' },
    { id: 'native-model-prices', source: path.join(homeDir, '.pi/agent/models.json'), optional: true, reason: 'Custom RMB prices are read from the existing model config; this file may contain provider credentials.' },
    { id: 'native-global-automation', source: path.join(homeDir, '.pi/automation'), optional: true, reason: 'Global definitions, prompts, run records and results keep their original scope paths.' },
    { id: 'native-global-flows', source: path.join(homeDir, '.pi/flows'), optional: true, reason: 'Native Flow discovery uses the existing global path.' },
  ];
  for (const cwd of roots) {
    const suffix = createHash('sha256').update(cwd).digest('hex').slice(0, 12);
    for (const [name, relative, reason] of [
      ['automation', '.pi/automation', 'Keep definitions and runs in their project scope.'],
      ['flows', '.pi/flows', 'Keep native flow definitions in their project scope.'],
      ['knowledge-base', '.pi/dashboard', 'Keep project KB configuration, indexes, staleness records and source references at their original paths.'],
    ]) retain.push({ id: `supplemental-project-${suffix}-${name}`, source: path.join(cwd, relative), optional: true, reason });
  }
  return { copy, retain };
}

function fileInventory(root) {
  const counts = { exists: false, files: 0, directories: 0, bytes: 0 };
  const visit = file => {
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('supplemental-state-symlink-rejected');
    counts.exists = true;
    if (stat.isFile()) { counts.files++; counts.bytes += stat.size; }
    else if (stat.isDirectory()) {
      counts.directories++;
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } else throw new Error('supplemental-state-special-file-rejected');
  };
  visit(root);
  return counts;
}

function readSmallJson(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('supplemental-state-json-invalid');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Read-only inventory. No prompts, objectives, paths, prices, providers or secrets in its result. */
export function inspectSupplementalState(options) {
  const mappings = createSupplementalStateMappings(options);
  const legacy = options.legacyDashboardDir ?? path.join(options.homeDir, '.pi/dashboard');
  const inventories = mappings.copy.map(mapping => ({ id: mapping.id, ...fileInventory(mapping.source) }));
  const goals = { files: 0, records: 0, schemaVersions: [], statuses: {}, linkedSessions: 0, drivers: 0, inFlightSpawns: 0, respawns: 0 };
  const directory = path.join(legacy, 'goals');
  if (fs.existsSync(directory)) {
    const schemas = new Set();
    for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json'))) {
      const data = readSmallJson(path.join(directory, name));
      if (!object(data) || !Array.isArray(data.goals)) throw new Error('supplemental-goal-schema-invalid');
      goals.files++;
      schemas.add(data.schemaVersion);
      for (const goal of data.goals) {
        goals.records++;
        const status = ['active', 'paused', 'achieved', 'failed', 'abandoned', 'budget_exhausted'].includes(goal.status) ? goal.status : 'other';
        goals.statuses[status] = (goals.statuses[status] || 0) + 1;
        goals.linkedSessions += Array.isArray(goal.sessionIds) ? goal.sessionIds.length : 0;
        goals.drivers += Number(typeof goal.driverSessionId === 'string' && !!goal.driverSessionId);
        goals.inFlightSpawns += Number(!!goal.inFlightSpawn);
        goals.respawns += Array.isArray(goal.respawns) ? goal.respawns.length : 0;
      }
    }
    goals.schemaVersions = [...schemas].sort();
  }
  return { copy: inventories, retain: mappings.retain.map(mapping => ({ id: mapping.id, ...fileInventory(mapping.source) })), goals };
}
