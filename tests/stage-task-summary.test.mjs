import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { digest } from '../extensions/research-loop/src/workbench-sync.mjs';
import {
  MAX_SUMMARY_BYTES,
  MAX_SUMMARY_CHARS,
  MAX_TASKS,
  STAGE_TASK_SUMMARY_RELATIVE_PATH,
  STAGE_TASK_SUMMARY_SCHEMA,
  recordStageTaskSummary,
} from '../extensions/research-loop/src/stage-task-summary.mjs';

const CLOCK = () => Date.parse('2026-11-04T12:00:00.000Z');

function write(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value), { mode });
}

function makeProject(root, charter = { objective: 'Synthetic task-summary charter', successCriteria: ['Synthetic criterion'], revision: 1, frozenAt: '2026-01-01T00:00:00.000Z' }) {
  const cwd = path.join(root, 'project');
  fs.mkdirSync(path.join(cwd, '.pi', 'research-loop'), { recursive: true, mode: 0o700 });
  const stateFile = path.join(cwd, '.pi', 'research-loop', 'state.json');
  write(stateFile, { schema: 'pi-research-loop.v1', stage: '1-idea', charter });
  const context = {
    sessionId: 'session-1',
    adoptionId: 'adopt-' + 'a'.repeat(24),
    charterHash: 'sha256:' + digest(charter),
    charterRevision: charter.revision,
    stage: '2-experiment',
  };
  return { cwd, root, stateFile, context, charter, summaryFile: path.join(cwd, STAGE_TASK_SUMMARY_RELATIVE_PATH) };
}

function readSummary(project) {
  return JSON.parse(fs.readFileSync(project.summaryFile, 'utf8'));
}

test('records one bounded first actionable task sentence in a private atomic file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-'));
  const project = makeProject(root);
  const result = recordStageTaskSummary(
    project.cwd,
    project.context,
    'Please implement the parameter sweep and then run the tests. Also update the documentation.',
    CLOCK,
  );

  assert.equal(result.recorded, true);
  assert.equal(result.tasks, 1);
  assert.equal(result.path, STAGE_TASK_SUMMARY_RELATIVE_PATH);
  assert.equal(fs.existsSync(project.summaryFile), true);
  assert.equal(fs.statSync(project.summaryFile).mode & 0o777, 0o600);

  const record = readSummary(project);
  assert.equal(record.schema, STAGE_TASK_SUMMARY_SCHEMA);
  assert.equal(record.charterHash, project.context.charterHash);
  assert.equal(record.charterRevision, 1);
  assert.equal(record.tasks.length, 1);
  assert.match(record.tasks[0].summary, /^Please implement the parameter sweep/);
  assert.doesNotMatch(record.tasks[0].summary, /Also update/);
  assert.ok(record.tasks[0].summary.length <= MAX_SUMMARY_CHARS);
  assert.equal(record.tasks[0].at, '2026-11-04T12:00:00.000Z');

  const serialized = fs.readFileSync(project.summaryFile, 'utf8');
  assert.ok(!serialized.includes(project.cwd));
  assert.ok(!serialized.includes(root));
  assert.ok(!serialized.includes('owner'));
  assert.doesNotMatch(serialized, /"\/|[A-Za-z]:\\/);
  assert.ok(Buffer.byteLength(serialized) <= MAX_SUMMARY_BYTES);
});

test('invalid context, stale charter and missing prompt write nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-context-'));
  const project = makeProject(root);
  const prompt = 'Please review the ablation results.';

  assert.equal(recordStageTaskSummary(project.cwd, { ...project.context, sessionId: 'bad id!' }, prompt, CLOCK).reason, 'invalid-context');
  assert.equal(recordStageTaskSummary(project.cwd, { ...project.context, charterHash: 'not-a-hash' }, prompt, CLOCK).reason, 'invalid-context');
  assert.equal(recordStageTaskSummary(project.cwd, { ...project.context, charterRevision: 0 }, prompt, CLOCK).reason, 'invalid-context');
  assert.equal(recordStageTaskSummary(project.cwd, project.context, '', CLOCK).reason, 'prompt-unavailable');
  assert.equal(recordStageTaskSummary(project.cwd, project.context, 42, CLOCK).reason, 'prompt-unavailable');
  assert.equal(fs.existsSync(project.summaryFile), false);

  assert.equal(
    recordStageTaskSummary(project.cwd, { ...project.context, charterHash: 'sha256:' + 'b'.repeat(64) }, prompt, CLOCK).reason,
    'charter-changed',
  );
  assert.equal(fs.existsSync(project.summaryFile), false);

  assert.equal(recordStageTaskSummary(project.cwd, project.context, prompt, CLOCK).recorded, true);
  assert.equal(readSummary(project).tasks.length, 1);
});

test('secret and credential payloads are refused instead of summarized', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-secret-'));
  const project = makeProject(root);
  const prompts = [
    'Please set api_key=sk-abcdefghijklmnop and run the job.',
    'Use this token: ' + 'ghp_' + 'a'.repeat(24) + ' to fetch the results.',
    'password: hunter2 then update the dashboard',
    '-----BEGIN ' + 'OPENSSH PRIVATE KEY----- please deploy',
  ];
  for (const prompt of prompts) assert.equal(recordStageTaskSummary(project.cwd, project.context, prompt, CLOCK).reason, 'secret-payload');
  assert.equal(fs.existsSync(project.summaryFile), false);
});

test('code fences, markdown tables, attachments and result bodies are not treated as tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-noise-'));
  const project = makeProject(root);
  const noise = [
    '```js\nconst answer = 42;\n```',
    '| step | result |\n| --- | --- |\n| one | two |',
    '[attachment: results.csv]',
    '<tool_result>{"raw":"result body"}</tool_result>',
    'system: You are a helpful assistant.',
  ];
  for (const prompt of noise) assert.equal(recordStageTaskSummary(project.cwd, project.context, prompt, CLOCK).reason, 'no-task-intent');
  assert.equal(fs.existsSync(project.summaryFile), false);

  const mixed = '```python\nprint(secret)\n```\nPlease review the ablation table.';
  assert.equal(recordStageTaskSummary(project.cwd, project.context, mixed, CLOCK).recorded, true);
  const record = readSummary(project);
  assert.equal(record.tasks[0].summary, 'Please review the ablation table.');
  assert.doesNotMatch(JSON.stringify(record), /print|```/);
});

test('negated, future-only, quoted and questioned actions are not recorded as current tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-intent-'));
  const project = makeProject(root);
  for (const prompt of [
    '请不要运行实验。', 'Please do not delete the results.',
    '请问需要更新方案吗？', '明天再运行实验。',
    '> Please run the experiments.',
  ]) {
    assert.equal(recordStageTaskSummary(project.cwd, project.context, prompt, CLOCK).reason, 'no-task-intent', prompt);
  }
  assert.equal(fs.existsSync(project.summaryFile), false);
  assert.equal(recordStageTaskSummary(project.cwd, project.context, '请不要写论文。现在运行基准测试。', CLOCK).recorded, true);
  assert.equal(readSummary(project).tasks[0].summary, '现在运行基准测试。');
});

test('email, phone and absolute paths are redacted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-pii-'));
  const project = makeProject(root);
  const result = recordStageTaskSummary(
    project.cwd,
    project.context,
    'Please email alice@example.com and call +1 (555) 123-4567 about /var/research-fixture/private/result.csv, then fix the parser.',
    CLOCK,
  );
  assert.equal(result.recorded, true);
  const summary = readSummary(project).tasks[0].summary;
  assert.ok(summary.includes('[email]'));
  assert.ok(summary.includes('[phone]'));
  assert.ok(summary.includes('[path]'));
  assert.doesNotMatch(summary, /alice@example\.com|555|123-4567|\/var\/research-fixture|result\.csv/);
  assert.ok(summary.length <= MAX_SUMMARY_CHARS);
});

test('charter switch refuses the stale context and does not carry old tasks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-charter-'));
  const project = makeProject(root);
  assert.equal(recordStageTaskSummary(project.cwd, project.context, 'Please implement the first experiment.', CLOCK).recorded, true);
  assert.equal(readSummary(project).tasks.length, 1);

  const nextCharter = { ...project.charter, objective: 'A changed charter', revision: 2, frozenAt: '2026-11-04T00:00:00.000Z' };
  write(project.stateFile, { schema: 'pi-research-loop.v1', stage: '3-review', charter: nextCharter });
  const stale = recordStageTaskSummary(project.cwd, project.context, 'Please review the changed plan.', CLOCK);
  assert.equal(stale.recorded, false);
  assert.equal(stale.reason, 'charter-changed');
  assert.equal(readSummary(project).tasks.length, 1);

  const nextContext = { ...project.context, charterHash: 'sha256:' + digest(nextCharter), charterRevision: 2 };
  const fresh = recordStageTaskSummary(project.cwd, nextContext, 'Please review the changed plan.', CLOCK);
  assert.equal(fresh.recorded, true);
  const record = readSummary(project);
  assert.equal(record.charterRevision, 2);
  assert.equal(record.tasks.length, 1);
  assert.equal(record.tasks[0].summary, 'Please review the changed plan.');
});

test('keeps only the most recent few bounded summaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-cap-'));
  const project = makeProject(root);
  for (let index = 1; index <= MAX_TASKS + 3; index += 1) {
    assert.equal(recordStageTaskSummary(project.cwd, project.context, `Please implement task number ${index} now.`, CLOCK).recorded, true);
  }
  let record = readSummary(project);
  assert.equal(record.tasks.length, MAX_TASKS);
  assert.deepEqual(record.tasks.map(task => task.summary), Array.from({ length: MAX_TASKS }, (_, offset) => `Please implement task number ${MAX_TASKS + offset} now.`));

  const long = 'Please implement ' + 'x'.repeat(500);
  assert.equal(recordStageTaskSummary(project.cwd, project.context, long, CLOCK).recorded, true);
  record = readSummary(project);
  assert.ok(record.tasks.at(-1).summary.length <= MAX_SUMMARY_CHARS);
  assert.ok(Buffer.byteLength(fs.readFileSync(project.summaryFile, 'utf8')) <= MAX_SUMMARY_BYTES);
});

test('symlinked project records and summary files are refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-link-'));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o700 });

  const linked = path.join(root, 'linked-project');
  fs.mkdirSync(linked, { mode: 0o700 });
  fs.symlinkSync(outside, path.join(linked, '.pi'));
  const linkedContext = { sessionId: 'session-1', charterHash: 'sha256:' + 'c'.repeat(64), charterRevision: 1 };
  const linkedResult = recordStageTaskSummary(linked, linkedContext, 'Please implement the linked task.', CLOCK);
  assert.equal(linkedResult.recorded, false);
  assert.ok(['unsafe-path', 'write-failed'].includes(linkedResult.reason));
  assert.equal(fs.existsSync(path.join(outside, 'research-loop', 'stage-task-summary.json')), false);

  const project = makeProject(root);
  const target = path.join(root, 'outside-summary.json');
  write(target, '{"schema":"attacker-controlled"}');
  fs.symlinkSync(target, project.summaryFile);
  const result = recordStageTaskSummary(project.cwd, project.context, 'Please implement the real task.', CLOCK);
  assert.equal(result.recorded, false);
  assert.equal(result.reason, 'unsafe-path');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schema":"attacker-controlled"}');
});

test('concurrent writers leave a valid bounded summary file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-task-summary-concurrent-'));
  const project = makeProject(root);
  const barrier = path.join(root, 'start');
  const moduleUrl = new URL('../extensions/research-loop/src/stage-task-summary.mjs', import.meta.url).href;
  const script = `
    import fs from 'node:fs';
    import { recordStageTaskSummary } from ${JSON.stringify(moduleUrl)};
    const payload = JSON.parse(process.env.PAYLOAD);
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(payload.barrier)) Atomics.wait(sleeper, 0, 0, 10);
    const result = recordStageTaskSummary(payload.cwd, payload.context, payload.prompt, () => Date.parse('2026-11-04T12:00:00.000Z'));
    process.stdout.write(JSON.stringify(result));
  `;
  const summaries = ['Please implement concurrent task one.', 'Please review concurrent task two.', 'Please test concurrent task three.'];
  const children = summaries.map(prompt => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, PAYLOAD: JSON.stringify({ cwd: project.cwd, context: project.context, prompt, barrier }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  }));
  fs.writeFileSync(barrier, 'go');
  const outcomes = await Promise.all(children);
  const results = outcomes.map(outcome => {
    assert.equal(outcome.code, 0, outcome.stderr);
    return JSON.parse(outcome.stdout);
  });
  assert.ok(results.some(result => result.recorded === true));
  for (const result of results) {
    if (!result.recorded) assert.equal(result.reason, 'research-busy');
  }
  const record = readSummary(project);
  assert.equal(record.schema, STAGE_TASK_SUMMARY_SCHEMA);
  assert.equal(record.charterHash, project.context.charterHash);
  assert.ok(record.tasks.length >= 1 && record.tasks.length <= MAX_TASKS);
  for (const task of record.tasks) assert.ok(summaries.includes(task.summary));
});
