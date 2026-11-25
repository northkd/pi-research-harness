const WORK_SOURCE_CONTRIBUTION_PREFIX = "automation.worksource.";
function isWorkSource(v) {
  const s = v;
  return !!s && typeof s === "object" && typeof s.next === "function" && typeof s.ack === "function" && typeof s.nack === "function";
}
function collectWorkSourceContributions(entries, opts) {
  const warn = opts?.warn ?? (() => {
  });
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const { key, value } of entries) {
    const contribs = Array.isArray(value) ? value : [value];
    for (const c of contribs) {
      try {
        const entry = c;
        if (!entry || typeof entry !== "object") {
          warn(`automation work-source "${key}": ignored \u2014 not an object`);
          continue;
        }
        if (typeof entry.id !== "string" || entry.id.trim() === "") {
          warn(`automation work-source "${key}": ignored \u2014 missing/empty id`);
          continue;
        }
        if (!isWorkSource(entry.source)) {
          warn(`automation work-source "${entry.id}" (${key}): ignored \u2014 not a work source (next/ack/nack)`);
          continue;
        }
        if (seen.has(entry.id)) {
          warn(`automation work-source "${entry.id}" (${key}): ignored \u2014 duplicate id`);
          continue;
        }
        seen.add(entry.id);
        out.push({ id: entry.id, source: entry.source });
      } catch (e) {
        warn(`automation work-source "${key}": ignored \u2014 threw during validation: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return out;
}
export {
  WORK_SOURCE_CONTRIBUTION_PREFIX,
  collectWorkSourceContributions
};
