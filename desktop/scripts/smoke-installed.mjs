import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { NODE_VERSION } from './download-node.mjs';

const execFileAsync = promisify(execFile);
const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));
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

function runNsis(executable, args, timeout) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      // Quote argv[0] separately: verbatim arguments are needed for NSIS /D,
      // but the installer itself may also live under a path containing spaces.
      argv0: `"${executable}"`,
      windowsVerbatimArguments: true,
      windowsHide: true,
      shell: false,
      stdio: 'inherit',
      timeout,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`NSIS exited with code ${code}, signal ${signal}`));
    });
  });
}

async function installApplication(installer, temporary) {
  if (process.platform === 'darwin') {
    const mountpoint = path.join(temporary, 'mounted');
    await mkdir(mountpoint);
    await execFileAsync('/usr/bin/hdiutil', [
      'attach', installer, '-readonly', '-nobrowse', '-mountpoint', mountpoint,
    ], { timeout: 90_000 });
    try {
      const apps = (await readdir(mountpoint)).filter((name) => name.endsWith('.app'));
      assert.equal(apps.length, 1, 'The DMG must contain exactly one application bundle');
      const installed = path.join(temporary, 'Applications with spaces', apps[0]);
      await mkdir(path.dirname(installed));
      // ditto preserves the executable modes and framework links in the .app.
      await execFileAsync('/usr/bin/ditto', [path.join(mountpoint, apps[0]), installed], { timeout: 180_000 });
      const { stdout } = await execFileAsync('/usr/libexec/PlistBuddy', [
        '-c', 'Print :CFBundleExecutable', path.join(installed, 'Contents', 'Info.plist'),
      ], { timeout: 30_000 });
      const binaryName = stdout.trim();
      assert.equal(binaryName, productName, 'The DMG contains an unexpected application');
      const executable = path.join(installed, 'Contents', 'MacOS', binaryName);
      await access(executable);
      return { executable, kind: 'DMG drag-copy installation' };
    } finally {
      await execFileAsync('/usr/bin/hdiutil', ['detach', mountpoint], { timeout: 60_000 });
    }
  }

  const installed = path.join(temporary, 'Installed application with spaces');
  // NSIS requires /D to be the final, unquoted command-line argument; the path
  // may contain spaces. Direct spawn avoids a shell and its escaping rules.
  // NSIS contract: https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
  await runNsis(installer, ['/S', '/currentuser', `/D=${installed}`], 240_000);
  const executable = path.join(installed, `${productName}.exe`);
  await access(executable);
  return { executable, installed, kind: 'NSIS silent per-user installation' };
}

async function uninstallApplication(installation, temporary) {
  if (!installation?.installed) return;
  const original = path.join(installation.installed, `Uninstall ${productName}.exe`);
  const uninstaller = path.join(temporary, 'uninstall-smoke.exe');
  await copyFile(original, uninstaller);
  // Running the copy with _?= avoids NSIS returning before its child uninstaller
  // finishes, and lets it remove the original installer directory in one pass.
  await runNsis(uninstaller, ['/S', '/currentuser', `_?=${installation.installed}`], 120_000);
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
    installation = await installApplication(installer, temporary);
    await launchApplication(installation.executable, temporary, evidence);
    const report = validateSmokeReport(JSON.parse(await readFile(path.join(evidence, 'desktop-smoke.json'), 'utf8')));
    await assertServerStopped(report.baseUrl);
    await uninstallApplication(installation, temporary);
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
      await uninstallApplication(installation, temporary).catch((error) => {
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
