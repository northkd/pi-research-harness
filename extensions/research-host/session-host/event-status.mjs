/** Derive session state from an explicit native event or a forwarded event. */
export function extractSessionUpdates(event, hasPendingPrompt = false) {
  const type = event.eventType ?? event.type;
  const data = event.data ?? event;
  let update;
  switch (type) {
    case 'agent_start': update = { status: 'streaming', currentTool: null }; break;
    case 'agent_end':
    case 'agent_settled': update = { status: 'idle', currentTool: null }; break;
    case 'session_before_compact':
    case 'auto_compaction_start': update = { compacting: true }; break;
    case 'session_compact':
    case 'session_compact_failed':
    case 'auto_compaction_end': update = { compacting: false }; break;
    case 'ui_prompt_start': update = { currentTool: 'ask_user' }; break;
    case 'ui_prompt_end': update = { currentTool: null }; break;
    case 'tool_execution_start':
      if (typeof data.parentToolCallId === 'string' && data.parentToolCallId) return null;
      update = { currentTool: data.toolName ?? null }; break;
    case 'tool_execution_end':
      if (typeof data.parentToolCallId === 'string' && data.parentToolCallId) return null;
      update = { currentTool: null }; break;
    case 'model_select':
      if (!data.model?.provider || !data.model?.id) return null;
      update = { model: data.model.provider + '/' + data.model.id };
      if (data.thinkingLevel !== undefined) update.thinkingLevel = data.thinkingLevel;
      break;
    default: return null;
  }
  if (hasPendingPrompt && Object.hasOwn(update, 'currentTool') && !update.currentTool) update.currentTool = 'ask_user';
  return update;
}

/** Native `agent_settled` includes queued continuation/retry completion. */
export function extractNativeSessionUpdates(event, hasPendingPrompt = false) {
  if (event.type === 'agent_end') return null;
  return extractSessionUpdates(event, hasPendingPrompt);
}

/** Track witnessed tool identities separately from the single display name.
 * A settled run without an exact end retains an unknown record for inspection. */
export function updateActiveToolCalls(calls, event) {
  const type = event.eventType ?? event.type, data = event.data ?? event;
  if (type === 'agent_settled') {
    let changed = false;
    for (const [id, call] of calls) {
      if (call.phase === 'active') { calls.set(id, { ...call, phase: 'unknown' }); changed = true; }
    }
    return changed;
  }
  const toolCallId = data.toolCallId;
  if (!['tool_execution_start', 'tool_execution_end'].includes(type) || typeof toolCallId !== 'string'
    || !toolCallId || toolCallId.length > 1024 || /[\u0000-\u001f\u007f]/.test(toolCallId)) return false;
  if (type === 'tool_execution_end') return calls.delete(toolCallId);
  calls.set(toolCallId, { toolCallId, phase: 'active',
    ...(typeof data.toolName === 'string' ? { toolName: data.toolName } : {}),
    ...(typeof data.parentToolCallId === 'string' && data.parentToolCallId ? { parentToolCallId: data.parentToolCallId } : {}) });
  return true;
}

export function observedToolName(calls) {
  const active = [...calls.values()].filter(call => call.phase === 'active');
  return active.filter(call => !call.parentToolCallId).at(-1)?.toolName ?? active.at(-1)?.toolName ?? null;
}
