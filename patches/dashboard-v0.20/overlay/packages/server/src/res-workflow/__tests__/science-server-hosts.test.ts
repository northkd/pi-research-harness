import { describe, expect, it, vi } from "vitest";
import type { ScienceViewPartition } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { createScienceServerHosts, SCIENCE_HOST_PRIVATE_DIR } from "../science-server-hosts.js";
import type { createScienceHostClient } from "../science-host-client.js";

const partition: ScienceViewPartition = { ownerKey: '["fixture","operator"]', cwd: "/synthetic-workspace" };
const offline = { availability: "unknown", reason: "host-offline" } as const;

function fixture() {
  const client = {
    openWorkspace: vi.fn(async () => offline),
    openTask: vi.fn(async () => offline),
    list: vi.fn(async () => offline),
    detail: vi.fn(async () => offline),
    readArtifact: vi.fn(async () => offline),
    dispose: vi.fn(),
  } satisfies ReturnType<typeof createScienceHostClient>;
  const createClient = vi.fn<typeof createScienceHostClient>(() => client);
  const exits = new Set<() => void>();
  const registerExit = vi.fn((callback: () => void) => {
    exits.add(callback);
    return () => exits.delete(callback);
  });
  return { client, createClient, exits, registerExit, options: { platform: "linux" as const, createClient, registerExit, observe: vi.fn() } };
}

describe("fixed private Science startup hosts", () => {
  it("lazily shares one fixed client across viewer and records, including concurrent first calls", async () => {
    const f = fixture();
    const hosts = createScienceServerHosts({}, f.options);
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.exits.size).toBe(0);
    await Promise.all([
      hosts.scienceViewHost?.openWorkspace(partition),
      hosts.scienceInstancesHost?.list(partition),
      hosts.scienceViewHost?.openTask?.(partition, "si-synthetic"),
      hosts.scienceInstancesHost?.detail(partition, "si-synthetic"),
      hosts.scienceInstancesHost?.readArtifact(partition, "si-synthetic", "sa-synthetic"),
    ]);
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.createClient).toHaveBeenCalledWith({ privateDir: "/var/lib/pi-claude-science/viewer-ipc", observe: f.options.observe });
    expect(SCIENCE_HOST_PRIVATE_DIR).toBe("/var/lib/pi-claude-science/viewer-ipc");
    expect(f.client.openWorkspace).toHaveBeenCalledWith(partition);
    expect(f.client.openTask).toHaveBeenCalledWith(partition, "si-synthetic");
    expect(f.client.list).toHaveBeenCalledWith(partition);
    expect(f.client.detail).toHaveBeenCalledWith(partition, "si-synthetic");
    expect(f.client.readArtifact).toHaveBeenCalledWith(partition, "si-synthetic", "sa-synthetic");
    hosts.dispose();
  });

  it.each(["darwin", "win32", "freebsd"] as const)("keeps %s unconfigured without constructing a client", async platform => {
    const f = fixture();
    const hosts = createScienceServerHosts({}, { ...f.options, platform });
    expect(hosts.scienceViewHost).toBeUndefined();
    expect(hosts.scienceInstancesHost).toBeUndefined();
    hosts.dispose();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.registerExit).not.toHaveBeenCalled();
  });

  it("preserves both explicit hosts without owning or disposing them", async () => {
    const f = fixture();
    const hosts = createScienceServerHosts({ scienceViewHost: f.client, scienceInstancesHost: f.client }, f.options);
    expect(hosts.scienceViewHost).toBe(f.client);
    expect(hosts.scienceInstancesHost).toBe(f.client);
    hosts.dispose();
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.client.dispose).not.toHaveBeenCalled();
  });

  it("preserves a partial explicit host and uses the fixed client only for the missing interface", async () => {
    const f = fixture();
    const explicit = { openWorkspace: vi.fn(async () => offline) };
    const hosts = createScienceServerHosts({ scienceViewHost: explicit }, f.options);
    expect(hosts.scienceViewHost).toBe(explicit);
    await hosts.scienceViewHost?.openWorkspace(partition);
    expect(f.createClient).not.toHaveBeenCalled();
    await hosts.scienceInstancesHost?.list(partition);
    expect(f.createClient).toHaveBeenCalledTimes(1);
    expect(f.client.openWorkspace).not.toHaveBeenCalled();
    hosts.dispose();
    expect(f.client.dispose).toHaveBeenCalledTimes(1);
  });

  it("dispose before first access never reads private files and fences all later calls", async () => {
    const f = fixture();
    const hosts = createScienceServerHosts({}, f.options);
    hosts.dispose();
    expect(await hosts.scienceViewHost?.openWorkspace(partition)).toEqual(offline);
    expect(await hosts.scienceViewHost?.openTask?.(partition, "si-synthetic")).toEqual(offline);
    expect(await hosts.scienceInstancesHost?.list(partition)).toEqual(offline);
    expect(await hosts.scienceInstancesHost?.detail(partition, "si-synthetic")).toEqual(offline);
    expect(await hosts.scienceInstancesHost?.readArtifact(partition, "si-synthetic", "sa-synthetic")).toEqual(offline);
    expect(f.createClient).not.toHaveBeenCalled();
    expect(f.registerExit).not.toHaveBeenCalled();
  });

  it("close or process exit disposes only the owned client once and removes its listener", async () => {
    const f = fixture();
    const hosts = createScienceServerHosts({}, f.options);
    await hosts.scienceInstancesHost?.list(partition);
    expect(f.exits.size).toBe(1);
    for (const callback of f.exits) callback();
    hosts.dispose();
    expect(f.client.dispose).toHaveBeenCalledTimes(1);
    expect(f.exits.size).toBe(0);
    expect(await hosts.scienceInstancesHost?.list(partition)).toEqual(offline);
    expect(f.client.list).toHaveBeenCalledTimes(1);
  });

  it("structured telemetry emits only transport fields, never extra private material", async () => {
    const f = fixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const hosts = createScienceServerHosts({}, { ...f.options, observe: undefined });
      await hosts.scienceInstancesHost?.list(partition);
      const options = f.createClient.mock.calls[0]?.[0];
      options?.observe?.({ event: "science_host", side: "client", requestId: "sh-0123456789abcdef", phase: "instances-list", outcome: "unknown", error: "transport", elapsedMs: 5, ...{ url: "PRIVATE_URL", cookie: "PRIVATE_COOKIE", ownerKey: "PRIVATE_OWNER", cwd: "PRIVATE_PATH" } });
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ event: "science_host", side: "client", requestId: "sh-0123456789abcdef", phase: "instances-list", outcome: "unknown", error: "transport", elapsedMs: 5 });
      expect(JSON.stringify(log.mock.calls)).not.toContain("PRIVATE_");
      hosts.dispose();
    } finally { log.mockRestore(); }
  });
});
