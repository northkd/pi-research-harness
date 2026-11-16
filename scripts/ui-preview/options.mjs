import path from 'node:path';

export const PREVIEW_USAGE = 'Usage: node scripts/ui-preview/launcher.mjs run [--runtime DASHBOARD_CHECKOUT] [--output QA_OUTPUT] [--browser-script SCRIPT.mjs] [--collaboration-fixture | --legacy-workspace-fixture] [--api-only]';

/** Pure option parsing; importing this never boots a server or reads credentials. */
export function parsePreviewOptions(argv, { env = {}, scriptDirectory }) {
  const args = [...argv];
  if (args[0] === '--help' || args[0] === '-h') return null;
  if (args.shift() !== 'run') throw new Error(PREVIEW_USAGE);
  const value = { runtime: env.PI_UI_PREVIEW_RUNTIME, output: env.PI_UI_QA_OUTPUT,
    browserScript: null, collaborationFixture: true, apiOnly: false };
  let positionalScript = false, fixtureFlag = null;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === '--collaboration-fixture' || name === '--legacy-workspace-fixture') {
      if (fixtureFlag && fixtureFlag !== name) throw new Error('Choose only one fixture mode.');
      fixtureFlag = name;
      value.collaborationFixture = name === '--collaboration-fixture';
      continue;
    }
    if (name === '--api-only') { value.apiOnly = true; continue; }
    const property = { '--runtime': 'runtime', '--output': 'output', '--browser-script': 'browserScript' }[name];
    if (property) {
      const argument = args[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`Missing value for ${name}. ${PREVIEW_USAGE}`);
      value[property] = argument;
    } else if (!name.startsWith('-') && !positionalScript) {
      value.browserScript = name; positionalScript = true;
    } else throw new Error(`Unknown argument: ${name}. ${PREVIEW_USAGE}`);
  }
  if (!value.runtime || !value.output) throw new Error('Specify --runtime / --output or PI_UI_PREVIEW_RUNTIME / PI_UI_QA_OUTPUT.');
  value.browserScript ??= path.join(scriptDirectory, value.collaborationFixture ? 'collaboration-browser-qa.mjs' : 'browser-qa.mjs');
  return { ...value, runtime: path.resolve(value.runtime), output: path.resolve(value.output), browserScript: path.resolve(value.browserScript) };
}
