import fs from 'node:fs';
import path from 'node:path';
import {
  createResWorkflowAccessModeService, readSessionResearchAccessMode,
  createResWorkflowTaskPermissionService, decideResearchTaskPath, assertResearchTaskDelegation,
  createResWorkflowResearchBudgetService,
  isResearchAccessModeUpdate, isResearchTaskPermissionUpdate, isResWorkflowResearchBudgetUpdateRequest,
} from './core.mjs';

export {
  isResearchAccessModeUpdate, isResearchTaskPermissionUpdate, isResWorkflowResearchBudgetUpdateRequest,
} from './core.mjs';

function absolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0')) throw new TypeError(`${name} must be an absolute canonical path`);
  let cursor = path.parse(value).root;
  for (const part of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TypeError(`${name} must use regular directories`); }
    catch (error) { if (error.code === 'ENOENT') break; throw error; }
  }
  return value;
}

/** HTTP and terminal controls share the existing native policy transactions. */
export function createWorkbenchPolicies(options) {
  const researchLoopRoot = absolute(options.researchLoopRoot, 'researchLoopRoot');
  const privateDir = absolute(options.privateDir, 'privateDir');
  const accessModeStoreDir = absolute(options.accessModeStoreDir, 'accessModeStoreDir');
  const taskPermissionStoreDir = absolute(options.taskPermissionStoreDir, 'taskPermissionStoreDir');
  if (typeof options.connection !== 'function') throw new TypeError('workbench connection provider required');
  const accessMode = createResWorkflowAccessModeService({ researchLoopRoot, storeDir: accessModeStoreDir });
  const taskPermissions = createResWorkflowTaskPermissionService({ researchLoopRoot, connection: options.connection, storeDir: taskPermissionStoreDir });
  const researchBudget = createResWorkflowResearchBudgetService({ researchLoopRoot, connection: options.connection });
  const nativeOptions = { researchLoopRoot, contextOptions: { privateDir, storeDir: taskPermissionStoreDir } };
  return {
    'access-mode': { ...accessMode, validate: isResearchAccessModeUpdate },
    'task-permissions': { ...taskPermissions, validate: isResearchTaskPermissionUpdate },
    'research-budget': { ...researchBudget, validate: isResWorkflowResearchBudgetUpdateRequest },
    readSessionAccessMode: session => readSessionResearchAccessMode(session, { researchLoopRoot, storeDir: accessModeStoreDir }),
    decideTaskPath: (session, target, access, tool) => decideResearchTaskPath(session, target, access, tool, nativeOptions),
    assertTaskDelegation: session => assertResearchTaskDelegation(session, nativeOptions),
  };
}
