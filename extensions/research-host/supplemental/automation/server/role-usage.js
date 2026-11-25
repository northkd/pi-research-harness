import { parseModelRef } from "../../shared/role-schema.js";
function automationRoleUsage(discovered) {
  const out = [];
  for (const a of discovered) {
    const model = a.valid ? a.config?.model : void 0;
    if (typeof model === "string" && parseModelRef(model).kind === "role") {
      out.push({ label: `${a.scope}:${a.name}`, ref: model.trim() });
    }
  }
  return out;
}
export {
  automationRoleUsage
};
