#!/usr/bin/env node
/**
 * Decide how many explorer agents may run now.
 *
 * Policy (user-set): keep at least 1 GiB MemAvailable after admitting new
 * explorers; when memory is tight, start a subset and add more later.
 *
 * The estimate is deliberately conservative: one Pi child process plus its
 * session buffer is assumed to need `perAgentMiB`. This is an admission
 * heuristic, not a reservation, and must be re-checked before each launch.
 *
 * Usage:
 *   node explorer-capacity.mjs status
 *   node explorer-capacity.mjs admit --requested 4 --active 1
 */
import fs from 'node:fs';

const RESERVE_MIB = 1024;
const DEFAULT_PER_AGENT_MIB = 700;
const MAX_EXPLORERS = 8;

function meminfo() {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(text);
      return match ? Number(match[1]) / 1024 : null;
    };
    return { availableMiB: get('MemAvailable'), swapFreeMiB: get('SwapFree') };
  } catch {
    return { availableMiB: null, swapFreeMiB: null };
  }
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

function capacity({ availableMiB, swapFreeMiB }, { requested = MAX_EXPLORERS, active = 0, perAgentMiB = DEFAULT_PER_AGENT_MIB }) {
  if (!Number.isFinite(availableMiB)) {
    return { ok: false, reason: 'MemAvailable unavailable', admit: 0 };
  }
  const usable = availableMiB - RESERVE_MIB;
  const feasible = Math.max(0, Math.floor(usable / perAgentMiB));
  const room = Math.max(0, feasible - active);
  const admit = Math.min(room, requested, Math.max(0, MAX_EXPLORERS - active));
  const swapPressure = Number.isFinite(swapFreeMiB) && swapFreeMiB < 1024;
  return {
    ok: admit > 0,
    availableMiB: Math.round(availableMiB),
    swapFreeMiB: swapFreeMiB === null ? null : Math.round(swapFreeMiB),
    reserveMiB: RESERVE_MIB,
    perAgentMiB,
    feasible,
    active,
    requested,
    admit,
    defer: Math.max(0, requested - admit),
    swapPressure,
    reason: admit > 0
      ? `admit ${admit}; defer ${Math.max(0, requested - admit)} until memory frees up`
      : swapPressure
        ? 'swap free below 1 GiB; wait before adding explorers'
        : `need ${RESERVE_MIB} MiB reserve plus ${perAgentMiB} MiB per agent`,
  };
}

const { command, options } = parseArgs(process.argv.slice(2));
const snapshot = meminfo();

if (command === 'status') {
  console.log(JSON.stringify({ ...snapshot, capacity: capacity(snapshot, {
    requested: Number(options.requested) || MAX_EXPLORERS,
    active: Number(options.active) || 0,
    perAgentMiB: Number(options['per-agent']) || DEFAULT_PER_AGENT_MIB,
  }) }, null, 2));
  process.exit(0);
}

if (command === 'admit') {
  const result = capacity(snapshot, {
    requested: Number(options.requested) || MAX_EXPLORERS,
    active: Number(options.active) || 0,
    perAgentMiB: Number(options['per-agent']) || DEFAULT_PER_AGENT_MIB,
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.admit > 0 ? 0 : 3);
}

console.log(JSON.stringify({ ok: false, error: `unknown command: ${command}` }));
process.exit(2);
