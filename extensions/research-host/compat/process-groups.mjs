import fs from 'node:fs';

export function linuxProcessSnapshot() {
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const value = fs.readFileSync('/proc/' + name + '/stat', 'utf8');
      const fields = value.slice(value.lastIndexOf(')') + 2).split(' ');
      const uid = fs.statSync('/proc/' + name).uid;
      rows.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), startTime: fields[19], state: fields[0], uid });
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EACCES'].includes(error.code)) throw error; }
  }
  return rows;
}

/** PGIDs remain attributable after a wrapper exits while a witnessed member
 * survives. A recycled group without such a witness requires a fresh scan. */
export function createOwnedProcessGroups({ pid = process.pid, uid = process.getuid?.(), snapshot = linuxProcessSnapshot, signal = process.kill } = {}) {
  const groups = new Map();
  function observe() {
    const rows = snapshot().filter(row => row.state !== 'Z');
    const own = rows.find(row => row.pid === pid);
    if (!own || own.uid !== uid) throw new Error('native-process-owner-unavailable');
    const descendants = new Set([pid]);
    for (let pass = 0; pass < rows.length; pass++) {
      let changed = false;
      for (const row of rows) if (row.uid === uid && descendants.has(row.ppid) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true; }
      if (!changed) break;
    }
    const grouped = new Map();
    for (const row of rows) {
      if (!grouped.has(row.pgid)) grouped.set(row.pgid, []);
      grouped.get(row.pgid).push(row);
    }
    for (const [pgid, members] of grouped) {
      if (pgid === own.pgid || pgid < 2 || members.some(row => row.uid !== uid)) { groups.delete(pgid); continue; }
      const previous = groups.get(pgid);
      const witnessed = previous && members.some(row => previous.has(row.pid + ':' + row.startTime));
      if (members.every(row => descendants.has(row.pid)) || witnessed) groups.set(pgid, new Set(members.map(row => row.pid + ':' + row.startTime)));
      else groups.delete(pgid);
    }
    for (const pgid of groups.keys()) if (!grouped.has(pgid)) groups.delete(pgid);
    return new Set(groups.keys());
  }
  return {
    observe,
    kill(pgid) {
      if (!Number.isSafeInteger(pgid) || pgid < 2) throw new Error('native-process-group-invalid');
      if (!observe().has(pgid)) throw new Error('native-process-group-not-owned');
      signal(-pgid, 'SIGTERM');
      return { requested: true, pgid };
    },
  };
}
