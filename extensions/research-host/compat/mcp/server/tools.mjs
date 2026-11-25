import { rank } from "../shared/tiers.mjs";
const ALL_CONTEXT_MEMBERS = [
  "fastify",
  "sessionManager",
  "eventStore",
  "broadcastToSubscribers",
  "registerPiHandler",
  "registerBrowserHandler",
  "onEvent",
  "onSessionEnded",
  "sendToSession",
  "emitEventToSession",
  "sendExtensionMessage",
  "spawnSession",
  "abortSession",
  "abortSpawnedRun",
  "provide",
  "consume",
  "consumeAll",
  "getPluginConfig",
  "updatePluginConfig",
  "logger",
  // See change: expose-plugin-credential-and-oauth-seams.
  "credentials",
  "oauth",
  "registerPiRequestHandler"
];
const ALLOWLISTED_CONTEXT_MEMBERS = [
  "sessionManager",
  "sendToSession",
  "spawnSession",
  "abortSession",
  "onEvent"
];
const INTERNAL_ONLY_CONTEXT_MEMBERS = ["fastify"];
const DENIED_CONTEXT_MEMBERS = [
  "eventStore",
  "broadcastToSubscribers",
  "registerPiHandler",
  "registerBrowserHandler",
  "onSessionEnded",
  "emitEventToSession",
  "sendExtensionMessage",
  "abortSpawnedRun",
  "provide",
  "consume",
  "consumeAll",
  "getPluginConfig",
  "updatePluginConfig",
  "logger",
  // Plugin-private credential store, OAuth flows and bridge request lane:
  // never reachable from an MCP caller. See change:
  // expose-plugin-credential-and-oauth-seams.
  "credentials",
  "oauth",
  "registerPiRequestHandler"
];
const FORBIDDEN_VERB_NAMES = [
  // UI-only.
  "reorder_pinned_dirs",
  "set_session_process_drawer",
  // Transport plumbing.
  "subscribe",
  "watch_files",
  "worktree_init_subscribe"
];
function filterToolsForTier(tools, tier) {
  return tools.filter((t) => rank(t.tier) <= rank(tier));
}
function listTools(tools, tier = "operate") {
  return filterToolsForTier(tools, tier).map((t) => ({
    name: t.name,
    description: t.description,
    annotations: t.annotations,
    inputSchema: t.inputSchema
  }));
}
function findTool(name, tools) {
  return typeof name === "string" ? tools.find((t) => t.name === name) : void 0;
}
function checkToolCompleteness(tools, resolve) {
  const missing = tools.filter((t) => typeof resolve(t.name) !== "function").map((t) => t.name);
  return { ok: missing.length === 0, missing };
}
function assertContextPartitionTotal(all = ALL_CONTEXT_MEMBERS, allowed = ALLOWLISTED_CONTEXT_MEMBERS, denied = DENIED_CONTEXT_MEMBERS, internal = INTERNAL_ONLY_CONTEXT_MEMBERS) {
  const lists = [allowed, denied, internal];
  const unclassified = all.filter((m) => !lists.some((l) => l.includes(m)));
  const overlapping = all.filter((m) => lists.filter((l) => l.includes(m)).length > 1);
  return { ok: unclassified.length === 0 && overlapping.length === 0, unclassified, overlapping };
}
export {
  ALLOWLISTED_CONTEXT_MEMBERS,
  ALL_CONTEXT_MEMBERS,
  DENIED_CONTEXT_MEMBERS,
  FORBIDDEN_VERB_NAMES,
  INTERNAL_ONLY_CONTEXT_MEMBERS,
  assertContextPartitionTotal,
  checkToolCompleteness,
  filterToolsForTier,
  findTool,
  listTools
};
