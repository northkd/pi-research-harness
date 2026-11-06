import fs from 'node:fs';
import path from 'node:path';
import type { PathYoloRequestMessage, PathYoloResultMessage } from '@blackbelt-technology/pi-dashboard-shared/protocol.js';
import { isUngrantableSubject, realpathNearestAncestor } from '@blackbelt-technology/pi-dashboard-shared/forbidden-subjects.js';
import { handlePathYoloRequest, type AgentYoloDeps } from '../access/agent-yolo.js';
import { isRefused } from '../access/refusal-ledger.js';
import { readSessionResearchAccessMode, type ResearchAccessSession } from './access-mode-service.js';

/** Only a connected bridge's own local session may consume its owner's workspace mode. */
export async function handleResearchTaskPathRequest(sessionId: string, msg: PathYoloRequestMessage, session: ResearchAccessSession | undefined, deps: AgentYoloDeps, test: { readAccessMode?: typeof readSessionResearchAccessMode; refused?: typeof isRefused } = {}): Promise<PathYoloResultMessage> {
  const result = (verdict: PathYoloResultMessage['verdict']): PathYoloResultMessage => ({ type: 'path_yolo_result', requestId: typeof msg.requestId === 'string' ? msg.requestId : '', verdict });
  if (msg.sessionId !== sessionId || !session || session.id !== sessionId || session.originDeviceId || session.driver && session.driver !== 'pi' || typeof msg.requestId !== 'string' || !msg.requestId || msg.requestId.length > 256
    || typeof msg.path !== 'string' || !path.isAbsolute(msg.path) || msg.path.includes('\0')
    || !['read', 'write', 'edit'].includes(msg.tool) || msg.access !== (msg.tool === 'read' ? 'r' : 'w')) return result('decline');
  try {
    const resolved = realpathNearestAncestor(msg.path);
    const mode = await (test.readAccessMode ?? readSessionResearchAccessMode)(session);
    // This is a per-call decision, never a persistent directory grant. A later
    // switch to default takes effect even for a previously refused location.
    if (mode?.mode === 'full-access') return result('auto-allow');
    // Default preserves the native prompt and refusal rules. Legacy task grants
    // are deliberately absent: expiry/revocation is not a second permission gate.
    if (isUngrantableSubject(resolved)) return result('decline');
    let subject = path.dirname(resolved);
    try { if (fs.statSync(resolved).isDirectory()) subject = resolved; } catch { /* Future file's directory. */ }
    if (isUngrantableSubject(subject)) return result('decline');
    if ((test.refused ?? isRefused)('agent-path', subject)) return result('refused');
    // A saved default explicitly turns off workspace full access, including an
    // older transient YOLO setting. Unconfigured workspaces retain native YOLO.
    if (mode?.revision !== null) return result('decline');
    return handlePathYoloRequest(sessionId, msg, deps);
  } catch { return result('decline'); }
}
