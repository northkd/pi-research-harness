const WHOLE = /^\$\{\{trigger\}\}$/;
const EMBED = /\$\{\{trigger\}\}/g;
function stringify(value) {
  if (value === void 0 || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}
function interpolate(value, triggerValue) {
  if (typeof value === "string") {
    if (WHOLE.test(value)) return triggerValue ?? "";
    return value.replace(EMBED, () => stringify(triggerValue));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, triggerValue));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, triggerValue)])
    );
  }
  return value;
}
export {
  interpolate
};
