function encodePromptAnswer(result, cancelled) {
  if (cancelled) return void 0;
  if (typeof result === "object" && result !== null) {
    const r = result;
    if (Array.isArray(r.answers)) {
      return JSON.stringify(r.answers);
    }
    if (Array.isArray(r.values)) {
      return JSON.stringify(r.values);
    }
    if (r.value !== void 0) {
      return r.value;
    }
    if (r.confirmed !== void 0) {
      return r.confirmed.toString();
    }
  }
  return String(result ?? "");
}
function hasOwnOtherOption(options) {
  return options.some((o) => typeof o === "string" && /^other(?![\p{L}\p{N}])/iu.test(o.trim()));
}
function isOtherAllowed(p) {
  return p.allowOther === true && Array.isArray(p.options) && p.options.length > 0 && !hasOwnOtherOption(p.options);
}
function isCustomText(v) {
  return v.length > 0 && v === v.trim();
}
const OK = { ok: true };
const fail = (reason) => ({ ok: false, reason });
function parseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
function validateMultiselectValues(values, options, allowCustom = false) {
  if (!Array.isArray(values)) return fail("multiselect answer must be a JSON array");
  const seen = /* @__PURE__ */ new Set();
  let customs = 0;
  for (const v of values) {
    if (typeof v !== "string") return fail(`not an option: ${String(v)}`);
    if (!options.includes(v)) {
      if (!allowCustom || !isCustomText(v) || ++customs > 1) return fail(`not an option: ${String(v)}`);
    }
    if (seen.has(v)) return fail(`duplicate option: ${v}`);
    seen.add(v);
  }
  return OK;
}
function validateBatchEntry(entry, sub, index) {
  const at = `batch[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return fail(`${at}: entry must be an object`);
  }
  const e = entry;
  const options = Array.isArray(sub.options) ? sub.options : [];
  const other = isOtherAllowed({ allowOther: sub.allowOther, options });
  switch (sub.method) {
    case "confirm":
      return typeof e.confirmed === "boolean" ? OK : fail(`${at}: confirm needs {confirmed:boolean}`);
    case "select":
      return typeof e.value === "string" && (options.includes(e.value) || other && isCustomText(e.value)) ? OK : fail(`${at}: select value must be one of the options`);
    case "multiselect": {
      const r = validateMultiselectValues(e.values, options, other);
      return r.ok ? r : fail(`${at}: ${r.reason}`);
    }
    case "input":
      if (typeof e.value !== "string") return fail(`${at}: input needs {value:string}`);
      if (e.images !== void 0) return fail(`${at}: images are not supported on this road`);
      return OK;
    default:
      return fail(`${at}: unsupported sub-question method`);
  }
}
function validateQuestionAnswer(prompt, answer) {
  const options = prompt.options ?? [];
  const other = isOtherAllowed({ allowOther: prompt.allowOther, options });
  switch (prompt.type) {
    case "confirm":
      return answer === "true" || answer === "false" ? OK : fail('confirm answer must be "true" or "false"');
    case "select":
      return options.includes(answer) || other && isCustomText(answer) ? OK : fail("answer is not one of the options");
    case "multiselect": {
      const parsed = parseJson(answer);
      if (!parsed.ok) return fail("multiselect answer must be a JSON array");
      return validateMultiselectValues(parsed.value, options, other);
    }
    case "input":
    case "editor":
      return OK;
    case "batch": {
      const subs = prompt.metadata?.questions;
      if (!Array.isArray(subs)) return fail("batch prompt has no sub-questions");
      const parsed = parseJson(answer);
      if (!parsed.ok || !Array.isArray(parsed.value)) return fail("batch answer must be a JSON array");
      if (parsed.value.length !== subs.length) {
        return fail(`batch answer needs ${subs.length} entries, got ${parsed.value.length}`);
      }
      for (let i = 0; i < subs.length; i++) {
        const r = validateBatchEntry(parsed.value[i], subs[i] ?? {}, i);
        if (!r.ok) return r;
      }
      return OK;
    }
    default:
      return fail(`unsupported prompt type: ${prompt.type}`);
  }
}
export {
  encodePromptAnswer,
  hasOwnOtherOption,
  isOtherAllowed,
  validateQuestionAnswer
};
