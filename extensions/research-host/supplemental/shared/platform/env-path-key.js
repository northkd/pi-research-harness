function normalizeEnvPathKey(env, platform = process.platform) {
  if (platform !== "win32") return env;
  const variants = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
  if (variants.length === 0) return env;
  if (variants.length === 1 && variants[0] === "PATH" && typeof env.PATH === "string") return env;
  const ordered = [
    ...variants.filter((k) => k === "PATH"),
    ...variants.filter((k) => k !== "PATH").sort()
  ];
  const values = ordered.map((k) => env[k]).filter((v) => typeof v === "string");
  const out = { ...env };
  for (const key of variants) delete out[key];
  if (values.length > 0) out.PATH = mergePathEntries(values);
  return out;
}
function mergePathEntries(values) {
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  for (const entry of values.flatMap((v) => v.split(";"))) {
    const lower = entry.toLowerCase();
    if (entry === "" || seen.has(lower)) continue;
    seen.add(lower);
    entries.push(entry);
  }
  return entries.join(";");
}
export {
  normalizeEnvPathKey
};
