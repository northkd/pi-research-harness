const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value) => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
const revision = (value, minimum) => Number.isSafeInteger(value) && value >= minimum;
const id = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const adoption = (value) => typeof value === "string" && /^adopt-[a-f0-9]{24}$/.test(value);
const strings = (value) => Array.isArray(value) && value.every((item) => typeof item === "string");
function isResearchCharterBindingSession(value) {
  return object(value) && id(value.sessionId) && ["joined", "not-joined", "assignment-stale", "unavailable"].includes(value.status) && (value.error === void 0 || typeof value.error === "string");
}
function isResearchCharterBinding(value) {
  if (!object(value) || value.schema !== "pi-research-charter-binding.v1" || typeof value.cwd !== "string" || typeof value.adopted !== "boolean" || !(value.adoptionId === null || adoption(value.adoptionId)) || !["current", "stale", "not-adopted", "unavailable"].includes(value.status) || !revision(value.bindingRevision, 0) || !(value.boundCharterHash === null || hash(value.boundCharterHash)) || !(value.currentCharterHash === null || hash(value.currentCharterHash)) || !(value.boundCharterRevision === null || revision(value.boundCharterRevision, 1)) || !(value.currentCharterRevision === null || revision(value.currentCharterRevision, 1)) || !(value.currentObjective === null || typeof value.currentObjective === "string") || typeof value.canRebind !== "boolean" || !(value.updatedAt === null || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))) || value.error !== void 0 && typeof value.error !== "string" || value.session !== void 0 && !isResearchCharterBindingSession(value.session)) return false;
  if (["current", "stale"].includes(value.status)) {
    const charter = value.currentCharter;
    if (!value.adopted || !adoption(value.adoptionId) || !hash(value.boundCharterHash) || !hash(value.currentCharterHash) || !object(charter) || !revision(charter.revision, 1) || charter.revision !== value.currentCharterRevision || charter.objective !== value.currentObjective || typeof charter.objective !== "string" || !charter.objective.trim() || !strings(charter.successCriteria) || !charter.successCriteria.length || charter.constraints !== void 0 && !strings(charter.constraints) || charter.nonGoals !== void 0 && !strings(charter.nonGoals)) return false;
    if (value.status === "current" !== (value.boundCharterHash === value.currentCharterHash) || value.canRebind !== (value.status === "stale")) return false;
  } else if (value.canRebind) return false;
  return true;
}
function isResearchCharterBindingUpdate(value) {
  return object(value) && Object.keys(value).every((key) => ["cwd", "adoptionId", "expectedBindingRevision", "expectedBoundCharterHash", "expectedCharterHash", "requestId"].includes(key)) && typeof value.cwd === "string" && !!value.cwd && adoption(value.adoptionId) && revision(value.expectedBindingRevision, 0) && hash(value.expectedBoundCharterHash) && hash(value.expectedCharterHash) && id(value.requestId);
}
export {
  isResearchCharterBinding,
  isResearchCharterBindingSession,
  isResearchCharterBindingUpdate
};
