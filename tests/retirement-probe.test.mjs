import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalRetirementProbe } from '../extensions/research-loop/src/retirement-probe.mjs';

test('unproved shell and formal launch paths retain the session', { skip: process.platform !== 'linux' }, async () => {
  const scope = { sessionId: 'child', parentSessionId: 'parent', adoptionId: 'adoption', charterHash: 'hash', cwd: '/tmp' };
  const request = async () => ({ retirement: { complete: true, sessionId: scope.sessionId, pid: process.pid,
    reportId: 'result', formalChildren: [], supervisorRequests: [] } });
  const probe = createLocalRetirementProbe({ request, reportId: 'result' });
  const snapshot = await probe({ scope, activity: { toolNames: ['read', 'bash', 'bg_run', 'research_session', 'research_dispatch', 'research_loop'],
    backgroundTaskIds: [], subagentRunIds: [] } });
  assert.deepEqual(snapshot.unknownTools, ['bash', 'bg_run', 'research_session', 'research_dispatch', 'research_loop']);
});

test('retirement probe rejects a different native report before any process observation', async () => {
  const probe = createLocalRetirementProbe({ platform: 'linux', reportId: 'expected',
    request: async () => ({ retirement: { complete: true, sessionId: 'child', pid: process.pid, reportId: 'later' } }) });
  await assert.rejects(probe({ scope: { sessionId: 'child' }, activity: {} }), /native session\/report not verified/);
});
