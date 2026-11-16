import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { parsePreviewOptions } from '../scripts/ui-preview/options.mjs';

const directory = '/isolated/source/scripts/ui-preview';
const base = ['run', '--runtime', '/isolated/dashboard', '--output', '/isolated/qa'];
const parse = (args, env = {}) => parsePreviewOptions(args, { env, scriptDirectory: directory });

test('default one-command preview selects the real collaboration fixture and checker', () => {
  const result = parse(base);
  assert.equal(result.collaborationFixture, true);
  assert.equal(result.browserScript, path.join(directory, 'collaboration-browser-qa.mjs'));
  assert.equal(result.apiOnly, false);
  assert.equal(result.runtime, '/isolated/dashboard');
  assert.equal(result.output, '/isolated/qa');
});

test('explicit collaboration mode remains compatible; legacy requires explicit opt-in', () => {
  assert.deepEqual(parse([...base, '--collaboration-fixture']), parse(base));
  const legacy = parse([...base, '--legacy-workspace-fixture']);
  assert.equal(legacy.collaborationFixture, false);
  assert.equal(legacy.browserScript, path.join(directory, 'browser-qa.mjs'));
  assert.throws(() => parse([...base, '--collaboration-fixture', '--legacy-workspace-fixture']), /one fixture mode/);
});

test('API-only and custom browser helpers preserve the selected fixture', () => {
  const manual = parse([...base, '--browser-script', '/isolated/manual.mjs', '--api-only']);
  assert.equal(manual.collaborationFixture, true);
  assert.equal(manual.apiOnly, true);
  assert.equal(manual.browserScript, '/isolated/manual.mjs');
  assert.equal(parse([...base, '/isolated/other.mjs']).browserScript, '/isolated/other.mjs');
});

test('environment paths, help and invalid CLI fields do not start side effects', () => {
  assert.equal(parse(['--help']), null);
  assert.equal(parse(['-h']), null);
  const env = { PI_UI_PREVIEW_RUNTIME: '/isolated/env-runtime', PI_UI_QA_OUTPUT: '/isolated/env-qa' };
  assert.equal(parse(['run'], env).runtime, env.PI_UI_PREVIEW_RUNTIME);
  assert.equal(parse(['run'], env).output, env.PI_UI_QA_OUTPUT);
  assert.throws(() => parse(['run']), /Specify --runtime/);
  assert.throws(() => parse([...base, '--runtime']), /Missing value/);
  assert.throws(() => parse([...base, '--expose-publicly']), /Unknown argument/);
});
