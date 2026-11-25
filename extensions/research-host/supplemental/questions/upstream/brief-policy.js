import { redactSecrets } from "./redaction.js";
const PROVIDED_BRIEF_MAX_CHARS = 32768;
const REDACTION_MARGIN_CHARS = 256;
function contextMessageOf(message) {
  return typeof message === "string" && message.trim() !== "" ? message : void 0;
}
function decideBriefPolicy(input) {
  const message = contextMessageOf(input.message);
  if (message !== void 0 && message.length >= input.minBriefChars) return { kind: "provided", brief: redactSecrets(message.slice(0, PROVIDED_BRIEF_MAX_CHARS + REDACTION_MARGIN_CHARS)).slice(0, PROVIDED_BRIEF_MAX_CHARS) };
  return input.autoBrief ? { kind: "generate" } : { kind: "disabled" };
}
export {
  contextMessageOf,
  decideBriefPolicy
};
