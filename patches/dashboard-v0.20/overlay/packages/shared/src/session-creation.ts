/** Creation labels are display metadata, never session ownership or authorization. */
export interface SessionCreation {
  schema: "pi-session-creation.v1";
  kind: "user";
  entryPoint: "dashboard" | "research-stage";
  cwd: string;
  createdAt: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const pathKey = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return;
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return;
  const normalized = /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? value.replace(/\\/g, "/") : value;
  return normalized.replace(/\/+$/, "") || "/";
};

export function isSessionCreation(value: unknown): value is SessionCreation {
  if (!object(value) || Object.keys(value).length !== 5) return false;
  return value.schema === "pi-session-creation.v1" && value.kind === "user" &&
    (value.entryPoint === "dashboard" || value.entryPoint === "research-stage") &&
    pathKey(value.cwd) !== undefined && typeof value.createdAt === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) &&
    Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt;
}

export function createSessionCreation(cwd: string, entryPoint: SessionCreation["entryPoint"], createdAt = new Date().toISOString()): SessionCreation {
  const record = { schema: "pi-session-creation.v1" as const, kind: "user" as const, entryPoint, cwd, createdAt };
  if (!isSessionCreation(record)) throw new Error("session-creation-invalid");
  return record;
}

interface SessionCreationInfo {
  cwd?: unknown;
  sessionCreation?: unknown;
  resWorkflow?: { canonicalCwd?: unknown } | null;
  pluginRefs?: Record<string, Record<string, unknown>>;
}

/** A canonical membership may explain an alias; unrelated paths stay unrelated. */
export function sessionProvenanceMatchesCwd(info: SessionCreationInfo | null | undefined, provenanceCwd: unknown, expectedCwd?: string): boolean {
  const recorded = pathKey(provenanceCwd);
  if (!recorded) return false;
  const bag = info?.pluginRefs?.["res-workflow"]?.resWorkflow;
  const canonical = pathKey(info?.resWorkflow?.canonicalCwd) ?? (object(bag) ? pathKey(bag.canonicalCwd) : undefined);
  const scopes = [pathKey(info?.cwd), canonical].filter((value): value is string => value !== undefined);
  const expected = expectedCwd === undefined ? undefined : pathKey(expectedCwd);
  return scopes.includes(recorded) && (expectedCwd === undefined || expected !== undefined && scopes.includes(expected));
}

/** Read explicit creation evidence only. `source` and membership `via` are not creators. */
export function projectSessionCreation(info: SessionCreationInfo | null | undefined, expectedCwd?: string): SessionCreation | null {
  const candidates = [info?.sessionCreation, info?.pluginRefs?.["res-workflow"]?.sessionCreation].filter(value => value !== undefined);
  if (!candidates.length || candidates.some(value => !isSessionCreation(value))) return null;
  const records = candidates as SessionCreation[];
  const record = records[0];
  if (records.some(other => other.schema !== record.schema || other.kind !== record.kind || other.entryPoint !== record.entryPoint || other.cwd !== record.cwd || other.createdAt !== record.createdAt)) return null;
  if (!sessionProvenanceMatchesCwd(info, record.cwd, expectedCwd)) return null;
  return createSessionCreation(record.cwd, record.entryPoint, record.createdAt);
}
