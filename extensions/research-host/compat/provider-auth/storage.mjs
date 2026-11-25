import fs from 'node:fs';
import path from 'node:path';
export const AUTH_LIMIT=1024*1024;
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const clone=value=>value===undefined?undefined:structuredClone(value);
export const fail=(code,statusCode=400,vars)=>{throw Object.assign(new Error(code),{code,statusCode,...(vars?{vars}:{})});};
export function providerId(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)||['constructor','prototype','__proto__'].includes(value))fail('provider-auth-provider-invalid');return value;}
export function validateCredential(value){
  if(!object(value))fail('provider-auth-credential-invalid');
  if(value.type==='api_key'){
    if(value.key!==undefined&&(typeof value.key!=='string'||value.key.length>65536))fail('provider-auth-credential-invalid');
    if(value.env!==undefined&&(!object(value.env)||Object.values(value.env).some(v=>typeof v!=='string')))fail('provider-auth-credential-invalid');
  }else if(value.type==='oauth'){
    if(typeof value.access!=='string'||typeof value.refresh!=='string'||!Number.isFinite(value.expires))fail('provider-auth-credential-invalid');
  }else fail('provider-auth-credential-invalid');
  if(Buffer.byteLength(JSON.stringify(value))>AUTH_LIMIT/2)fail('provider-auth-credential-too-large');
  return value;
}
function parse(raw){
  let data;try{data=JSON.parse((raw??'{}').replace(/^\uFEFF/,''));}catch{fail('provider-auth-store-corrupt',503);}
  if(!object(data))fail('provider-auth-store-corrupt',503);
  try{for(const value of Object.values(data))validateCredential(value);}catch{fail('provider-auth-store-corrupt',503);}
  return data;
}
function checkPath(file,{missing=false}={}){
  let current=path.parse(file).root;
  for(const segment of file.slice(current.length).split(path.sep).filter(Boolean)){
    current=path.join(current,segment);let info;
    try{info=fs.lstatSync(current);}catch(error){if(error.code==='ENOENT'&&missing)return null;throw error;}
    if(info.isSymbolicLink()||current!==file&&!info.isDirectory())fail('provider-auth-store-unsafe',503);
    if(current===file&&(!info.isFile()||info.nlink!==1||info.uid!==process.getuid?.()||(info.mode&0o077)!==0||info.size>AUTH_LIMIT))fail('provider-auth-store-unsafe',503);
  }
  return fs.statSync(file);
}
export function credentialConflict(type){fail('provider_auth.credential_type_conflict',409,{storedType:type});}

/** Native Pi locking and write format, with fail-closed filesystem and JSON
 * guards. Enumeration reads raw metadata and never resolves command keys. */
export function createCredentialStorage({sdk,agentDir,authFile=path.join(agentDir,'auth.json')}={}){
  if(!path.isAbsolute(authFile)||path.resolve(authFile)!==authFile)throw new TypeError('absolute canonical authFile required');
  const nativeBackend=new sdk.FileAuthStorageBackend(authFile);
  function validateCurrent(raw){checkPath(authFile);parse(raw);}
  const backend={
    withLock(fn){checkPath(authFile,{missing:true});return nativeBackend.withLock(raw=>{validateCurrent(raw);const result=fn(raw);checkPath(authFile);return result;});},
    withLockAsync(fn,options){checkPath(authFile,{missing:true});return nativeBackend.withLockAsync(async raw=>{validateCurrent(raw);const result=await fn(raw);checkPath(authFile);return result;},options);},
  };
  let native;
  const nativeStore=()=>native??=sdk.AuthStorage.fromStorage(backend);
  function snapshot(){
    if(!checkPath(authFile,{missing:true}))return {};
    const descriptor=fs.openSync(authFile,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    try{const info=fs.fstatSync(descriptor);if(!info.isFile()||info.nlink!==1||info.size>AUTH_LIMIT)fail('provider-auth-store-unsafe',503);return parse(fs.readFileSync(descriptor,'utf8'));}
    finally{fs.closeSync(descriptor);}
  }
  async function resolveCredential(provider,{signal,allowCommand=false}={}){
    providerId(provider);signal?.throwIfAborted();const value=snapshot()[provider];
    if(!value)return undefined;
    if(value.type==='api_key'&&typeof value.key==='string'&&value.key.startsWith('!')&&!allowCommand)fail('provider-auth-command-resolution-required',409);
    if(value.type!=='api_key'||value.key===undefined)return clone(value);
    return clone(await nativeStore().read(provider,{signal}));
  }
  const credentials={
    read:resolveCredential,
    list:async options=>{options?.signal?.throwIfAborted();return Object.entries(snapshot()).map(([providerId,value])=>({providerId,type:value.type}));},
    async modify(provider,fn,options){
      providerId(provider);
      return clone(await nativeStore().modify(provider,async current=>{
        const next=await fn(clone(current));if(next===undefined)return undefined;
        validateCredential(next);if(current&&current.type!==next.type)credentialConflict(current.type);return clone(next);
      },options));
    },
    async delete(provider,options){return remove(provider,undefined,options);},
  };
  async function remove(provider,expectedType,options){
    providerId(provider);if(!checkPath(authFile,{missing:true}))return;
    await backend.withLockAsync(async raw=>{const data=parse(raw),current=data[provider];
      if(current&&expectedType&&current.type!==expectedType)credentialConflict(current.type);
      if(!Object.hasOwn(data,provider))return {result:undefined};delete data[provider];
      return {result:undefined,next:JSON.stringify(data,null,2)};
    },options);
    native=undefined;
  }
  return {authFile,credentials,snapshot,resolveCredential,remove,
    write:async(provider,credential,options)=>credentials.modify(provider,async()=>credential,options)};
}
