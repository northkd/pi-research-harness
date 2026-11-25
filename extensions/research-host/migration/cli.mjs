#!/usr/bin/env node
import fs from 'node:fs';
import { inspectMigration, verifyMigration } from './index.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const value = name => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  if (at + 1 >= args.length || args[at + 1].startsWith('--')) throw new Error('migration-option-value-required');
  const [, result] = args.splice(at, 2);
  return result;
};

try {
  let result;
  if (command === 'inventory') {
    const planFile = value('--plan');
    if (args.length) throw new Error('migration-unknown-option');
    const plan = planFile ? JSON.parse(fs.readFileSync(planFile, 'utf8')) : undefined;
    result = inspectMigration({ plan });
  } else if (command === 'verify') {
    const destinationDir = value('--destination');
    const sources = args.indexOf('--sources');
    if (sources !== -1) args.splice(sources, 1);
    if (args.length) throw new Error('migration-unknown-option');
    result = verifyMigration({ destinationDir, verifySources: sources !== -1 });
  } else throw new Error('usage: cli.mjs inventory [--plan ABSOLUTE_JSON] | verify --destination ABSOLUTE_PATH [--sources]');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} catch (error) {
  process.stderr.write((error.code ?? error.message ?? 'migration-command-failed') + '\n');
  process.exitCode = 1;
}
