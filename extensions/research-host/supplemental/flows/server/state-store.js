import { isFlowEvent, reduceFlowEvent } from "../flow-reducer.js";
class StateStore {
  map = /* @__PURE__ */ new Map();
  /** Initialize state for a session if it doesn't exist. */
  ensure(sessionId) {
    let s = this.map.get(sessionId);
    if (!s) {
      s = { flows: [], commands: [] };
      this.map.set(sessionId, s);
    }
    return s;
  }
  getState(sessionId) {
    return this.map.get(sessionId);
  }
  /** Apply an event from pi (flow_*, etc.) to the session's state. */
  applyEvent(sessionId, event) {
    const s = this.ensure(sessionId);
    let changed = false;
    if (isFlowEvent(event.eventType)) {
      const next = reduceFlowEvent(s.flowState ?? null, event);
      if (next !== s.flowState) {
        s.flowState = next;
        changed = true;
      }
    }
    return changed;
  }
  /** Update available flows list (from pi flows_list message). */
  setFlows(sessionId, flows) {
    const s = this.ensure(sessionId);
    s.flows = flows;
  }
  /** Update available commands list. */
  setCommands(sessionId, commands) {
    const s = this.ensure(sessionId);
    s.commands = commands;
  }
  clearSession(sessionId) {
    this.map.delete(sessionId);
  }
  /** Test-only: reset all state. */
  __resetForTests() {
    this.map.clear();
  }
}
const stateStore = new StateStore();
export {
  stateStore
};
