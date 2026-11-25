import path from 'node:path';
import { createHash } from 'node:crypto';

export function supplementalSessionId(spawnToken) {
  if (typeof spawnToken !== 'string' || !spawnToken || spawnToken.includes('\0') || spawnToken.length > 1024) throw new Error('supplemental-spawn-token-invalid');
  const hex = createHash('sha256').update('pi-research-supplemental\0' + spawnToken).digest('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), '5' + hex.slice(13, 16), '8' + hex.slice(17, 20), hex.slice(20, 32)].join('-');
}

/** Reflects the deployed Dashboard's actual scope behavior at server.ts:3896.
 * Existing mode/sandbox selections were recorded while Pi ran in-place. */
export function planAutomationSpawn(input, capabilities = {}) {
  if (!input || typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd)) throw new Error('automation-canonical-cwd-required');
  const mode = input.mode || 'local';
  const sandbox = input.sandbox || 'workspace-write';
  if (!['local', 'worktree'].includes(mode) || !['read-only', 'workspace-write', 'full-access'].includes(sandbox)) throw new Error('automation-scope-invalid');
  if (input.agent !== undefined && (typeof input.agent !== 'string' || !input.agent.trim())) throw new Error('automation-acp-agent-invalid');
  if (input.agent && !capabilities.acp) throw new Error('automation-acp-agent-unavailable');
  const modeEnforced = mode === 'local' || capabilities.worktree === true;
  const sandboxEnforced = capabilities.sandbox === true;
  if (capabilities.requireEnforcement && (!modeEnforced || !sandboxEnforced)) throw new Error('automation-requested-scope-unavailable');
  return {
    requested: { mode, sandbox, ...(input.agent ? { agent: input.agent } : {}) },
    effective: { cwd: input.cwd, mode: modeEnforced ? mode : 'local', sandbox: sandboxEnforced ? sandbox : null },
    enforcement: { mode: modeEnforced, worktree: mode === 'worktree' && capabilities.worktree === true, sandbox: sandboxEnforced, acp: !!input.agent },
    warnings: [
      ...(!modeEnforced ? ['Automation requested worktree mode. The deployed behavior executes in the selected project directory.'] : []),
      ...(!sandboxEnforced && sandbox !== 'workspace-write' ? ['Automation requested ' + sandbox + '. The deployed Pi host provides its ordinary tool and filesystem permissions.'] : []),
    ],
  };
}

/** Scope-capable hosts provide prepareWorktree/spawnSandboxed or spawnAcp.
 * Plain native Pi supports the explicitly reported deployed compatibility path. */
export function createAutomationSpawner(deps) {
  if (typeof deps?.createSession !== 'function' || typeof deps?.authorizeCwd !== 'function') throw new Error('automation-host-capabilities-required');
  return async input => {
    try {
      const plan = planAutomationSpawn(input, {
        acp: typeof deps.spawnAcp === 'function',
        worktree: typeof deps.prepareWorktree === 'function',
        sandbox: typeof deps.spawnSandboxed === 'function',
        requireEnforcement: deps.requireEnforcement === true,
      });
      if (await deps.authorizeCwd(input.cwd) === false) throw new Error('automation-cwd-not-authorized');
      for (const warning of plan.warnings) deps.onDiagnostic?.(warning);
      let cwd = input.cwd;
      let previous;
      if (input.resume?.sessionFile) {
        if (typeof deps.importSession !== 'function') throw new Error('supplemental-resume-capability-required');
        previous = await deps.importSession(input.resume.sessionFile);
        if (!previous?.id || previous.cwd !== cwd) throw new Error('supplemental-resume-identity-mismatch');
      }
      if (plan.requested.mode === 'worktree' && typeof deps.prepareWorktree === 'function') {
        const worktree = await deps.prepareWorktree({ cwd, spawnToken: input.spawnToken });
        if (!worktree || typeof worktree.cwd !== 'string' || !path.isAbsolute(worktree.cwd) || worktree.cwd === cwd) throw new Error('automation-worktree-unconfirmed');
        cwd = worktree.cwd;
      }
      const options = {
        cwd, model: input.agent ? undefined : input.model,
        prompt: input.initialPrompt, spawnToken: input.spawnToken, name: input.name,
        ...(previous ? { sessionId: previous.id, sessionFile: previous.sessionFile, resume: true } : input.spawnToken ? { sessionId: supplementalSessionId(input.spawnToken) } : {}),
        metadata: { ...(input.pluginRef || {}), ...(input.spawnToken ? { spawnToken: input.spawnToken } : {}), ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}), automationScope: { ...plan, effective: { ...plan.effective, cwd } } },
        ...(input.scope ? { scope: input.scope } : {}),
      };
      const result = input.agent
        ? await deps.spawnAcp({ ...options, agent: input.agent })
        : typeof deps.spawnSandboxed === 'function'
          ? await deps.spawnSandboxed({ ...options, sandbox: plan.requested.sandbox })
          : await deps.createSession(options);
      return { ...result, scope: options.metadata.automationScope };
    } catch (error) {
      return { success: false, message: error?.message || 'automation-spawn-unavailable' };
    }
  };
}
