const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** Pi's EventBus returns void. A mutated query is the existing pi-flows probe. */
export async function probeFlowRuntime(events) {
  const query = {};
  events.emit('flow:list-flows', query);
  await Promise.resolve();
  return {
    available: Object.hasOwn(query, 'flows') && Array.isArray(query.flows),
    flows: Array.isArray(query.flows) ? query.flows : [],
  };
}

function observedEvent(events, channels, match, timeoutMs, dispatch) {
  return new Promise(resolve => {
    const subscriptions = [];
    let finished = false;
    let timer;
    const finish = result => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const unsubscribe of subscriptions) if (typeof unsubscribe === 'function') unsubscribe();
      resolve(result);
    };
    for (const channel of channels) {
      subscriptions.push(events.on(channel, data => {
        const result = match(channel, data || {});
        if (result) finish(result);
      }));
    }
    timer = setTimeout(() => finish({ status: 'unconfirmed', reason: 'flow-effect-unconfirmed' }), timeoutMs);
    try { dispatch(); }
    catch { finish({ status: 'unconfirmed', reason: 'flow-effect-unconfirmed' }); }
  });
}

/** Accept control only after a receiver response or an observed state change. */
export function createFlowControlAdapter(events, options = {}) {
  const timeoutMs = options.timeoutMs || 1800;
  return async (event, beforeEmit) => {
    const runtime = await probeFlowRuntime(events);
    if (!runtime.available) return { status: 'rejected', reason: 'flow-runtime-unavailable' };
    const emit = () => { beforeEmit(); events.emit(event.eventType, event.data); };
    if (event.eventType === 'flow:run') {
      const name = event.data.flowName;
      if (typeof name !== 'string' || !runtime.flows.some(flow => flow?.name === name)) return { status: 'rejected', reason: 'flow-not-found' };
      return observedEvent(events, ['flow:flow-started', 'flow:complete'], (channel, data) => {
        if (data.flowName !== name) return null;
        if (channel === 'flow:flow-started') return { status: 'accepted', observation: 'flow_started' };
        if (data.status === 'rejected') return { status: 'rejected', reason: 'flow-start-rejected' };
        return null;
      }, timeoutMs, emit);
    }
    if (event.eventType === 'flow:abort' || event.eventType === 'flow:architect-abort') {
      const channel = event.eventType === 'flow:abort' ? 'flow:complete' : 'flow:architect-complete';
      return observedEvent(events, [channel], (_name, data) => data.status === 'rejected' ? null : { status: 'accepted', observation: 'flow_ended' }, timeoutMs, emit);
    }
    if (event.eventType === 'flow:toggle-autonomous') {
      return observedEvent(events, ['flow:autonomous-mode-changed'], (_name, data) => typeof data.enabled === 'boolean' ? { status: 'accepted', observation: 'flow_autonomous_changed' } : null, timeoutMs, emit);
    }
    if (event.eventType === 'flow:delete-request') {
      const name = event.data.flowName;
      if (typeof name !== 'string' || !name) return { status: 'rejected', reason: 'flow-name-required' };
      if (!runtime.flows.some(flow => flow?.name === name)) return { status: 'accepted', observation: 'flow_already_absent' };
      emit();
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const fresh = await probeFlowRuntime(events);
        if (fresh.available && !fresh.flows.some(flow => flow?.name === name)) return { status: 'accepted', observation: 'flow_absent' };
        await pause(20);
      }
      return { status: 'unconfirmed', reason: 'flow-effect-unconfirmed' };
    }
    // The deployed peer is absent, and its edit-mode/rediscovery handlers have
    // no verified response contract in this installation. A supplied adapter
    // can prove those effects when that peer supplies a status interface.
    if (typeof options.verifyEffect === 'function') {
      emit();
      return await options.verifyEffect(event, runtime) === true
        ? { status: 'accepted', observation: 'flow_verified_state' }
        : { status: 'unconfirmed', reason: 'flow-effect-unconfirmed' };
    }
    return { status: 'rejected', reason: 'flow-control-verification-unavailable' };
  };
}
