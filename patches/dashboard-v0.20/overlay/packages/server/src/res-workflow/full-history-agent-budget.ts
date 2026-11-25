import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { FullHistoryAgentBudgetAuthorization } from "./full-history-agent-contract.js";
import type { ResWorkflowAgentBudgetChoice } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";

/** Accept legacy budget metadata without giving it dispatch authority. */
export function validAgentBudgetChoice(value: unknown): value is ResWorkflowAgentBudgetChoice {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as ResWorkflowAgentBudgetChoice, c = v.consent;
  return Object.keys(v).every(k => ["maxRequests", "consent"].includes(k)) && (v.maxRequests === null || Number.isSafeInteger(v.maxRequests) && v.maxRequests >= 0) && !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 3 && c.scope === "this-job" && c.budgetMayIncreaseCharges === true && c.unknownRetryMayBillAgain === true;
}
export interface FullHistoryAgentBudgetRevision extends ResWorkflowAgentBudgetChoice {
  schema: "pi-full-agent-budget-revision.v1";
  revision: number; previousHash: string | null; usedRequests: number;
  requestId: string; requestHash: string; authorizedAt: string; expiresAt: string;
  grantHash: string; materialPlanHash: string; modelFingerprint: string; promptSchemaHash: string;
}

export const FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION = "能修改一下现在预算上限吗，取消上限但是不要停止现在的读取任务。";
export interface FullHistoryAgentBudgetBinding {
  scopeDir: string; ownerKey: string; cwd: string; jobId: string; grantHash: string;
  materialPlanHash: string; modelFingerprint: string; promptSchemaHash: string;
  /** Original grant timestamps; an amendment never renews them. */
  authorizedAt: string; expiresAt: string;
}
export interface FullHistoryAgentBudgetAmendment {
  schema: "pi-full-agent-budget-amendment.v1"; mode: "unlimited";
  ownerKey: string; cwd: string; jobId: string; grantHash: string; materialPlanHash: string;
  modelFingerprint: string; promptSchemaHash: string; authorizedAt: string; expiresAt: string;
  userInstruction: typeof FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function fail(): never { throw new Error("analysis-agent-budget-amendment-invalid"); }
const stamp = (s: { dev: number; ino: number; mode: number; uid: number; nlink: number; size: number; mtimeMs: number; ctimeMs: number }) => JSON.stringify([s.dev, s.ino, s.mode, s.uid, s.nlink, s.size, s.mtimeMs, s.ctimeMs]);
function validate(binding: FullHistoryAgentBudgetBinding, value: unknown, requireActive = false): asserts value is FullHistoryAgentBudgetAmendment {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const v = value as FullHistoryAgentBudgetAmendment;
  if (Object.keys(v).length !== 12 || Object.keys(v).some(k => !["schema", "mode", "ownerKey", "cwd", "jobId", "grantHash", "materialPlanHash", "modelFingerprint", "promptSchemaHash", "authorizedAt", "expiresAt", "userInstruction"].includes(k)) || v.schema !== "pi-full-agent-budget-amendment.v1" || v.mode !== "unlimited" || v.userInstruction !== FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION || !/^adopt-[a-f0-9]{24}$/.test(binding.jobId) || ["ownerKey", "cwd", "jobId", "grantHash", "materialPlanHash", "modelFingerprint", "promptSchemaHash", "expiresAt"].some(k => v[k as keyof typeof v] !== binding[k as keyof typeof binding]) || ![binding.grantHash, binding.materialPlanHash, binding.promptSchemaHash].every(s => /^[a-f0-9]{64}$/.test(s)) || !Number.isFinite(Date.parse(v.authorizedAt)) || new Date(v.authorizedAt).toISOString() !== v.authorizedAt || Date.parse(v.authorizedAt) < Date.parse(binding.authorizedAt) || Date.parse(v.authorizedAt) > Date.now() || Date.parse(v.expiresAt) <= Date.parse(v.authorizedAt) || Date.parse(v.expiresAt) - Date.parse(binding.authorizedAt) !== 86400000) fail();
  if (requireActive && Date.now() >= Date.parse(binding.expiresAt)) throw new Error("analysis-full-agent-authorization-expired");
}
async function anchor(binding: FullHistoryAgentBudgetBinding) {
  const parent = binding.scopeDir;
  if (!["linux", "darwin"].includes(process.platform) || !path.isAbsolute(parent) || path.resolve(parent) !== parent || !/^adopt-[a-f0-9]{24}$/.test(binding.jobId)) fail();
  const handle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), first = await handle.stat(), name = `${binding.jobId}.agent-budget-unlimited.json`, file = path.join(parent, name);
  const check = async () => { const [current, named] = await Promise.all([handle.stat(), lstat(parent)]); if (!current.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.uid !== process.getuid?.() || named.uid !== current.uid || (current.mode & 0o777) !== 0o700 || (named.mode & 0o777) !== 0o700 || await realpath(parent) !== parent) fail(); };
  try { await check(); return { handle, check, file, anchored: process.platform === "linux" ? `/proc/self/fd/${handle.fd}/${name}` : file }; }
  catch (error) { await handle.close(); throw error; }
}
/** Historical proof read, not a new/renewed grant. Dispatch must still check original expiry. */
export async function readFullHistoryAgentBudgetAuthorization(binding: FullHistoryAgentBudgetBinding): Promise<FullHistoryAgentBudgetAuthorization | null> {
  const root = await anchor(binding);
  try {
    let file;
    try { file = await open(root.anchored, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > 16384) fail();
      const raw = await file.readFile("utf8"), after = await file.stat(), named = await lstat(root.file); await root.check();
      if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || named.isSymbolicLink()) fail();
      let value: unknown; try { value = JSON.parse(raw); } catch { fail(); } validate(binding, value);
      return { unlimited: true, authorizationHash: digest(value), authorizedAt: value.authorizedAt, expiresAt: value.expiresAt, jobId: value.jobId, grantHash: value.grantHash, materialPlanHash: value.materialPlanHash, modelFingerprint: value.modelFingerprint, promptSchemaHash: value.promptSchemaHash };
    } finally { await file.close(); }
  } finally { await root.handle.close(); }
}
/** Host-only exclusive durable append. No public paid route calls this function. */
export async function writeFullHistoryAgentBudgetAmendment(binding: FullHistoryAgentBudgetBinding, value: FullHistoryAgentBudgetAmendment): Promise<FullHistoryAgentBudgetAuthorization> {
  validate(binding, value, true);
  const existing = await readFullHistoryAgentBudgetAuthorization(binding);
  if (existing) { if (existing.authorizationHash !== digest(value)) fail(); return existing; }
  const root = await anchor(binding);
  try {
    const file = await open(root.anchored, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const first = await file.stat();
      const check = async () => { await root.check(); const [current, named] = await Promise.all([file.stat(), lstat(root.file)]); if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || current.dev !== first.dev || current.ino !== first.ino || named.dev !== first.dev || named.ino !== first.ino || current.uid !== process.getuid?.() || named.uid !== current.uid || (current.mode & 0o777) !== 0o600 || (named.mode & 0o777) !== 0o600 || current.nlink !== 1 || named.nlink !== 1) fail(); };
      await check(); await file.writeFile(JSON.stringify(value) + "\n", "utf8"); await file.sync(); await check(); await root.handle.sync(); await check();
    } finally { await file.close(); }
  } finally { await root.handle.close(); }
  return (await readFullHistoryAgentBudgetAuthorization(binding))!;
}
