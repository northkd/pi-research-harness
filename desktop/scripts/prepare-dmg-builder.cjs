const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

// Vendor 1.2.3 corrected the HFS+ size calculation and made failed ditto copies
// fatal. 26.8.1 otherwise uses vendor 1.2.0, which can silently truncate big apps.
// Pins match the official electron-builder source at commit
// 2cbbb9392031e87ff91d48041bc57dbce45d1875/packages/dmg-builder/src/dmgUtil.ts.
const releaseName = 'dmg-builder@1.2.5';
const checksums = {
  'dmgbuild-bundle-arm64-75c8a6c.tar.gz':
    '793404d0c96687e27d5ee40a668d498c92e36a64d6c2906df511031adb33cbeb',
  'dmgbuild-bundle-x86_64-75c8a6c.tar.gz':
    '1664972f9cc2d6e8fce3b63e42cd30078aff602669c5856939c4519921200433',
};

module.exports = async function prepareDmgBuilder(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.platform !== 'darwin') {
    throw new Error('macOS installers must be built on a native macOS runner.');
  }
  const arch = { arm64: 'arm64', x64: 'x86_64' }[process.arch];
  if (!arch) throw new Error(`Unsupported macOS build architecture: ${process.arch}`);

  const { downloadArtifact } = require('app-builder-lib/out/binDownload');
  const directory = await downloadArtifact({
    releaseName,
    filenameWithExt: `dmgbuild-bundle-${arch}-75c8a6c.tar.gz`,
    checksums,
    githubOrgRepo: 'electron-userland/electron-builder-binaries',
  });
  const executable = path.resolve(directory, 'dmgbuild');
  if (!(await fs.stat(executable)).isFile()) {
    throw new Error(`The pinned DMG builder is not a regular file: ${executable}`);
  }
  await fs.access(executable, constants.X_OK);
  process.env.CUSTOM_DMGBUILD_PATH = executable;
  console.log(`Using verified ${releaseName} (${arch}) for macOS disk images.`);
  return executable;
};
