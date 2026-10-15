#!/usr/bin/env node
/** Explicit no-model gates. Dependency-free core checks work before installing the Pi host. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modes = ['offline', 'host', 'sdk'];
const mode = process.argv[2] || 'offline';
assert.ok(modes.includes(mode), 'Usage: run-checks.mjs offline|host|sdk');
// Synthetic ref is never authenticated or launched. All model executors in these gates are mocks.
const env = { ...process.env, PI_RESEARCH_SUPERVISOR_MODEL: 'fixture/reviewer:max', PI_OFFLINE: '1', PI_TELEMETRY: '0' };
const hostOnly = new Set(['adapter.test.mjs', 'integration.test.mjs']);
const tests = fs.readdirSync(path.join(root, 'test')).filter(f => f.endsWith('.test.mjs'));
function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (mode === 'sdk') {
  for (const file of ['cadence-smoke', 'proportional-smoke', 'host-repair-smoke', 'log-capacity-smoke', 'runtime-smoke']) {
    if (process.platform === 'linux') {
      const available = Number(/^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))?.[1]);
      if (!Number.isFinite(available) || available < 2097152) {
        console.error(`SDK resource gate: need >=2GiB MemAvailable before ${file}; no new SDK started`); process.exit(75);
      }
    }
    run([path.join(root, 'scripts', file + '.mjs')]);
  }
} else {
  const chosen = mode === 'host' ? tests.filter(f => hostOnly.has(f)) : tests.filter(f => !hostOnly.has(f));
  assert.ok(chosen.length);
  run(['--test', '--test-concurrency=1', ...chosen.sort().map(f => path.join(root, 'test', f))]);
}
