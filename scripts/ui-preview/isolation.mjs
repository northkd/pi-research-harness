/** Run the upstream isolation tripwire before native CLI modules touch state. */
import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const expected = process.env.PI_UI_PREVIEW_HOME;
const temporaryRoot = realpathSync(os.tmpdir());
if (!expected
  || !path.basename(expected).startsWith('pi-ui-preview-')
  || path.dirname(expected) !== temporaryRoot
  || realpathSync(expected) !== expected
  || process.env.HOME !== expected
  || process.env.USERPROFILE !== expected
  || os.homedir() === os.userInfo().homedir) {
  throw new Error('Refusing UI validation outside its newly created, isolated temporary home.');
}
const runtime = process.env.PI_UI_PREVIEW_RUNTIME;
if (!runtime || !path.isAbsolute(runtime) || realpathSync(runtime) !== runtime) {
  throw new Error('Missing canonical validation runtime.');
}
// Keep this original guard intact. Its checks and directory bootstrap are
// shared with Dashboard's standard test runner, not reimplemented here.
const setup = await import(pathToFileURL(path.join(runtime, 'packages/shared/src/test-support/setup-home.ts')).href);
setup.default();
