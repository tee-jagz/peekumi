import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { Repository } from '../src/engine.mjs';
import { createServer } from '../src/server.mjs';

const repo = new Repository(process.env.STRATA_TEST_REPO || process.cwd(), { python: process.env.STRATA_PYTHON || (process.platform === 'darwin' ? '/usr/bin/python3' : 'python3') });
const head = await repo.resolve('HEAD');
let base; try { base = await repo.resolve(process.env.STRATA_TEST_BASE || 'HEAD~1'); } catch { base = head; }
const token = 'browser-test-token';
const server = createServer(repo, { token, base });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.STRATA_BROWSER_CHANNEL ? { channel: process.env.STRATA_BROWSER_CHANNEL } : {}) });
await mkdir('test-results', { recursive: true });
try {
  const data = await repo.compare(base, head);
  const target = data.files.find(file => file.status === 'changed' && file.symbols.length > 0 && file.path.endsWith('.py')) || data.files.find(file => file.symbols.length > 0);
  assert.ok(target, 'Test repository needs an analysable source file');
  for (const viewport of [{ width: 390, height: 844 }, { width: 1366, height: 768 }]) {
    const page = await browser.newPage({ viewport }); const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.locator('#connect').waitFor({ state: 'visible' });
    await page.goto(url + '/#token=' + token); await page.reload();
    await page.locator('.node').first().waitFor({ state: 'visible', timeout: 45000 });
    await page.locator('#notice').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#change-total').textContent(), String(data.files.filter(f => f.status !== 'unchanged').length));
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal page overflow');
    await page.screenshot({ path: `test-results/${viewport.width}-overview.png`, fullPage: true });
    const folder = target.path.split('/')[0];
    if (target.path.includes('/')) {
      await page.locator(`.node[data-path="${folder}"]`).click();
      assert.equal(await page.locator('#scope-title').textContent(), folder);
      await page.screenshot({ path: `test-results/${viewport.width}-component.png`, fullPage: true });
    }
    await page.locator('#search').fill(target.path);
    await page.locator(`.node[data-path="${target.path}"]`).click();
    await page.waitForFunction(() => document.querySelector('#source-code').textContent !== 'Loading source…');
    assert.ok((await page.locator('#source-title').textContent()).includes(target.path));
    if (target.status === 'changed') assert.ok(await page.locator('.code-line.addition, .code-line.deletion').count() > 0);
    await page.locator('.node').first().click();
    assert.equal(await page.locator('[data-view="after"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('.code-line.highlight').count() > 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No overflow in source view');
    await page.screenshot({ path: `test-results/${viewport.width}-source.png`, fullPage: true });
    await page.locator('#source-panel').screenshot({ path: `test-results/${viewport.width}-source-detail.png` });
    await page.locator('[data-view="before"]').click();
    assert.equal(await page.locator('[data-view="before"]').getAttribute('aria-pressed'), 'true');
    await page.locator('.crumb').first().click(); await page.locator('#changed-only').check();
    assert.equal(await page.locator('.node[data-status="unchanged"]').count(), 0);
    await page.locator('#search').fill('no-such-file-strata-0000'); assert.ok(await page.locator('#map .empty').isVisible());
    await page.locator('#search').fill(''); await page.locator('#changed-only').uncheck();
    await page.locator('#base').selectOption(head); await page.locator('#notice').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelector('#change-total').textContent === '0');
    assert.deepEqual(errors, []); await page.close();
    console.log(`PASS ${viewport.width}×${viewport.height}: authentication, map, navigation, source, filters, comparison, overflow`);
  }
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
