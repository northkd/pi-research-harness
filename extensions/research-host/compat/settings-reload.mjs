import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, maybeJson } from '../session-host/files.mjs';
import { fail } from '../http.mjs';

export function createSettingsReload({ stateDir, sessions, controls, hasQuestion, readRevision, onDiagnostic }) {
  const file = path.join(stateDir, 'settings-reload.json');
  let processing;
  const current = () => maybeJson(file, 512 * 1024);
  const native = row => row?.live === true && (!row.driver || row.driver === 'pi') && !row.originDeviceId;
  const ready = row => row.status === 'idle' && !row.pendingUIRequests?.length && !hasQuestion(row.id);
  const summary = operation => ({
    reloadedSessions: operation?.sessions.filter(row => row.state === 'reloaded').length ?? 0,
    reload: operation ?? null,
  });

  function schedule(revision, retry = false) {
    if (!/^[a-f0-9]{64}$/.test(revision)) fail(400, 'settings-reload-revision-invalid');
    const previous = current();
    if (previous?.revision === revision && !retry) return summary(previous);
    const records = previous?.revision === revision ? previous.sessions : [];
    const operation = {
      revision,
      sessions: sessions.listSessions().filter(native).map(row => {
        const recorded = records.find(candidate => candidate.sessionId === row.id);
        if (recorded && ['applying', 'pending', 'reloaded'].includes(recorded.state)) return recorded;
        return { sessionId: row.id, requestId: 'settings-' + randomUUID(), state: 'pending' };
      }),
    };
    atomicJson(file, operation);
    void tick();
    return summary(operation);
  }

  function update(operation, entry, patch) {
    const latest = current();
    if (latest?.revision !== operation.revision) return;
    const index = latest.sessions.findIndex(row => row.requestId === entry.requestId);
    if (index < 0) return;
    latest.sessions[index] = { ...latest.sessions[index], ...patch };
    atomicJson(file, latest);
  }

  async function step() {
    const operation = current();
    if (!operation?.sessions.some(row => row.state === 'pending' || row.state === 'applying')) return;
    if (readRevision() !== operation.revision) {
      for (const entry of operation.sessions) {
        if (entry.state === 'pending' || entry.state === 'applying') update(operation, entry, { state: 'superseded' });
      }
      return;
    }
    for (const entry of operation.sessions) {
      if (entry.state !== 'pending' && entry.state !== 'applying') continue;
      const row = sessions.getSession(entry.sessionId);
      if (!native(row)) { update(operation, entry, { state: 'ended' }); continue; }
      if (!ready(row)) continue;
      update(operation, entry, { state: 'applying' });
      try {
        const result = await controls.apply(row, 'reload-settings', { requestId: entry.requestId });
        if (result.state !== 'reloaded' || !result.settingsHash || result.generation === result.previousGeneration) {
          fail(503, 'native-reload-receipt-invalid');
        }
        update(operation, entry, { state: 'reloaded', settingsHash: result.settingsHash, generation: result.generation });
      } catch (error) {
        const code = /^[a-z0-9-]{1,100}$/.test(error?.code ?? '') ? error.code : 'native-settings-reload-unconfirmed';
        update(operation, entry, code === 'native-settings-reload-busy'
          ? { state: 'pending', requestId: 'settings-' + randomUUID() }
          : { state: 'unconfirmed', code });
      }
      return;
    }
  }

  function tick() {
    if (!processing) processing = step().catch(() => onDiagnostic?.('settings-reload-state-unavailable'))
      .finally(() => { processing = undefined; });
    return processing;
  }

  return { schedule, status: () => summary(current()), tick, async settle() { await processing; } };
}
