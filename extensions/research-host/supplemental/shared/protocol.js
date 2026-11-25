const RESERVED_EVENT_PREFIXES = ["roles:", "role:", "model:", "prompt:", "dashboard:", "ui:"];
function isReservedEventType(eventType) {
  return RESERVED_EVENT_PREFIXES.some((p) => eventType.startsWith(p));
}
export {
  RESERVED_EVENT_PREFIXES,
  isReservedEventType
};
