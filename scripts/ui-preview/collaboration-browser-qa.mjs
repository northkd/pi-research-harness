/** Local, real-browser acceptance of the built app and native collaboration API.
 * No intercepted APIs, fake WebSockets, provider credentials or model calls.
 * Run ONLY via launcher.mjs --collaboration-fixture with a prepared runtime.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const runtime = process.env.PI_UI_PREVIEW_RUNTIME;
const base = process.env.PI_UI_PREVIEW_URL;
const cwd = process.env.PI_UI_DEMO_CWD;
const output = process.env.PI_UI_QA_OUTPUT;
const handoff = process.env.PI_UI_LOGIN_URL;
const fixture = JSON.parse(process.env.PI_UI_COLLABORATION_FIXTURE || 'null');
if (!runtime || !base || !cwd || !output || !handoff || !fixture?.synthetic) throw new Error('Use launcher.mjs run --collaboration-fixture.');
const require = createRequire(path.join(runtime, 'package.json'));
const { chromium } = require('playwright');
const report = { syntheticData: true, realModelCalls: 0, apiInterception: false,
  checks: [], screenshots: [], pageErrors: [], collaborationApiErrors: [],
  boundary: 'Ended synthetic transcripts: no real agent process is running. Queue start/admission is covered by the separate backend tests, not claimed by these screenshots.' };
let browser;
const redact = value => String(value).replaceAll(handoff, '[native one-time handoff]')
  .replace(/(\/auth\/local-proof\?code=)[^\s"'<>]+/g, '$1[redacted]');
try {
  browser = await chromium.launch({ executablePath: process.env.PI_UI_BROWSER_EXECUTABLE || undefined,
    headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'zh-CN',
    colorScheme: 'light', deviceScaleFactor: 1, reducedMotion: 'reduce' });
  await context.addInitScript(() => {
    localStorage.setItem('pi-dashboard-language', 'zh-CN');
    localStorage.setItem('dashboard:theme', 'light');
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push(redact(error.stack || error.message)));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/api/res-workflow/collaboration') && response.status() >= 400) report.collaborationApiErrors.push({ path: url.pathname, status: response.status() });
  });
  const snapshot = async () => {
    const response = await context.request.get(`${base}/api/res-workflow/collaboration?cwd=${encodeURIComponent(cwd)}`);
    assert.equal(response.status(), 200); return response.json();
  };
  const check = async (name, fn) => {
    try { await fn(); report.checks.push({ name, passed: true }); }
    catch (error) { report.checks.push({ name, passed: false, error: redact(error.message).slice(0, 1600) }); }
    console.log(JSON.stringify(report.checks.at(-1)));
  };
  const screenshot = async name => {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    report.screenshots.push(`${name}.png`);
  };
  const agents = async () => {
    await page.getByTestId('workspace-view-agents').click();
    await page.getByTestId('research-tenure-canvas').waitFor({ state: 'visible' });
  };
  const network = tenureId => page.locator(`[data-testid="tenure-network"][data-tenure-id="${tenureId}"]`);
  await page.goto(handoff, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(url => url.pathname !== '/auth/local-proof');
  await page.goto(`${base}/session/${fixture.currentMainSessionId}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('workspace-navigation').waitFor({ state: 'visible' });
  const firstLaunch = page.getByTestId('first-launch-display-backdrop');
  if (await firstLaunch.isVisible().catch(() => false)) await firstLaunch.locator('button').last().click();
  await agents();
  await check('one current main and independent historical family come from the native backend', async () => {
    const data = await snapshot();
    assert.equal(data.currentMainSessionId, fixture.currentMainSessionId);
    assert.equal(data.tenures.filter(row => row.status === 'current').length, 1);
    assert.equal(data.tenures.length, 2);
    await network(fixture.currentTenureId).waitFor({ state: 'visible' });
    await network(fixture.historicalTenureId).waitFor({ state: 'visible' });
    assert.equal(await network(fixture.currentTenureId).getByTestId('canvas-session-node').count(), 5);
    assert.equal(await network(fixture.historicalTenureId).getByTestId('canvas-session-node').count(), 2);
  });
  await check('four Multi-agents are siblings with visible recorded models and sources', async () => {
    const current = network(fixture.currentTenureId);
    const expectedParent = `session-${fixture.currentMainSessionId}`;
    const siblings = current.locator(`[data-testid="canvas-session-node"][data-parent-id="${expectedParent}"]`);
    assert.equal(await siblings.count(), 4);
    for (const child of await siblings.all()) {
      assert.match(await child.getByTestId('canvas-agent-model').innerText(), /demo\/ui-fixture-unpriced/);
      assert.match(await child.getByTestId('canvas-session-origin').innerText(), /主 Agent 派发/);
    }
    assert.equal(await current.getByTestId('canvas-ownership-bus').count(), 1);
    assert.equal((await page.getByTestId('research-canvas-zoom').innerText()).trim(), '100%');
  });
  await check('recorded subagents retain their own actual parent cards', async () => {
    const current = network(fixture.currentTenureId);
    assert.equal(await current.locator(`[data-testid="canvas-role-node"][data-parent-id="session-${fixture.childSessionIds[1]}"]`).count(), 2);
    assert.equal(await current.locator(`[data-testid="canvas-role-node"][data-parent-id="session-${fixture.childSessionIds[2]}"]`).count(), 1);
    assert.equal(await network(fixture.historicalTenureId).getByTestId('canvas-role-node').count(), 1);
  });
  await check('prepared queue displays ordering affordances without bypassing dependencies', async () => {
    const plan = page.locator(`[data-testid="research-plan-queue"][data-plan-id="${fixture.planId}"]`);
    assert.equal(await plan.getByTestId('research-queue-card').count(), 4);
    const dependent = plan.locator('[data-task-id="neb"]');
    assert.match(await dependent.innerText(), /依赖未满足/);
    assert.equal(await dependent.getByRole('button', { name: '立即开始', exact: true }).isDisabled(), true);
    assert.equal(await plan.getByRole('button', { name: /移动任务/ }).count(), 4);
  });
  await screenshot('collaboration-01-desktop-1920');
  await check('live concurrency editor changes the real persisted HTTP state without reload', async () => {
    await page.getByTestId('research-concurrency-open').click();
    await page.getByTestId('research-limit-multi').fill('5');
    await page.getByTestId('research-limit-sub').fill('4');
    await screenshot('collaboration-02-live-limits');
    await page.getByRole('button', { name: '保存并立即生效', exact: true }).click();
    await page.getByTestId('research-concurrency-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual((await snapshot()).limits, { maxMultiAgents: 5, maxSubagents: 4 });
    await page.getByTestId('research-concurrency-open').click();
    await page.getByTestId('research-limit-multi').fill('4');
    await page.getByTestId('research-limit-sub').fill('3');
    await page.getByRole('button', { name: '保存并立即生效', exact: true }).click();
    await page.getByTestId('research-concurrency-dialog').waitFor({ state: 'hidden' });
    assert.deepEqual((await snapshot()).limits, { maxMultiAgents: 4, maxSubagents: 3 });
  });
  await check('research workbench still contains its goal and constraints', async () => {
    await page.getByTestId('workspace-view-workbench').click();
    const charter = page.getByTestId('research-charter-binding-preview');
    await charter.waitFor({ state: 'visible' });
    assert.notEqual(await charter.getAttribute('open'), null, 'The workbench must expand the charter by default.');
    const contents = await charter.innerText();
    assert.match(contents, /查看当前目标与约束/);
    assert.match(contents, /【演示】修订后的合成研究目标/);
    assert.match(contents, /完成标准/);
    assert.match(contents, /源数据只读/);
    assert.match(contents, /不发布真实结论/);
    await screenshot('collaboration-03-workbench-goals');
    await agents();
  });
  for (const width of [1440, 1100, 768, 360]) await check(`real layout at ${width}px has no page-level overflow`, async () => {
    await page.setViewportSize({ width, height: 1000 });
    // The responsive shell may remount the primary view; use the actual nav.
    const navigation = page.getByTestId('workspace-view-agents');
    if (await navigation.isVisible()) await navigation.click();
    await page.getByTestId('research-tenure-canvas').waitFor({ state: 'visible' });
    const measured = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    assert.ok(measured.document <= measured.viewport + 2 && measured.body <= measured.viewport + 2, JSON.stringify(measured));
    await screenshot(`collaboration-04-width-${width}`);
  });
  report.passed = report.checks.every(item => item.passed) && report.pageErrors.length === 0 && report.collaborationApiErrors.length === 0;
} catch (error) {
  report.passed = false;
  report.error = redact(error.stack || error.message);
} finally {
  await browser?.close();
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'collaboration-browser-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed === true, checks: report.checks.length, screenshots: report.screenshots.length, modelCalls: 0, report: 'collaboration-browser-report.json' }));
  if (!report.passed) process.exitCode = 1;
}
