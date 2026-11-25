import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { launchScienceWorker, scienceWorkerEnvironment } from "../run-science-worker.mjs";
import { validateScienceWorkerManifest } from "../science-worker-host-validator.mjs";

const taskRef = "si-11111111-1111-4111-8111-111111111111", foreignRef = "si-33333333-3333-4333-8333-333333333333";
const file = "/fixed/root/worker.json", initialTime = 1_700_000_000_000, sentinel = "private-native-id-nonce-env-SENTINEL";
const content = Buffer.from("x,y\n1,2\n");
const artifact = { id: "sa-22222222-2222-4222-8222-222222222222", name: "fixture.csv", mediaType: "text/csv", bytes: content.length, sha256: createHash("sha256").update(content).digest("hex") };
const manifest = () => ({ schemaVersion: 1, kind: "science-external-cli-manifest", taskRef, status: "completed", observedAt: initialTime - 5_000, artifactsVerified: true, requiresHostValidation: true, scientificAccepted: false, actualModelIdentity: "unknown", actualProvider: "unknown", actualEffort: "unknown", artifacts: [structuredClone(artifact)] });
const reason = code => error => error?.code === code && error.message === code;

function fixture(options = {}) {
  let now = initialTime, revoked = false, checks = 0, disposed = 0, clients = 0, reads = 0;
  const calls = [], artifacts = options.artifacts ?? [structuredClone(artifact)];
  const config = { schemaVersion: 1, taskRef, partition: { ownerKey: '["fixture","owner"]', cwd: "/tmp" }, hostPrivateDir: "/tmp/fake-host", expiresAt: now + 60_000, deadlineAt: now + 50_000 };
  const lease = { config, async revalidate() { checks++; if (revoked) throw new Error(sentinel); } };
  const state = extra => ({ availability: "ready", instance: { id: taskRef, status: "completed", createdAt: 1, lastObservedAt: now, stale: false, modelIds: [], usage: null, cost: null, artifacts: structuredClone(artifacts), ...extra } });
  const client = {
    async detail(partition, id) { calls.push(["detail", structuredClone(partition), id]); reads++; return options.detail ? options.detail({ reads, state, revoke() { revoked = true; } }) : state(); },
    async readArtifact(partition, id, artifactId) { calls.push(["artifact", structuredClone(partition), id, artifactId]); return options.artifact ? options.artifact({ revoke() { revoked = true; }, advance(ms) { now += ms; } }) : { availability: "ready", artifact: artifacts.find(value => value.id === artifactId), content }; },
    dispose() { disposed++; },
    get submit() { throw new Error("submit must never be inspected"); },
    get cancel() { throw new Error("cancel must never be inspected"); },
  };
  const seam = {
    now: () => now,
    async loadConfig(selected) { assert.equal(selected, file); return lease; },
    createClient(selected) { assert.deepEqual(selected, { privateDir: config.hostPrivateDir }); clients++; return client; },
  };
  return { seam, config, calls, state, get checks() { return checks; }, get disposed() { return disposed; }, get clients() { return clients; } };
}
function collect() {
  let output = "", diagnostic = "";
  return { stdout: { write(value) { output += value; } }, stderr: { write(value) { diagnostic += value; } }, get output() { return output; }, get diagnostic() { return diagnostic; } };
}
function ownedChild(output, seen) {
  return (command, args, options) => {
    assert.equal(command, process.execPath); assert.deepEqual(args.slice(-2), ["--config", file]);
    assert.deepEqual(options.env, scienceWorkerEnvironment()); assert.equal(options.cwd, "/");
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = signal => { seen.kills.push(signal); return true; };
    queueMicrotask(() => { child.stdout.end(output); child.emit("close", 0); });
    return child;
  };
}

test("host independently verifies the fixed grant, fresh completion and every artifact", async () => {
  const f = fixture(), child = manifest();
  const result = await validateScienceWorkerManifest(file, Buffer.from(JSON.stringify(child)), f.seam);
  assert.equal(result.hostValidated, true); assert.equal(result.requiresHostValidation, false); assert.equal(result.scientificAccepted, false);
  assert.equal(result.observedAt, initialTime); assert.deepEqual(result.artifacts, [artifact]); assert.ok(f.checks >= 8);
  assert.deepEqual(f.calls.map(call => call[0]), ["detail", "artifact", "detail"]);
  assert.ok(f.calls.every(call => call[2] === taskRef && call[1].ownerKey === f.config.partition.ownerKey && call[1].cwd === f.config.partition.cwd));
  assert.equal(f.clients, 1); assert.equal(f.disposed, 1); assert.ok(!JSON.stringify(result).includes(sentinel));
  const outer = fixture(), output = collect(), signals = new EventEmitter(), seen = { kills: [] };
  const code = await launchScienceWorker(["--config", file], {
    ...output, signals, spawnChild: ownedChild(JSON.stringify(child), seen),
    validateManifest: (selected, bytes, options) => validateScienceWorkerManifest(selected, bytes, { ...outer.seam, ...options }),
  });
  assert.equal(code, 0); assert.equal(output.diagnostic, ""); assert.equal(JSON.parse(output.output).hostValidated, true);
  assert.equal(JSON.parse(output.output).requiresHostValidation, false); assert.equal(JSON.parse(output.output).scientificAccepted, false);
  assert.equal(outer.calls.length, 3); assert.equal(outer.disposed, 1); assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("forged selectors, flags, identities, extra fields and illegal observations refuse the child manifest", async () => {
  const invalid = [
    { taskRef: foreignRef }, { schemaVersion: 2 }, { kind: "other" }, { status: "running" }, { artifactsVerified: false },
    { requiresHostValidation: false }, { scientificAccepted: true }, { actualModelIdentity: "model" }, { actualProvider: "provider" }, { actualEffort: "high" },
    { extra: sentinel }, { hostValidated: true }, { observedAt: initialTime + 1 }, { observedAt: null }, { observedAt: -1 }, { observedAt: 1.5 },
    { artifacts: [{ ...artifact, extra: sentinel }] }, { artifacts: [artifact, artifact] }, { artifacts: [] },
  ];
  for (const change of invalid) {
    const f = fixture();
    await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify({ ...manifest(), ...change }), f.seam), reason("science-worker-response-refused"));
    assert.equal(f.calls.length, 0); assert.equal(f.clients, 0);
  }
  const f = fixture({ detail: ({ state }) => state({ lastObservedAt: initialTime - 6_000 }) });
  await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), f.seam), reason("science-worker-response-refused"));
});

test("stale completion, final state changes, asynchronous revocation and expiry cannot pass", async () => {
  for (const extra of [{ stale: true }, { lastObservedAt: null }, { lastObservedAt: initialTime + 1 }, { lastObservedAt: initialTime - 30_001 }, { status: "running" }, { id: foreignRef }]) {
    const f = fixture({ detail: ({ state }) => state(extra) });
    await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), f.seam), reason("science-worker-response-refused"));
    assert.equal(f.calls.filter(call => call[0] === "artifact").length, 0); assert.equal(f.disposed, 1);
  }
  const final = fixture({ detail: ({ reads, state }) => state(reads === 2 ? { status: "running" } : {}) });
  await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), final.seam), reason("science-worker-response-refused"));
  const unavailable = fixture({ detail: () => ({ availability: "unavailable", reason: "binding-unavailable" }) });
  await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), unavailable.seam), reason("science-worker-authority-refused"));
  const revoked = fixture({ artifact: async ({ revoke }) => { await Promise.resolve(); revoke(); return { availability: "ready", artifact, content }; } });
  await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), revoked.seam), reason("science-worker-authority-refused")); assert.equal(revoked.disposed, 1);
  for (const [ms, code] of [[50_000, "science-worker-deadline"], [60_000, "science-worker-authority-expired"]]) {
    const expired = fixture({ artifact: ({ advance }) => { advance(ms); return { availability: "ready", artifact, content }; } });
    await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), expired.seam), reason(code)); assert.equal(expired.disposed, 1);
  }
});

test("changed host content, artifact metadata and final artifact sets fail verification", async () => {
  for (const result of [
    { availability: "ready", artifact, content: Buffer.alloc(content.length) },
    { availability: "ready", artifact, content: content.subarray(1) },
    { availability: "ready", artifact: { ...artifact, name: "changed.csv" }, content },
    { availability: "ready", artifact: { ...artifact, sha256: "0".repeat(64) }, content },
  ]) {
    const f = fixture({ artifact: () => result });
    await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), f.seam), reason("science-worker-artifact-refused")); assert.equal(f.disposed, 1);
  }
  for (const changeAt of [1, 2]) {
    const f = fixture({ detail: ({ reads, state }) => state(reads === changeAt ? { artifacts: [{ ...artifact, name: "changed.csv" }] } : {}) });
    await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(manifest()), f.seam), reason("science-worker-artifact-refused"));
  }
});

test("Stop remains installed during host verification, aborts SDK work and cleans up without upstream mutation", async () => {
  let started; const reading = new Promise(resolve => { started = resolve; });
  const f = fixture({ artifact: () => { started(); return new Promise(() => {}); } }), output = collect(), signals = new EventEmitter(), seen = { kills: [] };
  const result = launchScienceWorker(["--config", file], {
    ...output, signals, spawnChild: ownedChild(JSON.stringify(manifest()), seen),
    validateManifest: (selected, bytes, options) => validateScienceWorkerManifest(selected, bytes, { ...f.seam, ...options }),
  });
  await reading; assert.equal(signals.listenerCount("SIGTERM"), 1); signals.emit("SIGTERM");
  assert.equal(await result, 130); assert.equal(output.output, ""); assert.equal(output.diagnostic, "science-worker-stopped; upstream may continue\n");
  assert.equal(f.disposed, 1); assert.deepEqual(seen.kills, []); assert.equal(signals.listenerCount("SIGTERM"), 0); assert.equal(signals.listenerCount("SIGINT"), 0); assert.equal(signals.listenerCount("SIGHUP"), 0);
  const failedOutput = collect();
  assert.equal(await launchScienceWorker(["--config", file], { ...failedOutput, signals, spawnChild: ownedChild(JSON.stringify(manifest()), seen), validateManifest() { throw new Error(sentinel); } }), 1);
  assert.equal(failedOutput.output, ""); assert.equal(failedOutput.diagnostic, "science-worker-runtime-unavailable; upstream may continue\n");
});

test("child and host output limits include the final host validation fields", async () => {
  const f = fixture();
  await assert.rejects(validateScienceWorkerManifest(file, " ".repeat(16_385), f.seam), reason("science-worker-response-refused"));
  const large = manifest(); large.artifacts = Array.from({ length: 32 }, (_, index) => ({ ...artifact, id: `sa-${String(index + 1).padStart(8, "0")}-2222-4222-8222-222222222222`, name: "a".repeat(200) }));
  let count = 0;
  while (Buffer.byteLength(JSON.stringify(large)) < 16_370) { const index = Math.floor(count / 200), offset = count % 200; large.artifacts[index].name = "界".repeat(offset + 1) + "a".repeat(199 - offset); count++; }
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 16_384);
  const boundary = fixture({ artifacts: large.artifacts });
  await assert.rejects(validateScienceWorkerManifest(file, JSON.stringify(large), boundary.seam), reason("science-worker-response-refused")); assert.equal(boundary.disposed, 1);
  const output = collect(), signals = new EventEmitter(), seen = { kills: [] }; let validated = false;
  const code = await launchScienceWorker(["--config", file], { ...output, signals, spawnChild: ownedChild(Buffer.alloc(16_385, 65), seen), validateManifest() { validated = true; } });
  assert.notEqual(code, 0); assert.equal(output.output, ""); assert.equal(output.diagnostic, "science-worker-response-refused; upstream may continue\n"); assert.equal(validated, false); assert.deepEqual(seen.kills, ["SIGTERM"]);
});
