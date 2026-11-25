import path from 'node:path';

const issued = new WeakSet();
const values = value => typeof value === 'function' ? value() : value;

export function isAllowedCwd(cwd, knownCwds) {
  return typeof cwd === 'string' && path.isAbsolute(cwd)
    && (values(knownCwds) || []).includes(cwd);
}

export async function admitCwd(cwd, knownCwds) {
  if (!isAllowedCwd(cwd, knownCwds)) return { kind: 'refuse' };
  const token = { cwd };
  issued.add(token);
  return { kind: 'admit', token };
}

export function admissionAllows(admission, cwd) {
  return admission?.kind === 'admit' && issued.has(admission.token) && admission.token.cwd === cwd;
}

export function releaseAdmission(token) { issued.delete(token); }

export function issueHeldAdmission(decision, cwd) {
  if (decision?.kind !== 'allow' || decision.cwd !== cwd) return { kind: 'refuse' };
  const token = { cwd };
  issued.add(token);
  return { kind: 'admit', token };
}

export function isOutside(root, target) {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
}
