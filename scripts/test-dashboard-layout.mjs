#!/usr/bin/env node
// Real browser geometry on actual dashboard components + stylesheet, synthetic data only.
// No production HTTP/WS endpoint, credentials, private session or model is contacted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkout = path.resolve(process.argv[2] || path.join(repo, '.runtime/dashboard-source'));
const require = createRequire(path.join(checkout, 'package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const react = (await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href)).default;
const tailwind = (await import(pathToFileURL(require.resolve('@tailwindcss/vite')).href)).default;
const { chromium } = await import(pathToFileURL(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'index.mjs')).href);
const aliases = [
  { find: /^react$/, replacement: require.resolve('react') },
  { find: /^react\/jsx-runtime$/, replacement: require.resolve('react/jsx-runtime') },
  { find: /^react\/jsx-dev-runtime$/, replacement: require.resolve('react/jsx-dev-runtime') },
  { find: /^react-dom\/client$/, replacement: require.resolve('react-dom/client') },
  { find: /^react-dom$/, replacement: require.resolve('react-dom') },
];
// Resolve all public workspace entries to THIS patched checkout, never another live source tree.
for (const name of fs.readdirSync(path.join(checkout, 'packages'))) {
  const root = path.join(checkout, 'packages', name), manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const [key, value] of Object.entries(pkg.exports || {})) {
    const target = typeof value === 'string' ? value : value?.default;
    if (!target || key.includes('*')) continue;
    const specifier = key === '.' ? pkg.name : pkg.name + key.slice(1);
    aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement: path.resolve(root, target) });
  }
}
aliases.push({ find: '@blackbelt-technology/pi-dashboard-shared', replacement: path.join(checkout, 'packages/shared/src') },
  { find: '@blackbelt-technology/pi-dashboard-client-utils', replacement: path.join(checkout, 'packages/client-utils/src') },
  { find: '@dashboard-runtime', replacement: path.join(checkout, 'packages/dashboard-plugin-runtime/src') },
  { find: '@dashboard', replacement: path.join(checkout, 'packages/client/src') });
const server = await createServer({ configFile: false, root: path.join(repo, 'tests/dashboard-layout'),
  plugins: [{ name: 'fixture-explicit-tailwind-source', enforce: 'pre', transform(source, id) {
    if (id === path.join(checkout, 'packages/client/src/index.css')) return source.replace('@import "tailwindcss";',
      '@import "tailwindcss";\n' + ['client', 'client-utils', 'dashboard-plugin-runtime', 'flows-plugin', 'subagents-plugin', 'goal-plugin', 'automation-plugin']
        .map(name => `@source "${path.join(checkout, 'packages', name, 'src').replaceAll('\\\\', '/') }";`).join('\n'));
  } }, react(), tailwind()], resolve: { alias: aliases },
  server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [repo, checkout, fs.realpathSync(path.join(checkout, 'node_modules'))] } },
  cacheDir: path.join(checkout, 'node_modules/.vite-layout-fixture'),
  optimizeDeps: { include: ['react', 'react-dom/client'] }, logLevel: 'error' });
let browser;
const failures = [], results = [], errors = [], foldingChecks = [];
const withOverlay = process.argv.includes('--css-overlay');
const output = process.env.PI_RESEARCH_LAYOUT_OUTPUT ? path.resolve(process.env.PI_RESEARCH_LAYOUT_OUTPUT) : undefined;
if (output) fs.mkdirSync(output, { recursive: true });
try {
  await server.listen();
  const address = server.httpServer.address();
  const url = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  // Decorative streaming shimmer moves outside its clipped box and changes
  // scrollWidth transiently. Use the app's real reduced-motion mode for stable
  // text geometry; this does not change wrapping, preview or content widths.
  const page = await browser.newPage({ reducedMotion: 'reduce' });
  page.on('pageerror', e => errors.push(e.message));
  // Local fixture + local modules only; fail rather than accidentally fetching production/private data.
  await page.route('**/*', route => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin === url || ['data:', 'blob:'].includes(requestUrl.protocol)) return route.continue();
    errors.push('Unexpected external request: ' + requestUrl.origin); return route.abort();
  });
  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const variant of ['subagents', 'user', 'assistant', 'stream', 'pending', 'steering']) {
      await page.goto(`${url}/?variant=${variant}`);
      if (withOverlay) await page.addStyleTag({ path: path.join(repo, 'patches/dashboard/text-containment.css') });
      if (variant === 'subagents') {
        await page.getByRole('button', { name: '执行流', exact: true }).click();
        await page.locator('button[aria-label^="任务节点"]').first().waitFor();
      } else await page.locator('.markdown-content').first().waitFor();
      await page.evaluate(() => document.fonts.ready);
      let foldButton;
      if (withOverlay) {
        await page.evaluate(src => import(src), `${url}/@fs${path.join(repo, 'patches/dashboard/content-folding.mjs')}`);
        foldButton = page.locator('.research-content-toggle:visible').first();
        await foldButton.waitFor();
        assert.equal(await foldButton.getAttribute('aria-expanded'), 'false', 'Long text defaults to preview');
        const collapsed = await page.locator('[data-research-fold="collapsed"]').first().evaluate(el => ({
          height: el.getBoundingClientRect().height, text: el.textContent, kind: el.getAttribute('data-research-fold-kind') }));
        assert.ok(collapsed.height <= (variant === 'subagents' ? 122 : 290), 'Preview has bounded height');
        await foldButton.focus(); await page.keyboard.press('Enter');
        await page.locator('[data-research-fold="expanded"]').first().waitFor();
        assert.equal(await foldButton.getAttribute('aria-expanded'), 'true');
        assert.equal(await foldButton.textContent(), '', 'UI label never enters plain-text message copy');
        assert.equal(await foldButton.getAttribute('aria-label'), '收起');
        const copiedUiLabel = await foldButton.evaluate(button => button.parentElement.innerText.includes('展开全文') || button.parentElement.innerText.includes('收起'));
        assert.equal(copiedUiLabel, false, 'Rendered host innerText excludes generated toggle label');
        assert.equal(await page.locator('[data-research-fold="expanded"]').first().textContent(), collapsed.text, 'Toggle never truncates source text');
        if (variant === 'stream') {
          await page.evaluate(() => window.dispatchEvent(new Event('fixture-stream-update')));
          await page.waitForFunction(() => document.querySelector('[data-research-fold="expanded"]')?.textContent?.endsWith('synthetic-stream-update'));
          assert.equal(await foldButton.getAttribute('aria-expanded'), 'true', 'Streaming does not reset expansion');
        }
      }
      const geometry = await page.evaluate(({ variant }) => {
        const root = variant === 'subagents' ? document.querySelector('main') : document.querySelector('[data-testid="chat-scroll-container"]');
        const all = [root, ...root.querySelectorAll('*')];
        const bad = all.filter(el => {
          if (!(el instanceof HTMLElement) || el.clientWidth === 0 || el.scrollWidth <= el.clientWidth + 2) return false;
          const css = getComputedStyle(el);
          // Intentional code/table/receipt scrolling stays local, never forces the card wider.
          if (['auto', 'scroll'].includes(css.overflowX) && el !== root) return false;
          if (el.closest('pre, .markdown-table-scroll, table')) return false;
          // Ellipsized labels are permitted; prose is asserted separately below.
          if (css.overflowX === 'hidden' && css.textOverflow === 'ellipsis') return false;
          return true;
        }).map(el => ({ tag: el.tagName, className: el.className, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }));
        const prose = variant === 'subagents' ? [...root.querySelectorAll('button[aria-label^="任务节点"] p')] : [...root.querySelectorAll('.markdown-content p')];
        const clippedProse = prose.filter(el => el.scrollWidth > el.clientWidth + 2 || getComputedStyle(el).textOverflow === 'ellipsis').length;
        const pres = [...root.querySelectorAll('pre, pre div')];
        const codeContainers = pres.filter(el => el.querySelector('code') && ['auto','scroll'].includes(getComputedStyle(el).overflowX));
        return { bad, clippedProse, documentOverflow: document.documentElement.scrollWidth > innerWidth + 2,
          proseCount: prose.length, codeScrollers: codeContainers.filter(el => el.scrollWidth > el.clientWidth + 2).length,
          codeOverflow: pres.map(el => ({ tag: el.tagName, className: el.className, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth, overflowX: getComputedStyle(el).overflowX, whiteSpace: getComputedStyle(el).whiteSpace })),
          tableScrollers: [...root.querySelectorAll('.markdown-table-scroll, table')].filter(el => el.scrollWidth > el.clientWidth + 2 && ['auto','scroll'].includes(getComputedStyle(el).overflowX)).length };
      }, { variant });
      const utilities = await page.evaluate(() => {
        const el = document.createElement('div'); el.className = 'flex flex-wrap min-w-0'; document.body.append(el);
        const css = getComputedStyle(el), ok = css.display === 'flex' && css.flexWrap === 'wrap' && css.minWidth === '0px'; el.remove(); return ok;
      });
      assert.equal(utilities, true, 'Full Tailwind component utility classes must be present');
      const scrollsPreserved = !['user', 'assistant', 'stream'].includes(variant) || geometry.codeScrollers > 0 && geometry.tableScrollers > 0;
      const pass = !geometry.documentOverflow && !geometry.bad.length && !geometry.clippedProse && geometry.proseCount > 0 && scrollsPreserved;
      results.push({ width, variant, pass, ...geometry });
      if (!pass) failures.push(`${width}:${variant}`);
      if (output && width === 768 && ['subagents', 'assistant'].includes(variant)) await page.screenshot({ path: path.join(output, variant + '.png'), fullPage: true });
      if (foldButton) {
        await foldButton.click();
        await page.locator('[data-research-fold="collapsed"]').first().waitFor();
        assert.equal(await foldButton.getAttribute('aria-expanded'), 'false');
        foldingChecks.push({ width, variant, defaultPreview: true, keyboardExpand: true, sourcePreserved: true, collapsesAgain: true });
        if (output && width === 768 && ['subagents', 'assistant'].includes(variant)) await page.screenshot({ path: path.join(output, variant + '-preview.png'), fullPage: true });
      }
      if (variant === 'subagents') {
        // Same components in list/tree/detail views must also stay inside their viewport.
        for (const mode of ['层级', '列表']) {
          await page.getByRole('button', { name: mode, exact: true }).click();
          await page.locator('button[aria-pressed][class*="flex-1"]').first().click();
          const detailOverflow = await page.locator('main').evaluate(el => el.scrollWidth > el.clientWidth + 2);
          results.push({ width, variant: 'subagents-' + mode + '-detail', pass: !detailOverflow });
          if (detailOverflow) failures.push(`${width}:${mode}-detail`);
          await page.getByRole('button', { name: '关闭任务详情', exact: true }).click();
        }
      }
    }
    if (withOverlay) {
      await page.goto(`${url}/?variant=assistant&short=1`);
      await page.addStyleTag({ path: path.join(repo, 'patches/dashboard/text-containment.css') });
      await page.locator('.markdown-content').waitFor();
      await page.evaluate(src => import(src), `${url}/@fs${path.join(repo, 'patches/dashboard/content-folding.mjs')}`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator('.research-content-toggle:visible').count(), 0, 'Short text does not get a redundant button');
      foldingChecks.push({ width, variant: 'short-assistant', noUnnecessaryToggle: true });
    }
  }
  const report = { result: failures.length || errors.length ? 'FAIL' : 'PASS', mode: 'actual-components-chrome-synthetic',
    cssSha256: withOverlay ? crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'patches/dashboard/text-containment.css'))).digest('hex') : null,
    foldingSha256: withOverlay ? crypto.createHash('sha256').update(fs.readFileSync(path.join(repo, 'patches/dashboard/content-folding.mjs'))).digest('hex') : null,
    results, foldingChecks, failures, errors,
    modelCalled: false, privateSessionsRead: false, productionRestarted: false };
  if (output) fs.writeFileSync(path.join(output, 'layout-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--expect-overflow')) assert.ok(failures.length > 0, 'Baseline must reproduce overflow');
  else { assert.deepEqual(errors, []); assert.deepEqual(failures, [], 'Unexpected overflow or clipped prose'); }
} finally { await browser?.close(); await server.close(); }
