import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, maybeJson } from '../session-host/files.mjs';
import { fail } from '../http.mjs';
import { forbiddenGrantSubjects, isUngrantableSubject } from './grants/index.mjs';

const MAX_DIRECTORIES = 4096;
const isAbsolute = value => typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value
  && value.length <= 4096 && !value.includes('\0');
const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const unique = list => [...new Set(list)];

function canonicalDirectory(value) {
  if (!isAbsolute(value)) fail(400, 'workspace-directory-invalid');
  try {
    if (fs.realpathSync(value) !== value || !fs.lstatSync(value).isDirectory()) fail(403, 'workspace-directory-refused');
  } catch (error) {
    if (error.code === 'ENOENT') fail(404, 'workspace-directory-not-found');
    throw error;
  }
  return value;
}

function directoryList(value) {
  return Array.isArray(value) && value.length <= MAX_DIRECTORIES && value.every(isAbsolute) && unique(value).length === value.length;
}

export function directLoopback(request) {
  return request?.socket?.remoteAddress === '127.0.0.1'
    && !['forwarded', 'x-forwarded-for', 'x-real-ip'].some(header => request.headers?.[header] !== undefined);
}

export function createWorkspaceDirectories({ stateDir, home, pinnedDirectories = [], listSessions, grantSubjects, trust }) {
  const file = path.join(stateDir, 'workspace-directories.json');
  const initial = { version: 1, pinned: unique(pinnedDirectories), created: [] };
  const state = () => {
    const current = maybeJson(file) ?? initial;
    if (current.version !== 1 || !directoryList(current.pinned) || !directoryList(current.created)) {
      fail(503, 'workspace-directories-invalid');
    }
    return current;
  };
  const pinned = () => [...state().pinned];
  const known = () => {
    const current = state();
    return unique([...current.pinned, ...current.created]);
  };

  function canBrowse(value, request) {
    if (directLoopback(request)) return true;
    const sensitive = forbiddenGrantSubjects({ homedir: home }).sensitive;
    if (sensitive.some(directory => within(directory, value))) return false;
    if (within(home, value)) return true;
    const roots = [...known(), ...listSessions().filter(row => !row.originDeviceId).map(row => row.cwd), ...(grantSubjects?.() ?? [])];
    return roots.some(root => isAbsolute(root) && within(root, value) && !isUngrantableSubject(root, { homedir: home }));
  }

  function registerCreated(value) {
    const directory = canonicalDirectory(value);
    if (path.dirname(directory) !== path.join(home, 'Projects')) fail(403, 'workspace-directory-refused');
    const current = state();
    if (current.created.includes(directory)) return;
    if (current.created.length >= MAX_DIRECTORIES) fail(409, 'workspace-directory-limit');
    atomicJson(file, { ...current, created: [...current.created, directory] });
  }

  function update(body, request) {
    if (!body || Object.keys(body).some(key => !['action', 'path', 'paths', 'piTrust'].includes(key))
        || body.piTrust !== undefined && typeof body.piTrust !== 'boolean') fail(400, 'workspace-pin-request-invalid');
    const current = state();
    if (body.action === 'reorder') {
      if (body.path !== undefined || body.piTrust !== undefined || !directoryList(body.paths)
          || body.paths.length !== current.pinned.length
          || !body.paths.every(directory => current.pinned.includes(directory))) fail(409, 'workspace-pin-order-changed');
      atomicJson(file, { ...current, pinned: [...body.paths] });
    } else if (body.action === 'pin' && body.paths === undefined) {
      const directory = canonicalDirectory(body.path);
      if (!canBrowse(directory, request) || isUngrantableSubject(directory, { homedir: home })) fail(403, 'workspace-directory-refused');
      if (!current.pinned.includes(directory)) {
        if (current.pinned.length >= MAX_DIRECTORIES) fail(409, 'workspace-directory-limit');
        const save = () => atomicJson(file, { ...current, pinned: [...current.pinned, directory] });
        if (trust) trust.grant('pinned', directory, body.piTrust, save);
        else save();
      }
    } else if (body.action === 'unpin' && body.paths === undefined && body.piTrust === undefined && isAbsolute(body.path)) {
      if (current.pinned.includes(body.path)) {
        const save = () => atomicJson(file, { ...current, pinned: current.pinned.filter(directory => directory !== body.path) });
        if (trust) trust.revoke('pinned', body.path, save);
        else save();
      }
    } else fail(400, 'workspace-pin-request-invalid');
    return pinned();
  }

  return { pinned, known, canBrowse, registerCreated, update };
}
