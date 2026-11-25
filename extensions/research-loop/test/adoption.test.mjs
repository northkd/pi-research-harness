import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { charterHash, confirmAdoption, configureResearch } from '../src/adoption.mjs';
import { loadState, saveState, sha256 } from '../src/ledger.mjs';

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adoption-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const proposal = { summary: 'Imported research remains unverified', objective: 'Test a falsifiable mechanism', successCriteria: ['Independent evidence'], unresolved: [], items: [{ text: 'An existing observation', sourceIds: ['src-one'], unverified: true }] };
  const input = { id: 'adopt-0123456789abcdef01234567', proposal, proposalHash: sha256(proposal), sources: [{ id: 'src-one', unverified: true }], expectedCharterHash: charterHash(cwd), objective: proposal.objective, successCriteria: proposal.successCriteria, autoRun: false };
  return { cwd, input };
}

test('new adoption configures without running, attempts, claims or publication authorization', (t) => {
  const { cwd, input } = setup(t);
  const result = confirmAdoption(cwd, input);
  assert.equal(result.configured, true);
  const state = loadState(cwd);
  assert.equal(state.charter.objective, input.objective);
  assert.equal(state.attempts, 0);
  assert.deepEqual(state.claims, []);
  assert.equal(fs.existsSync(path.join(cwd, '.pi/research-loop/ledger.jsonl')), false);
  assert.equal(fs.existsSync(path.join(cwd, '.pi/research-loop/auto-run.json')), false);
  assert.equal(confirmAdoption(cwd, input).configured, false);
});

test('existing charter and ledger bytes remain unchanged; source links are not experiments', (t) => {
  const { cwd, input } = setup(t);
  configureResearch(cwd, { objective: 'Preserve this objective', successCriteria: ['Preserve this criterion'] });
  input.expectedCharterHash = charterHash(cwd);
  const root = path.join(cwd, '.pi/research-loop');
  fs.writeFileSync(path.join(root, 'ledger.jsonl'), '{"seq":1,"signal":"blocked"}\n');
  const before = fs.readFileSync(path.join(root, 'state.json'));
  const ledger = fs.readFileSync(path.join(root, 'ledger.jsonl'));
  assert.equal(confirmAdoption(cwd, input).configured, false);
  assert.deepEqual(fs.readFileSync(path.join(root, 'state.json')), before);
  assert.deepEqual(fs.readFileSync(path.join(root, 'ledger.jsonl')), ledger);
});

test('charter CAS, legal source ids, proposal hash and autoRun false are mandatory', (t) => {
  const { cwd, input } = setup(t);
  assert.throws(() => confirmAdoption(cwd, { ...input, autoRun: true }), /autoRun/);
  assert.throws(() => confirmAdoption(cwd, { ...input, proposalHash: 'forged' }), /proposal/);
  const forged = { ...input.proposal, items: [{ text: 'unsupported', sourceIds: ['unknown'], unverified: true }] };
  assert.throws(() => confirmAdoption(cwd, { ...input, proposal: forged, proposalHash: sha256(forged) }), /source/);
  configureResearch(cwd, { objective: 'A concurrently configured charter', successCriteria: ['Do not overwrite'] });
  assert.throws(() => confirmAdoption(cwd, input), /charter.*changed/i);
  assert.equal(loadState(cwd).charter.objective, 'A concurrently configured charter');
});

test('exclusive initial state publication never overwrites a concurrently created state', (t) => {
  const { cwd } = setup(t);
  configureResearch(cwd, { objective: 'Created by the other writer', successCriteria: ['Preserve existing bytes'] });
  const file = path.join(cwd, '.pi/research-loop/state.json');
  const before = fs.readFileSync(file);
  assert.throws(() => saveState(cwd, { charter: { objective: 'Must not overwrite' } }, { exclusive: true }), { code: 'EEXIST' });
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
});

test('a live charter writer lock blocks a competing configuration', (t) => {
  const { cwd } = setup(t);
  configureResearch(cwd, { objective: 'Keep this target', successCriteria: ['No duplicate writer'] });
  fs.writeFileSync(path.join(cwd, '.pi/research-loop/.charter-configure.lock'), JSON.stringify({ schema: 'pi-research-charter-lock.v1', pid: process.pid }));
  assert.throws(() => configureResearch(cwd, { objective: 'Competing target', successCriteria: ['Not allowed'] }), /busy/);
  assert.equal(loadState(cwd).charter.objective, 'Keep this target');
});

test('symlinked research directories fail closed', (t) => {
  const { cwd, input } = setup(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'research-adoption-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, '.pi'));
  fs.symlinkSync(outside, path.join(cwd, '.pi/research-loop'));
  assert.throws(() => confirmAdoption(cwd, input), /unsafe|symlink/i);
  assert.deepEqual(fs.readdirSync(outside), []);
});
