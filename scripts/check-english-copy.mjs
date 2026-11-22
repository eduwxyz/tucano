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
  const inspect = async (surface, width) => {
    await page.evaluate(() => document.fonts.ready);
    if (surface === 'wiki') await page.locator('.wk-git').waitFor();
    const rows = await page.locator('.card__head p, .card .hint, .key-row p.muted.small, .wk-setting small, .wk-settings > section > small').evaluateAll(nodes => nodes.filter(el => el.getBoundingClientRect().height > 0).map(el => {
      const text = el.textContent.trim(),
        css = getComputedStyle(el),
        rect = el.getBoundingClientRect();
      const lines = node => {
        const tops = new Set();
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round(r.top * 10) / 10);
        }
        return tops.size;
      };
      const clone = el.cloneNode(false);
      Object.assign(clone.style, {
        position: 'fixed',
        top: '-10000px',
        left: '0',
        width: `${rect.width}px`,
        height: 'auto',
        minHeight: '0',
        maxHeight: 'none',
        display: 'block',
        font: css.font,
        lineHeight: css.lineHeight,
        letterSpacing: css.letterSpacing
      });
      document.body.append(clone);
      const sample = 'Choose a model for this task. Agents use these settings for new replies. You can change them at any time. '.repeat(8);
      let low = 0,
        high = sample.length;
      while (low < high) {
        const n = Math.ceil((low + high) / 2);
        clone.textContent = sample.slice(0, n);
        if (lines(clone) <= 2) low = n;else high = n - 1;
      }
      const best = low;
      clone.remove();
      return {
        text,
        characters: [...text].length,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        font: css.fontFamily,
        fontSize: css.fontSize,
        lineHeight: css.lineHeight,
        lines: lines(el),
        sampleTwoLineCharacters: best
      };
    }));
    report.measurements.push({
      surface,
      viewport: width,
      rows
    });
    const cards = page.locator('.page .card');
    for (let i = 0; i < (await cards.count()); i++) {
      const card = cards.nth(i);
      if (!(await card.isVisible())) continue;
      const title = (await card.locator('h2').first().textContent().catch(() => String(i))).trim();
      const name = `${width}-${surface}-${String(i).padStart(2, '0')}-${title.replace(/[^a-z0-9]+/gi, '-')}.png`;
      await card.screenshot({
        path: join(output, name)
      });
      report.captures.push(name);
    }
    if (surface === 'wiki') {
      const name = `${width}-wiki-settings.png`;
      await page.locator('.wk-settings').screenshot({
        path: join(output, name)
      });
      report.captures.push(name);
    }
  };
  for (const width of [1280, 900]) {
    await page.setViewportSize({
      width,
      height: 900
    });
    await page.locator('.sidebar .nav-item').filter({
      hasText: 'Settings'
    }).first().click();
    await page.getByRole('heading', {
      name: 'Settings',
      exact: true
    }).waitFor();
    for (const tab of ['General', 'Models', 'Agents', 'Phone']) {
      const target = page.getByRole('tab', {
        name: tab,
        exact: true
      });
      if (!(await target.count())) continue;
      await target.click();
      await inspect(tab.toLowerCase(), width);
    }
    await page.locator('.sidebar .nav-item').filter({
      hasText: 'Wiki'
    }).first().click();
    await page.getByRole('button', {
      name: 'Wiki settings',
      exact: true
    }).click();
    await page.locator('.wk-settings').waitFor();
    await inspect('wiki', width);
    await page.locator('.wk-settings header button').click();
  }
  if (!process.argv.includes('--baseline')) {
    for (const m of report.measurements) for (const row of m.rows) {
      if (row.text.startsWith('Bringing the Tucano from your computer?')) continue;
      assert.ok(row.lines <= 2, m.surface + ' ' + m.viewport + 'px: ' + row.lines + ' lines: ' + row.text);
    }
  }
  assert.deepEqual(report.errors, []);
  report.passed = true;
} catch (e) {
  report.failure = String(e.stack || e);
  report.log = log;
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill('SIGKILL');
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({
    passed: report.passed,
    failure: report.failure,
    captures: report.captures.length,
    rows: report.measurements.reduce((n, m) => n + m.rows.length, 0),
    log: report.failure ? log.slice(-2000) : undefined
  }));
}
