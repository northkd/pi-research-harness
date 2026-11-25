/** Browser-safe Science viewer wire contract. No upstream addresses or page metadata. */
export type ScienceViewTarget = { kind: "workspace" } | { kind: "task"; taskId: string };
export interface ScienceViewRequest { cwd: string; target: ScienceViewTarget }
export type ScienceViewReason = "host-unconfigured" | "host-offline" | "binding-unavailable" | "view-unavailable" | "lease-expired" | "access-revoked" | "invalid-host-response" | "busy";
export type ScienceViewResponse =
  | { availability: "ready"; leaseId: string; expiresAt: number }
  | { availability: "unavailable" | "unknown"; reason: ScienceViewReason };

export type ScienceViewInput =
  | { kind: "mouse"; x: number; y: number; action?: "click" | "move" | "down" | "up"; button?: "left" | "middle" | "right"; clickCount?: number }
  | { kind: "scroll"; x: number; y: number; deltaX?: number; deltaY?: number }
  | { kind: "key"; keyType?: "keyDown" | "keyUp" | "char"; key?: string; code?: string; text?: string }
  | { kind: "resize"; width: number; height: number }
  | { kind: "bringToFront" };
export interface ScienceViewFrame {
  jpegBase64: string;
  metadata: { deviceWidth: number; deviceHeight: number; timestamp: number };
}
export interface ScienceViewSubscribeMessage { type: "science_view_subscribe"; cwd: string; leaseId: string }
export interface ScienceViewUnsubscribeMessage { type: "science_view_unsubscribe"; cwd: string; leaseId: string }
export interface ScienceViewInputMessage { type: "science_view_input"; cwd: string; leaseId: string; input: ScienceViewInput }
export interface ScienceViewFrameMessage extends ScienceViewFrame { type: "science_view_frame"; leaseId: string }
export interface ScienceViewStatusMessage { type: "science_view_status"; leaseId: string; state: "streaming" | "unavailable" | "expired"; reason?: ScienceViewReason }

/** Host-only types, never serialized in the browser wire responses above. */
export interface ScienceViewPartition { ownerKey: string; cwd: string }
export interface ScienceViewSubscription {
  /** A UI event is not a task/material/approval grant. Host blocks business
   * mutations until durable intent and verified driver gates pass. */
  input(input: ScienceViewInput): Promise<void>;
  /** Detach only this consumer; never stop a task, Chrome or Science. */
  unsubscribe(): void;
}
export interface ScienceHostView {
  /** Frames begin only after private login completes and UI origins are verified. */
  subscribe(frame: (value: ScienceViewFrame) => void, unavailable?: () => void): Promise<ScienceViewSubscription>;
}
export type ScienceHostOpenResult =
  | { availability: "ready"; view: ScienceHostView }
  | { availability: "unavailable" | "unknown"; reason: ScienceViewReason };
export interface ScienceViewHost {
  /** Resolve only this trusted owner/canonical-cwd partition on the independent
   * host. Reuse its workspace view; never submit tasks. Connection, nonce and
   * origins come from fixed private host state. A real implementation must
   * intercept business mutations through the durable-intent/material/approval
   * boundary before injection. Task bindings remain unavailable in M1. */
  openWorkspace(partition: ScienceViewPartition): Promise<ScienceHostOpenResult>;
  /** Existing opaque registry instance only; no submit/retry or client-native IDs. */
  openTask?(partition: ScienceViewPartition, instanceId: string): Promise<ScienceHostOpenResult>;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function shape(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function taskId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
export function isScienceViewTarget(value: unknown): value is ScienceViewTarget {
  return object(value) && (value.kind === "workspace" && shape(value, ["kind"]) || value.kind === "task" && shape(value, ["kind", "taskId"]) && taskId(value.taskId));
}
export function scienceTabPath(target: ScienceViewTarget): string {
  if (!isScienceViewTarget(target)) throw new Error("invalid-science-target");
  return target.kind === "workspace" ? "science:workspace" : `science:task:${target.taskId}`;
}
export function parseScienceTabPath(value: unknown): ScienceViewTarget | null {
  if (typeof value !== "string") return null;
  if (value === "science:workspace") return { kind: "workspace" };
  const id = value.startsWith("science:task:") ? value.slice("science:task:".length) : undefined;
  return taskId(id) ? { kind: "task", taskId: id } : null;
}

const finite = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const optionalEnum = (value: unknown, values: readonly string[]) => value === undefined || typeof value === "string" && values.includes(value);
const text = (value: unknown, max: number) => value === undefined || typeof value === "string" && value.length <= max && !value.includes("\0");
export function isScienceViewInput(value: unknown): value is ScienceViewInput {
  if (!object(value)) return false;
  switch (value.kind) {
    case "mouse": return shape(value, ["kind", "x", "y", "action", "button", "clickCount"]) && finite(value.x, 0, 1) && finite(value.y, 0, 1) && optionalEnum(value.action, ["click", "move", "down", "up"]) && optionalEnum(value.button, ["left", "middle", "right"]) && (value.clickCount === undefined || Number.isInteger(value.clickCount) && finite(value.clickCount, 1, 3));
    case "scroll": return shape(value, ["kind", "x", "y", "deltaX", "deltaY"]) && finite(value.x, 0, 1) && finite(value.y, 0, 1) && (value.deltaX === undefined || finite(value.deltaX, -10000, 10000)) && (value.deltaY === undefined || finite(value.deltaY, -10000, 10000));
    case "key": return shape(value, ["kind", "keyType", "key", "code", "text"]) && optionalEnum(value.keyType, ["keyDown", "keyUp", "char"]) && text(value.key, 128) && text(value.code, 128) && text(value.text, 4096);
    case "resize": return shape(value, ["kind", "width", "height"]) && Number.isInteger(value.width) && Number.isInteger(value.height) && finite(value.width, 1, 3840) && finite(value.height, 1, 2160);
    case "bringToFront": return shape(value, ["kind"]);
    default: return false;
  }
}
