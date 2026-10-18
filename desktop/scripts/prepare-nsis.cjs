const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const desktop = path.resolve(__dirname, '..');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const templatePins = {
  'installer.nsi': '8811964416d122612c3e7601728af5d3f998d677918df829a4e8b4c739c8b9f8',
  'installSection.nsh': '74c4dbb4163cdd90ca4850b75d304e916235c882d6af7b5cdad63bffbc977072',
  'include/extractAppPackage.nsh': 'e4174388a0f7a1df0b85a0742aa1ea7a4b2b18f9f29dccd6ef10a66212f68148',
};
const includeLine = '!include "${PROJECT_DIR}\\nsis\\direct-extract.nsh"\n';
const binarySha256 = 'b0cfdeaf429f5cc53f85123dd8f5a5feb92c19d31aa34df257edf9a26be05f95';
const sourceSha256 = 'd1074d56f415aab99d99e597a7b66dc455dba6349ae8a4c89df76475b6a1284c';
const sourceUrls = [
  'https://netix.dl.sourceforge.net/project/sevenzip/7-Zip/21.07/7z2107-src.7z',
  'https://downloads.sourceforge.net/project/sevenzip/7-Zip/21.07/7z2107-src.7z',
];

async function prepareSourceArchive(destination) {
  const existing = await fs.readFile(destination).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing && sha256(existing) === sourceSha256) return;
  const failures = [];
  for (const url of sourceUrls) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, 1_219_373, 'Unexpected corresponding 7-Zip source size');
      assert.equal(sha256(bytes), sourceSha256, 'Corresponding 7-Zip source SHA-256 differs');
      await fs.writeFile(destination, bytes);
      return;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(`Cannot obtain the verified 7-Zip 21.07 corresponding source: ${failures.join('; ')}`);
}

async function patchTemplate() {
  const builder = JSON.parse(await fs.readFile(path.join(desktop, 'node_modules/app-builder-lib/package.json'), 'utf8'));
  assert.equal(builder.version, '26.8.1', 'Review the NSIS integration before changing electron-builder');
  const templates = path.join(desktop, 'node_modules/app-builder-lib/templates/nsis');
  let section;
  for (const [name, expected] of Object.entries(templatePins)) {
    const text = await fs.readFile(path.join(templates, name), 'utf8');
    // Only our one exact include may already have been applied in this checkout.
    const original = name === 'installSection.nsh' ? text.replace(includeLine, '') : text;
    assert.equal(sha256(original), expected, `Unexpected pinned NSIS template: ${name}`);
    if (name === 'installSection.nsh') section = original;
  }
  assert.ok(section.startsWith('!include installer.nsh\n'), 'Extraction macro insertion point changed');
  await fs.writeFile(path.join(templates, 'installSection.nsh'), section.replace(
    '!include installer.nsh\n', `!include installer.nsh\n${includeLine}`,
  ));
}

module.exports = async function prepareNsis(context) {
  if (context.electronPlatformName !== 'win32') return;
  assert.equal(process.platform, 'win32', 'Windows installers must be built on Windows');
  assert.equal(process.arch, 'x64', 'This installer supports Windows x64');
  const binary = await fs.readFile(path.join(desktop, 'node_modules/7zip-bin/win/x64/7za.exe'));
  assert.equal(binary.length, 1_231_360, 'Unexpected pinned 7-Zip executable size');
  assert.equal(sha256(binary), binarySha256, 'Pinned 7-Zip executable SHA-256 differs');

  const licenses = path.join(desktop, 'resources/licenses/Windows-installer-7zip');
  await fs.mkdir(licenses, { recursive: true });
  const licenseSource = path.join(desktop, 'nsis/licenses');
  const names = ['7zip-extra-21.07-LICENSE.txt', 'LGPL-2.1.txt', '7zip-bin-MIT.txt', 'SOURCES.md'];
  for (const name of names) await fs.copyFile(path.join(licenseSource, name), path.join(licenses, name));
  await prepareSourceArchive(path.join(licenses, '7z2107-src.7z'));
  await patchTemplate();

  const manifestFile = path.join(desktop, 'resources/research-bundle.json');
  const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  manifest.windowsInstaller = {
    format: 'NSIS', extraction: 'direct-to-install-directory',
    extractor: '7-Zip 21.07 x64', extractorSha256: binarySha256,
    correspondingSource: 'licenses/Windows-installer-7zip/7z2107-src.7z',
    correspondingSourceSha256: sourceSha256,
  };
  await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('Prepared verified 7-Zip direct extraction and corresponding source for Windows NSIS.');
};

module.exports.patchTemplate = patchTemplate;
