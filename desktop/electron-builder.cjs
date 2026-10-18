module.exports = {
  appId: 'io.github.northkd.pi-research-harness',
  productName: 'Pi Research Harness',
  executableName: 'Pi Research Harness',
  asar: true,
  npmRebuild: false, // Server native modules run under the bundled Node, not Electron.
  directories: { output: 'dist', buildResources: 'resources/icons' },
  files: ['src/**', 'runtime/**', 'assets/**', 'package.json'],
  extraResources: [
    { from: 'resources/server', to: 'server' },
    { from: 'resources/harness', to: 'harness' },
    { from: 'resources/node', to: 'node' },
    { from: 'resources/research-bundle.json', to: 'research-bundle.json' },
    { from: 'resources/licenses', to: 'licenses' },
    { from: 'resources/icons/icon.png', to: 'icon.png' },
    { from: 'resources/git', to: 'git', filter: ['**/*'] }
  ],
  beforePack: './scripts/verify-resources.cjs',
  publish: null,
  mac: {
    icon: 'resources/icons/icon.icns',
    target: ['dmg', 'zip'],
    category: 'public.app-category.developer-tools',
    minimumSystemVersion: '13.5',
    identity: '-',
    notarize: false,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    artifactName: 'Pi-Research-Harness-${version}-macOS-${arch}.${ext}'
  },
  dmg: { title: 'Pi Research Harness ${version}', sign: false },
  win: {
    icon: 'resources/icons/icon.ico',
    target: ['nsis'],
    artifactName: 'Pi-Research-Harness-${version}-windows-${arch}-Setup.${ext}'
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Pi Research Harness',
    uninstallDisplayName: 'Pi Research Harness',
    runAfterFinish: false,
    deleteAppDataOnUninstall: false
  },
  linux: { target: ['dir'], category: 'Development' }
};
