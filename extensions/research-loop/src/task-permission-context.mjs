import fs from 'node:fs';
import { readWorkbenchRecordContext } from './workbench-context.mjs';
import { readTaskPermissions, recordTaskPermissionBlock } from './task-permissions.mjs';

/** Resolve a grant only for a persisted, confirmed workbench participant and its operator. */
export function readTaskPermissionContext(ctx, options = {}) {
  try {
    const membership = readWorkbenchRecordContext(ctx, options);
    if (!membership) return null;
    // The verifier intentionally projects no cwd. Resolve it from its verified ctx.
    const cwd = fs.realpathSync(ctx.cwd);
    const file = ctx.sessionManager.getSessionFile().slice(0, -6) + '.meta.json';
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let meta;
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024) return null;
      const data = Buffer.alloc(before.size + 1), size = fs.readSync(fd, data, 0, data.length, 0), after = fs.fstatSync(fd);
      if (size !== before.size || before.mtimeMs !== after.mtimeMs || before.size !== after.size) return null;
      meta = JSON.parse(data.subarray(0, size).toString('utf8'));
    } finally { fs.closeSync(fd); }
    const principal = meta.principalOwner;
    const owners = principal ? [[principal.iss, principal.sub]] : [['host', 'inert-operator'], ['urn:pi-dashboard:local-operator', 'local-operator']];
    for (const owner of owners) {
      const binding = { cwd, charterHash: membership.charterHash, ownerKey: JSON.stringify(owner), ...(options.storeDir ? { storeDir: options.storeDir } : {}) };
      let profile;
      try { profile = readTaskPermissions(binding); } catch { continue; }
      const current = readWorkbenchRecordContext(ctx, options);
      if (!current || fs.realpathSync(ctx.cwd) !== cwd || current.charterHash !== membership.charterHash || current.adoptionId !== membership.adoptionId) return null;
      return { profile, binding };
    }
    return { profile: null, unavailable: true };
  } catch { /* Never derive a grant from untrusted prompt text or missing membership. */ }
  return null;
}
export function recordTaskPermissionContextBlock(context, code, tool, target) {
  if (!context?.binding) return;
  try { recordTaskPermissionBlock({ ...context.binding, code, tool, ...(target ? { target } : {}) }); } catch { /* Diagnostics cannot widen permission or hold a run. */ }
}
