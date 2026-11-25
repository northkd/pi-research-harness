// Classification only: dangerous examples below are data, never executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { operationDecision, digest } from '../src/policy.mjs';
const store = { cwd: '/fixture', resourceGate: () => ({ ok: true }), scopePath(value) {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('..')) throw new Error('Outside fixture');
  return value;
} };
const state = { enabled: true, coreRevision: 1, coreText: 'Synthetic guard repair', authorizationScope: [],
  operationGrants: [], branchRestrictions: [], pendingChanges: false, lastVerdict: 'ON_TRACK' };
const decide = command => operationDecision(store, state, { toolName: 'bash', input: { command, timeout: 30 } });
test('Node quoted heredoc log is not hard-dangerous, but requires direct UI even when unrestricted', () => {
  const d = decide("node --input-type=module <<'JS'\nconsole.log('no native API or shutdown called.');\nJS");
  assert.notEqual(d.hard, true);
  assert.equal(d.allow, false);
  assert.equal(d.confirmable, true);
  assert.equal(d.directHumanRequired, true);
  assert.equal(d.commandInputConfirmation, true);
});
test('ordinary data and comments do not become executable command names', () => {
  for (const command of ["printf '%s\\n' 'shutdown'", 'echo rm dd reboot', 'grep -n shutdown README.md', 'echo ready # shutdown now']) {
    assert.notEqual(decide(command).hard, true, command);
  }
});
test('actual static dangerous executable words remain hard refusals', () => {
  for (const command of ['shutdown now', '/sbin/reboot', 'rm file.txt', "r''m file.txt", 'dd if=a of=b', 'sudo true', 'git reset --hard', 'git -C local clean -f', 'echo ready; rm file.txt', 'echo x | /bin/rm file.txt', "sh -c 'rm file.txt'", 'env X=1 /bin/rm file.txt', 'printf x | xargs rm', 'find . -exec rm {} \\;', "bash <<'SH'\nrm file.txt\nSH"]) {
    const d = decide(command); assert.equal(d.allow, false, command); assert.equal(d.hard, true, command);
  }
});
test('dynamic and opaque evaluation never inherits automatic approval', () => {
  for (const command of ["sh -c 'echo hi'", "node -e 'console.log(1)'", "python3 -c 'print(1)'", '$(printf echo) ready', 'echo `printf hi`', 'eval "$ACTION"', 'command "$ACTION"', 'bash <<EOF\n$ACTION\nEOF', 'node -e"console.log(1)"', 'python3 -c"print(1)"', 'source script.sh', 'busybox echo hi', 'r? obsolete.txt', '~/.local/bin/action', 'node --import=data:text/javascript,console.log(1)', 'node -r preload.cjs test.mjs', 'python3 -m module', "php -r 'echo 1;'", "awk 'BEGIN { print 1 }'", "Rscript -e 'print(1)'", "lua -e 'print(1)'"]) {
    const d = decide(command); assert.equal(d.allow, false, command); assert.equal(d.directHumanRequired, true, command);
  }
});
test('old matching grant cannot authorize opaque or destructive command input', () => {
  for (const command of ['node -e "console.log(1)"', 'rm obsolete.txt']) {
    const input = { command, timeout: 30 };
    const withOldGrant = { ...state, operationGrants: [{ coreRevision: 1, toolName: 'bash', inputDigest: digest(input), paths: [], pathDigests: {} }] };
    const d = operationDecision(store, withOldGrant, { toolName: 'bash', input });
    assert.equal(d.allow, false, command);
    if (command.startsWith('node')) assert.equal(d.commandInputConfirmation, true);
    else assert.equal(d.hard, true);
  }
});
test('sensitive paths and resource restrictions remain independent', () => {
  assert.equal(decide('grep value credentials/input.txt').hard, true);
  assert.equal(decide('node test.mjs > raw/input.txt').hard, true);
  const low = { ...store, resourceGate: () => ({ ok: false }) };
  const d = operationDecision(low, state, { toolName: 'bash', input: { command: "node <<'JS'\nconsole.log('shutdown');\nJS", timeout: 30 } });
  assert.equal(d.hard, true); assert.equal(d.directHumanRequired, undefined);
});
test('branch restrictions bind normalized path aliases without blocking different files', () => {
  for (const pendingChanges of [false, true]) {
    const restricted = { ...state, blocked: true, pendingChanges,
      branchRestrictions: [{ id: 'branch-plan', active: true, coreRevision: 1, paths: ['plan.md'] }] };
    for (const command of ['cat plan.md', 'cat ./plan.md', 'cat notes/../plan.md', 'cat /fixture/plan.md']) {
      const d = operationDecision(store, restricted, { toolName: 'bash', input: { command, timeout: 30 } });
      assert.equal(d.allow, false, command);
      assert.notEqual(d.confirmable, true, command);
    }
    const other = operationDecision(store, restricted, { toolName: 'bash', input: { command: 'cat notes/plan.md', timeout: 30 } });
    assert.equal(other.allow, true, 'an unrelated static local read keeps its original task permissions');
  }
});
test('explicit protected paths remain hard refusals inside inline, dynamic and document input', () => {
  for (const command of ["node -e 'fs.readFileSync(\"raw/x\")'", 'cat "$D"/raw/x',
    "node -e 'fs.readFileSync(\"credentials/input.txt\")'", "cat r''aw/x",
    "node <<'JS'\nconsole.log('raw/x');\nJS", 'echo ready # raw/x']) {
    const d = decide(command);
    assert.equal(d.allow, false, command);
    assert.equal(d.hard, true, command);
    assert.notEqual(d.confirmable, true, command);
  }
  for (const command of ["node -e 'console.log(\"straw/x\")'", 'cat "$D"/draw/x']) {
    assert.equal(decide(command).directHumanRequired, true, command);
  }
});
test('batching cannot silently approve an inline confirmation', () => {
  const d = operationDecision(store, state, { toolName: 'parallel', input: { tool_uses: [
    { recipient_name: 'functions.bash', parameters: { command: "node -e 'console.log(1)'", timeout: 30 } }
  ] } });
  assert.equal(d.allow, false); assert.equal(d.hard, true);
});
