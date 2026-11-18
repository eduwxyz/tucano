import { measureCopy } from './lib/copy-layout.mjs';
// Built-renderer copy checks. Run npm run build first.
// Optional: TUCANO_BROWSER_CHANNEL=msedge (or chrome). The default uses Playwright Chromium.
// Scratch data, fake engines, loopback ports, and a headless browser keep daily work untouched.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { chromium } from 'playwright';
const root = resolve('.');
const output = resolve(process.argv[2] || join(tmpdir(), 'tucano-english-copy-report'));
mkdirSync(output, {
  recursive: true
});
const data = mkdtempSync(join(tmpdir(), 'tucano-copy-'));
const reservations = await Promise.all([0, 1, 2].map(async () => {
  const server = createServer();
  await new Promise(y => server.listen(0, '127.0.0.1', y));
  return {
    server,
    port: server.address().port
  };
}));
await Promise.all(reservations.map(({
  server
}) => new Promise(y => server.close(y))));
const env = {
  ...process.env,
  TUCANO_DATA: data,
  TUCANO_SEED: '1',
  TUCANO_FAKE_ENGINES: '1',
  TUCANO_LOCALE: 'en-US',
  TUCANO_HOST: '127.0.0.1',
  TUCANO_PORT: String(reservations[0].port),
  TUCANO_WEBHOOK_PORT: String(reservations[1].port),
  TUCANO_GIT_PORT: String(reservations[2].port),
  TUCANO_TOKEN: 'copy-audit-scratch-only'
};
const server = spawn(process.execPath, ['out/main/server.js'], {
  cwd: root,
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
let log = '';
server.stdout.on('data', b => log += b);
server.stderr.on('data', b => log += b);
const report = {
  dirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8'
  }).trim(),
  source: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim(),
  data,
  measurements: [],
  captures: [],
  errors: []
};
let browser;
try {
  const url = `http://127.0.0.1:${reservations[0].port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise(y => setTimeout(y, 100));
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TUCANO_BROWSER_CHANNEL ? {
      channel: process.env.TUCANO_BROWSER_CHANNEL
    } : {})
  });
  const page = await browser.newPage({
    viewport: {
      width: 1280,
      height: 900
    }
  });
  page.on('pageerror', e => report.errors.push(String(e)));
  await page.goto(`${url}/?token=copy-audit-scratch-only`);
  await page.locator('.sidebar').waitFor();
  await page.evaluate(() => document.fonts.ready);
  if (await page.locator('.modal').count()) {
    await page.keyboard.press('Escape');
  }
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Settings' }).first().click();
  report.navigation = [];
  report.copy = [];
  for (const width of [1280, 900, 760]) {
    await page.setViewportSize({ width, height: 900 });
    for (const category of ['app', 'workspace', 'agents', 'models', 'knowledge', 'connections']) {
      const tab = page.locator('#settings-tab-' + category);
      if (!(await tab.count())) continue;
      await tab.click();
      await page.evaluate(() => document.fonts.ready);
      const links = await page.locator('.settings-sections a').evaluateAll(nodes => nodes.map(node => ({ id: node.getAttribute('href').slice(1), label: node.textContent })));
      assert.equal(links.length, await page.locator('[data-settings-section]').count());
      const grouped = await page.locator('.settings-content .card').evaluateAll(nodes => nodes.every(node => { const style = getComputedStyle(node); return style.borderRadius !== '0px' && style.boxShadow === 'none' }));
      assert.ok(grouped, 'Settings groups need restrained rounded borders without shadows');
      const labels = await measureCopy(page, [{ selector: '.settings-pages button', maxLines: 1 }, { selector: '.settings-sections a', maxLines: 1 }]);
      assert.ok(labels.passed, JSON.stringify(labels.failures));
      for (let index = 0; index < links.length; index++) {
        const link = links[index];
        await page.locator('.settings-sections a[href="#' + link.id + '"]').click();
        await page.waitForFunction(id => {
          const target = document.getElementById(id), nav = document.querySelector('.settings-navigation');
          return target && nav && !document.querySelector('.settings-layout')?.hasAttribute('data-settings-scrolling') && Math.abs(target.getBoundingClientRect().top - nav.getBoundingClientRect().bottom - 16) < 3;
        }, link.id);
        assert.equal(await page.evaluate(() => document.activeElement.id), link.id);
        assert.equal(await page.locator('.settings-sections [aria-current="location"]').getAttribute('href'), '#' + link.id);
        const geometry = await page.locator('#' + link.id).evaluate(el => ({ top: el.getBoundingClientRect().top, navigationBottom: document.querySelector('.settings-navigation').getBoundingClientRect().bottom }));
        report.navigation.push({ width, category, ...link, ...geometry });
        if (width === 900 || index === 0) {
          const name = width + '-' + link.id + '.png';
          await page.screenshot({ path: join(output, name) });
          report.captures.push(name);
        }
      }
      const hints = '.settings-content .hint:visible, .settings-content .card__head p:visible, .settings-content .key-row p.muted.small:visible, .settings-content .wk-setting small:visible, .settings-content .workspace-danger__section > p:visible';
      if (await page.locator(hints).count()) {
        const copy = await measureCopy(page, [{ selector: hints }]);
        const exceptions = copy.failures.filter(f => f.text?.startsWith('Export everything from Workspace'));
        copy.failures = copy.failures.filter(f => !exceptions.includes(f));
        copy.exceptions = exceptions.map(item => ({ ...item, reason: 'Full restore replacement consequences and database-only restore distinction must remain visible.' }));
        copy.passed = copy.failures.length === 0;
        report.copy.push({ width, category, ...copy });
        if (!process.argv.includes('--baseline')) assert.ok(copy.passed, JSON.stringify(copy.failures));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'The page must not overflow horizontally');
      if (links.length > 1) {
        await page.locator('#settings-tab-' + category).focus();
        await page.evaluate(id => {
          const target = document.getElementById(id), scroller = document.querySelector('.page__scroll'), nav = document.querySelector('.settings-navigation');
          scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - nav.getBoundingClientRect().height - 20;
          scroller.dispatchEvent(new Event('scroll'));
        }, links[1].id);
        await page.waitForFunction(id => document.querySelector('.settings-sections [aria-current="location"]')?.getAttribute('href') === '#' + id, links[1].id);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-tab-' + category);
      }
    }
  }
  await page.setViewportSize({ width: 900, height: 900 });
  report.dependentStates = [];
  await page.locator('#settings-tab-models').click();
  const routing = page.locator('#settings-models-routing');
  if (await routing.count()) {
    await routing.getByRole('switch').first().click();
    await routing.locator('.routing').waitFor();
    const copy = await measureCopy(page, [{ selector: '#settings-models-routing .hint:visible, #settings-models-routing .card__head p:visible' }]);
    assert.ok(copy.passed, JSON.stringify(copy.failures));
    report.dependentStates.push({ name: 'Routing enabled', ...copy });
    await routing.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, '900-routing-enabled.png') });
    report.captures.push('900-routing-enabled.png');
    await routing.getByRole('switch').first().click();
  }
  const suggestions = page.locator('#settings-models-classifiers .key-row').filter({ hasText: 'Suggest answers' });
  if (await suggestions.count()) {
    await suggestions.getByRole('switch').click();
    const copy = await measureCopy(page, [{ selector: '#settings-models-classifiers .hint:visible, #settings-models-classifiers .key-row p.muted.small:visible' }]);
    assert.ok(copy.passed, JSON.stringify(copy.failures));
    report.dependentStates.push({ name: 'Suggestions enabled without a key', ...copy });
    await suggestions.getByRole('switch').click();
  }
  await page.locator('#settings-tab-knowledge').click();
  const resolver = page.locator('#settings-knowledge-wiki-resolver');
  if (await resolver.count()) {
    await resolver.getByRole('switch').click();
    const who = resolver.getByRole('combobox', { name: 'Finding resolver' });
    await who.click();
    await page.getByRole('option', { name: 'Lia', exact: false }).click();
    assert.equal(await resolver.getByText('Resolver model', { exact: true }).count(), 0);
    const copy = await measureCopy(page, [{ selector: '#settings-knowledge-wiki-resolver small:visible' }]);
    assert.ok(copy.passed, JSON.stringify(copy.failures));
    report.dependentStates.push({ name: 'Agent resolver', ...copy });
    await resolver.scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(output, '900-agent-resolver.png') });
    report.captures.push('900-agent-resolver.png');
    await who.click();
    await page.getByRole('option', { name: 'Built-in resolver', exact: true }).click();
    await resolver.getByText('Resolver model', { exact: true }).waitFor();
    await resolver.getByRole('switch').click();
  }
  // Settings reuses the contextual Wiki import and schema flows.
  await page.locator('#settings-tab-knowledge').click();
  await page.locator('.settings-sections a[href="#settings-knowledge-wiki-import"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-settings-scrolling]'));
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('#settings-knowledge-wiki-import').getByRole('button', { name: 'Import…', exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles([]);
  await page.locator('.wk-stage').waitFor();
  report.importFlow = true;
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Settings' }).first().click();
  await page.locator('#settings-tab-knowledge').click();
  await page.locator('.settings-sections a[href="#settings-knowledge-wiki-rules"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-settings-scrolling]'));
  await page.locator('#settings-knowledge-wiki-rules button').click();
  await page.getByRole('heading', { name: 'Wiki schema', exact: true }).first().waitFor();
  report.schemaFlow = true;
  await page.locator('.sidebar .nav-item').filter({ hasText: 'Settings' }).first().click();
  // Reduced motion follows the same section geometry without scheduling a scroll transition.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.locator('#settings-tab-app').click();
  await page.locator('.settings-sections a[href="#settings-app-updates"]').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-app-updates');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.locator('#settings-tab-app').click();
  await page.getByRole('radio', { name: 'Português', exact: true }).click();
  await page.locator('#settings-tab-knowledge').filter({ hasText: 'Conhecimento' }).waitFor();
  for (const category of ['app', 'workspace', 'agents', 'models', 'knowledge', 'connections']) {
    const tab = page.locator('#settings-tab-' + category);
    if (!(await tab.count())) continue;
    await tab.click();
    const name = 'pt-900-' + category + '.png';
    await page.screenshot({ path: join(output, name) });
    report.captures.push(name);
    const labels = await measureCopy(page, [{ selector: '.settings-pages button', maxLines: 1 }, { selector: '.settings-sections a', maxLines: 1 }]);
    assert.ok(labels.passed, JSON.stringify(labels.failures));
  }
  report.localeNavigation = true;
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (error) {
  report.failure = String(error.stack || error);
  report.log = log;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGKILL');
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, captures: report.captures.length, sections: report.navigation?.length, copyFailures: report.copy?.flatMap(c => c.failures).length }));
}
