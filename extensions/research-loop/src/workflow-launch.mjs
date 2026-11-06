import { randomUUID } from 'node:crypto';

/** Dispatch through the native workflow host; a saved research quota is not a prerequisite. */
export function spawnResearchWorkflow({ pi, ctx, cwd, params }) {
  const parentSessionId = ctx?.sessionManager?.getSessionId?.();
  if (ctx?.cwd !== cwd || typeof parentSessionId !== 'string' || !parentSessionId) throw new Error('research-workflow-scope-mismatch');
  const requestId = 'research-workflow-' + randomUUID();
  return new Promise((resolve, reject) => {
    const reply = 'subagents:rpc:v1:reply:' + requestId;
    const off = pi.events.on(reply, value => {
      if (value?.requestId !== requestId) return;
      clearTimeout(timer);
      off();
      value.success ? resolve(value.data) : reject(new Error('research-workflow-rpc-failed'));
    });
    const timer = setTimeout(() => { off(); reject(new Error('research-workflow-rpc-unconfirmed')); }, 30_000);
    timer.unref?.();
    try {
      pi.events.emit('subagents:rpc:v1:request', { version: 1, requestId, method: 'spawn', params, source: { extension: 'research-loop' } });
    } catch (error) {
      clearTimeout(timer);
      off();
      reject(error);
    }
  });
}
