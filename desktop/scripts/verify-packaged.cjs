const verifyResources = require('./verify-resources.cjs');

// Validate the actual copied application, including PTY/SQLite, before creating
// its DMG/NSIS archive. Source-directory validation cannot catch copy filters.
module.exports = (context) => verifyResources({
  ...context,
  researchResourcesDirectory: context.packager.getResourcesDir(context.appOutDir),
});
