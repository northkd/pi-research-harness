import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { charterHash, configureResearch, confirmAdoption, sha256 } from '../../extensions/research-loop/src/adoption.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const json = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
};

/** Real platform confirmation followed by a real configure revision; no model calls. */
export function charterBindingFixture(t, options = {}) {
  const root = options.root ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'charter-binding-'));
  if (!options.root) t?.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = options.cwd ?? path.join(root, 'project');
  fs.mkdirSync(cwd, { recursive: true });
  const privateDir = options.privateDir ?? path.join(root, 'private');
  const ownerKey = options.ownerKey ?? JSON.stringify(['host', 'inert-operator']);
  const adoptionId = options.adoptionId ?? 'adopt-' + digest(cwd).slice(0, 24);
  const proposal = { items: [] };
  const receipt = confirmAdoption(cwd, {
    id: adoptionId, proposal, proposalHash: sha256(proposal), sources: [],
    objective: 'Original research target', successCriteria: ['Keep original evidence'],
    expectedCharterHash: charterHash(cwd), autoRun: false,
  });
  const privateScope = path.join(privateDir, digest(ownerKey), digest(cwd));
  const privateOperationPath = path.join(privateScope, adoptionId + '.json');
  const adoptedPointerPath = path.join(privateScope, 'adopted.json');
  json(privateOperationPath, {
    schema: 'pi-res-workflow-operation.v1', ownerKey, cwd,
    adoption: { id: adoptionId, cwd, status: 'confirmed', proposalHash: sha256(proposal) },
    confirmationIntent: { hash: receipt.confirmationHash, at: receipt.at },
  });
  json(adoptedPointerPath, { id: adoptionId, confirmed: true, confirmationHash: receipt.confirmationHash });
  const currentStatePath = path.join(cwd, '.pi', 'research-loop', 'state.json');
  const originalReceiptPath = path.join(cwd, '.pi', 'research-loop', 'adoptions', adoptionId, 'confirmation.json');
  if (options.revise !== false) {
    const state = JSON.parse(fs.readFileSync(currentStatePath, 'utf8'));
    configureResearch(cwd, {
      ...state.charter, objective: 'Revised research target', successCriteria: ['Keep old evidence separate', 'Evaluate revised target'],
      constraints: ['Read-only source data'], nonGoals: ['No publication'], ...options.revisedCharter, autoRun: false,
    }, { expectedCharterHash: receipt.charterHash });
  }
  const sessionId = options.sessionId ?? 'lead-session';
  const sessionFile = options.sessionFile ?? path.join(root, sessionId + '.jsonl');
  let header = { type: 'session', id: sessionId, cwd, timestamp: receipt.at };
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  if (options.preserveExistingSession && fs.existsSync(sessionFile)) {
    header = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\n')[0]);
    if (header.type !== 'session' || header.id !== sessionId || header.cwd !== cwd) throw new Error('Fixture session identity mismatch');
  } else if (options.firstTurn !== true) fs.writeFileSync(sessionFile, JSON.stringify(header) + '\n', { mode: 0o600 });
  const [iss, sub] = JSON.parse(ownerKey);
  const metaFile = sessionFile.slice(0, -6) + '.meta.json';
  const previousMeta = options.preserveExistingSession && fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  const resWorkflow = { canonicalCwd: cwd, joinedAt: receipt.at, via: 'spawn' };
  json(metaFile, {
    ...previousMeta,
    cwd, driver: 'pi', principalOwner: { iss, sub },
    resWorkflow,
    ...(previousMeta.pluginRefs?.['res-workflow']?.resWorkflow ? { pluginRefs: { ...previousMeta.pluginRefs, 'res-workflow': { ...previousMeta.pluginRefs['res-workflow'], resWorkflow } } } : {}),
  });
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile, getHeader: () => header } };
  const preservePaths = [originalReceiptPath, privateOperationPath, adoptedPointerPath, currentStatePath,
    path.join(cwd, '.pi', 'research-loop', 'events.jsonl'), path.join(cwd, '.pi', 'research-loop', 'ledger.jsonl'), path.join(cwd, 'ledger.jsonl')].filter(file => fs.existsSync(file));
  const originalBytes = new Map(preservePaths.map(file => [file, fs.readFileSync(file)]));
  return { root, cwd, privateDir, ownerKey, adoptionId, privateScope, originalReceiptPath, privateOperationPath, adoptedPointerPath, currentStatePath, receipt, sessionId, sessionFile, ctx, originalBytes };
}
