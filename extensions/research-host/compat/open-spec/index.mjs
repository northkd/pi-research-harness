import { fail, reply } from '../../http.mjs';
import { createNativeControlClient } from '../native-control-client.mjs';

const safeChange = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 &&
  value !== '.' && value !== '..' && !/[\/\\`\u0000-\u001f\u007f]/.test(value);

function renameTarget(row, changeName) {
  const trimmed = row.name?.trim();
  return !trimmed || row.attachedProposal && trimmed === row.attachedProposal ? changeName : undefined;
}

function systemName(row, value) {
  if (row.nameSource === 'user') return { name: value || undefined };
  return value === '' ? { name: undefined, nameSource: undefined, nameSourceFor: undefined }
    : { name: value, nameSource: 'system', nameSourceFor: value };
}

export function createProposalCompatibility({ sessions, nativeControls = createNativeControlClient({ sessions }) }) {
  const update = sessions.updateSession ?? sessions.updateSessionMeta;
  async function apply(row, changeName) {
    if (typeof update !== 'function') fail(501, 'session-proposal-persistence-unavailable');
    if (row.driver && row.driver !== 'pi') fail(409, 'session-proposal-native-context-unsupported');
    if (row.live) await nativeControls.probe(row);
    const updates = changeName === null ? {
      attachedProposal: null, openspecPhase: null, openspecChange: null, pendingReplaceProposal: null, rejectedReplaceProposals: [],
    } : { attachedProposal: changeName };
    const name = changeName === null
      ? row.name?.trim() === row.attachedProposal && row.nameSource !== 'user' ? '' : undefined
      : renameTarget(row, changeName);
    if (name !== undefined) {
      if (row.live) {
        if (row.external || !name) await nativeControls.apply(row, 'set-name', { name });
        else {
          const renamed = await sessions.command(row.id, { type: 'set_session_name', name });
          if (renamed?.success !== true) fail(409, 'session-proposal-rename-unconfirmed');
        }
      }
      Object.assign(updates, systemName(row, name));
    }
    await update(row.id, updates);
    if (!row.live) return reply({ success: true, pending: true, data: { attachedProposal: changeName, contextState: 'waiting-for-session' } }, 202);
    const context = await nativeControls.apply(sessions.getSession(row.id), 'proposal-context', { attachedChange: changeName });
    if (context.attachedChange !== changeName || !/^[a-f0-9]{64}$/.test(context.fragmentHash ?? '')) fail(503, 'session-proposal-context-unconfirmed');
    return reply({ success: true, data: { attachedProposal: changeName, contextState: 'applied', contextFragmentHash: context.fragmentHash } });
  }
  return {
    attach(row, body) {
      if (!body || Object.keys(body).some(key => key !== 'changeName') || !safeChange(body.changeName)) fail(400, 'session-proposal-change-required');
      return apply(row, body.changeName);
    },
    detach(row, body) {
      if (!body || Object.keys(body).length) fail(400, 'invalid-session-request');
      return apply(row, null);
    },
  };
}
