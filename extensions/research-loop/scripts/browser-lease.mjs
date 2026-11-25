#!/usr/bin/env node
/**
 * Browser lease for the dedicated research Chrome.
 *
 * One batch of web tasks shares a single Chrome instance and a single login
 * session. The lease records the owner and an operation counter. Only the
 * owner may hold or release it, and the browser is stopped only when the last
 * batch releases it.
 *
 * Usage:
 *   node browser-lease.mjs acquire --owner <id> [--batch <id>]
 *   node browser-lease.mjs renew   --owner <id>
 *   node browser-lease.mjs release --owner <id> [--stop]
 *   node browser-lease.mjs status
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const project = process.env.PI_RESEARCH_PROJECT ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const leaseDir = path.join(project, '.pi', 'research-loop');
const leaseFile = path.join(leaseDir, 'browser-lease.json');
const stopScript = path.join(os.homedir(), '.local', 'bin', 'pi-research-browser-stop');

function readLease() {
  try { return JSON.parse(fs.readFileSync(leaseFile, 'utf8')); }
  catch { return null; }
}

function writeLease(value) {
  fs.mkdirSync(leaseDir, { recursive: true, mode: 0o700 });
  const temp = `${leaseFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, leaseFile);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (!rest[i].startsWith('--')) continue;
    const key = rest[i].slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) { options[key] = next; i += 1; }
    else options[key] = true;
  }
  return { command, options };
}

function isFresh(lease, ttlSeconds) {
  if (!lease?.renewedAt) return false;
  const age = (Date.now() - Date.parse(lease.renewedAt)) / 1000;
  return Number.isFinite(age) && age <= ttlSeconds;
}

const { command, options } = parseArgs(process.argv.slice(2));
const owner = options.owner;
const now = new Date().toISOString();
const current = readLease();

function fail(message, code = 2) {
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(code);
}

if (command === 'status') {
  console.log(JSON.stringify({ ok: true, lease: current, leaseFile }, null, 2));
  process.exit(0);
}

if (!owner) fail('--owner is required');

if (command === 'acquire') {
  const ttl = Number(options.ttl) || 86400 * 7; // Uncapped work duration: default 7 days instead of 30 min
  // A lease is held until its owner releases it or its heartbeat goes stale.
  // The process that runs this script exits immediately, so liveness must be
  // measured by heartbeat age, not by the script's pid.
  const held = current?.owner && current.owner !== owner && isFresh(current, ttl);
  if (held) fail(`browser lease held by ${current.owner} until ${current.renewedAt} + ${ttl}s; operations must be serial`);
  const value = {
    owner,
    batch: options.batch ?? current?.batch ?? owner,
    acquiredAt: current?.owner === owner ? current.acquiredAt : now,
    renewedAt: now,
    ttlSeconds: ttl,
    operations: current?.owner === owner ? current.operations ?? 0 : 0,
    browserProfile: path.join(project, 'browser-profile'),
  };
  writeLease(value);
  console.log(JSON.stringify({ ok: true, lease: value }, null, 2));
  process.exit(0);
}

if (command === 'renew') {
  if (!current || current.owner !== owner) fail('only the lease owner may renew');
  const value = { ...current, renewedAt: now, operations: (current.operations ?? 0) + 1 };
  writeLease(value);
  console.log(JSON.stringify({ ok: true, lease: value }, null, 2));
  process.exit(0);
}

if (command === 'release') {
  if (current && current.owner !== owner) fail('only the lease owner may release');
  writeLease({ owner: null, releasedAt: now, lastOwner: owner, batch: current?.batch ?? null });
  const result = { ok: true, released: true, stopped: false };
  if (options.stop) {
    if (!fs.existsSync(stopScript)) fail(`stop script not found: ${stopScript}`);
    try {
      const out = execFileSync(stopScript, ['--json'], { encoding: 'utf8', timeout: 30000 });
      result.stop = JSON.parse(out);
      result.stopped = result.stop.ok === true;
    } catch (error) {
      result.stopped = false;
      result.stopError = String(error?.stdout || error?.message || error);
    }
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.stopped || !options.stop ? 0 : 1);
}

fail(`unknown command: ${command}`);
