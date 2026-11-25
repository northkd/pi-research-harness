import { requestPluginServer } from "../../bridge-request.mjs";
import { FLOW_FILES_REPORT, FLOW_FILES_REQUEST_EVENT } from "../flow-files-contract.js";
const TRIGGERS = [
  "flow:register-flows-dir",
  "flow:register-agents-dir",
  "flow:unregister-flows-dir",
  "flow:unregister-agents-dir",
  "flow:rediscover",
  FLOW_FILES_REQUEST_EVENT
];
const DEBOUNCE_MS = 300;
const RETRY_MS = 2e3;
const MAX_RETRIES = 5;
function toFile(name, source) {
  return typeof name === "string" && typeof source === "string" && source ? { name, source } : null;
}
function collectFlowFiles(events) {
  const flows = [];
  const agents = [];
  try {
    const probe = {};
    events.emit("flow:list-flows", probe);
    if (Array.isArray(probe.flows)) {
      for (const f of probe.flows) {
        const r = toFile(f?.name, f?.source);
        if (r) flows.push(r);
      }
    }
  } catch {
  }
  try {
    const probe = {};
    events.emit("flow:get-agents", probe);
    const entries = probe.agents instanceof Map ? probe.agents.entries() : probe.agents && typeof probe.agents === "object" ? Object.entries(probe.agents) : [];
    for (const [key, cfg] of entries) {
      const c = cfg;
      const r = toFile(typeof c?.name === "string" ? c.name : key, c?.source);
      if (r) agents.push(r);
    }
  } catch {
  }
  return { flows, agents };
}
function startFlowFilesReporter(pi) {
  const events = pi.events;
  if (!events || typeof events.emit !== "function" || typeof events.on !== "function") return;
  let timer;
  let retries = 0;
  const send = async () => {
    timer = void 0;
    const reply = await requestPluginServer("flows", FLOW_FILES_REPORT, collectFlowFiles(events));
    if (reply.ok) {
      retries = 0;
      return;
    }
    if ((reply.error === "unavailable" || reply.error === "disconnected" || reply.error === "timeout") && retries < MAX_RETRIES) {
      retries++;
      timer = setTimeout(() => void send(), RETRY_MS);
    }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    retries = 0;
    timer = setTimeout(() => void send(), DEBOUNCE_MS);
  };
  for (const name of TRIGGERS) {
    try {
      events.on(name, schedule);
    } catch {
    }
  }
  try {
    pi.on?.("session_start", schedule);
  } catch {
  }
}
export {
  collectFlowFiles,
  startFlowFilesReporter
};
