#!/usr/bin/env node
/**
 * Read-only skills index.
 *
 * Scans skill directories and reports the facts a model cannot reliably infer
 * from a name: duplicate/overridden entries, missing trigger phrases, declared
 * dependencies, and whether the skill is reachable by a subagent.
 *
 * It never edits a SKILL.md and never writes outside research-loop/.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = path.join(root, 'generated');

const SKILL_DIRS = [
  path.join(os.homedir(), '.agents', 'skills'),
  path.join(os.homedir(), '.pi', 'agent', 'skills'),
  path.join(os.homedir(), '.pi', 'agent', 'npm', 'node_modules', '@companion-ai', 'feynman', 'skills'),
];

const DEPENDENCY_HINTS = [
  { name: 'shell-or-python', pattern: /\b(?:bash|python3?|node|npx|uv|pip)\b|```(?:bash|sh|python)/i },
  { name: 'network', pattern: /\b(?:curl|wget|https?:\/\/|API|MCP)\b/i },
  { name: 'external-cli', pattern: /\b(?:agy|codex|claude|gemini|mineru|playwright|firecrawl)\b/i },
  { name: 'zotero', pattern: /\bzotero\b/i },
];

function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    fields[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

function discover(dir) {
  if (!fs.existsSync(dir)) return [];
  const found = [];
  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      if (entry.isFile() && entry.name === 'SKILL.md') found.push(full);
    }
  };
  walk(dir, 0);
  return found;
}

const records = [];
for (const dir of SKILL_DIRS) {
  for (const file of discover(dir)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const { fields, body } = parseFrontmatter(text);
    const name = fields.name || path.basename(path.dirname(file));
    const description = fields.description || '';
    const hasTrigger = /use when|trigger|when the user|when you need/i.test(description);
    const deps = DEPENDENCY_HINTS.filter((d) => d.pattern.test(text)).map((d) => d.name);
    records.push({
      name,
      description,
      location: file,
      source: path.relative(os.homedir(), file).split(path.sep)[0] === '.agents' ? 'user-agents' : 'pi-agent',
      hasTriggerPhrase: hasTrigger,
      dependencies: deps,
      disableModelInvocation: fields['disable-model-invocation'] === 'true',
      bytes: Buffer.byteLength(text),
    });
  }
}

// Duplicate names: first discovery wins in Pi, later copies are shadowed.
const byName = new Map();
for (const record of records) {
  if (!byName.has(record.name)) byName.set(record.name, []);
  byName.get(record.name).push(record);
}
const duplicates = [...byName.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([name, list]) => ({ name, copies: list.map((r) => r.location), effective: list[0].location }));

const index = {
  schema: 'pi-research-loop.skills-index.v1',
  generatedAt: new Date().toISOString(),
  scannedDirs: SKILL_DIRS.map((d) => ({ dir: d, exists: fs.existsSync(d) })),
  counts: {
    total: records.length,
    missingTriggerPhrase: records.filter((r) => !r.hasTriggerPhrase).length,
    duplicates: duplicates.length,
    withShellOrPython: records.filter((r) => r.dependencies.includes('shell-or-python')).length,
  },
  duplicates,
  skills: records.sort((a, b) => a.name.localeCompare(b.name)),
};

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'skills-index.json'), JSON.stringify(index, null, 2) + '\n');

const lines = [
  '# Skills index',
  '',
  `Generated ${index.generatedAt}. Read-only scan; no SKILL.md was modified.`,
  '',
  `Total: ${index.counts.total} · missing trigger phrase: ${index.counts.missingTriggerPhrase} · duplicate names: ${index.counts.duplicates} · need shell/Python: ${index.counts.withShellOrPython}`,
  '',
  '## Duplicate names (only the first copy is effective)',
  '',
];
if (!duplicates.length) lines.push('- none');
for (const d of duplicates) {
  lines.push(`- **${d.name}** → effective: \`${d.effective}\``);
  for (const copy of d.copies.slice(1)) lines.push(`  - shadowed: \`${copy}\``);
}
lines.push('', '## Skills without an explicit trigger phrase', '');
const weak = records.filter((r) => !r.hasTriggerPhrase);
if (!weak.length) lines.push('- none');
for (const r of weak) lines.push(`- \`${r.name}\` — ${r.description.slice(0, 120) || '(no description)'}`);
lines.push('', '## Skills that need shell/Python (a read-only agent cannot execute them)', '');
for (const r of records.filter((x) => x.dependencies.includes('shell-or-python'))) {
  lines.push(`- \`${r.name}\` — deps: ${r.dependencies.join(', ')}`);
}
lines.push('');
fs.writeFileSync(path.join(outDir, 'SKILLS.md'), lines.join('\n'));

console.log(JSON.stringify({
  ok: true,
  out: ['generated/skills-index.json', 'generated/SKILLS.md'],
  counts: index.counts,
  duplicates: duplicates.map((d) => d.name),
}, null, 2));
