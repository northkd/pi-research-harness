const verifyResources = require('./verify-resources.cjs');
const path = require('node:path');
const { auditMacFramework } = require('./mac-framework-audit.cjs');

// Validate the actual copied application, including PTY/SQLite, before creating
// its DMG/NSIS archive. Source-directory validation cannot catch copy filters.
module.exports = async (context) => {
  const resources = context.packager.getResourcesDir(context.appOutDir);
  if (context.electronPlatformName === 'darwin') {
    await require('./prepare-dmg-builder.cjs')(context);
    auditMacFramework({
      appPath: path.resolve(resources, '../..'), stage: 'after-pack',
      directory: path.join(path.dirname(context.appOutDir), 'native-audit'),
    });
  }
  await verifyResources({ ...context, researchResourcesDirectory: resources });
};
