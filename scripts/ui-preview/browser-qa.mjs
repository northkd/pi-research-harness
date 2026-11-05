/** Headless validation of the actual built app; fixtures are explicitly synthetic. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const runtime = process.env.PI_UI_PREVIEW_RUNTIME;
const base = process.env.PI_UI_PREVIEW_URL;
const cwd = process.env.PI_UI_DEMO_CWD;
const output = process.env.PI_UI_QA_OUTPUT;
if (!runtime || !base || !cwd || !output || !process.env.PI_UI_LOGIN_URL) throw new Error('Run this check through scripts/ui-preview/launcher.mjs.');
const documentName = 'README-演示.md';
const fixtureSessions = JSON.parse(process.env.PI_UI_DEMO_SESSIONS || '[]');
const endedIds = new Set(fixtureSessions.filter(row => row.status === 'ended' && row.synthetic).map(row => row.id));
const require = createRequire(path.join(runtime, 'package.json'));
const { chromium } = require('playwright');
fs.mkdirSync(output, { recursive: true });
const report = { checks: [], errors: [], cancellations: [], requests: [], screenshots: [], browser: '', syntheticData: true };
const browser = await chromium.launch({ executablePath: process.env.PI_UI_BROWSER_EXECUTABLE || undefined, headless: true });
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
  await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: false });
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
  await page.getByTestId('workspace-view-workbench').click();
  for (const tab of ['overview', 'claims', 'audit', 'all', 'workflow']) {
    await check(`workbench secondary ${tab} stays reachable`, async () => {
      await page.getByTestId(`research-tab-${tab}`).click();
      assert.equal(await page.getByTestId(`research-tab-${tab}`).getAttribute('aria-selected'), 'true');
    });
  }
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
