import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pinnedPackages, installPackages} from '../scripts/install-packages.mjs';

const configured = {packages: ['npm:example@1.2.3', {source: 'npm:@scope/tool@2.0.0', skills: []}, '/local/integration']};

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pinned-install-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(configured));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

function createManifests(dir) {
  for (const {name, version} of pinnedPackages(configured)) {
    const root = path.join(dir, 'npm/node_modules', name);
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({name, version}));
  }
}

test('only exact npm versions are admitted; local package and filters are retained', () => {
  assert.deepEqual(pinnedPackages(configured).map(p => p.spec), ['example@1.2.3', '@scope/tool@2.0.0']);
  assert.throws(() => pinnedPackages({packages: ['npm:example@latest']}), /exact npm version/);
  assert.throws(() => pinnedPackages({packages: ['npm:example@1.2.3', 'npm:example@2.0.0']}), /Duplicate/);
});

test('fresh directory explicitly installs pins and verifies their manifests', t => {
  const dir = fixture(t);
  const before = fs.readFileSync(path.join(dir, 'settings.json'));
  let calls = 0;
  const result = installPackages(dir, {run(command, args, options) {
    calls++;
    assert.equal(command, 'npm');
    assert.ok(args.includes('example@1.2.3'));
    assert.ok(args.includes('@scope/tool@2.0.0'));
    assert.ok(args.includes('--legacy-peer-deps'));
    assert.equal(args[args.indexOf('--prefix') + 1], path.join(dir, 'npm'));
    assert.equal(options.shell, false);
    createManifests(dir);
    return {status: 0, signal: null};
  }});
  assert.equal(calls, 1);
  assert.deepEqual(result, {verifiedPackages: 2, installedNow: true});
  assert.ok(fs.readFileSync(path.join(dir, 'settings.json')).equals(before));
  assert.deepEqual(installPackages(dir, {checkOnly: true}), {verifiedPackages: 2, installedNow: false});
});

test('an exit-zero installer without installed packages is not accepted', t => {
  const dir = fixture(t);
  assert.throws(() => installPackages(dir, {run: () => ({status: 0, signal: null})}), /Installation incomplete/);
});

test('locked install preserves exact config and invokes npm ci, not an unlocked resolution', t => {
  const dir = fixture(t);
  const lockDir = path.join(dir, 'lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'package.json'), JSON.stringify({dependencies: {example: '1.2.3', '@scope/tool': '2.0.0'}}));
  fs.writeFileSync(path.join(lockDir, 'package-lock.json'), '{}');
  const result = installPackages(dir, {lockDir, run(command, args) {
    assert.equal(command, 'npm');
    assert.equal(args[0], 'ci');
    createManifests(dir);
    return {status: 0};
  }});
  assert.equal(result.verifiedPackages, 2);
});

test('locked repair refuses nonempty unknown installation and config mismatches', t => {
  const dir = fixture(t);
  const lockDir = path.join(dir, 'lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'package.json'), JSON.stringify({dependencies: {example: '9.0.0'}}));
  assert.throws(() => installPackages(dir, {lockDir}), /do not match/);
  fs.writeFileSync(path.join(lockDir, 'package.json'), JSON.stringify({dependencies: {example: '1.2.3', '@scope/tool': '2.0.0'}}));
  fs.mkdirSync(path.join(dir, 'npm/node_modules/unknown'), {recursive: true});
  assert.throws(() => installPackages(dir, {lockDir}), /fresh empty/);
});

test('check-only does not install absent packages', t => {
  const dir = fixture(t);
  assert.throws(() => installPackages(dir, {checkOnly: true, run() {throw new Error('must not run');}}), /Missing or mismatched/);
  assert.equal(fs.existsSync(path.join(dir, 'npm')), false);
});
