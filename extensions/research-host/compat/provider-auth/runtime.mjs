import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSelectedPi({agentDir,managedInstallRoot}={}) {
  const install=managedInstallRoot??process.env.PI_MANAGED_INSTALL_ROOT??path.join(os.homedir(),'.pi/agent/install');
  const version=fs.readFileSync(path.join(install,'current-version'),'utf8').trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version))throw new Error('provider-auth-runtime-selection-invalid');
  const entry=fs.realpathSync(path.join(install,'releases',version,'node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
  const [publicSdk,authSdk]=await Promise.all([import(pathToFileURL(entry).href),import(pathToFileURL(path.join(path.dirname(entry),'core/auth-storage.js')).href)]);
  const sdk={...publicSdk,...authSdk};
  if(!sdk.AuthStorage?.fromStorage||!sdk.FileAuthStorageBackend||!sdk.ModelRuntime?.create)throw new Error('provider-auth-runtime-unavailable');
  return {sdk,version,entry};
}
