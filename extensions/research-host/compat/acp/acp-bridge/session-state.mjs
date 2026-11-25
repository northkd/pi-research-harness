class PromptQueue {
  items = [];
  get length() {
    return this.items.length;
  }
  enqueue(p) {
    this.items.push(p);
  }
  shift() {
    return this.items.shift();
  }
  edit(index, text) {
    const item = this.items[index];
    if (!item) return false;
    this.items[index] = { ...item, text };
    return true;
  }
  remove(index) {
    if (!this.items[index]) return false;
    this.items.splice(index, 1);
    return true;
  }
  /** Move to the front so it is sent next. */
  promote(index) {
    const item = this.items[index];
    if (!item) return false;
    this.items.splice(index, 1);
    this.items.unshift(item);
    return true;
  }
  clear(indices) {
    if (indices === "all") this.items = [];
    else this.items = this.items.filter((_, i) => !indices.includes(i));
  }
  clearAll() {
    this.items = [];
  }
  view() {
    return this.items.map((i) => ({ text: i.text, imageCount: i.images?.length ?? 0 }));
  }
}
class EchoGuard {
  /** A dashboard prompt is written and not yet resolved (v1) / not yet accepted (v2). */
  awaiting = false;
  /** v1: drop every user chunk for the whole active prompt. */
  dropAllUntilResolved = false;
  held = [];
  suppressedIds = /* @__PURE__ */ new Set();
  /** A dashboard prompt was just written. */
  begin(protocol) {
    this.awaiting = true;
    this.dropAllUntilResolved = protocol === 1;
    this.held = [];
  }
  /**
   * Route one user update. Returns `suppress` (mark id suppressed, then push),
   * `hold` (already stored; do not push yet) or `pass`.
   */
  route(u) {
    if (this.suppressedIds.has(u.messageId)) return "suppress";
    if (!this.awaiting) return "pass";
    if (this.dropAllUntilResolved) {
      this.suppressedIds.add(u.messageId);
      return "suppress";
    }
    this.held.push(u);
    return "hold";
  }
  /**
   * v2 acceptance (`{messageId}`): echoes of that id (held or later) are dropped;
   * other held user updates are released to the caller to push.
   */
  accepted(messageId) {
    this.awaiting = false;
    if (messageId) this.suppressedIds.add(messageId);
    const release = this.held.filter((u) => u.messageId !== messageId);
    this.held = [];
    return release;
  }
  /** v1 resolution / rejected prompt: the active window is over. */
  resolved() {
    this.awaiting = false;
    this.dropAllUntilResolved = false;
    const release = this.held;
    this.held = [];
    return release;
  }
}
export {
  EchoGuard,
  PromptQueue
};
