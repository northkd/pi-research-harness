import test from 'node:test';
import assert from 'node:assert/strict';
import { createSystemdRolloutAdapter } from './rollout-systemd.mjs';
import { LEGACY_UNITS, NEW_UNITS } from './rollout.mjs';

const proven = async () => ({ ok: true, evidence: ['fixture-native-and-feature-proof'] });
const callbacks = { assertNativeQuiescent: proven, verifyHealth: proven, verifyProofs: proven, verifyRestart: proven, quiesceNewSessions: proven };

test('systemd adapter pins user bus, exact units and non-shell execution', async () => {
  const calls = [];
  const adapter = createSystemdRolloutAdapter({ ...callbacks, uid: 1000, checkSocket: file => file === '/run/user/1000/bus',
    environment: { PATH: '/fixture/path', DBUS_SESSION_BUS_ADDRESS: 'wrong' },
    async executeCommand(file, args, options) { calls.push({ file, args, options }); return { stdout: 'LoadState=loaded\nActiveState=inactive\nUnitFileState=disabled\nMainPID=0\nFragmentPath=/fixture/unit\n' }; } });
  assert.equal((await adapter.preflight()).ok, true);
  assert.equal(calls.length, LEGACY_UNITS.length + NEW_UNITS.length);
  assert.equal(calls.every(call => call.file === '/usr/bin/systemctl' && call.args[0] === '--user' && call.options.env.DBUS_SESSION_BUS_ADDRESS === 'unix:path=/run/user/1000/bus'), true);
  await adapter.stop(LEGACY_UNITS[0]); await adapter.start(NEW_UNITS[0]);
  await adapter.enable(NEW_UNITS[1]); await adapter.disable(LEGACY_UNITS[1]); await adapter.daemonReload();
  await assert.rejects(adapter.stop('unrelated-user.service'), { code: 'rollout-unit-outside-allowlist' });
  assert.equal((await adapter.assertQuiescent({ phase: 'fixture' })).ok, true);
});

test('missing proof callbacks, active writers, missing bus and failed command fail explicitly', async () => {
  assert.throws(() => createSystemdRolloutAdapter({}), { code: 'rollout-real-proof-callbacks-required' });
  const active = createSystemdRolloutAdapter({ ...callbacks, executeCommand: async () => ({ stdout: 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nMainPID=123\n' }) });
  await assert.rejects(active.assertQuiescent({}), { code: 'rollout-service-writer-still-running' });
  const missing = createSystemdRolloutAdapter({ ...callbacks, checkSocket: () => false });
  await assert.rejects(missing.preflight(), { code: 'rollout-user-bus-socket-required' });
  const failed = createSystemdRolloutAdapter({ ...callbacks, executeCommand: async () => { throw new Error('fixture-secret'); } });
  await assert.rejects(failed.daemonReload(), { code: 'rollout-user-systemd-command-failed' });
});

test('systemd state parser recognizes absent new units and demands native evidence', async () => {
  const adapter = createSystemdRolloutAdapter({ ...callbacks, assertNativeQuiescent: async () => ({ ok: true }),
    executeCommand: async () => { const error = new Error('not found'); error.stdout = 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\nMainPID=0\n'; throw error; } });
  assert.deepEqual(await adapter.serviceState(NEW_UNITS[0]), { active: false, enabled: false, exists: false, mainPid: 0, fragmentPath: '' });
  await adapter.stop(NEW_UNITS[0]); await adapter.disable(NEW_UNITS[0]);
  await assert.rejects(adapter.assertQuiescent({}), { code: 'rollout-native-writer-quiescence-unconfirmed' });
});
