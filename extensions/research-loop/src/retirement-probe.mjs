/** Local native-state observations only. Unknown adapters keep retirement pending. */
import fs from 'node:fs';
import path from 'node:path';

// Shells can daemonize and formal sessions can still be registering. These launch paths need a complete host terminal adapter.
const SAFE_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'write', 'edit', 'bg_status', 'bg_logs',
  'research_communication', 'subagent', 'subagent_supervisor',
  'contact_supervisor', 'canvas', 'memory_write', 'memory_search', 'memory_forget']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
function privateJson(file, root) {
  if (fs.realpathSync(root) !== root) throw new Error('symlinked native task root');
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('outside native task root');
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('symlinked native task metadata');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error('invalid native task metadata');
    const bytes = Buffer.alloc(stat.size + 1), length = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.fstatSync(fd);
    if (length !== stat.size || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) throw new Error('native task changed');
    return JSON.parse(bytes.subarray(0, length).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function processes() {
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const text = fs.readFileSync(`/proc/${name}/stat`, 'utf8'), fields = text.slice(text.lastIndexOf(')') + 2).split(/\s+/);
      rows.push({ pid: Number(name), ppid: Number(fields[1]), group: Number(fields[2]), startTicks: fields[19] });
    } catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error; }
  }
  return rows;
}
export function createLocalRetirementProbe({ request, reportId, pid = process.pid, platform = process.platform } = {}) {
  return async ({ scope, activity }) => {
    if (platform !== 'linux' || typeof request !== 'function') throw new Error('native retirement adapter unavailable');
    const status = await request({ action: 'status' });
    const native = status.retirement;
    if (!native || native.sessionId !== scope.sessionId || native.pid !== pid || native.complete !== true
        || !reportId || native.reportId !== reportId) throw new Error('native session/report not verified');
    const rows = processes(), self = rows.find(row => row.pid === pid);
    if (!self) throw new Error('native process missing');
    const tree = new Set([pid]);
    for (;;) {
      const count = tree.size;
      for (const row of rows) if (tree.has(row.ppid)) tree.add(row.pid);
      if (tree.size === count) break;
    }
    const heldLocks = [];
    const inodes = new Set();
    for (const name of fs.readdirSync(`/proc/${pid}/fd`)) {
      try { const stat = fs.statSync(`/proc/${pid}/fd/${name}`); if (stat.isFile()) inodes.add(stat.ino); }
      catch (error) { if (!['ENOENT', 'EBADF'].includes(error.code)) throw error; }
    }
    for (const line of fs.readFileSync('/proc/locks', 'utf8').split('\n').filter(Boolean)) {
      const fields = line.trim().split(/\s+/), offset = fields[1] === '->' ? 1 : 0;
      if (tree.has(Number(fields[4 + offset])) || Number(fields[4 + offset]) === -1 && inodes.has(Number(fields[5 + offset]?.split(':')[2]))) heldLocks.push('native-lock-present');
    }
    const backgroundTasks = [];
    const unknownTools = activity.toolNames.filter(name => !SAFE_TOOLS.has(name));
    // Retained ordinary subagents require their native process-terminal adapter;
    // do not substitute final text or a missing process for that proof.
    if (activity.subagentRunIds.length) unknownTools.push('ordinary-subagent-terminal-adapter-unavailable');
    const root = path.join(scope.cwd, '.pi', 'tasks');
    for (const id of activity.backgroundTaskIds) {
      if (!ID.test(id)) throw new Error('invalid native task identity');
      const row = privateJson(path.join(root, `${scope.sessionId}-${pid}`, `${id}.json`), root);
      if (row.id !== id || row.cwd !== scope.cwd || !Number.isInteger(row.pid)) throw new Error('native task identity mismatch');
      backgroundTasks.push({ id, sessionId: scope.sessionId, cwd: scope.cwd, status: row.status,
        processExited: !rows.some(process => process.pid === row.pid || process.group === row.pid),
        startTime: row.startTime, endTime: row.endTime, exitCode: row.exitCode, signal: row.signal,
        notified: row.notified, notifyOnCompletion: row.notifyOnCompletion });
    }
    const last = processes().find(row => row.pid === pid);
    if (!last || last.startTicks !== self.startTicks) throw new Error('native process identity changed');
    return { ...scope, complete: true, observedAt: Date.now(), backgroundTasks, subagents: [],
      formalChildren: native.formalChildren, supervisorRequests: native.supervisorRequests,
      descendantProcesses: rows.filter(row => row.pid !== pid && tree.has(row.pid)).map(row => ({ pid: row.pid, startTicks: row.startTicks })),
      heldLocks, unknownTools };
  };
}
