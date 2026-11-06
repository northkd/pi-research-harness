/** Headless validation of the actual built app; fixtures are explicitly synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { inspectWorkbenchRecordContext } from '../../extensions/research-loop/src/workbench-context.mjs';
const runtime = process.env.PI_UI_PREVIEW_RUNTIME;
const base = process.env.PI_UI_PREVIEW_URL;
const cwd = process.env.PI_UI_DEMO_CWD;
const output = process.env.PI_UI_QA_OUTPUT;
if (!runtime || !base || !cwd || !output || !process.env.PI_UI_LOGIN_URL) throw new Error('Run this check through scripts/ui-preview/launcher.mjs.');
const documentName = 'README-演示.md';
const fixtureSessions = JSON.parse(process.env.PI_UI_DEMO_SESSIONS || '[]');
const bindingFixture = JSON.parse(process.env.PI_UI_BINDING_FIXTURE || 'null');
const endedIds = new Set(fixtureSessions.filter(row => row.status === 'ended' && row.synthetic).map(row => row.id));
const require = createRequire(path.join(runtime, 'package.json'));
const { chromium } = require('playwright');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], errors: [], cancellations: [], requests: [], screenshots: [], browser: '', syntheticData: true };
const browser = await chromium.launch({ executablePath: process.env.PI_UI_BROWSER_EXECUTABLE || undefined, headless: true,
  // Keep native scrollbars painted: their theme is part of the visual check.
  ignoreDefaultArgs: ['--hide-scrollbars'] });
report.browser = browser.version();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: 'light', reducedMotion: 'reduce' });
await context.addInitScript(() => {
  if (!localStorage.getItem('pi-dashboard-language')) localStorage.setItem('pi-dashboard-language', 'zh-CN');
  if (!localStorage.getItem('dashboard:theme')) localStorage.setItem('dashboard:theme', 'light');
});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.setDefaultNavigationTimeout(30000);
let phase = 'initial page';
const responseReads = [];
page.on('pageerror', e => {
  const event = { message: redact(e.message), name: e.name, stack: redact(e.stack), phase };
  // Monaco's CancellationError has the exact name/message "Canceled". Its
  // own unexpected-error helper excludes this type. Preview disposes the
  // markdown editor and may surface the same cancellation in Chromium. Keep
  // the complete evidence, narrowly distinguished from application failures.
  if (e.name === 'Canceled' && e.message === 'Canceled'
    && phase === 'unsaved Markdown edit survives primary views without writing disk'
    && /\/assets\/monaco-[^/]+\.js/.test(e.stack || '')
    && e.stack?.includes('.cancel (') && e.stack?.includes('.dispose (')) {
    report.cancellations.push(event);
  } else report.errors.push(event);
});
page.on('response', response => {
  const url = new URL(response.url());
  if (url.pathname.startsWith('/api/') && response.status() >= 400) {
    responseReads.push((async () => {
      const body = await response.json().catch(() => null);
      report.requests.push({ path: url.pathname, status: response.status(), sessionId: url.searchParams.get('sessionId'),
        error: typeof body?.error === 'string' ? redact(body.error) : undefined,
        message: typeof body?.message === 'string' ? redact(body.message) : undefined });
    })());
  }
});
function redact(value) {
  return String(value).replaceAll(process.env.PI_UI_LOGIN_URL || '__no_login_url__', '[local browser handoff]')
    .replace(/(\/auth\/local-proof\?code=)[^\s"']+/g, '$1[redacted]');
}
async function check(name, fn) {
  phase = name;
  try { await fn(); report.checks.push({ name, passed: true }); }
  catch (error) { report.checks.push({ name, passed: false, error: redact(error.message).slice(0,1300) }); }
  console.log(JSON.stringify(report.checks.at(-1)));
}
async function screenshot(name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false, animations: 'disabled' });
  report.screenshots.push(`${name}.png`);
}
async function ready() {
  await page.getByTestId('workspace-navigation').waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="research-pipeline"]') || document.querySelector('[data-testid="research-pipeline"]')?.textContent?.includes('研究'));
}
async function overflowCheck(label) {
  const measure = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth }));
  assert.ok(measure.documentWidth <= measure.viewport + 2 && measure.bodyWidth <= measure.viewport + 2, `${label}: ${JSON.stringify(measure)}`);
}
try {
  await page.goto(process.env.PI_UI_LOGIN_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => url.pathname !== '/auth/local-proof', { timeout: 15000 });
  await check('native authentication, matched build and research API', async () => {
    const health = await (await context.request.get(`${base}/api/health`)).json();
    assert.equal(health.clientBuild?.status, 'matched');
    const plugins = await (await context.request.get(`${base}/api/plugins`)).json();
    const browserPlugin = plugins.plugins?.find(row => row.id === 'browser');
    assert.equal(browserPlugin?.status.enabled, false);
    report.browserPlugin = { enabled: browserPlugin.status.enabled, loaded: browserPlugin.status.loaded };
    const profiles = await context.request.get(`${base}/api/browser/profiles`);
    const unavailable = await profiles.json();
    assert.equal(profiles.status(), 404);
    assert.equal(unavailable.error, 'not_found');
    assert.equal(unavailable.message, 'No API route for GET /api/browser/profiles');
    report.browserPlugin.unavailableRouteVerified = true;
    const response = await context.request.get(`${base}/api/res-workflow?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(response.status(), 200); assert.equal((await response.json()).cwd, cwd);
  });
  const launch = page.getByTestId('first-launch-display-backdrop');
  if (await launch.isVisible({ timeout: 5000 }).catch(() => false)) await launch.locator('button').last().click();
  const folder = Buffer.from(cwd).toString('base64url');
  await page.goto(`${base}/folder/${folder}/research`, { waitUntil: 'domcontentloaded' });
  await ready();
  if (await launch.isVisible().catch(() => false)) await launch.locator('button').last().click();
  await check('legacy research deep link opens new workbench', async () => {
    await page.getByTestId('research-pipeline').waitFor();
    assert.equal(await page.getByTestId('workspace-view-workbench').getAttribute('aria-selected'), 'true');
  });
  let staleBinding;
  const bindingEndpoint = `${base}/api/res-workflow/charter-binding`;
  const bindingQuery = bindingFixture && `?cwd=${encodeURIComponent(cwd)}&sessionId=${encodeURIComponent(bindingFixture.sessionId)}`;
  const nativeContext = () => inspectWorkbenchRecordContext({ cwd, sessionManager: {
    getSessionId: () => bindingFixture.sessionId, getSessionFile: () => bindingFixture.sessionFile,
  } }, { privateDir: bindingFixture.privateDir, expectedOwnerKey: bindingFixture.ownerKey });
  await check('joined historical session exposes stale charter separately from missing membership', async () => {
    assert.ok(bindingFixture, 'launcher must create a legitimate stale adoption fixture');
    const response = await context.request.get(bindingEndpoint + bindingQuery);
    assert.equal(response.status(), 200);
    staleBinding = await response.json();
    assert.equal(staleBinding.status, 'stale');
    assert.equal(staleBinding.session?.status, 'joined');
    assert.equal(staleBinding.currentCharterRevision, 2);
    assert.notEqual(staleBinding.boundCharterHash, staleBinding.currentCharterHash);
    const inspected = nativeContext();
    assert.equal(inspected.status, 'charter-stale');
    assert.equal(inspected.error, 'research-workbench-charter-binding-stale');
    await page.getByTestId('research-main-agent-select').selectOption(bindingFixture.sessionId);
    await page.waitForFunction(() => document.querySelector('[data-testid="research-charter-binding-status"]')?.textContent === '会话已接入 · 目标绑定已过期（当前版本 2）');
    const preview = page.getByTestId('research-charter-binding-preview');
    await preview.locator('summary').click();
    assert.match(await preview.textContent(), /源数据只读/);
    assert.match(await preview.textContent(), /不发布真实结论/);
    await screenshot('22-charter-binding-stale-1440');
    await preview.locator('summary').click();
  });
  await check('one explicit platform transition restores native context and preserves original research records', async () => {
    assert.equal(staleBinding?.status, 'stale');
    const reply = page.waitForResponse(response => response.url() === bindingEndpoint && response.request().method() === 'POST');
    await page.getByTestId('research-charter-binding-rebind').click();
    const response = await reply;
    assert.equal(response.status(), 200);
    const receipt = await response.json();
    assert.equal(receipt.adoptionId, staleBinding.adoptionId);
    assert.equal(receipt.boundCharterHash, staleBinding.currentCharterHash);
    assert.equal(receipt.bindingRevision, staleBinding.bindingRevision + 1);
    await page.waitForFunction(() => document.querySelector('[data-testid="research-charter-binding-status"]')?.textContent === '会话已接入 · 目标版本 2 已绑定');
    const inspected = nativeContext();
    assert.equal(inspected.status, 'ready');
    assert.equal(inspected.context.adoptionId, staleBinding.adoptionId);
    assert.equal(inspected.context.charterHash, staleBinding.currentCharterHash);
    assert.equal(inspected.context.charterRevision, 2);
    for (const original of bindingFixture.originalFiles) {
      assert.equal(createHash('sha256').update(fs.readFileSync(original.file)).digest('hex'), original.hash, `Repair rewrote ${path.basename(original.file)}`);
    }
    report.charterBinding = { originalAdoptionPreserved: true, preservedFiles: bindingFixture.originalFiles.length,
      nativeBefore: 'charter-stale', nativeAfter: 'ready', currentRevision: 2, bindingRevision: receipt.bindingRevision,
      modelRequests: 0 };
    await screenshot('23-charter-binding-current-1440');
  });
  await check('binding survives reload and rejects an outdated compare-and-swap request', async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForFunction(() => document.querySelector('[data-testid="research-charter-binding-status"]')?.textContent === '会话已接入 · 目标版本 2 已绑定');
    assert.equal(await page.getByTestId('research-charter-binding-rebind').count(), 0);
    const outdated = await context.request.post(bindingEndpoint, { data: {
      cwd, adoptionId: staleBinding.adoptionId, expectedBindingRevision: staleBinding.bindingRevision,
      expectedBoundCharterHash: staleBinding.boundCharterHash, expectedCharterHash: staleBinding.currentCharterHash,
      requestId: randomUUID(),
    } });
    assert.equal(outdated.status(), 409);
    assert.equal(nativeContext().status, 'ready');
    const fresh = await (await context.request.get(bindingEndpoint + bindingQuery)).json();
    assert.equal(fresh.bindingRevision, 1);
  });
  await check('main-agent selection alone does not mark a different conversation as joined', async () => {
    await page.getByTestId('research-main-agent-select').selectOption(fixtureSessions[1].id);
    await page.waitForFunction(() => document.querySelector('[data-testid="research-charter-binding-status"]')?.textContent === '会话未接入 · 目标版本 2 已绑定');
    await page.getByTestId('research-main-agent-select').selectOption(bindingFixture.sessionId);
    await page.waitForFunction(() => document.querySelector('[data-testid="research-charter-binding-status"]')?.textContent === '会话已接入 · 目标版本 2 已绑定');
  });
  await check('one access-mode selection persists through the real authenticated service without task setup', async () => {
    const select = page.getByTestId('research-access-select');
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-select"]')?.value === 'default');
    const endpoint = `${base}/api/res-workflow/access-mode?cwd=${encodeURIComponent(cwd)}`;
    let response = await context.request.get(endpoint);
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).mode, 'default');
    await select.selectOption('full-access');
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-status"]')?.textContent?.includes('完全访问已开启'));
    response = await context.request.get(endpoint);
    assert.equal((await response.json()).mode, 'full-access');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await page.getByTestId('research-permissions-task').count(), 0);
    await screenshot('17-full-access-1440');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-select"]')?.value === 'full-access');
    await page.getByTestId('research-access-select').selectOption('default');
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-select"]')?.value === 'default');
    response = await context.request.get(endpoint);
    assert.equal((await response.json()).mode, 'default');
  });
  await screenshot('01-real-workbench-1440');
  await check('unsent folder draft survives all primary views', async () => {
    await page.getByTestId('workspace-view-chat').click();
    const composer = page.getByTestId('composer-card').locator('textarea');
    await composer.fill('【UI 验证】未发送的研究草稿');
    for (const view of ['workbench', 'agents', 'files', 'science', 'chat']) await page.getByTestId(`workspace-view-${view}`).click();
    assert.equal(await composer.inputValue(), '【UI 验证】未发送的研究草稿');
  });
  await screenshot('02-conversation-1440');
  await check('empty files navigation retains research tab and visible tree', async () => {
    await page.getByTestId('workspace-view-files').click();
    await page.getByTestId('tree-toggle').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('tree-toggle').getAttribute('aria-pressed'), 'true');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    // The legacy /research route intentionally reopens its named target on a
    // reload. The Files action must still find the retained tabs afterwards.
    await page.getByTestId('workspace-view-files').click();
    assert.ok(await page.locator('[data-tab-path="research:"]').count() > 0);
  });
  await check('file tree opens a real project document', async () => {
    await page.getByText(documentName, { exact: true }).first().click();
    await page.locator(`[data-tab-path="${documentName}"]`).waitFor();
    await page.locator('.markdown-content:visible').waitFor();
  });
  await check('unsaved Markdown edit survives primary views without writing disk', async () => {
    const original = fs.readFileSync(path.join(cwd, documentName), 'utf8');
    await page.getByTestId('md-edit-toggle').click();
    const input = page.locator('.monaco-editor:visible textarea.inputarea');
    await input.waitFor({ state: 'visible', timeout: 20000 });
    await input.focus();
    await page.keyboard.press('Control+Home');
    await page.keyboard.insertText('UI_DRAFT_PRESERVED\n');
    await page.getByTestId('md-dirty-dot').waitFor({ state: 'visible' });
    for (const view of ['workbench', 'agents', 'science', 'chat', 'files']) await page.getByTestId(`workspace-view-${view}`).click();
    await page.getByTestId('md-save-btn').waitFor({ state: 'visible' });
    assert.equal(await page.getByTestId('md-save-btn').isEnabled(), true);
    // automaticLayout remeasures after the previously hidden pane is revealed.
    // Wait for the visible lines, not just the already-mounted Save button.
    await page.waitForFunction(() => [...document.querySelectorAll('.monaco-editor')].some(editor =>
      editor.getBoundingClientRect().width > 100 && editor.querySelector('.view-lines')?.textContent?.includes('UI_DRAFT_PRESERVED')));
    assert.match(await page.locator('.monaco-editor:visible .view-lines').innerText(), /UI_DRAFT_PRESERVED/);
    assert.equal(fs.readFileSync(path.join(cwd, documentName), 'utf8'), original);
    await input.focus();
    await page.keyboard.press('Control+z');
    await page.getByTestId('md-preview-toggle').click();
  });
  await screenshot('03-files-1440');
  await page.getByTestId('workspace-view-science').click();
  await screenshot('04-science-1440');
  await check('no-session Science has an explicit unavailable state', async () => {
    assert.equal(await page.getByTestId('workspace-view-science').getAttribute('aria-selected'), 'true');
    assert.match(await page.locator('body').innerText(), /Science/);
  });
  const sessions = fixtureSessions;
  if (sessions.length) {
    await page.goto(`${base}/session/${sessions[0].id}`, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.getByTestId('workspace-view-chat').click();
    await check('real ended transcript stays readable', async () => {
      await page.getByText('阶段记录', { exact: false }).first().waitFor();
      assert.match(await page.locator('body').innerText(), /没有价格或真实费用记录/);
    });
    await screenshot('10-session-chat-1440');
    await check('current usage is accessible from workbench', async () => {
      await page.getByTestId('workspace-view-workbench').click();
      const fee = page.getByTestId('speed-indicator-badge');
      await fee.waitFor();
      await fee.click();
      await page.getByTestId('speed-indicator-popover').waitFor();
      await page.getByTestId('tab-view-billing').click();
      await page.getByTestId('billing-total').waitFor();
      assert.equal(await page.getByTestId('billing-total').innerText(), '待定价');
      await screenshot('11-usage-drawer-1440');
      await page.keyboard.press('Escape');
    });
    if (sessions[0].timingScenario === 'pi-stream') {
      await check('source timing excludes first-output wait and persistence delay in the actual performance panel', async () => {
        const response = await context.request.get(`${base}/api/speed-monitor/stats?sessionId=${encodeURIComponent(sessions[0].id)}`);
        assert.equal(response.status(), 200);
        const stats = await response.json();
        assert.equal(stats.latest.timingSource, 'pi-stream');
        assert.equal(stats.latest.tps, 160);
        assert.equal(stats.latest.durationSeconds, 10);
        assert.equal(stats.latest.firstTokenSeconds, 8);
        assert.equal(stats.latest.generationSeconds, 2);
        assert.equal(stats.recentCount, 1);
        await page.getByTestId('speed-indicator-badge').click();
        await page.getByTestId('tab-view-speed').click();
        await page.getByTestId('latest-speed-value').waitFor({ state: 'visible' });
        assert.match(await page.getByTestId('latest-speed-value').innerText(), /^160\s*tokens\/s$/);
        assert.match(await page.getByTestId('latest-speed-ttft').innerText(), /8(?:\.0)?\s*秒/);
        assert.match(await page.getByTestId('latest-speed-duration').innerText(), /10(?:\.0)?\s*秒/);
        assert.match(await page.getByTestId('latest-speed-generation').innerText(), /2(?:\.0)?\s*秒/);
        assert.match(await page.getByTestId('latest-speed-model').innerText(), /ui-fixture-unpriced/);
        await screenshot('15-speed-measured-1440');
        await page.keyboard.press('Escape');
        await page.getByTestId('workspace-view-chat').click();
        assert.doesNotMatch(await page.locator('body').innerText(), /dashboard-speed-timing|generationDurationMs|messageEntryId/);
      });
      await check('SDK-only and legacy timing stay explicit estimates without invented first-output times', async () => {
        for (const [index, expected, source] of [[1, 38, 'sdk-duration'], [2, 22, 'legacy-timestamps']]) {
          await page.goto(`${base}/session/${sessions[index].id}`, { waitUntil: 'domcontentloaded' });
          await ready();
          const response = await context.request.get(`${base}/api/speed-monitor/stats?sessionId=${encodeURIComponent(sessions[index].id)}`);
          const stats = await response.json();
          assert.equal(stats.latest.timingSource, source);
          assert.equal(stats.latest.tps, null);
          assert.equal(stats.latest.estimatedTps, expected);
          assert.equal(stats.latest.firstTokenSeconds, null);
          await page.getByTestId('workspace-view-workbench').click();
          await page.getByTestId('research-pipeline').waitFor({ state: 'visible' });
          await page.getByTestId('speed-indicator-badge').click();
          await page.getByTestId('tab-view-speed').click();
          await page.getByTestId('latest-speed-value').waitFor({ state: 'visible' });
          assert.match(await page.getByTestId('latest-speed-value').innerText(), new RegExp(`^≈\\s*${expected}\\s*tokens/s$`));
          assert.equal((await page.getByTestId('latest-speed-ttft').innerText()).trim(), '—');
          assert.match(await page.getByTestId('current-speed-label').innerText(), /估算/);
          if (index === 1) await screenshot('16-speed-sdk-estimate-1440');
          await page.keyboard.press('Escape');
        }
      });
    }
  }
  await check('legacy folder editor route keeps workspace navigation and return', async () => {
    await page.goto(`${base}/folder/${folder}/editor`, { waitUntil: 'domcontentloaded' });
    await ready();
    await page.getByTestId('workspace-view-files').click();
    await page.getByTestId('tree-toggle').waitFor({ state: 'visible' });
    await page.getByTestId('workspace-view-chat').click();
    await page.getByTestId('composer-card').waitFor({ state: 'visible' });
  });
  await page.goto(`${base}/res-workflow-demo.html?res-demo=1&demo-project=${encodeURIComponent(cwd)}`, { waitUntil: 'domcontentloaded' });
  await ready();
  await page.getByTestId('research-pipeline').waitFor();
  await check('demo data is explicitly identified', async () => assert.match(await page.locator('body').innerText(), /模拟|演示/));
  await screenshot('05-workbench-demo-1440');
  await page.getByTestId('workspace-view-agents').click();
  await screenshot('06-agents-demo-1440');
  await check('recorded multi-agent creators form a three-level canvas hierarchy', async () => {
    const nodes = page.getByTestId('canvas-session-node');
    assert.equal(await nodes.count(), 4);
    assert.equal(await page.getByTestId('canvas-parent-edge').count(), 3);
    const grandchild = page.locator('[data-testid="canvas-session-node"][data-parent-id="DEMO:experiment"]');
    assert.equal(await grandchild.getAttribute('data-depth'), '2');
    assert.match(await grandchild.innerText(), /创建者/);
    await grandchild.click();
    await page.getByRole('button', { name: /^返回创建者 / }).click();
    assert.match(await page.getByTestId('canvas-session-node').innerText(), /实验/);
    await page.getByRole('button', { name: '返回全部会话', exact: true }).click();
  });
  await check('stacked subagents animate and spread within the canvas without a dialog', async () => {
    await page.getByTestId('canvas-session-node').filter({ hasText: '文献' }).first().click();
    const group = page.locator('[data-testid="canvas-role-node"][aria-expanded="false"]').first();
    await group.waitFor({ state: 'visible' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await group.click();
    const cards = page.locator('[data-testid="canvas-execution-node"][data-expanded="true"]');
    await cards.first().waitFor({ state: 'visible' });
    assert.equal(await cards.count(), 2);
    assert.equal(await page.getByRole('dialog').count(), 0);
    const motion = await cards.first().evaluate(element => ({
      duration: getComputedStyle(element).transitionDuration,
      inCanvas: !!element.closest('[data-testid="research-canvas-viewport"]'),
    }));
    assert.equal(motion.inCanvas, true);
    assert.ok(motion.duration.split(',').some(value => parseFloat(value) > 0), 'normal motion should animate the spread');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="canvas-execution-node"][data-expanded="true"]')]
      .every(element => getComputedStyle(element).transitionDuration.split(',').every(value => parseFloat(value) === 0)));
    const boxes = await cards.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    }));
    assert.ok(boxes[0].right <= boxes[1].x + 1 || boxes[1].right <= boxes[0].x + 1 || boxes[0].bottom <= boxes[1].y + 1 || boxes[1].bottom <= boxes[0].y + 1,
      'expanded execution cards should not overlap');
    await screenshot('12-subagents-spread-1440');
    await cards.first().click();
    assert.ok(await page.getByRole('dialog').count() > 0, 'explicit execution details remain available');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '收起执行卡片', exact: true }).click();
    assert.equal(await page.locator('[data-testid="canvas-execution-node"][data-expanded="true"]').count(), 0);
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByRole('button', { name: '返回全部会话', exact: true }).click();
  });
  await check('narrow canvas retains nested collaborators and inline execution cards', async () => {
    try {
      await page.setViewportSize({ width: 360, height: 850 });
      // App remounts its folder route at the mobile breakpoint. Enter through
      // the actual mobile navigation before checking the collaboration canvas.
      await page.getByTestId('workspace-view-agents').click();
      await page.getByTestId('canvas-session-node').filter({ hasText: '文献' }).first().click();
      await page.locator('[data-testid="canvas-role-node"][aria-expanded="false"]').first().click();
      assert.equal(await page.locator('[data-testid="canvas-execution-node"][data-expanded="true"]').count(), 2);
      assert.equal(await page.getByRole('dialog').count(), 0);
      await overflowCheck('narrow expanded collaboration');
      await screenshot('13-subagents-spread-360');
      await page.getByRole('button', { name: '收起执行卡片', exact: true }).click();
      await page.getByRole('button', { name: '返回全部会话', exact: true }).click();
    } finally {
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  });
  await page.getByTestId('workspace-view-workbench').click();
  for (const tab of ['overview', 'claims', 'audit', 'all', 'workflow']) {
    await check(`workbench secondary ${tab} stays reachable`, async () => {
      await page.getByTestId(`research-tab-${tab}`).click();
      assert.equal(await page.getByTestId(`research-tab-${tab}`).getAttribute('aria-selected'), 'true');
    });
  }
  await check('research overview shows usage without budget configuration or task-grant forms', async () => {
    await page.getByTestId('research-tab-overview').click();
    assert.equal(await page.getByTestId('research-permissions').count(), 0);
    assert.equal(await page.getByTestId('research-budget-controls').count(), 0);
    assert.doesNotMatch(await page.locator('body').innerText(), /长任务执行授权|批准并启用长任务|总览与预算/);
    assert.match(await page.getByTestId('research-tab-overview').innerText(), /研究总览/);
    await screenshot('18-research-overview-1440');
    await page.getByTestId('research-tab-workflow').click();
  });
  await check('main-agent selection survives reload and routes a simulated task to the selected session', async () => {
    const select = page.getByTestId('research-main-agent-select');
    await select.locator('option[value="DEMO:literature"]').waitFor({ state: 'attached' });
    await select.selectOption('DEMO:literature');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await ready();
    await page.waitForFunction(() => document.querySelector('[data-testid="research-main-agent-select"]')?.value === 'DEMO:literature');
    await page.getByTestId('research-main-agent-compose').click();
    await page.getByTestId('research-main-agent-prompt').fill('【模拟】把文献核查分给子 Agent，只返回证据摘要。');
    await page.getByTestId('research-main-agent-send').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="research-main-agent-feedback"]')?.textContent?.includes('模拟'));
    assert.equal(await page.getByTestId('research-main-agent-select').inputValue(), 'DEMO:literature');
    await screenshot('19-main-agent-selection-1440');
  });
  await check('all five stage cards can launch independently while execution records stay collapsed', async () => {
    const records = page.getByTestId('research-run-status');
    const collapse = records.getByRole('button', { name: '收起', exact: true });
    if (await collapse.isVisible().catch(() => false)) await collapse.click();
    const stages = ['1-idea', '2-experiment', '3-review', '4-summary', '5-writing'];
    for (const stage of stages) {
      const start = page.locator('.research-stage-overview').getByTestId(`research-stage-start-${stage}`);
      await start.waitFor({ state: 'visible' });
      await start.click();
      const prompt = page.getByTestId('research-stage-prompt');
      await prompt.waitFor({ state: 'visible' });
      await prompt.fill(`【模拟】独立检查 ${stage} 的入口，不执行真实研究。`);
      if (stage === '3-review') await screenshot('20-independent-stage-editor-1440');
      await page.getByTestId('research-stage-launch').click();
      await prompt.waitFor({ state: 'hidden' });
      assert.equal(await records.locator('[aria-controls="research-run-status-content"]').getAttribute('aria-expanded'), 'false');
    }
    await screenshot('21-workflow-stage-actions-1440');
  });
  await check('simulated access choice survives switching views and can return to default', async () => {
    await page.getByTestId('research-access-select').selectOption('full-access');
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-status"]')?.textContent?.includes('完全访问已开启'));
    await page.getByTestId('workspace-view-agents').click();
    await page.getByTestId('workspace-view-workbench').click();
    assert.equal(await page.getByTestId('research-access-select').inputValue(), 'full-access');
    await page.getByTestId('research-access-select').selectOption('default');
    await page.waitForFunction(() => document.querySelector('[data-testid="research-access-select"]')?.value === 'default');
  });
  await check('intake drawer retains its page and closes with Escape', async () => {
    await page.getByRole('button', { name: '资料接入与项目设置', exact: true }).click();
    await page.getByRole('dialog', { name: '资料接入与项目设置' }).waitFor();
    await screenshot('07-intake-drawer-1440');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '资料接入与项目设置' }).waitFor({ state: 'hidden' });
  });
  for (const width of [1920, 1440, 1100, 768, 360]) {
    await page.setViewportSize({ width, height: width < 768 ? 850 : 1000 });
    await check(`light layout no document overflow at ${width}px`, async () => { await ready(); await page.getByTestId('research-pipeline').waitFor({ state: 'visible', timeout: 20000 }); await overflowCheck(width); });
    await screenshot(`08-workbench-light-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => localStorage.setItem('dashboard:theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready();
  await check('dark theme preserves workspace navigation', async () => assert.equal(await page.locator('html').getAttribute('data-theme'), null));
  await screenshot('09-workbench-dark-1440');
  await check('dark layout no document overflow', () => overflowCheck('dark'));
  await check('no unexpected API failures', async () => {
    await Promise.all(responseReads);
    const unexpected = report.requests.filter(row => {
      // The native browser plugin is deliberately opt-in. This fresh isolated
      // install reports it disabled above; a real enabled plugin gets no bypass.
      if (report.browserPlugin?.enabled === false && report.browserPlugin.unavailableRouteVerified
        && row.path === '/api/browser/profiles' && row.status === 404
        // A navigation can cancel body collection after headers were received.
        // The same disabled endpoint's full response was verified above.
        && (row.error === undefined || (row.error === 'not_found' && row.message === 'No API route for GET /api/browser/profiles'))) return false;
      const vault = /^\/api\/session\/([^/]+)\/vault-bindings$/.exec(row.path);
      // These are negative API contracts for the deliberately ended fixtures,
      // not exemptions for real or active sessions and not missing plugins.
      if (vault && endedIds.has(vault[1]) && row.status === 404 && row.error === 'session-unknown') return false;
      if (row.path === '/api/plugins/flows/files' && endedIds.has(row.sessionId)
        && row.status === 404 && row.error === 'session not found') return false;
      return true;
    });
    assert.deepEqual(unexpected, []);
  });
  fs.writeFileSync(path.join(output, 'final-dom.txt'), await page.locator('body').innerText());
} catch (error) {
  report.checks.push({ name: 'browser run completed', passed: false, error: redact(error.stack) });
  await screenshot('failure').catch(() => {});
  fs.writeFileSync(path.join(output, 'failure-dom.txt'), await page.locator('body').innerText().catch(() => ''));
} finally {
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.filter(x => x.passed).length;
  report.failed = report.checks.filter(x => !x.passed).length;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors: report.errors, cancellations: report.cancellations,
    failures: report.checks.filter(x => !x.passed), screenshots: report.screenshots }));
  await browser.close();
  if (report.failed || report.errors.length) process.exitCode = 1;
}
