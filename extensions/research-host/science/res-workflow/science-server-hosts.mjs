import { createScienceHostClient } from "./science-host-client.mjs";
const SCIENCE_HOST_PRIVATE_DIR = "/var/lib/pi-claude-science/viewer-ipc";
const offline = { availability: "unknown", reason: "host-offline" };
const observeTransport = ({ event, side, requestId, phase, outcome, error, elapsedMs }) => {
  console.info(JSON.stringify({ event, side, requestId, phase, outcome, error, elapsedMs }));
};
function registerProcessExit(callback) {
  process.once("exit", callback);
  return () => {
    process.off("exit", callback);
  };
}
function createScienceServerHosts(config, options = {}) {
  if ((options.platform ?? process.platform) !== "linux" || config.scienceViewHost && config.scienceInstancesHost) {
    return { scienceViewHost: config.scienceViewHost, scienceInstancesHost: config.scienceInstancesHost, dispose() {
    } };
  }
  let owned;
  let removeExit;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    removeExit?.();
    owned?.dispose();
  };
  const client = () => {
    if (disposed) return void 0;
    if (!owned) {
      owned = (options.createClient ?? createScienceHostClient)({ privateDir: SCIENCE_HOST_PRIVATE_DIR, observe: options.observe ?? observeTransport });
      removeExit = (options.registerExit ?? registerProcessExit)(dispose);
    }
    return owned;
  };
  const defaults = {
    async openWorkspace(partition) {
      return client()?.openWorkspace(partition) ?? offline;
    },
    async openTask(partition, instanceId) {
      return client()?.openTask?.(partition, instanceId) ?? offline;
    },
    async list(partition) {
      return client()?.list(partition) ?? offline;
    },
    async detail(partition, instanceId) {
      return client()?.detail(partition, instanceId) ?? offline;
    },
    async readArtifact(partition, instanceId, artifactId) {
      return client()?.readArtifact(partition, instanceId, artifactId) ?? offline;
    }
  };
  return { scienceViewHost: config.scienceViewHost ?? defaults, scienceInstancesHost: config.scienceInstancesHost ?? defaults, dispose };
}
export {
  SCIENCE_HOST_PRIVATE_DIR,
  createScienceServerHosts
};
