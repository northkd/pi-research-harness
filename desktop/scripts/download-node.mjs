import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const desktopDirectory = fileURLToPath(new URL('..', import.meta.url));

// Build and embedded runtimes use the same pinned Node major and native ABI.
// Distribution index: https://nodejs.org/download/release/v24.15.0/
export const NODE_VERSION = '24.15.0';

export function nodeAsset(platform = process.platform, arch = process.arch) {
  const supported = {
    darwin: ['arm64', 'x64'],
    win32: ['x64'],
    // Linux is useful for local development; release CI only ships macOS/Windows.
    linux: ['arm64', 'x64'],
  };
  if (!supported[platform]?.includes(arch)) {
    throw new Error(`Unsupported bundled Node platform: ${platform}/${arch}`);
  }
  const distributionPlatform = platform === 'win32' ? 'win' : platform;
  const directory = `node-v${NODE_VERSION}-${distributionPlatform}-${arch}`;
  const format = platform === 'win32' ? 'zip' : 'tar.gz';
  const filename = `${directory}.${format}`;
  return {
    version: NODE_VERSION,
    platform,
    arch,
    directory,
    format,
    filename,
    executable: platform === 'win32' ? 'node.exe' : 'bin/node',
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`,
    checksumsUrl: `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`,
  };
}

export function checksumFor(checksums, filename) {
  const matches = checksums.split(/\r?\n/)
    .map((line) => /^([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line))
    .filter((match) => match && match[2] === filename);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one official SHA-256 record for ${filename}`);
  }
  return matches[0][1].toLowerCase();
}

async function officialResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!response.ok || !response.body) {
    throw new Error(`Node download failed: HTTP ${response.status} (${url})`);
  }
  if (new URL(response.url).origin !== 'https://nodejs.org') {
    throw new Error('Node download unexpectedly redirected outside nodejs.org');
  }
  return response;
}

async function sha256File(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function extractArchive(asset, archive, destination) {
  await mkdir(destination, { recursive: true });
  if (asset.format === 'zip') {
    // Paths travel as environment values, never as interpolated PowerShell code.
    await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:PI_NODE_ARCHIVE -DestinationPath $env:PI_NODE_EXTRACT_DIR -Force',
    ], {
      env: { ...process.env, PI_NODE_ARCHIVE: archive, PI_NODE_EXTRACT_DIR: destination },
      windowsHide: true,
      timeout: 180_000,
    });
  } else {
    // Preserve executable bits and npm/npx symlinks from the official archive.
    await execFileAsync('tar', ['-xzf', archive, '-C', destination], { timeout: 180_000 });
  }
}

export async function downloadNode() {
  const asset = nodeAsset();
  const resources = path.join(desktopDirectory, 'resources');
  const destination = path.join(resources, 'node');
  await mkdir(resources, { recursive: true });
  const staging = await mkdtemp(path.join(resources, '.node-download-'));
  try {
    console.log(`Downloading official ${asset.filename}`);
    const checksums = await (await officialResponse(asset.checksumsUrl)).text();
    const expectedSha256 = checksumFor(checksums, asset.filename);
    const archive = path.join(staging, asset.filename);
    const response = await officialResponse(asset.url);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(archive, { flags: 'wx' }));

    const actualSha256 = await sha256File(archive);
    if (actualSha256 !== expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${asset.filename}: expected ${expectedSha256}, received ${actualSha256}`);
    }
    console.log(`Verified SHA-256 ${actualSha256}`);

    const extracted = path.join(staging, 'extracted');
    await extractArchive(asset, archive, extracted);
    const runtime = path.join(extracted, asset.directory);
    const executable = path.join(runtime, asset.executable);
    const npmCli = path.join(runtime, process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : 'lib/node_modules/npm/bin/npm-cli.js');
    await access(executable);
    await access(npmCli);

    // Execute the downloaded runtime before replacing any previous good bundle.
    // A wrong-architecture archive must fail here, before electron-builder runs.
    const { stdout } = await execFileAsync(executable, [
      '-p', 'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})',
    ], { timeout: 30_000, windowsHide: true });
    const actual = JSON.parse(stdout.trim());
    if (actual.version !== `v${NODE_VERSION}` || actual.platform !== asset.platform || actual.arch !== asset.arch) {
      throw new Error(`Bundled Node identity does not match this build: ${stdout.trim()}`);
    }
    await writeFile(path.join(runtime, 'pi-research-runtime.json'), `${JSON.stringify({
      version: actual.version,
      platform: actual.platform,
      arch: actual.arch,
      archive: asset.filename,
      url: asset.url,
      sha256: actualSha256,
      checksumsUrl: asset.checksumsUrl,
    }, null, 2)}\n`);

    await rm(destination, { recursive: true, force: true });
    await rename(runtime, destination);
    console.log(`Bundled ${actual.version} (${actual.platform}/${actual.arch}), including npm, at ${destination}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  downloadNode().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
