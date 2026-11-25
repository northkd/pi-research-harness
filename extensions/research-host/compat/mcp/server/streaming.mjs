const MAX_BUFFERED_EVENTS = 1e3;
class McpSubscription {
  sessionIds;
  sink;
  caller;
  options;
  buffered = 0;
  closed = false;
  drainBound = false;
  unsubscribe = null;
  constructor(sessionIds, sink, caller, options = {}) {
    this.sessionIds = sessionIds;
    this.sink = sink;
    this.caller = caller;
    this.options = options;
  }
  /** True once released. Tests assert this rather than poking internals. */
  get isClosed() {
    return this.closed;
  }
  /** Attach to the source. Separated from the constructor so a failure to
   * attach cannot leave a half-live subscription. */
  attach(source) {
    this.unsubscribe = source.onEvent((sessionId, payload) => {
      this.deliver({ sessionId, payload });
    });
    return this;
  }
  deliver(event) {
    if (this.closed) return;
    if (!this.sessionIds.has(event.sessionId)) return;
    if (this.options.isStillAuthorised && !this.options.isStillAuthorised()) {
      this.terminate("credential revoked");
      return;
    }
    if (this.buffered >= MAX_BUFFERED_EVENTS) {
      this.terminate("subscriber too slow");
      return;
    }
    const ok = this.sink.write(`${JSON.stringify(event)}
`);
    if (ok) {
      this.buffered = 0;
      return;
    }
    this.buffered += 1;
    if (!this.drainBound) {
      this.drainBound = true;
      this.sink.onDrain?.(() => {
        this.buffered = 0;
      });
    }
  }
  terminate(reason) {
    if (this.closed) return;
    try {
      this.sink.write(`${JSON.stringify({ error: "stream terminated", reason })}
`);
    } catch {
    }
    this.close();
  }
  /**
   * Release the subscription. Idempotent, because it is reached from a clean
   * client close, a transport abort, AND shutdown — S4/S5 differ only in which
   * path fires first, so both must converge here.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    try {
      this.sink.end();
    } catch {
    }
  }
  /** The caller this stream belongs to. */
  get owner() {
    return this.caller;
  }
}
class SubscriptionRegistry {
  live = /* @__PURE__ */ new Set();
  get size() {
    return this.live.size;
  }
  open(source, sessionIds, sink, caller, options = {}) {
    const sub = new McpSubscription(new Set(sessionIds), sink, caller, options);
    const originalClose = sub.close.bind(sub);
    sub.close = () => {
      originalClose();
      this.live.delete(sub);
    };
    sub.attach(source);
    this.live.add(sub);
    return sub;
  }
  /** Release everything — server shutdown, or plugin unload (X8). */
  closeAll() {
    for (const sub of [...this.live]) sub.close();
    this.live.clear();
  }
}
export {
  MAX_BUFFERED_EVENTS,
  McpSubscription,
  SubscriptionRegistry
};
