// MOCK core: adapter orchestration tests, not privacy/core correctness or live-model proof.
import fs from 'node:fs';
import path from 'node:path';
export class MockStore {
  constructor(cwd) { this.cwd = cwd; this.file = path.join(cwd, 'mock-state.json'); fs.mkdirSync(path.join(cwd, '.pi/mainline-supervision'), { recursive: true }); }
  getState() { return fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file)) : { version: 1, enabled: false, authorized: false, revision: 0, reviewedRevision: -1, coreRevision: 0, materialRevision: 0, lastAttemptMaterialRevision: -1, checkpoints: [], pendingCheckpoints: [], blocked: false, reviewActivity: { state: 'standby' }, events: [] }; }
  save(s) { fs.writeFileSync(this.file, JSON.stringify(s)); return s; }
  configure(p) {
    const s = this.getState(), coreChanged = s.coreText !== p.coreText;
    if (coreChanged || JSON.stringify(s.approvedPaths) !== JSON.stringify(p.approvedPaths)) { s.revision++; s.materialRevision = s.revision; s.coreRevision++; }
    if (coreChanged) { const key = 'core-' + s.coreRevision; s.checkpoints.push(key); s.pendingCheckpoints.push(key); }
    return this.save({ ...s, ...p, enabled: true });
  }
  setEnabled(enabled) { return this.save({ ...this.getState(), enabled }); }
  record(e) { const s = this.getState(); if (!s.enabled) return { changed: false, revision: s.revision }; s.events.push(e); s.revision++; const materialChanged = e.type === 'tool_result' && !e.gateDenied && !['read', 'grep', 'find', 'ls'].includes(e.toolName); if (materialChanged) s.materialRevision = s.revision; this.save(s); return { changed: true, revision: s.revision, materialChanged }; }
  recordCheckpoint({ stageId, kind }) {
    const s = this.getState(), key = s.coreText + ':' + stageId + ':' + kind;
    if (s.materialRevision <= s.lastAttemptMaterialRevision || s.checkpoints.includes(key)) return { changed: false };
    s.checkpoints.push(key); s.pendingCheckpoints.push(key); this.save(s); return { changed: true };
  }
  requestHumanCheck() { return this.recordCheckpoint({ stageId: 'human-' + this.getState().materialRevision, kind: 'stage_complete' }); }
  reviewEligibility({ automatic = false } = {}) { const s = this.getState(); return { ok: s.materialRevision > s.lastAttemptMaterialRevision && (!automatic || s.pendingCheckpoints.length > 0) }; }
  resourceGate() { return { ok: true, memAvailableMiB: 4096 }; }
  beginReview({ sessionId, requestId, automatic = false }) {
    const s = this.getState();
    if (!s.enabled || !s.authorized || s.reviewActivity.state === 'reviewing' || !this.reviewEligibility({ automatic }).ok) return { ok: false, reason: 'no eligible change' };
    s.lastAttemptMaterialRevision = s.materialRevision; s.pendingCheckpoints = [];
    const packetDir = path.join(this.cwd, 'reviews', requestId); fs.mkdirSync(packetDir, { recursive: true });
    for (const [name, text] of Object.entries({ 'CORE.md': s.coreText, 'EVIDENCE.json': JSON.stringify(s.events), 'MANIFEST.json': '{}' })) fs.writeFileSync(path.join(packetDir, name), text);
    s.reviewActivity = { state: 'reviewing', requestId, packetDir, ownerSessionId: sessionId, revision: s.revision };
    this.save(s); return { ok: true, packetDir, requestId, revision: s.revision };
  }
  attachRun(requestId, runId) { const s = this.getState(); if (s.reviewActivity.requestId !== requestId) throw new Error('identity'); s.reviewActivity.runId = runId; this.save(s); }
  finishReview(requestId, result) { const s = this.getState(); if (s.reviewActivity.requestId !== requestId || (result.runId && s.reviewActivity.runId !== result.runId)) throw new Error('identity'); s.lastVerdict = result.error ? 'FAILED' : result.verdict; s.lastResult = result; s.reviewedRevision = s.reviewActivity.revision; s.blocked = false; s.reviewActivity.state = result.error ? 'failed' : 'standby'; this.save(s); }
  scopePath(p) { if (typeof p !== 'string' || p.startsWith('/') || p.includes('..') || p.startsWith('.')) throw new Error('Unsafe'); return p; }
  readLocal(p) { return fs.readFileSync(p, 'utf8'); }
  recordCorrection(p) { const s = this.getState(); s.correction = p; s.correctionCoreRevision = s.coreRevision; s.correctionPaths = p.evidencePaths; s.revision++; this.save(s); }
  approved(p, s) { return (s.approvedPaths ?? []).includes(p) ? p : null; }
  withheldCapturePaths() { return new Set(); }
  statusText() { return `后台监督：${this.getState().reviewActivity.state}`; }
}
export { MockStore as MainlineStore };
