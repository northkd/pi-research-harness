import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NODE_VERSION } from './download-node.mjs';
import { auditMacFramework } from './mac-framework-audit.cjs';

const execFileAsync = promisify(execFile);
const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));
const nativeAuditDirectory = path.join(desktopDirectory, 'dist', 'native-audit');
const productName = 'Pi Research Harness';
const launchTimeoutMs = 180_000;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The packaged main process writes this report only after its actual local server
// is healthy and its BrowserWindow has loaded the dashboard. No model is invoked.
export function validateSmokeReport(report, platform = process.platform, arch = process.arch) {
  assert.equal(report.ok, true, 'The desktop main process did not report success');
  assert.equal(report.packaged, true, 'The smoke test must launch the packaged application');
  assert.equal(report.platform, platform, 'The application platform does not match the runner');
  assert.equal(report.arch, arch, 'The application architecture does not match the runner');
  assert.equal(report.nodeVersion, `v${NODE_VERSION}`, 'The bundled server must use the pinned Node runtime');
  assert.equal(report.healthStatus, 200, 'The actual dashboard health endpoint must return HTTP 200');
  assert.equal(report.uiLoaded, true, 'The dashboard renderer did not load');
  assert.notEqual(report.recovery, true, 'A recovery page is not a working dashboard');
  const url = new URL(report.baseUrl);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1', 'The local desktop server must bind to loopback');
  assert.equal(url.username, '');
  assert.equal(url.password, '');
  assert.ok(Number(url.port) > 0 && Number(url.port) <= 65535, 'The report must identify a real listening port');
  assert.ok(url.pathname === '/' && !url.search && !url.hash, 'The report must contain the local base URL');
  return report;
}

async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function findInstaller(dist) {
  const suffix = process.platform === 'darwin' ? '.dmg' : '-Setup.exe';
  const files = (await readdir(dist)).filter((name) => name.startsWith('Pi-Research-Harness-') && name.endsWith(suffix));
  assert.equal(files.length, 1, `Expected exactly one native ${suffix} installer in ${dist}; clean old build output first`);
  return path.join(dist, files[0]);
}

async function nsisProcessSnapshot(rootPid) {
  if (!Number.isInteger(rootPid)) return [];
  // Query only this installer and its descendants. No machine-wide process list
  // or recursive filesystem scan: the bundle contains over 100,000 small files.
  const command = `
$ErrorActionPreference = 'Stop'
$nsisQueue = [System.Collections.Generic.Queue[int]]::new()
$nsisSeen = [System.Collections.Generic.HashSet[int]]::new()
$nsisRows = [System.Collections.Generic.List[object]]::new()
$nsisQueue.Enqueue(${rootPid})
while ($nsisQueue.Count -gt 0 -and $nsisSeen.Count -lt 32) {
  $nsisId = $nsisQueue.Dequeue()
  if (-not $nsisSeen.Add($nsisId)) { continue }
  $nsisProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $nsisId" -ErrorAction SilentlyContinue
  if (-not $nsisProcess) { continue }
  $nsisWindow = Get-Process -Id $nsisId -ErrorAction SilentlyContinue
  $nsisRows.Add([pscustomobject]@{
    pid = $nsisProcess.ProcessId; parentPid = $nsisProcess.ParentProcessId; name = $nsisProcess.Name
    cpuSeconds = ([double]$nsisProcess.KernelModeTime + [double]$nsisProcess.UserModeTime) / 10000000
    readBytes = [double]$nsisProcess.ReadTransferCount; writeBytes = [double]$nsisProcess.WriteTransferCount
    workingSetBytes = [double]$nsisProcess.WorkingSetSize; windowTitle = $nsisWindow.MainWindowTitle
  })
  Get-CimInstance Win32_Process -Filter "ParentProcessId = $nsisId" -ErrorAction SilentlyContinue |
    ForEach-Object { $nsisQueue.Enqueue([int]$_.ProcessId) }
}
ConvertTo-Json -InputObject @($nsisRows.ToArray()) -Depth 4 -Compress`;
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 10_000, maxBuffer: 256_000 });
  return JSON.parse(stdout.trim() || '[]');
}

async function nsisInstallationSnapshot(installed) {
  const markers = [
    `${productName}.exe`, `Uninstall ${productName}.exe`, 'resources/app.asar',
    'resources/research-bundle.json', 'resources/node/node.exe', 'resources/git/cmd/git.exe',
    'resources/harness/package.json', 'resources/server/package.json',
    'resources/server/node_modules/@blackbelt-technology/pi-dashboard-web/dist/index.html',
  ];
  const files = await Promise.all(markers.map(async (relative) => {
    try {
      const info = await stat(path.join(installed, relative));
      return { path: relative, exists: true, bytes: info.size, modifiedAt: info.mtime.toISOString() };
    } catch (error) { return { path: relative, exists: false, error: error.code }; }
  }));
  const directories = await Promise.all(['.', 'resources', 'resources/server/node_modules', 'resources/harness/node_modules'].map(async (relative) => {
    try { return { path: relative, entries: (await readdir(path.join(installed, relative))).length }; }
    catch (error) { return { path: relative, entries: null, error: error.code }; }
  }));
  return { directory: installed, files, directories };
}

async function runNsis(executable, args, { timeout, installed, evidence, stage }) {
  const started = Date.now();
  const diagnosticFile = path.join(evidence, `nsis-${stage}.jsonl`);
  const child = spawn(executable, args, {
    // NSIS /D and _?= must be final and unquoted. Only argv[0] is quoted,
    // preserving executable paths with spaces without shell interpretation.
    argv0: `"${executable}"`, windowsVerbatimArguments: true,
    windowsHide: true, shell: false, stdio: 'inherit',
  });
  const exit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let sampling = false;
  let pendingSample = Promise.resolve();
  const snapshot = async (event, details = {}) => {
    sampling = true;
    try {
      const [processes, installation] = await Promise.all([
        child.exitCode === null && child.signalCode === null
          ? nsisProcessSnapshot(child.pid).catch((error) => ({ diagnosticError: error.message }))
          : [],
        nsisInstallationSnapshot(installed),
      ]);
      const record = { at: new Date().toISOString(), event, stage, elapsedMs: Date.now() - started,
        pid: child.pid, executable, arguments: args, timeoutMs: timeout, processes, installation, ...details };
      await appendFile(diagnosticFile, `${JSON.stringify(record)}\n`);
      console.log(`[nsis-${stage}] ${JSON.stringify(record)}`);
    } catch (error) {
      console.error(`[nsis-${stage}] Could not record diagnostics: ${error.message}`);
    } finally { sampling = false; }
  };
  // Samples never overlap, and each process query has its own short timeout.
  pendingSample = snapshot('started');
  const interval = setInterval(() => {
    if (!sampling) pendingSample = snapshot('running');
  }, 30_000);
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), timeout);
  });
  const result = await Promise.race([exit, deadline]);
  clearTimeout(timer);
  clearInterval(interval);
  if (result.timedOut) {
    // Kill the owned process tree, including an NSIS bootstrap child, before
    // cleanup can remove files underneath a still-running installer.
    let termination;
    try {
      const killed = await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 15_000,
      });
      termination = { ok: true, stdout: killed.stdout.trim(), stderr: killed.stderr.trim() };
    } catch (error) {
      termination = { ok: false, error: error.message, stdout: error.stdout, stderr: error.stderr };
    }
    const stopped = await Promise.race([exit, delay(10_000).then(() => ({ stillRunning: true }))]);
    await pendingSample;
    await snapshot('timeout', { termination, exit: { code: stopped.code, signal: stopped.signal, stillRunning: stopped.stillRunning } });
    throw new Error(`NSIS ${stage} exceeded ${timeout / 1000}s; owned process-tree termination ${termination.ok ? 'succeeded' : 'failed'}. Diagnostics: ${diagnosticFile}`);
  }
  await pendingSample;
  await snapshot('exited', { exit: { code: result.code, signal: result.signal, error: result.error?.message } });
  if (result.error) throw result.error;
  if (result.code !== 0) throw new Error(`NSIS ${stage} exited with code ${result.code}, signal ${result.signal}. Diagnostics: ${diagnosticFile}`);
}

async function installApplication(installer, temporary, evidence) {
  if (process.platform === 'darwin') {
    const command = (executable, args, options) => {
      console.log(`[mac-install] ${JSON.stringify({ executable, arguments: args })}`);
      return execFileAsync(executable, args, options);
    };
    const mountpoint = path.join(temporary, 'mounted');
    await mkdir(mountpoint);
    await command('/usr/bin/hdiutil', [
      'attach', installer, '-readonly', '-nobrowse', '-mountpoint', mountpoint,
    ], { timeout: 90_000 });
    let installation;
    let installed;
    try {
      const apps = (await readdir(mountpoint)).filter((name) => name.endsWith('.app'));
      assert.equal(apps.length, 1, 'The DMG must contain exactly one application bundle');
      const mountedApp = path.join(mountpoint, apps[0]);
      auditMacFramework({ appPath: mountedApp, stage: 'dmg-mounted', directory: nativeAuditDirectory });
      installed = path.join(temporary, 'Applications with spaces', apps[0]);
      await mkdir(path.dirname(installed));
      // ditto preserves the executable modes and framework links in the .app.
      await command('/usr/bin/ditto', [mountedApp, installed], { timeout: 180_000 });
      auditMacFramework({ appPath: installed, stage: 'installed-before-detach', directory: nativeAuditDirectory });
      const { stdout } = await command('/usr/libexec/PlistBuddy', [
        '-c', 'Print :CFBundleExecutable', path.join(installed, 'Contents', 'Info.plist'),
      ], { timeout: 30_000 });
      const binaryName = stdout.trim();
      assert.equal(binaryName, productName, 'The DMG contains an unexpected application');
      const executable = path.join(installed, 'Contents', 'MacOS', binaryName);
      await access(executable);
      installation = { executable, kind: 'DMG drag-copy installation' };
    } finally {
      await command('/usr/bin/hdiutil', ['detach', mountpoint], { timeout: 60_000 });
    }
    auditMacFramework({ appPath: installed, stage: 'installed-after-detach', directory: nativeAuditDirectory, launchProbe: true });
    return installation;
  }

  const installed = path.join(temporary, 'Installed application with spaces');
  // NSIS requires /D to be the final, unquoted command-line argument; the path
  // may contain spaces. Direct spawn avoids a shell and its escaping rules.
  // NSIS contract: https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
  await runNsis(installer, ['/S', '/currentuser', `/D=${installed}`], {
    timeout: 600_000, installed, evidence, stage: 'install',
  });
  const executable = path.join(installed, `${productName}.exe`);
  await access(executable);
  return { executable, installed, kind: 'NSIS silent per-user installation' };
}

async function uninstallApplication(installation, temporary, evidence) {
  if (!installation?.installed) return;
  const original = path.join(installation.installed, `Uninstall ${productName}.exe`);
  const uninstaller = path.join(temporary, 'uninstall-smoke.exe');
  await copyFile(original, uninstaller);
  // Running the copy with _?= avoids NSIS returning before its child uninstaller
  // finishes, and lets it remove the original installer directory in one pass.
  await runNsis(uninstaller, ['/S', '/currentuser', `_?=${installation.installed}`], {
    timeout: 300_000, installed: installation.installed, evidence, stage: 'uninstall',
  });
  await assert.rejects(access(installation.executable), { code: 'ENOENT' }, 'NSIS left the installed application executable behind');
}

async function terminateTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true, timeout: 15_000,
    }).catch(() => {});
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await delay(1_000);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}

async function launchApplication(executable, temporary, evidence) {
  const environment = {
    ...process.env,
    PI_RESEARCH_USER_DATA_DIR: path.join(temporary, 'User data with spaces'),
    PI_RESEARCH_SMOKE_DIR: evidence,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--smoke-test'], {
    cwd: temporary,
    env: environment,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = createWriteStream(path.join(evidence, 'stdout.log'));
  const stderr = createWriteStream(path.join(evidence, 'stderr.log'));
  let errorTail = '';
  const onStdout = (chunk) => stdout.write(chunk);
  const onStderr = (chunk) => {
    stderr.write(chunk);
    errorTail = (errorTail + chunk.toString()).slice(-16_000);
  };
  child.stdout.on('data', onStdout);
  child.stderr.on('data', onStderr);
  const exit = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let timer;
  try {
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), launchTimeoutMs);
    });
    const result = await Promise.race([exit, timeout]);
    if (result.timedOut) {
      await terminateTree(child);
      await Promise.race([exit, delay(10_000)]);
      throw new Error(`The installed application did not finish its smoke test within ${launchTimeoutMs / 1000}s\n${errorTail}`);
    }
    if (result.error) throw result.error;
    if (result.code !== 0) {
      await terminateTree(child);
      throw new Error(`The installed application exited with code ${result.code}, signal ${result.signal}\n${errorTail}`);
    }
  } finally {
    clearTimeout(timer);
    child.stdout.off('data', onStdout);
    child.stderr.off('data', onStderr);
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
  }
}

async function assertServerStopped(baseUrl) {
  const url = new URL(baseUrl);
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: url.hostname, port: Number(url.port) });
    socket.setTimeout(3_000);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error('The local dashboard server is still listening after the desktop application exited'));
    });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Could not verify that the desktop server stopped'));
    });
  });
}

async function writeArtifactChecksums(dist) {
  const files = (await readdir(dist)).filter((name) =>
    name.startsWith('Pi-Research-Harness-') && /\.(dmg|zip|exe)$/.test(name)).sort();
  const artifacts = [];
  for (const name of files) {
    const filename = path.join(dist, name);
    artifacts.push({ name, bytes: (await stat(filename)).size, sha256: await hashFile(filename) });
  }
  assert.ok(artifacts.length > 0, 'No distributable artifacts were found');
  await writeFile(path.join(dist, 'SHA256SUMS.txt'), artifacts.map(({ name, sha256 }) => `${sha256}  ${name}\n`).join(''));
  return artifacts;
}

export async function smokeInstalled() {
  assert.ok(['darwin', 'win32'].includes(process.platform), 'Run installer smoke on a native macOS or Windows runner');
  const dist = path.join(desktopDirectory, 'dist');
  const evidence = path.join(dist, 'smoke-results');
  await rm(evidence, { recursive: true, force: true });
  await mkdir(evidence, { recursive: true });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'pi-research-desktop-smoke-'));
  const started = Date.now();
  let installation;
  let primaryError;
  try {
    const installer = await findInstaller(dist);
    const installerSha256 = await hashFile(installer);
    console.log(`Installing and smoke testing ${path.basename(installer)}`);
    installation = await installApplication(installer, temporary, evidence);
    await launchApplication(installation.executable, temporary, evidence);
    const report = validateSmokeReport(JSON.parse(await readFile(path.join(evidence, 'desktop-smoke.json'), 'utf8')));
    await assertServerStopped(report.baseUrl);
    await uninstallApplication(installation, temporary, evidence);
    const installationKind = installation.kind;
    installation = undefined;

    const artifacts = await writeArtifactChecksums(dist);
    assert.equal(artifacts.find(({ name }) => name === path.basename(installer))?.sha256, installerSha256,
      'The installer changed while the smoke test was running');
    await writeFile(path.join(evidence, 'installer-smoke.json'), `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      platform: process.platform,
      arch: process.arch,
      installation: installationKind,
      installer: path.basename(installer),
      installerSha256,
      application: report,
      serverStoppedAfterExit: true,
      artifacts,
      durationMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    }, null, 2)}\n`);
    console.log(`PASS: native installer, packaged dashboard, bundled Node ${report.nodeVersion}, and server shutdown`);
  } catch (error) {
    primaryError = error;
    await writeFile(path.join(evidence, 'installer-smoke-failure.json'), `${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      platform: process.platform,
      arch: process.arch,
      message: error.stack ?? error.message,
      durationMs: Date.now() - started,
    }, null, 2)}\n`);
    throw error;
  } finally {
    if (installation) {
      await uninstallApplication(installation, temporary, evidence).catch((error) => {
        if (!primaryError) throw error;
        console.error(`Smoke cleanup also failed: ${error.message}`);
      });
    }
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 1_000 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  smokeInstalled().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
