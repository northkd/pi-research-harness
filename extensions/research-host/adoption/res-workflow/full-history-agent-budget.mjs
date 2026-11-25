import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
function validAgentBudgetChoice(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value, c = v.consent;
  return Object.keys(v).every((k) => ["maxRequests", "consent"].includes(k)) && (v.maxRequests === null || Number.isSafeInteger(v.maxRequests) && v.maxRequests >= 0) && !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 3 && c.scope === "this-job" && c.budgetMayIncreaseCharges === true && c.unknownRetryMayBillAgain === true;
}
const FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION = "\u80FD\u4FEE\u6539\u4E00\u4E0B\u73B0\u5728\u9884\u7B97\u4E0A\u9650\u5417\uFF0C\u53D6\u6D88\u4E0A\u9650\u4F46\u662F\u4E0D\u8981\u505C\u6B62\u73B0\u5728\u7684\u8BFB\u53D6\u4EFB\u52A1\u3002";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail() {
  throw new Error("analysis-agent-budget-amendment-invalid");
}
const stamp = (s) => JSON.stringify([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
function validate(binding, value, requireActive = false) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value;
  if (Object.keys(v).length !== 12 || Object.keys(v).some((k) => !["schema", "mode", "ownerKey", "cwd", "jobId", "grantHash", "materialPlanHash", "modelFingerprint", "promptSchemaHash", "authorizedAt", "expiresAt", "userInstruction"].includes(k)) || v.schema !== "pi-full-agent-budget-amendment.v1" || v.mode !== "unlimited" || v.userInstruction !== FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION || !/^adopt-[a-f0-9]{24}$/.test(binding.jobId) || ["ownerKey", "cwd", "jobId", "grantHash", "materialPlanHash", "modelFingerprint", "promptSchemaHash", "expiresAt"].some((k) => v[k] !== binding[k]) || ![binding.grantHash, binding.materialPlanHash, binding.promptSchemaHash].every((s) => /^[a-f0-9]{64}$/.test(s)) || !Number.isFinite(Date.parse(v.authorizedAt)) || new Date(v.authorizedAt).toISOString() !== v.authorizedAt || Date.parse(v.authorizedAt) < Date.parse(binding.authorizedAt) || Date.parse(v.authorizedAt) > Date.now() || Date.parse(v.expiresAt) <= Date.parse(v.authorizedAt) || Date.parse(v.expiresAt) - Date.parse(binding.authorizedAt) !== 864e5) fail();
  if (requireActive && Date.now() >= Date.parse(binding.expiresAt)) throw new Error("analysis-full-agent-authorization-expired");
}
async function anchor(binding) {
  const parent = binding.scopeDir;
  if (!["linux", "darwin"].includes(process.platform) || !path.isAbsolute(parent) || path.resolve(parent) !== parent || !/^adopt-[a-f0-9]{24}$/.test(binding.jobId)) fail();
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), first = await handle.stat(), name = `${binding.jobId}.agent-budget-unlimited.json`, file = path.join(parent, name);
  const check = async () => {
    const [current, named] = await Promise.all([handle.stat(), lstat(parent)]);
    if (!current.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.uid !== process.getuid?.() || named.uid !== current.uid || (current.mode & 511) !== 448 || (named.mode & 511) !== 448 || await realpath(parent) !== parent) fail();
  };
  try {
    await check();
    return { handle, check, file, anchored: process.platform === "linux" ? `/proc/self/fd/${handle.fd}/${name}` : file };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function readFullHistoryAgentBudgetAuthorization(binding) {
  const root = await anchor(binding);
  try {
    let file;
    try {
      file = await open(root.anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 511) !== 384 || before.nlink !== 1 || before.size > 16384) fail();
      const raw = await file.readFile("utf8"), after = await file.stat(), named = await lstat(root.file);
      await root.check();
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || named.isSymbolicLink()) fail();
      let value;
      try {
        value = JSON.parse(raw);
      } catch {
        fail();
      }
      validate(binding, value);
      return { unlimited: true, authorizationHash: digest(value), authorizedAt: value.authorizedAt, expiresAt: value.expiresAt, jobId: value.jobId, grantHash: value.grantHash, materialPlanHash: value.materialPlanHash, modelFingerprint: value.modelFingerprint, promptSchemaHash: value.promptSchemaHash };
    } finally {
      await file.close();
    }
  } finally {
    await root.handle.close();
  }
}
async function writeFullHistoryAgentBudgetAmendment(binding, value) {
  validate(binding, value, true);
  const existing = await readFullHistoryAgentBudgetAuthorization(binding);
  if (existing) {
    if (existing.authorizationHash !== digest(value)) fail();
    return existing;
  }
  const root = await anchor(binding);
  try {
    const file = await open(root.anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 384);
    try {
      const first = await file.stat();
      const check = async () => {
        await root.check();
        const [current, named] = await Promise.all([file.stat(), lstat(root.file)]);
        if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.uid !== process.getuid?.() || named.uid !== current.uid || (current.mode & 511) !== 384 || (named.mode & 511) !== 384 || current.nlink !== 1 || named.nlink !== 1) fail();
      };
      await check();
      await file.writeFile(JSON.stringify(value) + "\n", "utf8");
      await file.sync();
      await check();
      await root.handle.sync();
      await check();
    } finally {
      await file.close();
    }
  } finally {
    await root.handle.close();
  }
  return await readFullHistoryAgentBudgetAuthorization(binding);
}
export {
  FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION,
  readFullHistoryAgentBudgetAuthorization,
  validAgentBudgetChoice,
  writeFullHistoryAgentBudgetAmendment
};
