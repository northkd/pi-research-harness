import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { createAccessGrantStore, isAllowed, isGrantAdmitted, offeredAncestorLadder,
  isUngrantableSubject, realpathNearestAncestor } from './upstream.mjs';

export { isGrantAdmitted, canonicalSubject, decidePathAccess, buildOptions, GrantCache,
  isUngrantableSubject, forbiddenGrantSubjects, defaultResolveEnv, resolveToolPath,
  resolveReadTarget, canonicalizeTarget, isPathWithinRoots, createPathGateHandler,
  RootsProvider, Suppression, DEFAULT_AGENT_PATH_GATE, resolveAgentPathGate } from './upstream.mjs';
export { createNativePathGate } from './native.mjs';
export { createNativeGrantTransport } from './transport.mjs';
export { registerNativePathGate } from './binder.mjs';

export const DENIAL_TTL_MS = 10 * 60 * 1000;
const clone = value => structuredClone(value);

/** One local-host authority. Callers must first pass their existing session ACL.
 * Project grants survive restart; session grants live for this host process. */
export function createGrantAuthority({storeFile, home = os.homedir(), onChanged, now = Date.now} = {}) {
  if (!storeFile || !path.isAbsolute(storeFile) || !path.isAbsolute(home)) throw new TypeError('absolute grant storeFile and home required');
  const store = createAccessGrantStore({storeFile, homedir: home, onChanged});
  const denials = new Map();
  const prune = () => { for (const [id,row] of denials) if (now() - row.at >= DENIAL_TTL_MS) denials.delete(id); };
  const ungrantable = subject => isUngrantableSubject(subject,{homedir:home});

  async function evaluatePath(resolved, anchors, opts = {}) {
    if (!path.isAbsolute(resolved) || !Array.isArray(anchors) || anchors.some(p=>!path.isAbsolute(p))) throw new TypeError('absolute containment paths required');
    if (await isAllowed(resolved,{anchors})) return {allowed:true,viaGrant:false};
    if (opts.allowGrant !== false && await isGrantAdmitted(resolved,store.grantedSubjects())) return {allowed:true,viaGrant:true};
    if (opts.allowGrant === false) return {allowed:false,viaGrant:false};
    let subject = resolved;
    if ((opts.subjectKind ?? 'file') === 'file') subject = path.dirname(resolved);
    else if (opts.subjectKind === 'auto') {
      try { if (!(await fs.lstat(resolved)).isDirectory()) subject=path.dirname(resolved); } catch { /* retain exact unknown resource */ }
    }
    subject = realpathNearestAncestor(subject);
    let ancestors=[];
    try { ancestors=await offeredAncestorLadder(subject,{homedir:home}); } catch { /* a failed probe keeps the narrower offer */ }
    const remedy={reason:'Path is outside every containment anchor for this session.',
      hint:'Approve the named directory in the CLI, or use a session rooted in it.',subject,ancestors};
    if (!opts.quiet) {
      prune();
      const row={denialId:randomUUID(),subject,ancestors,site:opts.site??'file-read',session:opts.session??'unknown',at:now()};
      denials.set(row.denialId,row);
      if(denials.size>200) denials.delete(denials.keys().next().value);
      remedy.denialId=row.denialId;
    }
    return {allowed:false,viaGrant:false,remedy};
  }

  async function createFromDenial(input, approve) {
    input=input&&typeof input==='object'?{...input}:{};
    prune();
    const row=denials.get(input?.denialId);
    if(!row || input.session!==row.session) return {ok:false,reason:'unknown-denial'};
    if(typeof input.subject!=='string' || !['session','project'].includes(input.scope??'project')) return {ok:false,reason:'invalid-request'};
    const normalized=store.normalizeGrantSubject(input.subject);
    const named=new Set([row.subject,...row.ancestors]);
    if(!named.has(normalized)) return {ok:false,reason:'unnamed'};
    if(ungrantable(normalized)) return {ok:false,reason:'forbidden'};
    if(typeof approve!=='function' || await approve(clone({...row,subject:normalized,scope:input.scope??'project'}))!==true) return {ok:false,reason:'approval-required'};
    // Re-evaluate the same sealed subject after the operator answers.
    if(!denials.has(row.denialId) || now()-row.at>=DENIAL_TTL_MS || store.normalizeGrantSubject(input.subject)!==normalized || ungrantable(normalized)) return {ok:false,reason:'denial-changed'};
    const widened=normalized!==row.subject;
    const result=store.recordGrant({subject:normalized,scope:input.scope??'project',origin:row.session,
      ...(widened?{widenedFrom:row.subject}:{}),...(input.via==='agent-prompt'?{via:'agent-prompt'}:{})});
    if(!result.ok) return {ok:false,reason:'write-failed',error:result.error};
    denials.delete(row.denialId);
    return {ok:true,grant:clone(result.grant),widened};
  }

  return Object.freeze({
    storeFile,
    list:()=>clone(store.listGrants()),
    subjects:({persistedOnly=false}={})=>persistedOnly?store.listGrants().filter(g=>g.scope==='project').map(g=>g.subject):[...store.grantedSubjects()],
    denials:()=>{prune();return [...denials.values()].reverse().map(clone);},
    revoke(subject,scope){if(typeof subject!=='string' || scope!==undefined&&!['session','project'].includes(scope)) throw new TypeError('invalid grant revoke');return store.revokeGrant(subject,scope);},
    evaluatePath,createFromDenial,
  });
}
