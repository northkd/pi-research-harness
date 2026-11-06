import fs from 'node:fs';
import path from 'node:path';
import type { PathYoloRequestMessage, PathYoloResultMessage } from '@blackbelt-technology/pi-dashboard-shared/protocol.js';
import { isUngrantableSubject, realpathNearestAncestor } from '@blackbelt-technology/pi-dashboard-shared/forbidden-subjects.js';
import { handlePathYoloRequest, type AgentYoloDeps } from '../access/agent-yolo.js';
import { isRefused } from '../access/refusal-ledger.js';
import { decideResearchTaskPath } from './task-permission-service.js';

type Session = Parameters<typeof decideResearchTaskPath>[0];
/** Only a connected bridge's own joined session may consume a task grant. */
export async function handleResearchTaskPathRequest(sessionId: string, msg: PathYoloRequestMessage, session: Session, deps: AgentYoloDeps, test: { decideTaskPath?: typeof decideResearchTaskPath; refused?: typeof isRefused } = {}): Promise<PathYoloResultMessage> {
  const result = (verdict: PathYoloResultMessage['verdict']): PathYoloResultMessage => ({ type: 'path_yolo_result', requestId: typeof msg.requestId === 'string' ? msg.requestId : '', verdict });
  if (msg.sessionId !== sessionId || session && session.id !== sessionId || typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 256
    || typeof msg.path !== 'string' || !path.isAbsolute(msg.path) || msg.path.includes('\0')
    || !['read', 'write', 'edit'].includes(msg.tool) || msg.access !== (msg.tool === 'read' ? 'r' : 'w')) return result('decline');
  try {
    const resolved = realpathNearestAncestor(msg.path);
    // Existing protected locations and explicit operator refusals keep priority.
    if (isUngrantableSubject(resolved)) return result('decline');
    let subject = path.dirname(resolved);
    try { if (fs.statSync(resolved).isDirectory()) subject = resolved; } catch { /* Future file's directory. */ }
    if (isUngrantableSubject(subject)) return result('decline');
    if ((test.refused ?? isRefused)('agent-path', subject)) return result('refused');
    const decision = await (test.decideTaskPath ?? decideResearchTaskPath)(session?.id === sessionId ? session : undefined, resolved, msg.access, msg.tool);
    if (decision) return result(decision);
  } catch { /* Existing gate remains authoritative if task authorization is unavailable. */ }
  return handlePathYoloRequest(sessionId, msg, deps);
}
