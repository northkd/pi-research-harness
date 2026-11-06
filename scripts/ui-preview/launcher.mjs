/** Reproducible UI QA against a prepared Dashboard runtime and synthetic data. */
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerDashboardExtras } from '../register-dashboard-extras.mjs';
import { charterBindingFixture } from '../../tests/fixtures/charter-binding.mjs';
import { configureResearch } from '../../extensions/research-loop/src/adoption.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(directory, '../..');
const guard = path.join(directory, 'isolation.mjs');
const usage = 'Usage: node scripts/ui-preview/launcher.mjs run [--runtime DASHBOARD_CHECKOUT] [--output QA_OUTPUT] [--browser-script SCRIPT.mjs]';

function options() {
  const args = process.argv.slice(2);
  if (args[0] === '--help' || args[0] === '-h') return null;
  if (args.shift() !== 'run') throw new Error(usage);
  const value = {
    runtime: process.env.PI_UI_PREVIEW_RUNTIME,
    output: process.env.PI_UI_QA_OUTPUT,
    browserScript: path.join(directory, 'browser-qa.mjs'),
  };
  let positionalScript = false;
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    const property = { '--runtime': 'runtime', '--output': 'output', '--browser-script': 'browserScript' }[name];
    if (property) {
      const argument = args[++index];
      if (!argument || argument.startsWith('--')) throw new Error(`Missing value for ${name}. ${usage}`);
      value[property] = argument;
    } else if (!name.startsWith('-') && !positionalScript) {
      value.browserScript = name;
      positionalScript = true;
    } else throw new Error(`Unknown argument: ${name}. ${usage}`);
  }
  if (!value.runtime || !value.output) throw new Error('Specify --runtime / --output or PI_UI_PREVIEW_RUNTIME / PI_UI_QA_OUTPUT.');
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, path.resolve(item)]));
}

const config = options();
if (!config) {
  console.log(`${usage}\nRequires Node >= 22.19. Both runtime and output paths must be supplied, via options or environment.`);
  process.exit(0);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 19)) throw new Error('UI validation requires Node >= 22.19 for the native Dashboard TypeScript entrypoints.');
const runtime = fs.realpathSync(config.runtime);
const wrapper = path.join(runtime, 'packages/server/bin/pi-dashboard.mjs');
for (const file of [wrapper, path.join(runtime, 'packages/shared/src/test-support/setup-home.ts'), config.browserScript]) {
  if (!fs.statSync(file).isFile()) throw new Error(`Missing required file: ${file}`);
}
fs.mkdirSync(config.output, { recursive: true, mode: 0o700 });
const output = fs.realpathSync(config.output);
const project = path.join(output, 'synthetic-demo');
// Never reuse a project, including a prior run's demo or a dangling symlink.
try {
  fs.lstatSync(project);
  throw new Error('Output already contains synthetic-demo; choose a fresh QA output directory.');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function seedEndedTranscripts(previewHome) {
  // Schema sources: upstream tests/e2e/archive-fold.spec.ts (ended sidecars),
  // session-actions-menu.spec.ts (scanner filename/cwd encoding), and
  // extras/speed-plugin/src/server/__tests__/stats.test.ts (usage records).
  // Everything here is synthetic. No cost, price or live bridge is recorded.
  const folder = `--${project.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const destination = path.join(previewHome, '.pi/agent/sessions', folder);
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  const cases = [
    { name: '【演示】03 · 数据细节分析', request: '【演示】请整理合成样例的分析步骤和待验证事项。此对话为人工编写的 UI 夹具，没有调用模型。', answer: '## 【演示】阶段记录\n\n以下仅用于界面排版：\n\n- 合成表格已准备，可查看 demo-materials/03-合成实验.csv。\n- 样例 B 的数字只用于展示对照，不支持真实材料结论。\n- 真实数据、误差分析和独立核验仍待补充。\n\n### 下一步\n\n请在真实项目中提供原始数据，再检查假设与证据之间的对应关系。\n\n**本会话已经结束。所有 token 数与耗时均为合成占位，没有价格或真实费用记录。**', tool: true },
    { name: '【演示】工作 1 · 文献与证据', request: '【演示】整理虚构文献线索，并标注证据边界。不要把示例当成真实论文。', answer: '## 【演示】资料整理\n\n| 线索 | 当前记录 | 下一步 |\n|---|---|---|\n| DEMO-REF-01 | 人工构造的题目 | 替换为真实 DOI |\n| DEMO-REF-02 | 人工构造的方法 | 查阅原文并确认范围 |\n\n所有条目都是界面演示数据。本记录没有检索真实论文，也没有进行模型评审。合成 token 数不代表实际消费。' },
    { name: '【演示】工作 2 · 结果与评审', request: '【演示】检查示例结论中哪些仍属于未解决问题。当前没有真实研究结果。', answer: '## 【演示】待验证清单\n\n1. 是否有独立样本支持示例趋势？尚未验证。\n2. 是否覆盖反例和适用条件？尚未验证。\n3. 是否可以推广到真实材料？证据不足。\n\n这是一份已结束的合成会话，不代表真实执行、通过评审或科学结论。没有记录真实模型费用。' },
  ];
  return cases.map((item, index) => {
    const id = randomUUID();
    const startedAt = Date.now() - (index + 1) * 3_600_000;
    const endedAt = startedAt + 28_000;
    const iso = value => new Date(value).toISOString();
    const stamp = iso(startedAt).replace(/[:.]/g, '-');
    const filename = path.join(destination, `${stamp}_${id}.jsonl`);
    let parentId = null;
    const entries = [{ type: 'session', version: 3, id, timestamp: iso(startedAt), cwd: project }];
    const add = (type, value, at) => {
      const entryId = randomUUID().replaceAll('-', '').slice(0, 8);
      entries.push({ type, id: entryId, parentId, timestamp: iso(at), ...value });
      parentId = entryId;
      return entryId;
    };
    add('model_change', { provider: 'demo', modelId: 'ui-fixture-unpriced' }, startedAt);
    add('session_info', { name: item.name }, startedAt + 1);
    add('message', { message: { role: 'user', content: [{ type: 'text', text: item.request }], timestamp: startedAt + 1000 } }, startedAt + 1000);
    if (item.tool) {
      add('message', { message: { role: 'assistant', api: 'openai-completions', provider: 'demo', model: 'ui-fixture-unpriced', stopReason: 'toolUse', timestamp: startedAt + 2000,
        content: [{ type: 'text', text: '【演示】以下工具调用为静态记录，没有执行。' }, { type: 'toolCall', id: 'demo-read-1', name: 'read', arguments: { path: 'demo-materials/03-合成实验.csv' } }],
        usage: { input: 600, output: 80, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 680 } } }, startedAt + 6000);
      add('message', { message: { role: 'toolResult', toolCallId: 'demo-read-1', toolName: 'read', isError: false, timestamp: startedAt + 7000,
        content: [{ type: 'text', text: '【演示】人工构造的工具输出，未执行命令：\n样本,条件,示例指标\nDEMO-A,基线,0.42\nDEMO-B,对照,0.58' }] } }, startedAt + 7000);
    }
    const answerEntryId = add('message', { message: { role: 'assistant', api: 'openai-completions', provider: 'demo', model: 'ui-fixture-unpriced', stopReason: 'stop', timestamp: startedAt + 8000,
      ...(index < 2 ? { durationMs: 10000 } : {}),
      content: [{ type: 'text', text: item.answer }],
      usage: { input: 1200 + index * 300, output: 320 + index * 60, reasoning: 0, cacheRead: index * 100, cacheWrite: 0, totalTokens: 1520 + index * 460 } } }, endedAt);
    // Synthetic timing cases: source-observed output window, SDK-only request
    // duration, then legacy wall timestamps. No actual provider is contacted.
    if (index === 0) add('custom', { customType: 'dashboard-speed-timing', data: {
      version: 1, source: 'pi-stream', messageEntryId: answerEntryId,
      messageTimestamp: startedAt + 8000, provider: 'demo', model: 'ui-fixture-unpriced',
      requestDurationMs: 10000, firstTokenMs: 8000, generationDurationMs: 2000, firstOutputKind: 'text',
    } }, endedAt + 1);
    fs.writeFileSync(filename, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
    fs.writeFileSync(filename.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ cwd: project, source: 'tui', status: 'ended', hidden: false, archived: false,
      name: item.name, nameSource: 'user', firstMessage: item.request, startedAt, endedAt, tags: ['demo'] }, null, 2), { mode: 0o600 });
    fs.utimesSync(filename, new Date(endedAt), new Date(endedAt));
    return { id, name: item.name, status: 'ended', synthetic: true, sessionFile: filename,
      timingScenario: index === 0 ? 'pi-stream' : index === 1 ? 'sdk-duration' : 'legacy-timestamps' };
  });
}

function seedStaleCharterBinding(previewHome, session) {
  const fixture = charterBindingFixture(null, {
    root: previewHome, cwd: project, privateDir: path.join(previewHome, '.pi/dashboard/res-workflow'),
    // This isolated server has no identity resolver. Native browser login proves
    // local access while resWorkflowAccess retains the inert host owner realm.
    ownerKey: JSON.stringify(['host', 'inert-operator']),
    sessionFile: session.sessionFile, sessionId: session.id, preserveExistingSession: true, revise: false,
  });
  const state = JSON.parse(fs.readFileSync(fixture.currentStatePath, 'utf8'));
  // Exercise the same platform revision path as a real user. Original receipt,
  // claims and workflow history remain intact; no hand-edited hash is involved.
  configureResearch(project, {
    ...state.charter, objective: '【演示】修订后的合成研究目标：核对新范围，保留旧证据',
    successCriteria: ['【演示】旧主张保持原始验收记录', '【演示】新目标单独核对'],
    constraints: ['【演示】源数据只读'], nonGoals: ['【演示】不发布真实结论'], autoRun: false,
  }, { expectedCharterHash: fixture.receipt.charterHash });
  const files = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(file);
      else if (entry.isFile()) files.push(file);
      else throw new Error('Unexpected non-regular synthetic fixture');
    }
  }
  collect(path.join(project, '.pi/research-loop'));
  for (const file of [fixture.privateOperationPath, fixture.adoptedPointerPath, path.join(project, 'ledger.jsonl')]) {
    if (fs.existsSync(file)) files.push(file);
  }
  const originalFiles = [...new Set(files)].map(file => ({ file, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
  return { cwd: project, privateDir: fixture.privateDir, ownerKey: fixture.ownerKey, adoptionId: fixture.adoptionId,
    sessionId: session.id, sessionFile: session.sessionFile, originalFiles };
}

function isolatedEnvironment(previewHome) {
  // Explicit allowlist: no provider credentials, production agent paths,
  // dashboard overrides, shell hooks or inherited NODE_OPTIONS.
  const env = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return {
    ...env,
    HOME: previewHome,
    USERPROFILE: previewHome,
    TMPDIR: fs.realpathSync(os.tmpdir()),
    XDG_CONFIG_HOME: path.join(previewHome, '.config'),
    XDG_CACHE_HOME: path.join(previewHome, '.cache'),
    XDG_DATA_HOME: path.join(previewHome, '.local/share'),
    PI_CODING_AGENT_DIR: path.join(previewHome, '.pi/agent'),
    PI_CODING_AGENT_SESSION_DIR: path.join(previewHome, '.pi/agent/sessions'),
    // Same explicit backend path as bin/pi-research-dashboard. It is our
    // repository source, never an inherited user/provider configuration.
    PI_RESEARCH_LOOP_ROOT: path.join(repo, 'extensions/research-loop'),
    PI_DASHBOARD_PIN_DIRS: project,
    PI_DASHBOARD_NO_MDNS: '1',
    // Native Linux-compatible TCP bridge opt-in; loopback and normal proof
    // authentication remain mandatory. No Unix-socket assumption is needed.
    PI_GATEWAY_TCP: '1',
    PI_UI_PREVIEW_HOME: previewHome,
    PI_UI_PREVIEW_RUNTIME: runtime,
    NODE_OPTIONS: `--localstorage-file=${JSON.stringify(path.join(previewHome, 'node-localstorage'))}`,
  };
}

function redact(value) {
  return String(value)
    .replace(/(\/auth\/local-proof\?code=)[^\s"'<>]+/g, '$1[redacted]')
    .replace(/(authorization["']?\s*[:=]\s*["']?bearer\s+)[^\s"']+/gi, '$1[redacted]');
}

function mintBrowserHandoff(state, env) {
  const result = spawnSync(process.execPath, ['--import', guard, wrapper, 'open', '--print', '--host', '127.0.0.1', '--port', String(state.port), '--url', state.url], {
    cwd: runtime, env, encoding: 'utf8', timeout: 15_000,
  });
  const link = result.stdout?.split('\n').find(line => /^http:\/\/127\.0\.0\.1:\d+\/auth\/local-proof\?code=/.test(line));
  if (result.status !== 0 || !link) {
    throw new Error(`Native local browser handoff failed (${result.status}): ${redact(result.stderr ?? '')}`);
  }
  // Never persist this one-time URL or print its code.
  return link;
}

async function verifySyntheticReadApis(state) {
  // Use the native endpoint-bound proof helper. Read only the credential
  // created by this temporary instance; do not alter server admission rules.
  const { httpProofHeaders } = await import(pathToFileURL(path.join(runtime, 'packages/shared/src/local-credential-proof.ts')).href);
  const token = fs.readFileSync(path.join(state.previewHome, '.pi/dashboard/local/token'), 'utf8').trim();
  const get = async route => {
    const url = state.url + route;
    const response = await fetch(url, { headers: httpProofHeaders(token, url, 'GET'), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`Isolated read smoke failed: ${route.split('?')[0]} returned ${response.status}`);
    return response.json();
  };
  const listing = await get('/api/sessions');
  const rows = Array.isArray(listing) ? listing : Array.isArray(listing.data) ? listing.data : listing.sessions;
  if (!Array.isArray(rows)) throw new Error('Unexpected native sessions response.');
  for (const fixture of state.syntheticSessions) {
    const row = rows.find(value => value.id === fixture.id);
    if (!row || row.status !== 'ended' || !row.name?.startsWith('【演示】')) throw new Error('Synthetic transcript was not discovered as an ended demo session.');
  }
  const stats = await get(`/api/speed-monitor/stats?sessionId=${encodeURIComponent(state.syntheticSessions[0].id)}`);
  const report = await get('/api/speed-monitor/billing');
  if (!stats.history?.length || stats.billing?.complete !== false || stats.billing?.unpricedTurns < 1 || stats.billing?.sessionTotalCost !== 0) {
    throw new Error('Synthetic statistics must remain unpriced, with no invented money amount.');
  }
  if (!report.sessions?.length || report.billing?.sessionTotalCost !== 0) throw new Error('Synthetic month report is missing or invents a fee.');
  return { syntheticReadSmoke: 'passed', endedSessions: state.syntheticSessions.length, speedApi: 200, billingApi: 200, fixturePricing: 'unpriced', recordedMoney: 'none' };
}

async function assertFallbackPortFree() {
  // A workbench sync helper has a localhost:18767 fallback. Refuse to run if
  // any service owns it; never send our fixtures to that other process.
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!fs.existsSync(file)) continue;
    for (const row of fs.readFileSync(file, 'utf8').split('\n').slice(1)) {
      const columns = row.trim().split(/\s+/);
      if (columns[3] === '0A' && parseInt(columns[1]?.split(':')[1], 16) === 18767) {
        throw new Error('Port 18767 already belongs to another service; refusing cross-service validation.');
      }
    }
  }
  // Also works on hosts without /proc and catches a bound, non-listening port.
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error('Port 18767 is unavailable; refusing cross-service validation.')));
    probe.listen(18767, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

async function availablePort() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const value = probe.address().port;
        probe.close(error => error ? reject(error) : resolve(value));
      });
    });
    if (port !== 8000 && port !== 18767) return port;
  }
  throw new Error('Could not allocate a separate validation port.');
}

function managedProcess(args, env, logName, echo = false) {
  const log = fs.openSync(path.join(output, logName), 'w', 0o600);
  const child = spawn(process.execPath, args, { cwd: runtime, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const write = line => {
    const safe = redact(line);
    fs.writeSync(log, safe + '\n');
    if (echo) console.log(safe);
  };
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) write(line);
    });
    stream.on('end', () => { if (pending) write(pending); });
  }
  const managed = { child, exited: false, error: null, exit: null };
  child.once('error', error => { managed.error = error; });
  managed.exit = new Promise(resolve => child.once('close', (code, signal) => {
    managed.exited = true;
    fs.closeSync(log);
    resolve({ code: code ?? (signal ? 1 : 0), signal });
  }));
  return managed;
}

async function waitWithin(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

async function stop(managed) {
  if (!managed || managed.exited) return;
  // The child handle belongs to this invocation. Never read or signal a PID
  // saved by a prior process or another PID namespace.
  managed.child.kill('SIGTERM');
  if (await waitWithin(managed.exit, 10_000)) return;
  managed.child.kill('SIGKILL');
  if (!(await waitWithin(managed.exit, 5000))) throw new Error('Could not stop the owned UI validation process.');
}

await assertFallbackPortFree();
const previewHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pi-ui-preview-'));
const env = isolatedEnvironment(previewHome);
let server;
let browser;
let interrupted = false;
const report = { syntheticData: true, startedAt: new Date().toISOString(), status: 'failed', runtime, project };
const signalHandlers = new Map();
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  const handler = () => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    if (browser && !browser.exited) browser.child.kill(signal);
    if (server && !server.exited) server.child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}
try {
  const created = spawnSync(process.execPath, ['--import', guard, path.join(repo, 'scripts/create-demo-project.mjs'), project], {
    cwd: repo, env, encoding: 'utf8', timeout: 15_000,
  });
  if (created.status !== 0) throw new Error(`Could not create the synthetic demo: ${redact(created.stderr ?? '')}`);
  registerDashboardExtras(runtime);
  const syntheticSessions = seedEndedTranscripts(previewHome);
  const bindingFixture = seedStaleCharterBinding(previewHome, syntheticSessions[0]);
  const port = await availablePort();
  const configDir = path.join(previewHome, '.pi/dashboard');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
    port, piPort: 0, bindHost: '127.0.0.1', autoShutdown: false,
    dashboardName: 'Pi Research · UI validation', tunnel: { enabled: false },
  }, null, 2), { mode: 0o600 });
  server = managedProcess(['--import', guard, wrapper, '--host', '127.0.0.1', '--port', String(port), '--pi-port', '0', '--no-tunnel', '--ephemeral'], env, 'server.log');
  const state = { port, url: `http://127.0.0.1:${port}`, previewHome, syntheticSessions };
  let health;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !interrupted) {
    if (server.error) throw server.error;
    if (server.exited) throw new Error('Native server exited before health was ready.');
    try {
      const response = await fetch(`${state.url}/api/health`, { signal: AbortSignal.timeout(1500) });
      const result = await response.json();
      if (response.ok && result.ok === true) { health = result; break; }
    } catch { /* Wait for native startup without changing its admission rules. */ }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  if (interrupted) throw new Error('UI validation interrupted.');
  if (!health) throw new Error(`Native server readiness timed out; inspect ${path.join(output, 'server.log')}`);
  console.log(JSON.stringify({ ready: true, url: state.url, version: health.version, clientBuild: health.clientBuild }));
  const smoke = await verifySyntheticReadApis(state);
  fs.writeFileSync(path.join(output, 'synthetic-read-smoke.json'), JSON.stringify(smoke, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(smoke));
  const handoff = mintBrowserHandoff(state, env);
  const browserEnv = { ...env };
  for (const key of ['PLAYWRIGHT_BROWSERS_PATH', 'PI_UI_BROWSER_EXECUTABLE', 'CI']) {
    if (process.env[key]) browserEnv[key] = process.env[key];
  }
  Object.assign(browserEnv, {
    PI_UI_PREVIEW_URL: state.url,
    PI_UI_DEMO_CWD: project,
    PI_UI_DEMO_SESSIONS: JSON.stringify(syntheticSessions),
    PI_UI_BINDING_FIXTURE: JSON.stringify(bindingFixture),
    PI_UI_QA_OUTPUT: output,
    PI_UI_LOGIN_URL: handoff,
  });
  console.log('Native one-time browser handoff prepared; credentials remain temporary.');
  browser = managedProcess(['--import', guard, config.browserScript], browserEnv, 'browser-process.log', true);
  const result = await browser.exit;
  if (browser.error) throw browser.error;
  if (interrupted) throw new Error('UI validation interrupted.');
  if (result.code !== 0) throw new Error(`Browser validation exited with code ${result.code}.`);
  Object.assign(report, { status: 'passed', version: health.version, clientBuild: health.clientBuild, syntheticSessions });
  process.exitCode = 0;
} catch (error) {
  report.error = redact(error.message ?? error);
  console.error(report.error);
  if (!process.exitCode) process.exitCode = 1;
} finally {
  try {
    await stop(browser);
    await stop(server);
  } catch (error) {
    report.status = 'failed';
    report.cleanupError = redact(error.message ?? error);
    console.error(report.cleanupError);
    process.exitCode = 1;
  }
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if ((!browser || browser.exited) && (!server || server.exited)) {
    fs.rmSync(previewHome, { recursive: true, force: true });
  }
  report.endedAt = new Date().toISOString();
  fs.writeFileSync(path.join(output, 'launcher-summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
}
