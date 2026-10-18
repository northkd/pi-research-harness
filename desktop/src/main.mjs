import { app, BrowserWindow, Menu, dialog, ipcMain, net as electronNet, protocol, session, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeResearchProfile } from '../runtime/research-bootstrap.mjs';
import { navigationAction, normalizeDashboardUrl, validateHealth, withRuntimePath } from '../runtime/desktop-policy.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke-test');
const resourcesDir = app.isPackaged ? process.resourcesPath : path.resolve(sourceDir, '../resources');
const launcherUrl = 'pi-research://desktop/launcher.html';
protocol.registerSchemesAsPrivileged([{ scheme: 'pi-research', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.setName('Pi Research Harness');
if (smoke && process.env.PI_RESEARCH_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.PI_RESEARCH_USER_DATA_DIR));
const dataDir = path.join(app.getPath('userData'), 'research');
const preferencePath = path.join(app.getPath('userData'), 'desktop-settings.json');
const logDir = path.join(app.getPath('userData'), 'logs');
fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
const logPath = path.join(logDir, 'server.log');
const taskkillPath = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32/taskkill.exe') : undefined;

let window;
let child;
let localUrl;
let currentUrl;
let starting;
let stopping;
let quitting = false;
let navigationEpoch = 0;
let externalPrompt = false;
let state = { phase: 'starting', title: '正在启动本地工作台', detail: '正在准备科研配置和本地服务。', version: app.getVersion() };
function updateState(fields) {
  state = { ...state, ...fields };
  if (window && !window.isDestroyed()) window.webContents.send('research:state', state);
}
function readPreferences() {
  try { return JSON.parse(fs.readFileSync(preferencePath, 'utf8')); } catch { return { mode: 'local' }; }
}
function savePreferences(value) {
  fs.mkdirSync(path.dirname(preferencePath), { recursive: true, mode: 0o700 });
  const temporary = `${preferencePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, preferencePath);
}

function documentationUrl() {
  const repository = 'https://github.com/northkd/pi-research-harness';
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(resourcesDir, 'research-bundle.json'), 'utf8'));
    if (/^[a-f0-9]{40}$/.test(manifest.sourceCommit)) return `${repository}/blob/${manifest.sourceCommit}/docs/DESKTOP.md`;
  } catch { /* Development runs can start before resources are prepared. */ }
  return repository;
}

function assertLauncher(event) {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== launcherUrl) {
    throw new Error('This action is available only from the desktop launcher.');
  }
}

async function freePort(preferred = 0) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => {
      if (preferred && error.code === 'EADDRINUSE') freePort(0).then(resolve, reject);
      else reject(error);
    });
    probe.listen({ host: '127.0.0.1', port: preferred, exclusive: true }, () => {
      const port = probe.address().port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1460, height: 960, minWidth: 920, minHeight: 650,
    title: 'Pi Research Harness', backgroundColor: '#101319', show: false,
    icon: path.join(resourcesDir, 'icon.png'),
    webPreferences: {
      preload: path.join(sourceDir, 'preload.cjs'),
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      spellcheck: false
    }
  });
  window.once('ready-to-show', () => { if (window && !quitting) window.show(); });
  // A page cannot silently launch the user's browser through script or a redirect.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (currentUrl && navigationAction(currentUrl, url) !== 'deny') void openExternalLink(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url === launcherUrl) return;
    const action = currentUrl ? navigationAction(currentUrl, url) : 'deny';
    if (action !== 'allow') {
      event.preventDefault();
      if (action === 'external') void openExternalLink(url);
    }
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (currentUrl && navigationAction(currentUrl, url) !== 'allow') event.preventDefault();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) void showLauncher({ phase: 'error', title: '页面已停止响应', detail: `可以重新打开工作台。${details.reason}` });
  });
  window.on('closed', () => { window = undefined; });
  return window;
}

async function openExternalLink(url) {
  if (externalPrompt || quitting || !window) return;
  externalPrompt = true;
  try {
    const result = await dialog.showMessageBox(window, { type: 'question', title: '打开外部链接',
      message: '是否在系统浏览器中打开此链接？', detail: url,
      buttons: ['取消', '打开链接'], defaultId: 0, cancelId: 0 });
    if (result.response === 1 && !quitting) await shell.openExternal(url);
  } finally { externalPrompt = false; }
}

async function showLauncher(fields = {}) {
  if (quitting) return;
  if (!window || window.isDestroyed()) createWindow();
  currentUrl = undefined;
  updateState(fields);
  await window.loadURL(launcherUrl);
  if (window && !quitting) window.show();
}

async function openDashboard(url, operation = navigationEpoch) {
  if (quitting || operation !== navigationEpoch) return;
  if (!window || window.isDestroyed()) createWindow();
  currentUrl = normalizeDashboardUrl(url);
  await window.loadURL(currentUrl);
  if (quitting || operation !== navigationEpoch || !window) return;
  window.setTitle('Pi Research Harness');
  window.show();
}

async function waitForHealthyServer(processHandle, url) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (quitting) throw new Error('客户端正在退出。');
    if (processHandle.exitCode !== null || processHandle.signalCode) throw new Error('本地服务提前退出，请查看运行日志。');
    try {
      const response = await fetch(`${url}api/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) {
        const body = await response.json();
        if (body.mode === 'recovery' || body.recovery) throw new Error('后端进入恢复模式，请查看运行日志。');
        if (validateHealth(body, processHandle.pid)) return body;
      }
    } catch (error) {
      if (error.message.startsWith('后端进入')) throw error;
    }
    await delay(300);
  }
  throw new Error('本地服务启动超时，请查看运行日志后重试。');
}

async function startLocal() {
  if (quitting) return;
  const operation = ++navigationEpoch;
  if (starting) {
    await starting;
    if (!quitting && operation === navigationEpoch && child && localUrl) {
      savePreferences({ mode: 'local' });
      await openDashboard(localUrl, operation);
    }
    return;
  }
  if (child && child.exitCode === null && localUrl) {
    savePreferences({ mode: 'local' });
    return openDashboard(localUrl, operation);
  }
  starting = (async () => {
    updateState({ phase: 'starting', title: '正在启动本地工作台', detail: '正在加载 Dashboard 与科研扩展。首次启动可能需要一分钟。' });
    const profilePreview = initializeResearchProfile({ dataDir, resourcesDir, readOnly: true });
    const port = await freePort(smoke ? 0 : profilePreview.port);
    let piPort = await freePort(smoke ? 0 : profilePreview.piPort);
    while (piPort === port) piPort = await freePort(0);
    if (quitting) throw new Error('客户端正在退出。');
    const profile = initializeResearchProfile({ dataDir, resourcesDir, port, piPort });
    const serverRoot = path.join(resourcesDir, 'server');
    const nodeBinDir = path.join(resourcesDir, 'node', ...(process.platform === 'win32' ? [] : ['bin']));
    const nodePath = path.join(nodeBinDir, process.platform === 'win32' ? 'node.exe' : 'node');
    const requireServer = createRequire(path.join(serverRoot, 'package.json'));
    const jitiRegister = path.join(path.dirname(requireServer.resolve('jiti/package.json')), 'lib/jiti-register.mjs');
    const serverCli = path.join(serverRoot, 'node_modules/@blackbelt-technology/pi-dashboard-server/src/cli.ts');
    for (const file of [nodePath, jitiRegister, serverCli]) if (!fs.existsSync(file)) throw new Error('安装包缺少运行文件，请重新安装完整版本。');
    let environment = withRuntimePath({
      ...process.env, ...profile.environment,
      PI_RESEARCH_MANAGED_DIR: path.join(dataDir, 'managed'),
      MANAGED_DIR: path.join(dataDir, 'managed'),
      PI_DASHBOARD_HOST: '127.0.0.1', PI_DASHBOARD_NO_MDNS: '1',
      DASHBOARD_STARTER: 'Electron',
      JITI_FS_CACHE: path.join(dataDir, 'cache/jiti')
    }, [
      nodeBinDir, path.join(serverRoot, 'node_modules/.bin'), path.join(resourcesDir, 'harness/node_modules/.bin'),
      ...(process.platform === 'win32' ? [path.join(resourcesDir, 'git/cmd'), path.join(resourcesDir, 'git/usr/bin'), path.join(resourcesDir, 'git/mingw64/bin')] : [])
    ]);
    if (process.platform === 'win32') {
      // Some dashboard subprocess helpers read uppercase PATH after cloning env.
      const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === 'PATH');
      const runtimePath = environment[pathKey];
      for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PATH') delete environment[key];
      environment.PATH = runtimePath;
      environment.GIT_EXEC_PATH = path.join(resourcesDir, 'git/mingw64/libexec/git-core');
      const certificateFile = path.join(resourcesDir, 'git/mingw64/etc/ssl/certs/ca-bundle.crt');
      if (!environment.SSL_CERT_FILE && fs.existsSync(certificateFile)) environment.SSL_CERT_FILE = certificateFile;
    }
    delete environment.ELECTRON_RUN_AS_NODE;
    for (const directory of ['cache/jiti', 'managed']) fs.mkdirSync(path.join(dataDir, directory), { recursive: true, mode: 0o700 });
    // Keep logs bounded between launches while preserving one previous file.
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.previous`);
    const descriptor = fs.openSync(logPath, 'a', 0o600);
    fs.writeSync(descriptor, `\n[desktop] Starting v${app.getVersion()} ${process.platform}/${process.arch}\n`);
    const processHandle = spawn(nodePath, ['--import', pathToFileURL(jitiRegister).href, serverCli,
      '--host', '127.0.0.1', '--port', String(port), '--pi-port', String(piPort), '--no-tunnel'], {
      cwd: serverRoot, env: environment, windowsHide: true, stdio: ['ignore', descriptor, descriptor], shell: false,
      detached: process.platform !== 'win32'
    });
    fs.closeSync(descriptor);
    child = processHandle;
    localUrl = `http://127.0.0.1:${port}/`;
    processHandle.on('error', (error) => updateState({ phase: 'error', title: '本地服务启动失败', detail: error.message }));
    processHandle.once('exit', () => {
      if (child === processHandle) child = undefined;
      if (!quitting && !stopping && !starting && currentUrl === localUrl) void showLauncher({ phase: 'error', title: '本地服务已停止', detail: '点击打开本地工作台重新启动，或查看运行日志。' });
    });
    await once(processHandle, 'spawn');
    const health = await waitForHealthyServer(processHandle, localUrl);
    if (!quitting && operation === navigationEpoch) {
      if (!smoke) savePreferences({ mode: 'local' });
      updateState({ phase: 'ready', title: '本地工作台已就绪', detail: '科研数据保存在此客户端的独立配置目录。' });
      await openDashboard(localUrl, operation);
    }
    if (smoke) {
      const uiDeadline = Date.now() + 45_000;
      let uiLoaded = false;
      while (Date.now() < uiDeadline) {
        uiLoaded = await window.webContents.executeJavaScript('Boolean(document.querySelector("#root")?.childElementCount && document.body.innerText.trim().length > 20)');
        if (uiLoaded) break;
        await delay(250);
      }
      if (!uiLoaded) throw new Error('Packaged dashboard did not render.');
      const nodeVersion = spawnSync(nodePath, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
      const report = { ok: true, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
        nodeVersion, baseUrl: localUrl, healthStatus: 200, uiLoaded, recovery: false, mode: health.mode,
        serverPid: processHandle.pid, dataDir, harness: JSON.parse(fs.readFileSync(path.join(resourcesDir, 'research-bundle.json'), 'utf8')).version };
      await stopLocal();
      const reportDir = process.env.PI_RESEARCH_SMOKE_DIR;
      if (!reportDir) throw new Error('PI_RESEARCH_SMOKE_DIR is required for --smoke-test.');
      fs.mkdirSync(reportDir, { recursive: true });
      fs.writeFileSync(path.join(reportDir, 'desktop-smoke.json'), `${JSON.stringify(report, null, 2)}\n`);
      quitting = true;
      app.exit(0);
    }
  })();
  try { return await starting; }
  catch (error) {
    await stopLocal();
    if (!quitting && operation === navigationEpoch) await showLauncher({ phase: 'error', title: '工作台暂时未能启动', detail: error.message });
    if (smoke) { console.error(error.stack); quitting = true; app.exit(1); }
    throw error;
  } finally { starting = undefined; }
}

async function stopLocal() {
  if (stopping) return stopping;
  const target = child;
  if (!target || !target.pid || target.exitCode !== null || target.signalCode) return;
  stopping = (async () => {
    const exited = once(target, 'exit').catch(() => undefined);
    // Shutdown is sent only to the process this application started and identified.
    try {
      const health = await (await fetch(`${localUrl}api/health`, { signal: AbortSignal.timeout(1200) })).json();
      if (validateHealth(health, target.pid)) {
        await fetch(`${localUrl}api/shutdown`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"userQuit":true}', signal: AbortSignal.timeout(5000) });
        await Promise.race([exited, delay(5000)]);
      }
    } catch { /* Fall back to terminating our own child. */ }
    if (target.exitCode === null && !target.signalCode) {
      if (process.platform === 'win32') spawnSync(taskkillPath, ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
      else {
        try { process.kill(-target.pid, 'SIGTERM'); } catch { target.kill('SIGTERM'); }
      }
      await Promise.race([exited, delay(5000)]);
      if (target.exitCode === null && !target.signalCode) {
        if (process.platform === 'win32') spawnSync(taskkillPath, ['/PID', String(target.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
        else { try { process.kill(-target.pid, 'SIGKILL'); } catch { target.kill('SIGKILL'); } }
        await Promise.race([exited, delay(2000)]);
      }
    }
    if (child === target) child = undefined;
  })();
  try { await stopping; } finally { stopping = undefined; }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { window.restore(); window.show(); window.focus(); } else void showLauncher(); });
  app.whenReady().then(async () => {
    const assets = new Map(['launcher.html', 'launcher.css', 'launcher.js'].map((name) => [`pi-research://desktop/${name}`, path.join(sourceDir, '../assets', name)]));
    protocol.handle('pi-research', (request) => {
      const file = assets.get(request.url);
      return file ? electronNet.fetch(pathToFileURL(file).href) : new Response('Not found', { status: 404 });
    });
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    for (const [channel, handler] of [
      ['research:get-state', () => state],
      ['research:open-logs', () => shell.openPath(logDir)],
      ['research:start-local', () => startLocal()],
      ['research:connect', async (raw) => {
        const url = normalizeDashboardUrl(raw);
        const operation = ++navigationEpoch;
        updateState({ phase: 'starting', title: '正在连接已有工作台', detail: new URL(url).host, remoteUrl: url });
        try {
          await openDashboard(url, operation);
          if (!quitting && operation === navigationEpoch) savePreferences({ mode: 'remote', remoteUrl: url });
        } catch {
          if (!quitting && operation === navigationEpoch) await showLauncher({ phase: 'error', title: '连接未成功', detail: '请确认服务器地址、网络连接与 HTTPS 证书。', remoteUrl: url });
        }
      }]
    ]) ipcMain.handle(channel, (event, ...args) => { assertLauncher(event); return handler(...args); });
    const menu = [
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
      { label: '工作台', submenu: [
        { label: '打开本地工作台', click: () => void startLocal().catch(() => {}) },
        { label: '连接已有 Dashboard…', click: () => { navigationEpoch++; void showLauncher({ phase: 'idle', title: '选择工作台', detail: '打开本地工作台，或连接你已有的 Dashboard。' }); } },
        { type: 'separator' },
        { label: '打开科研配置目录', click: () => void shell.openPath(dataDir) },
        { label: '查看运行日志', click: () => void shell.openPath(logDir) },
        { type: 'separator' }, { role: 'quit', label: '退出客户端' }
      ] },
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
      { label: '帮助', submenu: [
        { label: '项目与使用说明', click: () => void shell.openExternal(documentationUrl()) },
        { label: '第三方许可证', click: () => void shell.openPath(path.join(resourcesDir, 'licenses')) }
      ] }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
    const preferences = smoke ? { mode: 'local' } : readPreferences();
    await showLauncher({ remoteUrl: preferences.remoteUrl });
    if (preferences.mode === 'remote' && preferences.remoteUrl) {
      try { await openDashboard(preferences.remoteUrl); }
      catch { await showLauncher({ phase: 'error', title: '连接未成功', detail: '检查网络后重试，或打开本地工作台。' }); }
    } else await startLocal().catch(() => {});
  }).catch((error) => { if (smoke) console.error(error.stack); else dialog.showErrorBox('Pi Research Harness', error.message); quitting = true; app.exit(1); });
  app.on('activate', () => {
    if (!window) { createWindow(); if (currentUrl) void openDashboard(currentUrl); else void showLauncher(); }
    else window.show();
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', (event) => {
    event.preventDefault();
    if (quitting) return;
    if (!smoke && child) {
      const choice = dialog.showMessageBoxSync({ type: 'question', title: '退出科研工作台',
        message: '退出将停止本机 Dashboard，正在执行的本地任务可能中断。',
        detail: '远程服务器上的任务由远程服务器管理。', buttons: ['继续使用', '退出'], defaultId: 0, cancelId: 0 });
      if (choice !== 1) {
        if (!window) { if (currentUrl) void openDashboard(currentUrl); else void showLauncher(); }
        return;
      }
    }
    quitting = true;
    navigationEpoch++;
    void stopLocal().finally(() => app.exit(0));
  });
}
