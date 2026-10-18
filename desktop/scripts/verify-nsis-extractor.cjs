#!/usr/bin/env node
'use strict';

// A small native gate for the exact extraction macro, before preparing the app.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const expected7zaSha256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const nsisString = value => String(value).replace(/\$/g, '$$$$').replace(/"/g, '$\\"');

async function run(stage, executable, args, options, report) {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] NSIS extractor: ${stage}`);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let termination = null;
    let settled = false;
    let fallback;
    const child = spawn(executable, args, {
      ...options, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (code, signal, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallback);
      const result = { stage, pid: child.pid ?? null, code, signal, timedOut,
        durationMs: Date.now() - started, stdout, stderr, termination,
        error: error ? { code: error.code ?? null, message: error.message } : null };
      report.processes.push(result);
      if (error || timedOut || code !== 0) {
        reject(new Error(`${stage} failed: ${JSON.stringify(result)}`));
      } else {
        resolve(result);
      }
    };
    child.stdout.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-65536); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-65536); });
    child.once('error', error => finish(null, null, error));
    child.once('close', (code, signal) => finish(code, signal));
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true, encoding: 'utf8', timeout: 15000,
        });
        termination = { code: killed.status, signal: killed.signal,
          stdout: String(killed.stdout ?? '').slice(-2000),
          stderr: String(killed.stderr ?? '').slice(-2000) };
        if (killed.status !== 0) child.kill();
      }
      fallback = setTimeout(() => finish(null, null), 5000);
    }, 120000);
  });
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log(JSON.stringify({ ok: true, skipped: true, reason: 'Requires native Windows x64',
      platform: process.platform, arch: process.arch }));
    return;
  }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-research-extractor-smoke-'));
  const report = { ok: false, platform: process.platform, arch: process.arch,
    work, processes: [], files: [] };
  let passed = false;
  try {
    assert.equal(require('7zip-bin/package.json').version, '5.2.0');
    const sevenZip = path.join(desktop, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
    assert.equal(hash(await fs.readFile(sevenZip)), expected7zaSha256, 'Unexpected 7za.exe bytes');
    const { NsisTargetOptions, NSIS_PATH, NSIS_RESOURCES_PATH } =
      require('app-builder-lib/out/targets/nsis/nsisUtil');
    NsisTargetOptions.resolve({});
    const [nsis, resources] = await Promise.all([NSIS_PATH(), NSIS_RESOURCES_PATH()]);
    const compiler = path.join(nsis, 'Bin', 'makensis.exe');
    const source = path.join(work, 'archive input');
    const archive = path.join(work, 'fixture payload.7z');
    const installer = path.join(work, 'extractor smoke.exe');
    const uninstaller = path.join(work, 'remove extractor smoke.exe');
    const script = path.join(work, 'extractor.nsi');
    const runtimeTemp = path.join(work, 'process temp');
    const relativeFiles = ['server', 'harness'].map(tree => path.join('resources', tree,
      'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules',
      '@earendil-works', 'pi-ai', 'node_modules', 'openai', 'resources', 'admin',
      'organization', 'projects', 'service-accounts.mjs'));
    let installed = path.join(work, 'Installed application with spaces');
    while (path.join(installed, relativeFiles[0]).length <= 280) {
      installed = path.join(installed, 'long installation directory');
    }
    assert(installed.startsWith(work + path.sep));
    assert(installed.length < 240, 'The installation root itself should stay below MAX_PATH');
    report.installed = installed;
    await fs.mkdir(runtimeTemp, { recursive: true });
    const expected = [];
    for (const [index, relative] of relativeFiles.entries()) {
      const bytes = Buffer.from(`// Native long-path extractor fixture ${index}\r\nexport const value = "${index}";\r\n`, 'utf8');
      const filename = path.join(source, relative);
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, bytes);
      expected.push(bytes);
    }
    const env = { ...process.env, TEMP: runtimeTemp, TMP: runtimeTemp, NSISDIR: nsis };
    await run('create the fixture archive', sevenZip,
      ['a', '-t7z', '-mx=1', '-y', archive, ...relativeFiles], { cwd: source, env }, report);
    const lines = [
      'Unicode true',
      'RequestExecutionLevel user',
      'SilentInstall silent',
      'SilentUnInstall silent',
      'AutoCloseWindow true',
      'SetCompress off',
      'Name "Pi Research native extractor smoke"',
      `OutFile "${nsisString(installer)}"`,
      `InstallDir "${nsisString(installed)}"`,
      `!define PROJECT_DIR "${nsisString(desktop)}"`,
      '!include "LogicLib.nsh"',
      `!addplugindir /x86-unicode "${nsisString(path.join(resources, 'plugins', 'x86-unicode'))}"`,
      '!macro extractUsing7za FILE',
      '!macroend',
      `!include "${nsisString(path.join(desktop, 'nsis', 'direct-extract.nsh'))}"`,
      `!include "${nsisString(path.join(desktop, 'nsis', 'long-path-remove.nsh'))}"`,
      'Section "Install"',
      '  InitPluginsDir',
      '  SetOutPath "$PLUGINSDIR"',
      `  File /oname=fixture.7z "${nsisString(archive)}"`,
      '  !insertmacro extractUsing7za "$PLUGINSDIR\\fixture.7z"',
      `  WriteUninstaller "${nsisString(uninstaller)}"`,
      '  SetErrorLevel 0',
      'SectionEnd',
      'Section "Uninstall"',
      // Use the exact fixture directory; do not depend on NSIS self-copy paths.
      `  StrCpy $INSTDIR "${nsisString(installed)}"`,
      '  !insertmacro ResearchRemoveInstallDirectory',
      '  SetErrorLevel 0',
      'SectionEnd',
      '',
    ];
    await fs.writeFile(script, lines.join('\r\n'));
    await run('compile the exact extraction macro', compiler,
      ['-INPUTCHARSET', 'UTF8', '-V3', script], { cwd: work, env }, report);
    await run('run the silent extractor installer', installer, ['/S'], { cwd: work, env }, report);
    for (const [index, relative] of relativeFiles.entries()) {
      const filename = path.join(installed, relative);
      assert(filename.length > 260, `Fixture does not exercise a long path: ${filename}`);
      const actual = await fs.readFile(filename);
      assert.equal(actual.length, expected[index].length, `Installed size mismatch: ${relative}`);
      assert.equal(hash(actual), hash(expected[index]), `Installed SHA256 mismatch: ${relative}`);
      assert.deepEqual(actual, expected[index], `Installed bytes mismatch: ${relative}`);
      report.files.push({ relative, installedPathLength: filename.length,
        bytes: actual.length, sha256: hash(actual) });
    }
    // _?= is the final, deliberately unquoted NSIS argument. The generated
    // uninstaller is outside INSTDIR so the production macro can remove it all.
    await run('remove long paths using the generated NSIS uninstaller', uninstaller,
      ['/S', `_?=${installed}`], {
        cwd: work, env, argv0: `"${uninstaller}"`, windowsVerbatimArguments: true,
      }, report);
    await assert.rejects(fs.access(installed), { code: 'ENOENT' }, 'NSIS left the installation directory behind');
    report.installedDirectoryRemoved = true;
    report.ok = true;
    passed = true;
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    report.error = error.stack || String(error);
    const diagnostic = path.join(work, 'extractor-smoke-failure.json');
    await fs.writeFile(diagnostic, JSON.stringify(report, null, 2)).catch(() => {});
    console.error(JSON.stringify({ ...report, diagnostic }, null, 2));
    process.exitCode = 1;
  } finally {
    const reportFile = path.join(desktop, 'dist', 'native-audit', 'nsis-extractor.json');
    await fs.mkdir(path.dirname(reportFile), { recursive: true });
    await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    // Preserve failed fixture files and compiler output for diagnosis.
    if (passed) await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1; });
