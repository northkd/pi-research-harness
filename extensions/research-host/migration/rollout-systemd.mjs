import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LEGACY_UNITS, NEW_UNITS } from './rollout.mjs';

const execute = promisify(execFile);
const allowed = new Set([...LEGACY_UNITS, ...NEW_UNITS]);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

/** The caller supplies native-writer and feature proofs; systemd alone cannot prove them. */
export function createSystemdRolloutAdapter({ assertNativeQuiescent, verifyHealth, verifyProofs, verifyRestart, quiesceNewSessions,
  uid = process.getuid(), executeCommand = execute, checkSocket = file => fs.statSync(file).isSocket(), environment = process.env } = {}) {
  for (const callback of [assertNativeQuiescent, verifyHealth, verifyProofs, verifyRestart, quiesceNewSessions]) if (typeof callback !== 'function') fail('rollout-real-proof-callbacks-required');
  if (!Number.isInteger(uid) || uid < 1) fail('rollout-user-bus-uid-invalid');
  const socket = `/run/user/${uid}/bus`, bus = `unix:path=${socket}`;
  const command = async args => {
    let result;
    try { result = await executeCommand('/usr/bin/systemctl', ['--user', ...args], {
      env: { ...environment, DBUS_SESSION_BUS_ADDRESS: bus, SYSTEMD_PAGER: 'cat', SYSTEMD_COLORS: '0' },
      timeout: 45000, maxBuffer: 256 * 1024, encoding: 'utf8',
    }); } catch (error) {
      if (args[0] === 'show' && /^LoadState=not-found$/m.test(String(error.stdout ?? ''))) return String(error.stdout);
      fail('rollout-user-systemd-command-failed');
    }
    return String(result.stdout ?? '');
  };
  const unit = name => { if (!allowed.has(name)) fail('rollout-unit-outside-allowlist'); return name; };
  const adapter = {
    async serviceState(name) {
      const output = await command(['show', unit(name), '--no-pager', '--property=LoadState,ActiveState,SubState,UnitFileState,MainPID,FragmentPath']);
      const fields = Object.fromEntries(output.trim().split('\n').filter(Boolean).map(row => { const index = row.indexOf('='); return [row.slice(0, index), row.slice(index + 1)]; }));
      if (!['loaded', 'not-found'].includes(fields.LoadState) || !['active', 'inactive', 'failed'].includes(fields.ActiveState)) fail('rollout-service-state-unsettled');
      if (fields.UnitFileState && !['enabled', 'disabled', 'enabled-runtime'].includes(fields.UnitFileState)) fail('rollout-service-enable-state-unrecognized');
      return { active: fields.ActiveState === 'active', enabled: fields.UnitFileState === 'enabled' || fields.UnitFileState === 'enabled-runtime',
        exists: fields.LoadState === 'loaded', mainPid: Number(fields.MainPID || 0), fragmentPath: fields.FragmentPath || '' };
    },
    stop: async name => { if ((await adapter.serviceState(name)).exists) await command(['stop', unit(name)]); },
    start: async name => command(['start', unit(name)]), enable: async name => command(['enable', unit(name)]),
    disable: async name => { if ((await adapter.serviceState(name)).exists) await command(['disable', unit(name)]); },
    daemonReload: () => command(['daemon-reload']),
    async preflight() {
      if (!checkSocket(socket)) fail('rollout-user-bus-socket-required');
      const services = {};
      for (const name of allowed) services[name] = await adapter.serviceState(name);
      return { ok: true, bus, services, evidence: ['explicit user bus available; exact service states read'] };
    },
    async assertQuiescent(context) {
      for (const name of allowed) {
        const current = await adapter.serviceState(name);
        if (current.active || current.mainPid !== 0) fail('rollout-service-writer-still-running');
      }
      const result = await assertNativeQuiescent({ ...context, adapter });
      if (result?.ok !== true || !Array.isArray(result.evidence) || !result.evidence.length) fail('rollout-native-writer-quiescence-unconfirmed');
      return { ...result, observedAt: new Date().toISOString(), evidence: ['all exact service writers inactive with MainPID=0', ...result.evidence] };
    },
    verifyHealth: context => verifyHealth({ ...context, adapter }),
    verifyProofs: context => verifyProofs({ ...context, adapter }),
    verifyRestart: context => verifyRestart({ ...context, adapter }),
    quiesceNewSessions: context => quiesceNewSessions({ ...context, adapter }),
  };
  return adapter;
}
