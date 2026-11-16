/** Keep an isolated native preview alive for an externally controlled browser.
 * No browser is launched and no visual assertion is invented by this helper.
 * A one-time native login link is handed off only through a mode-0600 file in
 * the launcher's temporary HOME; neither its value nor cookies enter reports.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const previewHome = process.env.PI_UI_PREVIEW_HOME;
const base = process.env.PI_UI_PREVIEW_URL;
const cwd = process.env.PI_UI_DEMO_CWD;
const output = process.env.PI_UI_QA_OUTPUT;
const handoff = process.env.PI_UI_LOGIN_URL;
if (!previewHome || !base || !cwd || !output || !handoff) throw new Error('Run this helper through scripts/ui-preview/launcher.mjs.');
if (fs.realpathSync(previewHome) !== previewHome || path.dirname(previewHome) !== fs.realpathSync(os.tmpdir())
  || !path.basename(previewHome).startsWith('pi-ui-preview-') || process.env.HOME !== previewHome
  || process.env.USERPROFILE !== previewHome || os.homedir() === os.userInfo().homedir) {
  throw new Error('Manual preview requires the isolated launcher HOME.');
}
const origin = new URL(base), login = new URL(handoff);
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port
  || login.origin !== origin.origin || login.pathname !== '/auth/local-proof' || !login.searchParams.get('code')) {
  throw new Error('Manual preview requires an endpoint-bound native loopback login.');
}

const privateDir = fs.mkdtempSync(path.join(previewHome, 'manual-browser-'));
fs.chmodSync(privateDir, 0o700);
const handoffFile = path.join(privateDir, 'handoff.url');
const stopFile = path.join(privateDir, 'stop');
const metadataFile = path.join(output, 'manual-browser-ready.json');
const requestedAt = new Date().toISOString();
const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
let reason = null;
const onSignal = () => { reason = 'signal'; };
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, onSignal);

try {
  fs.writeFileSync(handoffFile, handoff + '\n', { flag: 'wx', mode: 0o600 });
  // Safe to inspect: this metadata contains a file path, never a credential.
  fs.writeFileSync(metadataFile, JSON.stringify({
    syntheticData: true, ready: true, url: base, project: cwd,
    sessions: JSON.parse(process.env.PI_UI_DEMO_SESSIONS || '[]').map(row => ({ id: row.id, name: row.name })),
    handoffFile, stopFile, requestedAt, expiresAt,
    visualVerification: 'external-browser-required',
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ manualPreview: true, ready: true, metadataFile, visualVerification: 'external-browser-required' }));
  while (!reason) {
    if (fs.existsSync(stopFile)) { reason = 'stop-requested'; break; }
    if (Date.now() >= Date.parse(expiresAt)) { reason = 'expired'; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
} finally {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, onSignal);
  // Only this invocation's private handoff files are removed, never user data.
  for (const file of [handoffFile, stopFile]) fs.rmSync(file, { force: true });
  fs.rmdirSync(privateDir);
  if (fs.existsSync(metadataFile)) {
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    fs.writeFileSync(metadataFile, JSON.stringify({ ...metadata, ready: false, handoffFile: null, stopFile: null, endedAt: new Date().toISOString(), reason }, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(JSON.stringify({ manualPreview: true, ended: true, reason, visualVerification: 'external-browser-required' }));
}
