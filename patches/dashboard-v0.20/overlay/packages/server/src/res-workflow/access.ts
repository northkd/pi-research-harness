import { lstat } from "node:fs/promises";
import path from "node:path";
import { admitCwd, releaseAdmission, type AdmitCwdOptions } from "@blackbelt-technology/pi-dashboard-shared/cwd-guard.js";
import { metaPath } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { canAccessSession, isLocalOperator } from "../identity/session-access.js";
import type { HostPolicy } from "../identity/host-access.js";
import { HostActions, hostResource } from "../identity/host-resources.js";
import { ResWorkflowError, type ResWorkflowAccess } from "./adoption-service.js";
import type { HistoryCandidate } from "./history-candidates.js";
import { readBoundedRegular } from "./safe-files.js";

export interface ResWorkflowAccessDeps {
  knownCwds(): string[];
  history(): HistoryCandidate[];
  isResolverActive?(): boolean;
  hostPolicy?: HostPolicy;
  admitOptions?: AdmitCwdOptions;
}

export interface ResWorkflowIdentity {
  principal?: { iss: string; sub: string } | null;
  expiresAt?: number | null;
  write: boolean;
}

/** One owner/path admission for HTTP adoption and explicit WS spawn association. */
export async function resWorkflowAccess(deps: ResWorkflowAccessDeps, identity: ResWorkflowIdentity, rawCwd: unknown): Promise<ResWorkflowAccess> {
  if (typeof rawCwd !== "string" || !rawCwd || rawCwd.length > 4096 || rawCwd.includes("\0") || !path.isAbsolute(rawCwd)) throw new ResWorkflowError(400, "absolute-cwd-required");
  const active = deps.isResolverActive?.() ?? false;
  const principal = identity.principal;
  if (active && !principal) throw new ResWorkflowError(404, "workspace-not-found");
  const validateIdentity = () => {
    if (active !== (deps.isResolverActive?.() ?? false) || typeof identity.expiresAt === "number" && Date.now() >= identity.expiresAt) throw new ResWorkflowError(403, "adoption-identity-expired");
  };
  const operator = !active || isLocalOperator(principal);
  const admitForOwner = async (target: string) => {
    const admission = await admitCwd(target, deps.knownCwds, deps.admitOptions);
    if (admission.kind !== "admit" || operator) return admission;
    const ownedCwds = deps.history().filter(row => !row.originDeviceId && row.cwd && canAccessSession({ active, principal, owner: row.principalOwner })).map(row => row.cwd!);
    const owned = ownedCwds.length ? await admitCwd(admission.token.canonCwd, () => ownedCwds, deps.admitOptions) : { kind: "refuse" as const };
    if (owned.kind === "admit") { releaseAdmission(owned.token); return admission; }
    if (owned.kind === "indeterminate") { releaseAdmission(admission.token); return owned; }
    if (principal && deps.hostPolicy?.hasPolicy()) {
      try {
        const action = identity.write ? HostActions.workspaceWrite : HostActions.workspaceRead;
        if (await deps.hostPolicy.authorize({ principal, action, resource: hostResource.workspace(admission.token.canonCwd) })) return admission;
      } catch { /* Policy failures deny access. */ }
    }
    releaseAdmission(admission.token);
    return { kind: "refuse" as const };
  };
  validateIdentity();
  const admitted = await admitForOwner(rawCwd);
  if (admitted.kind === "indeterminate") throw new ResWorkflowError(503, "cwd-admission-unavailable");
  if (admitted.kind !== "admit") throw new ResWorkflowError(operator ? 403 : 404, operator ? "cwd-not-allowed" : "workspace-not-found");
  const cwd = admitted.token.canonCwd;
  releaseAdmission(admitted.token);
  if (!(await lstat(cwd).catch(() => null))?.isDirectory()) throw new ResWorkflowError(404, "folder-not-found");
  validateIdentity();
  return {
    cwd, ownerKey: JSON.stringify(principal ? [principal.iss, principal.sub] : ["host", "inert-operator"]), write: identity.write,
    async revalidate() {
      validateIdentity();
      const current = await admitForOwner(cwd);
      if (current.kind === "indeterminate") throw new ResWorkflowError(503, "cwd-admission-unavailable");
      if (current.kind !== "admit") throw new ResWorkflowError(operator ? 403 : 404, operator ? "cwd-not-allowed" : "workspace-not-found");
      try {
        if (current.token.canonCwd !== cwd || !(await lstat(cwd)).isDirectory()) throw new ResWorkflowError(409, "cwd-changed");
        validateIdentity();
      } finally { releaseAdmission(current.token); }
    },
    async canReadHistory(candidate) {
      validateIdentity();
      if (!active || isLocalOperator(principal)) return true;
      let owner = candidate.principalOwner;
      if (!candidate.unregistered) {
        const current = deps.history().find(item => item.id === candidate.id && item.sessionFile === candidate.sessionFile && item.originDeviceId === candidate.originDeviceId);
        if (!current) return false;
        owner = current.principalOwner;
      } else if (candidate.sessionFile) {
        try {
          const meta = JSON.parse((await readBoundedRegular(metaPath(candidate.sessionFile), 128 * 1024)).text);
          owner = meta?.principalOwner && typeof meta.principalOwner.iss === "string" && typeof meta.principalOwner.sub === "string" ? { iss: meta.principalOwner.iss, sub: meta.principalOwner.sub } : undefined;
        } catch { return false; }
      }
      validateIdentity();
      return canAccessSession({ active, principal, owner });
    },
  };
}
