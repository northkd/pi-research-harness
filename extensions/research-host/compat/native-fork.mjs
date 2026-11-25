import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fail } from '../http.mjs';

export async function loadManagedSessionManager({ env = process.env, home = os.homedir() } = {}) {
  const agent = env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi/agent');
  if (!path.isAbsolute(agent)) fail(503, 'native-session-sdk-unavailable');
  let version;
  try { version = fs.readFileSync(path.join(agent, 'install/current-version'), 'utf8').trim(); }
  catch { fail(503, 'native-session-sdk-unavailable'); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(version)) fail(503, 'native-session-sdk-unavailable');
  const file = path.join(agent, 'install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js');
  let loaded;
  try { loaded = await import(pathToFileURL(file).href); }
  catch { fail(503, 'native-session-sdk-unavailable'); }
  if (typeof loaded.SessionManager?.open !== 'function' || typeof loaded.SessionManager?.create !== 'function') fail(503, 'native-session-sdk-unavailable');
  return loaded.SessionManager;
}

function sourceFile(row) {
  if (typeof row.sessionFile !== 'string' || !path.isAbsolute(row.sessionFile)) fail(409, 'session-fork-source-unsafe');
  const stat = fs.lstatSync(row.sessionFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || fs.realpathSync(row.sessionFile) !== row.sessionFile) fail(409, 'session-fork-source-unsafe');
  return row.sessionFile;
}

function copySnapshot(source, destination) {
  const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let output;
  try {
    const stat = fs.fstatSync(input);
    if (!stat.isFile() || stat.uid !== process.getuid?.()) fail(409, 'session-fork-source-unsafe');
    output = fs.openSync(destination, 'wx', 0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < stat.size) {
      const bytes = fs.readSync(input, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (!bytes) fail(409, 'session-fork-source-changed');
      fs.writeFileSync(output, buffer.subarray(0, bytes));
      offset += bytes;
    }
    const after = fs.lstatSync(source);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.isSymbolicLink() || fs.realpathSync(source) !== source) fail(409, 'session-fork-source-changed');
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

/** The native SDK owns branch selection and migration. It reads a private
 * snapshot so opening an older session cannot migrate the parent's file. */
export function createNativeSessionFork({ sessions, loadSessionManager = loadManagedSessionManager }) {
  return async function forkSession(row) {
    if (row.researchSession || row.pluginRefs?.['res-workflow']?.researchSession || row.hostInheritedReadOnly) fail(409, 'research-session-fork-assignment-required');
    let source;
    try { source = sourceFile(row); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const result = await sessions.createSession({ cwd: row.cwd, sessionId: randomUUID(), name: row.name, model: row.model,
        ...(row.principalOwner ? { principalOwner: row.principalOwner } : {}),
        metadata: { degradedFromSessionId: row.id, ...(row.attachedProposal ? { attachedProposal: row.attachedProposal } : {}) } });
      if (result?.success !== true) fail(503, 'session-fork-launch-unconfirmed');
      return { ...result, degradedToNew: true };
    }
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-native-fork-'));
    let destination;
    try {
      const snapshot = path.join(temporary, 'source.jsonl');
      copySnapshot(source, snapshot);
      const SessionManager = await loadSessionManager();
      const manager = SessionManager.open(snapshot, temporary);
      if (manager.getSessionId() !== row.id || manager.getCwd() !== row.cwd) fail(409, 'session-fork-source-identity-mismatch');
      const leafId = manager.getLeafId();
      let branch = manager;
      if (leafId) manager.createBranchedSession(leafId);
      else branch = SessionManager.create(row.cwd, temporary, { parentSession: source });
      const header = { ...branch.getHeader(), parentSession: source };
      if (header.id === row.id || !/^[A-Za-z0-9_-]{1,128}$/.test(header.id ?? '') || header.cwd !== row.cwd) fail(503, 'session-fork-identity-unconfirmed');
      destination = path.join(path.dirname(source), path.basename(branch.getSessionFile()));
      const fd = fs.openSync(destination, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(header) + '\n');
        for (const entry of branch.getEntries()) fs.writeFileSync(fd, JSON.stringify(entry) + '\n');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      const directory = fs.openSync(path.dirname(destination), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      const result = await sessions.createSession({ cwd: row.cwd, sessionId: header.id, sessionFile: destination,
        name: row.name, model: row.model, ...(row.principalOwner ? { principalOwner: row.principalOwner } : {}),
        metadata: { parentSessionId: row.id, parentSessionFile: source,
          ...(row.attachedProposal ? { attachedProposal: row.attachedProposal } : {}),
          ...(row.name ? { name: row.name, nameSource: row.nameSource } : {}) } });
      if (result?.success !== true || result.sessionId !== header.id || result.sessionFile !== destination) fail(503, 'session-fork-launch-unconfirmed');
      return { ...result, parentSessionId: row.id, parentSessionFile: source };
    } finally {
      // A destination handed to the native host remains available for its
      // normal launch-outcome reconciliation, even if startup was interrupted.
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  };
}
