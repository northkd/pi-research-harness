import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionCreation, isSessionCreation, projectSessionCreation, sessionProvenanceMatchesCwd } from '../patches/dashboard-v0.20/overlay/packages/shared/src/session-creation.ts';

const creation = {
  schema: 'pi-session-creation.v1', kind: 'user', entryPoint: 'dashboard',
  cwd: '/research', createdAt: '2026-11-06T09:00:00.000Z',
};

test('session creation requires an explicit bounded display record; launch source and membership prove nothing', () => {
  assert.equal(isSessionCreation(creation), true);
  assert.deepEqual(createSessionCreation('/research', 'dashboard', creation.createdAt), creation);
  for (const value of [null, { ...creation, kind: 'agent' }, { ...creation, parentSessionId: 'parent' }, { ...creation, entryPoint: 'prompt' }, { ...creation, cwd: '../research' }, { ...creation, createdAt: 'yesterday' }]) {
    assert.equal(isSessionCreation(value), false);
  }
  assert.equal(projectSessionCreation({ cwd: '/research', source: 'dashboard', resWorkflow: { canonicalCwd: '/research', via: 'spawn' } }, '/research'), null);
});

test('creation projection survives persisted plugin refs without treating unrelated directories as the same workspace', () => {
  const info = { cwd: '/research', pluginRefs: { 'res-workflow': { sessionCreation: creation } } };
  assert.deepEqual(projectSessionCreation(info, '/research'), creation);
  assert.equal(projectSessionCreation(info, '/elsewhere'), null);
  assert.equal(projectSessionCreation({ ...info, cwd: '/elsewhere' }, '/research'), null);
  assert.equal(projectSessionCreation({ ...info, sessionCreation: { ...creation, entryPoint: 'research-stage' } }, '/research'), null);
});

test('canonical membership can explain a cwd alias but absent evidence cannot create a relation', () => {
  const info = { cwd: '/alias', resWorkflow: { canonicalCwd: '/research' } };
  assert.equal(sessionProvenanceMatchesCwd(info, '/research', '/alias'), true);
  assert.equal(sessionProvenanceMatchesCwd(info, '/research', '/research'), true);
  assert.equal(sessionProvenanceMatchesCwd(info, '/other', '/alias'), false);
  assert.equal(sessionProvenanceMatchesCwd({ cwd: '/elsewhere' }, '/research', '/research'), false);
});
