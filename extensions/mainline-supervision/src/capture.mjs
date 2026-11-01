import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Root Pi package discovery replaces the author's standalone install-local wrapper.
const HOST_FILES = ['src/core.mjs', 'src/index.ts', 'src/capture.mjs', 'src/policy.mjs', 'package.json'];
const MAX_TOTAL = 512 * 1024;
const CHUNK = 6 * 1024;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SENSITIVE_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*["']?\s*[:=]\s*(?![\s/])\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;

function boundedFile(file, limit = MAX_TOTAL) {
  let current = path.parse(path.resolve(file)).root;
  for (const component of path.resolve(file).slice(current.length).split(path.sep)) {
    current = path.join(current, component);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symlink capture source rejected');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > limit) throw new Error('Non-regular or oversized capture source');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function utf8(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary capture source rejected');
  return text;
}
function fragments(bytes) {
  utf8(bytes);
  const parts = [];
  for (let start = 0; start < bytes.length;) {
    let end = Math.min(bytes.length, start + CHUNK);
    if (end < bytes.length) while ((bytes[end] & 0xc0) === 0x80) end--;
    if (end <= start) throw new Error('Invalid UTF-8 chunk boundary');
    parts.push(bytes.subarray(start, end)); start = end;
  }
  return parts.length ? parts : [Buffer.alloc(0)];
}
const json = bytes => {
  try { return JSON.parse(utf8(bytes)); }
  catch (error) { throw new Error('Malformed bounded source JSON; capture refused', { cause: error }); }
};

/** Resource snapshots are observations, not an execution admission. */
export function captureResourceSnapshot({platform = process.platform, totalmem = os.totalmem, freemem = os.freemem, readMeminfo = () => utf8(boundedFile('/proc/meminfo', 64 * 1024))} = {}) {
  if (platform === 'darwin') {
    const total = totalmem(), free = freemem();
    if (![total, free].every(n => Number.isFinite(n) && n >= 0)) throw new Error('Memory snapshot unavailable');
    return { source: 'node:os', values: { MemTotalKiB: Math.floor(total / 1024), MemFreeKiB: Math.floor(free / 1024) } };
  }
  if (platform !== 'linux') throw new Error('Resource snapshot unavailable on this platform');
  const mem = readMeminfo(), values = {};
  for (const key of ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree']) {
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, 'm').exec(mem);
    if (!match) throw new Error('Required resource field unavailable');
    values[key + 'KiB'] = Number(match[1]);
  }
  return { source: '/proc/meminfo', values };
}

/** Preparation is local only. The UI sees a frozen source/output/operation preview before
 * any publication or external scope grant. There is deliberately no shell or command input. */
export function prepareCapture(store, request, { clock = Date.now } = {}) {
  const allowed = ['capturePaths', 'outputDir', 'includeHostImplementation', 'runIds', 'text'];
  if (!request || Object.keys(request).some(k => !allowed.includes(k))) throw new Error('Unknown capture parameter');
  const s = store.getState();
  if (!s.coreRevision || !s.authorized || s.reviewActivity.requestId) throw new Error('Frozen authorized idle review state required');
  if (!Array.isArray(request.capturePaths) || request.capturePaths.length < 1 || request.capturePaths.length > 20)
    throw new Error('Capture requires 1–20 exact files');
  const sources = [...new Set(request.capturePaths.map(p => store.scopePath(p)))];
  if (sources.some(p => p.endsWith('/') || !/^[A-Za-z0-9._/-]+$/.test(p))) throw new Error('Exact canonical capture files required');
  if (sources.some(p => !store.approved(p, s))) throw new Error('Capture sources must already have explicit project approval');
  // Existing project source approval and this per-capture output/model-read UI grant
  // are separate. Do not use this action to approve arbitrary new research inputs.
  const outputRoot = store.scopePath(String(request.outputDir ?? '').replace(/\/$/, '') + '/');
  if (!outputRoot.startsWith('research/tasks/')) throw new Error('Capture output must be a bounded research/tasks subtree');
  const runIds = request.runIds ?? [];
  if (!Array.isArray(runIds) || runIds.length > 4 || runIds.some(r => !/^[a-f0-9-]{36}$/.test(r))) throw new Error('Invalid exact review run IDs');
  if (request.includeHostImplementation !== undefined && typeof request.includeHostImplementation !== 'boolean') throw new Error('Invalid host source choice');
  const capturedAt = clock();
  const streams = [];
  const operations = [];
  const omissions = [];
  let total = 0;
  const add = (label, bytes, origin) => {
    bytes = Buffer.from(bytes);
    const text = utf8(bytes);
    if (SENSITIVE_TEXT.test(text)) { omissions.push({ label, reason: 'sensitive-marker-content-withheld', sha256: sha(bytes) }); return; }
    total += bytes.length;
    if (total > MAX_TOTAL) throw new Error('Capture exceeds 512KiB; narrow the exact sources');
    streams.push({ label, bytes, origin, sha256: sha(bytes) });
  };
  let filterOverrides = [];
  const git = (args, allowNoMatch = false) => {
    const argv = ['--no-pager', ...filterOverrides, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'core.attributesFile=/dev/null', '-c', 'diff.external=', '-c', 'core.quotePath=false',
      '-c', 'protocol.allow=never', '-c', 'core.sshCommand=/bin/false', ...args];
    try {
      const result = execFileSync('/usr/bin/git', argv, { cwd: store.cwd, shell: false, timeout: 5000,
        maxBuffer: MAX_TOTAL, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', HOME: '/nonexistent',
          GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
          GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', GIT_PROTOCOL_FROM_USER: '0',
          GIT_SSH_COMMAND: '/bin/false', GIT_SSH: '/bin/false', GIT_ASKPASS: '/bin/false', SSH_ASKPASS: '/bin/false' },
        stdio: ['ignore', 'pipe', 'pipe'] });
      operations.push({ executable: '/usr/bin/git', argv, exitCode: 0, stdoutSha256: sha(result), stdoutBytes: result.length });
      return result;
    } catch (error) {
      // Preserve bounded failure identity; never retry with another binary or shell.
      const stderr = Buffer.from(error.stderr ?? '');
      operations.push({ executable: '/usr/bin/git', argv, exitCode: error.status ?? null,
        signal: error.signal ?? null, stderrSha256: sha(stderr), stderrBytes: stderr.length });
      if (allowNoMatch && error.status === 1 && stderr.length === 0) return Buffer.alloc(0);
      throw new Error('Fixed Git capture failed; no fallback', { cause: error });
    }
  };
  const root = utf8(git(['rev-parse', '--show-toplevel'])).trim();
  if (fs.realpathSync(root) !== store.cwd) throw new Error('Capture cwd must be the Git root');
  // Reject promisor/partial clones before dereferencing any object. Git 2.43 may ignore
  // GIT_NO_LAZY_FETCH, so transport denial is defense-in-depth, not the only boundary.
  const objectDir = fs.realpathSync(path.resolve(store.cwd, utf8(git(['rev-parse', '--git-path', 'objects'])).trim()));
  if (fs.existsSync(path.join(objectDir, 'info', 'alternates'))) throw new Error('Non-local-only alternate object store refused');
  const packDir = path.join(objectDir, 'pack');
  if (fs.existsSync(packDir) && fs.readdirSync(packDir).some(name => name.endsWith('.promisor')))
    throw new Error('Promisor object pack refused; local-only capture required');
  const partialKeys = new TextDecoder('utf-8', { fatal: true }).decode(
    git(['config', '--includes', '--null', '--name-only', '--get-regexp', '^(extensions\\.partialclone|remote\\..*\\.promisor)$'], true));
  if (partialKeys.length) throw new Error('Partial/promisor repository refused; transports prohibited');
  const head = utf8(git(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
  if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Invalid exact Git baseline');
  // diff can invoke clean/process filters even with --no-textconv. Query names only
  // (never values), then disable every configured driver before working-tree reads.
  const filterKeys = new TextDecoder('utf-8', { fatal: true }).decode(
    git(['config', '--includes', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], true))
    .split('\0').filter(Boolean);
  const drivers = new Set();
  for (const key of filterKeys) {
    const match = /^filter\.([A-Za-z0-9._-]+)\.(?:clean|process|required)$/i.exec(key);
    if (!match) throw new Error('Unsafe filter configuration name; capture refused');
    drivers.add(match[1]);
  }
  filterOverrides = [...drivers].flatMap(name => ['-c', `filter.${name}.clean=`, '-c', `filter.${name}.process=`, '-c', `filter.${name}.required=false`]);
  // Validate all sources before diff/status; Git is not allowed to serve as a path escape.
  for (const source of sources) boundedFile(store.contained(path.join(store.cwd, source)));
  add('git-identity', Buffer.from(JSON.stringify({ cwd: store.cwd, head, capturedAt })), { kind: 'fixed-git-command' });
  add('git-path-status', git(['status', '--porcelain=v1', '--untracked-files=no', '--ignore-submodules=all', '--', ...sources]), { kind: 'fixed-git-command', paths: sources });
  add('git-cumulative-diff', git(['diff', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all', head, '--', ...sources]),
    { kind: 'fixed-git-command', baseline: head, paths: sources });
  for (const source of sources) {
    const absolute = store.contained(path.join(store.cwd, source));
    const bytes = boundedFile(absolute);
    add('current:' + source, bytes, { kind: 'direct-file', path: source, capturedAt, bytes: bytes.length });
    try {
      add('baseline:' + source, git(['show', `${head}:${source}`]), { kind: 'fixed-git-blob', path: source, baseline: head });
    } catch (error) {
      // New files have no baseline. A genuine command error was already recorded, never hidden.
      omissions.push({ label: 'baseline:' + source, reason: 'baseline-blob-unavailable', detail: String(error.message) });
    }
  }
  if (request.includeHostImplementation) for (const name of HOST_FILES) {
    const absolute = path.join(PACKAGE, name);
    add('installed-host:' + name, boundedFile(absolute), { kind: 'direct-installed-host-file', path: absolute, capturedAt });
  }
  if (runIds.length) {
    const index = utf8(boundedFile(path.join(store.root, 'review-index.jsonl'), 4 * 1024 * 1024));
    for (const runId of runIds) {
      const rows = index.trim().split('\n').filter(Boolean).map(line => json(Buffer.from(line))).filter(row => row.runId === runId);
      if (rows.length !== 1) throw new Error('Exact native review row missing or ambiguous');
      const row = rows[0];
      if (!/^\.pi\/mainline-supervision\/reviews\/[a-f0-9-]{36}$/.test(row.packetDir)) throw new Error('Invalid native packet identity');
      const packet = store.contained(path.join(store.cwd, row.packetDir));
      const manifest = json(boundedFile(path.join(packet, 'MANIFEST.json')));
      const resultBytes = boundedFile(path.join(packet, 'RESULT.json'));
      const result = json(resultBytes);
      if (manifest.requestId !== row.requestId || result.requestId !== row.requestId || result.runId !== runId || result.revision !== manifest.revision)
        throw new Error('Native review identity mismatch');
      add('native-result:' + runId, resultBytes, { kind: 'direct-native-artifact', path: row.packetDir + '/RESULT.json', runId });
      add('native-manifest:' + runId, boundedFile(path.join(packet, 'MANIFEST.json')), { kind: 'direct-native-artifact', path: row.packetDir + '/MANIFEST.json', runId });
      const rawFile = path.join(packet, 'RAW_REVIEW.json');
      if (fs.existsSync(rawFile)) add('native-review:' + runId, boundedFile(rawFile), { kind: 'direct-native-artifact', path: row.packetDir + '/RAW_REVIEW.json', runId });
      else omissions.push({ label: 'native-review:' + runId, reason: 'no-valid-review-output', verdict: result.verdict });
      const receiptFile = path.join(packet, 'ADAPTER_RECEIPT.json');
      if (fs.existsSync(receiptFile)) {
        const receipt = json(boundedFile(receiptFile));
        const expected = `/tmp/pi-subagents-uid-${process.getuid()}/async-subagent-runs/${runId}`;
        if (receipt.requestId !== row.requestId || receipt.runId !== runId || receipt.asyncDir !== expected) throw new Error('Native receipt mismatch');
        const statusFile = path.join(expected, 'status.json');
        if (fs.existsSync(statusFile)) {
          const statusBytes = boundedFile(statusFile);
          const status = json(statusBytes);
          if (status.runId !== runId) throw new Error('Native status run mismatch');
          const projection = { source: 'direct-native-status-projection', sourceSha256: sha(statusBytes), runId,
            state: status.state, startedAt: status.startedAt, lastUpdate: status.lastUpdate,
            processTerminal: status.processTerminal,
            steps: (status.steps ?? []).map(step => ({ agent: step.agent, status: step.status, exitCode: step.exitCode,
              error: String(step.error ?? '').slice(0, 4000), requestedModel: step.requestedModel, structuredOutputFailed: step.structuredOutputFailed })) };
          add('native-terminal:' + runId, Buffer.from(JSON.stringify(projection)), { kind: 'trusted-host-allowlist-projection', path: statusFile, runId,
            omissions: ['session/transcript, prompts, command lines, tools and unrelated runtime fields withheld'] });
        } else omissions.push({ label: 'native-terminal:' + runId, reason: 'retention-managed-status-unavailable' });
      }
    }
  }
  const snapshot = captureResourceSnapshot();
  const resource = { capturedAt, nodeVersion: process.version, nodeExecutable: process.execPath, snapshotNotReservation: true, ...snapshot.values };
  add('capture-resource', Buffer.from(JSON.stringify(resource)), { kind: 'direct-host-resource-projection', path: snapshot.source, capturedAt,
    omissions: ['not a subsequent execution admission; available memory and swap are not inferred on macOS; Python/dependency versions not queried'] });
  const directory = outputRoot + 'capture-' + crypto.randomUUID();
  const parts = [];
  const inventory = [];
  for (const stream of streams) {
    const names = [];
    let offset = 0;
    for (const bytes of fragments(stream.bytes)) {
      const leaf = `p${String(parts.length + 1).padStart(4, '0')}.txt`;
      parts.push({ path: directory + '/' + leaf, bytes, sha256: sha(bytes) });
      names.push({ leaf, startByte: offset, endByteExclusive: offset + bytes.length });
      offset += bytes.length;
    }
    inventory.push({ label: stream.label, origin: stream.origin, bytes: stream.bytes.length, sha256: stream.sha256, parts: names });
  }
  // The inventory is itself a fully captured stream, not an unbounded manifest snapshot.
  const catalog = Buffer.from(JSON.stringify({ version: 1, capturedAt, baseline: head, inventory, operations, omissions }));
  const catalogParts = [];
  for (const bytes of fragments(catalog)) {
    const leaf = `p${String(parts.length + 1).padStart(4, '0')}.txt`;
    parts.push({ path: directory + '/' + leaf, bytes, sha256: sha(bytes) }); catalogParts.push(leaf);
  }
  const manifestPath = directory + '/MANIFEST.json';
  const outputs = [...parts.map(p => p.path), manifestPath];
  if (outputs.length > 180 || new Set([...s.authorizationScope, ...outputs]).size > 256) throw new Error('Fixed output scope limit exceeded');
  const manifest = { version: 1, source: 'direct-bounded-host-capture', capturedAt, baseline: head,
    directory, outputsDigest: sha(JSON.stringify(outputs)), inventoryParts: catalogParts, inventorySha256: sha(catalog),
    sourceCount: streams.length, outputCount: outputs.length, sourceBytes: total,
    scopeOnly: 'collection; not test execution, research success, historical permission authentication or ON_TRACK',
    omissionsCount: omissions.length };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > CHUNK) throw new Error('Manifest exceeded chunk limit');
  parts.push({ path: manifestPath, bytes: manifestBytes, sha256: sha(manifestBytes) });
  return { directory, manifestPath, parts, outputs, sources, runIds, head, capturedAt, resource, omissions,
    sourceCoreRevision: s.coreRevision, sourceCoreDigest: sha(s.coreText),
    previewDigest: sha(JSON.stringify({ sources, runIds, includeHostImplementation: Boolean(request.includeHostImplementation), head,
      files: parts.map(p => ({ path: p.path, sha256: p.sha256 })), operations })),
    hostFiles: request.includeHostImplementation ? HOST_FILES.map(p => path.join(PACKAGE, p)) : [] };
}

export function capturePreview(prepared, model) {
  return `一次有界只读取证，原科研门禁/核心和旧失败不变。\n模型读取：${model}\n` +
    `项目来源：${JSON.stringify(prepared.sources)}\n固定宿主来源：${JSON.stringify(prepared.hostFiles)}\n` +
    `原生run：${JSON.stringify(prepared.runIds)}；Git基线：${prepared.head}\n` +
    `输出前缀：${prepared.directory}/\n逐项文件：${prepared.outputs.map(p => path.basename(p)).join(', ')}\n` +
    `仅固定Git只读命令、直接文件及资源/终态投影；不运行shell/测试/SSH，不读会话或轨迹。` +
    `\n冻结预览：${prepared.previewDigest}；遗漏数：${prepared.omissions.length}。` +
    '\n是否批准保存以上固定原件并将逐项输出加入监督读取范围？本确认不追认历史许可，不解除blocked。';
}

export function publishCapture(store, prepared, consent) {
  if (consent?.source !== 'direct-human-ui' || consent.confirmed !== true || consent.previewDigest !== prepared.previewDigest)
    throw new Error('Exact preview UI consent required');
  const s = store.getState();
  if (s.reviewActivity.requestId) throw new Error('Active review prevents capture publication');
  if (!s.authorized || s.coreRevision !== prepared.sourceCoreRevision || sha(s.coreText) !== prepared.sourceCoreDigest)
    throw new Error('Capture core/scope changed during consent');
  const dir = store.contained(path.join(store.cwd, prepared.directory));
  if (fs.existsSync(dir)) throw new Error('Capture directory already exists; refuse overwrite');
  store.ensureDir(path.dirname(dir));
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const part of prepared.parts) {
    const file = store.contained(path.join(store.cwd, part.path));
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, part.bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  const files = Object.fromEntries(prepared.parts.map(p => [p.path, { sha256: p.sha256, bytes: p.bytes.length }]));
  const registered = store.addCapturedEvidence({ manifestPath: prepared.manifestPath, outputs: prepared.outputs,
    sources: [...prepared.sources, ...prepared.hostFiles], files, consent,
    expectedCoreRevision: prepared.sourceCoreRevision, expectedCoreDigest: prepared.sourceCoreDigest });
  return { ...registered, manifestPath: prepared.manifestPath, outputs: prepared.outputs, omissions: prepared.omissions,
    resource: prepared.resource, source: 'direct-bounded-host-capture', historicalPermissionVerified: false };
}
