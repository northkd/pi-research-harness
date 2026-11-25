import { createRequire } from "node:module";
import { resolvePiPackageEntry } from "../../shared/pi-package-resolver.js";
import { probeAll } from "../peer-probe.js";
const requireFromCwd = createRequire(`${process.cwd()}/_`);
async function activate(ctx) {
  const pi = ctx?.pi ?? ctx;
  const events = ctx?.events ?? pi?.events;
  let status = "probing";
  let wired = false;
  let lastBroadcast = "";
  function broadcast(probe) {
    const payload = {
      status,
      peers: {
        "@pi/anthropic-messages": probe.am,
        "pi-flows": probe.flows
      },
      pid: process.pid,
      at: Date.now()
    };
    const json = JSON.stringify(payload);
    if (json === lastBroadcast) return;
    lastBroadcast = json;
    try {
      events?.emit?.("flows-anthropic-bridge:status", payload);
    } catch {
    }
  }
  function runProbe() {
    return probeAll({
      // Tier 1: standard Node resolver anchored at cwd.
      resolve: (spec) => requireFromCwd.resolve(spec),
      // Tier 2: pi-packages fallback. Reads ~/.pi/agent/settings.json +
      // <cwd>/.pi/settings.json and returns an absolute entry path for
      // peers installed via pi (npm/git/local) but not in any
      // node_modules ancestor of cwd. See change:
      // add-shared-pi-package-resolver.
      resolvePiPackage: (spec) => {
        const ep = resolvePiPackageEntry(spec, { cwd: process.cwd() });
        return ep ? { entryPath: ep } : null;
      },
      flowsListenerCount: () => typeof pi?.events?.listenerCount === "function" ? pi.events.listenerCount("flow:register-agent-extension") : 0
    });
  }
  let agentFactory = null;
  function emitAgentFactory() {
    if (!agentFactory) return;
    try {
      pi?.events?.emit?.("flow:register-agent-extension", { factory: agentFactory });
    } catch {
    }
  }
  async function tryWire() {
    if (wired) {
      const probe2 = runProbe();
      if (!probe2.bothPresent && status !== "degraded") {
        status = "degraded";
        broadcast(probe2);
      } else {
        emitAgentFactory();
      }
      return;
    }
    const probe = runProbe();
    if (!probe.bothPresent) {
      status = "waiting_peers";
      broadcast(probe);
      return;
    }
    let mod;
    try {
      if (probe.am.via === "pi-packages" && probe.am.entryPath) {
        mod = await import(probe.am.entryPath);
      } else {
        try {
          mod = await import("@blackbelt-technology/pi-anthropic-messages");
        } catch {
          mod = await import("@pi/anthropic-messages");
        }
      }
    } catch (e) {
      status = "waiting_peers";
      broadcast({
        ...probe,
        am: { ok: false, reason: `import failed: ${e.message}` }
      });
      return;
    }
    const piAnthropicMessages = mod.default;
    const isClaudeAnthropicMessages = mod.isClaudeAnthropicMessages;
    await piAnthropicMessages(pi);
    agentFactory = async (agentPi) => {
      await piAnthropicMessages(agentPi);
      try {
        agentPi?.on?.("session_start", (_e, agentCtx) => {
          try {
            events?.emit?.("flows-anthropic-bridge:agent-active", {
              pid: process.pid,
              modelId: agentCtx?.model?.id,
              gateOpen: !!isClaudeAnthropicMessages?.(agentCtx)
            });
          } catch {
          }
        });
      } catch {
      }
    };
    emitAgentFactory();
    wired = true;
    status = "active";
    broadcast(probe);
  }
  await tryWire();
  try {
    pi?.on?.("session_start", () => {
      void tryWire();
    });
  } catch {
  }
}
export {
  activate as default
};
