const PEER_AM = "@blackbelt-technology/pi-anthropic-messages";
const PEER_AM_LEGACY = "@pi/anthropic-messages";
const PEER_AM_NAMES = [PEER_AM, PEER_AM_LEGACY];
const PEER_FLOWS = "pi-flows";
function probePeer(spec, deps) {
  try {
    deps.resolve(spec);
    return { ok: true, via: "node" };
  } catch (e) {
    var tier1Reason = e.message;
  }
  const hit = deps.resolvePiPackage?.(spec);
  if (hit && typeof hit.entryPath === "string" && hit.entryPath.length > 0) {
    return { ok: true, via: "pi-packages", entryPath: hit.entryPath };
  }
  return { ok: false, reason: tier1Reason };
}
function probeAll(deps) {
  let am = { ok: false, reason: "not probed" };
  for (const name of PEER_AM_NAMES) {
    am = probePeer(name, deps);
    if (am.ok) break;
  }
  const flowsModule = probePeer(PEER_FLOWS, deps);
  const flowsListener = (deps.flowsListenerCount?.() ?? 0) > 0;
  const flows = flowsModule.ok ? flowsModule : flowsListener ? { ok: true, via: "node", reason: "via flow:register-agent-extension listener" } : { ok: false, reason: flowsModule.reason ?? "pi-flows event listeners absent" };
  return { am, flows, bothPresent: am.ok && flows.ok };
}
export {
  PEER_AM,
  PEER_AM_LEGACY,
  PEER_AM_NAMES,
  PEER_FLOWS,
  probeAll
};
