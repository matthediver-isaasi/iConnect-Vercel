// Isolated browser verification: a standalone fixture server, never the tenant
// application. All non-fixture browser requests are aborted and fail the run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const server = spawn(process.execPath, ['client/src/lib/formPrefillBarrier.browser.fixture-server.mjs'], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Fixture startup timed out')), 30000);
    server.stdout.on('data', chunk => {
      if (String(chunk).includes('Isolated prefill fixture:')) { clearTimeout(timeout); resolve(); }
    });
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Fixture server exited: ${code}`)); });
    server.stderr.on('data', chunk => process.stderr.write(chunk));
  });
  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  const unexpected = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (route.request().url().startsWith('http://127.0.0.1:5059/')) return route.continue();
    unexpected.push(route.request().url());
    return route.abort();
  });
  await page.goto('http://127.0.0.1:5059/fixture');
  const status = page.getByRole('status');
  await status.waitFor();
  assert.equal(await status.textContent(), 'Please wait while we load some data');
  await page.screenshot({ path: 'client/src/lib/form-prefill-overlay.desktop.jpg', type: 'jpeg' });
  assert.equal(await page.locator('input').first().isDisabled(), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.prefillFixture.submits()), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'client/src/lib/form-prefill-overlay.mobile.jpg', type: 'jpeg' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.evaluate(() => window.prefillFixture.reject());
  await page.getByRole('alert').waitFor();
  await page.getByRole('button', { name: 'Retry loading data' }).click();
  await status.waitFor();
  assert.equal(await page.evaluate(() => window.prefillFixture.attempts()), 2);
  await page.evaluate(() => window.prefillFixture.resolve());
  await page.locator('[data-testid="form-prefill-overlay"]').waitFor({ state: 'detached' });
  assert.equal(await page.locator('input').nth(0).inputValue(), 'Maya Reed');
  assert.equal(await page.locator('input').nth(2).inputValue(), 'Keep this draft answer');
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  assert.equal(await page.evaluate(() => window.prefillFixture.submits()), 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpected, []);
  console.log('Browser fixture passed: desktop/mobile overlay, native tab/submit lock, error/retry, applied values and draft preservation. No tenant/provider requests.');
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}
