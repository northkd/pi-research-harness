/**
 * Child sessions own a launch model. Ambient extensions may observe that model,
 * but they must not replace the parent's concrete choice during startup or a
 * later tool loop. This guard is scoped to one AgentSession and its stream.
 */
function identity(model) {
  return typeof model?.provider === 'string' && model.provider
    && typeof model?.id === 'string' && model.id
    ? `${model.provider}/${model.id}` : undefined;
}

function selectionError(expected, observed) {
  const error = new Error(`model_selection_changed: native Pi child was launched with '${expected}' but selected '${observed ?? '(missing model)'}'. The provider request was blocked before dispatch. Child extensions must preserve the launch model; start a new child to request a different model.`);
  error.code = 'model_selection_changed';
  error.expectedModel = expected;
  error.observedModel = observed;
  return error;
}

/** Install before extension startup, then restore once all startup hooks finish. */
export function protectChildModelSelection(session, model) {
  if (!model) return { restore: async () => {} };
  const expected = identity(model);
  // pi-auto-model 0.8.x implements its router as a legacy pi-messages provider:
  // replies carry a different physical model, without a Pi virtual route receipt.
  // It cannot satisfy native child identity verification. Stop before spending a
  // request, including when the parent model was inherited by the child.
  if (model.provider === 'pi-auto-model' && model.id === 'auto' && model.api === 'pi-messages') {
    const error = new Error(`model_router_verification_unsupported: '${expected}' uses a legacy pi-messages router without a native virtual-model identity receipt. Specify a concrete provider/model for this child. Native pi-virtual models remain supported.`);
    error.code = 'model_router_verification_unsupported';
    error.expectedModel = expected;
    throw error;
  }
  if (!expected || typeof session?.agent?.streamFunction !== 'function'
      || typeof session.setModel !== 'function') {
    throw new Error('model_selection_guard_unavailable: the native Pi child cannot enforce its launch model.');
  }
  // Pi resolves a native virtual selection in prepareRequest before calling
  // streamFunction with the physical model. Preserve that routing contract while
  // requiring the session itself to keep the requested virtual selection.
  const virtual = model.api === 'pi-virtual';
  let failure;
  const reject = observed => {
    const error = selectionError(expected, observed);
    failure = error.message;
    throw error;
  };
  const originalStream = session.agent.streamFunction;
  session.agent.streamFunction = (selected, context, options) => {
    const selection = identity(session.model);
    if (selection !== expected || (virtual && session.model?.api !== 'pi-virtual')) {
      reject(selection);
    }
    const observed = identity(selected);
    if (!virtual && observed !== expected) reject(observed);
    // A later permitted request must never inherit an earlier local failure.
    failure = undefined;
    return originalStream(selected, context, options);
  };
  const initialThinking = session.thinkingLevel;
  return {
    get failure() { return failure; },
    async restore() {
      if (identity(session.model) !== expected) {
        // setModel emits this session's model_select event. Routers such as
        // pi-auto-model suspend themselves on that explicit concrete selection.
        // Do not persist: the parent session and global defaults are independent.
        await session.setModel(model);
        if (initialThinking !== undefined && typeof session.setThinkingLevel === 'function') {
          session.setThinkingLevel(initialThinking);
        }
      }
      const observed = identity(session.model);
      if (observed !== expected) throw selectionError(expected, observed);
    },
  };
}
