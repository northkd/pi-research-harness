import type { ScienceHostObserver } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import type { ScienceInstancesHost } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { ScienceViewHost } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { createScienceHostClient } from "./science-host-client.js";

/** Operator-installed directory, shared with the independent host daemon. */
export const SCIENCE_HOST_PRIVATE_DIR = "/var/lib/pi-claude-science/viewer-ipc";

interface ServerHosts {
  scienceViewHost?: ScienceViewHost;
  scienceInstancesHost?: ScienceInstancesHost;
}
interface Options {
  platform?: NodeJS.Platform;
  createClient?: typeof createScienceHostClient;
  registerExit?: (callback: () => void) => () => void;
  observe?: ScienceHostObserver;
}
const offline = { availability: "unknown", reason: "host-offline" } as const;
const observeTransport: ScienceHostObserver = ({ event, side, requestId, phase, outcome, error, elapsedMs }) => {
  console.info(JSON.stringify({ event, side, requestId, phase, outcome, error, elapsedMs }));
};
function registerProcessExit(callback: () => void): () => void {
  process.once("exit", callback);
  return () => { process.off("exit", callback); };
}

/** No registry, CLI, HTTP or browser startup. The first read opens one local IPC client. */
export function createScienceServerHosts(config: ServerHosts, options: Options = {}): ServerHosts & { dispose(): void } {
  if ((options.platform ?? process.platform) !== "linux" || (config.scienceViewHost && config.scienceInstancesHost)) {
    return { scienceViewHost: config.scienceViewHost, scienceInstancesHost: config.scienceInstancesHost, dispose() {} };
  }
  let owned: ReturnType<typeof createScienceHostClient> | undefined;
  let removeExit: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeExit?.();
    owned?.dispose();
  };
  const client = () => {
    if (disposed) return undefined;
    if (!owned) {
      owned = (options.createClient ?? createScienceHostClient)({ privateDir: SCIENCE_HOST_PRIVATE_DIR, observe: options.observe ?? observeTransport });
      removeExit = (options.registerExit ?? registerProcessExit)(dispose);
    }
    return owned;
  };
  const defaults: ScienceViewHost & ScienceInstancesHost = {
    async openWorkspace(partition) { return client()?.openWorkspace(partition) ?? offline; },
    async openTask(partition, instanceId) { return client()?.openTask?.(partition, instanceId) ?? offline; },
    async list(partition) { return client()?.list(partition) ?? offline; },
    async detail(partition, instanceId) { return client()?.detail(partition, instanceId) ?? offline; },
    async readArtifact(partition, instanceId, artifactId) { return client()?.readArtifact(partition, instanceId, artifactId) ?? offline; },
  };
  return { scienceViewHost: config.scienceViewHost ?? defaults, scienceInstancesHost: config.scienceInstancesHost ?? defaults, dispose };
}
