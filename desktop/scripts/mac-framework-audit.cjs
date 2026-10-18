const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const frameworkRelative = 'Contents/Frameworks/Electron Framework.framework';

// Read-only bundle diagnostics. Reports survive failed smoke cleanup and expose
// the exact stage at which a framework link or its binary stops being portable.
function auditMacFramework({ appPath, stage, directory, executableName = 'Pi Research Harness', launchProbe = false }) {
  if (!/^[a-z0-9-]+$/.test(stage)) throw new Error('Invalid macOS framework audit stage');
  const application = path.resolve(appPath);
  const report = {
    schemaVersion: 1, stage, platform: process.platform, arch: process.arch,
    application, completedAt: new Date().toISOString(), paths: [], errors: [],
  };
  let applicationRealPath;
  try { applicationRealPath = fs.realpathSync(application); }
  catch (error) { report.errors.push(`Application cannot be resolved: ${error.code || error.message}`); }
  report.applicationRealPath = applicationRealPath || null;

  function inspect(relative) {
    const filename = path.join(application, relative);
    const record = { relative, filename };
    report.paths.push(record);
    try {
      const stat = fs.lstatSync(filename);
      record.type = stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other';
      record.mode = (stat.mode & 0o7777).toString(8);
      record.bytes = stat.size;
      if (stat.isSymbolicLink()) {
        record.linkTarget = fs.readlinkSync(filename);
        record.absoluteLink = path.isAbsolute(record.linkTarget);
        record.linkResolvedFromParent = path.resolve(path.dirname(filename), record.linkTarget);
      }
    } catch (error) {
      record.lstatError = error.code || error.message;
      report.errors.push(`${relative}: lstat ${record.lstatError}`);
      return record;
    }
    try {
      record.realpath = fs.realpathSync(filename);
      record.insideApplication = Boolean(applicationRealPath &&
        (record.realpath === applicationRealPath || record.realpath.startsWith(`${applicationRealPath}${path.sep}`)));
      if (!record.insideApplication) report.errors.push(`${relative}: resolves outside the installed application`);
      const resolved = fs.statSync(filename);
      record.resolvedType = resolved.isDirectory() ? 'directory' : resolved.isFile() ? 'file' : 'other';
      record.resolvedBytes = resolved.size;
    } catch (error) {
      record.realpathError = error.code || error.message;
      report.errors.push(`${relative}: realpath ${record.realpathError}`);
    }
    return record;
  }

  const executable = inspect(path.join('Contents/MacOS', executableName));
  inspect(`${frameworkRelative}/Versions/Current`);
  const framework = inspect(`${frameworkRelative}/Electron Framework`);
  inspect(`${frameworkRelative}/Versions/Current/Electron Framework`);
  if (framework.resolvedType && framework.resolvedType !== 'file') report.errors.push('Electron Framework is not a regular binary');
  if (executable.resolvedType && executable.resolvedType !== 'file') report.errors.push('Electron application executable is not a regular file');

  if (launchProbe && report.errors.length === 0) {
    const result = spawnSync(executable.filename, ['--version'], {
      cwd: path.dirname(application),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    report.electronLoadProbe = {
      arguments: ['--version'], electronRunAsNode: true,
      status: result.status, signal: result.signal,
      stdout: (result.stdout || '').trim().slice(-4096),
      stderr: (result.stderr || '').trim().slice(-16384),
      ...(result.error ? { error: result.error.message } : {}),
    };
    if (result.error || result.status !== 0) report.errors.push('Electron could not load its framework in RunAsNode mode');
  } else if (launchProbe) report.electronLoadProbe = { skipped: true, reason: 'Framework validation already failed' };

  report.ok = report.errors.length === 0;
  fs.mkdirSync(directory, { recursive: true });
  const evidence = path.join(directory, `mac-framework-${stage}.json`);
  fs.writeFileSync(evidence, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[mac-framework] ${stage}: ${report.ok ? 'OK' : 'FAILED'} ${JSON.stringify({ application, frameworkBytes: framework.resolvedBytes, evidence })}`);
  if (!report.ok) {
    console.error(JSON.stringify(report, null, 2));
    throw new Error(`macOS framework audit failed at ${stage}: ${report.errors.join('; ')}`);
  }
  return report;
}

// Optional electron-builder afterSign hook: complements afterPack so a mounted
// DMG failure can be separated from a signing-stage failure without mutations.
module.exports = function afterSignFrameworkAudit(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const resources = context.packager.getResourcesDir(context.appOutDir);
  return auditMacFramework({
    appPath: path.resolve(resources, '../..'), stage: 'after-sign', launchProbe: true,
    directory: path.join(path.dirname(context.appOutDir), 'native-audit'),
  });
};
module.exports.auditMacFramework = auditMacFramework;
