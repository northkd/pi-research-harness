import { readRoleConfigFromDisk } from "../../shared/role-config-disk.js";
import { joinRef, resolveModelRef } from "../../shared/role-schema.js";
function resolveModel(model, opts = {}) {
  const trimmed = model.trim();
  if (!trimmed.startsWith("@")) {
    return { model: trimmed };
  }
  const roles = opts.readRoles ? opts.readRoles() : readRoleConfigFromDisk().roles;
  const r = resolveModelRef(trimmed, { roles });
  if (!r.unresolved && r.model) {
    return { model: joinRef(r.model, r.level) };
  }
  return {
    model: opts.defaultModel ?? "",
    error: `unresolved role "${trimmed}"${opts.defaultModel ? ` \u2014 falling back to default model "${opts.defaultModel}"` : " \u2014 no default model configured"}`
  };
}
export {
  resolveModel
};
