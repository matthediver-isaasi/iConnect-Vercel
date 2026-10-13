import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

test('mounted branding hydration never replaces normalized discovery with raw tenant artwork', async () => {
  assert.ok(process.env.REPLIT_DEV_DOMAIN, 'Start the development workflow first');
  const browser = await chromium.launch({
    executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    let brandingReads = 0;
    await page.route('**/api/public/tenant-branding*', route => {
      brandingReads++;
      return route.fulfill({ json: { success: true, branding: {
        id: 'fixture', name: 'Favicon fixture', faviconUrl: 'https://invalid.example/non-square-original.png',
      } } });
    });
    await page.goto(`https://${process.env.REPLIT_DEV_DOMAIN}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.title === 'Favicon fixture');
    await page.waitForTimeout(1000);
    assert.ok(brandingReads > 0);
    const icons = await page.locator('link[rel*=icon]').evaluateAll(nodes => nodes.map(n => ({
      rel: n.rel, href: n.getAttribute('href'), type: n.type, sizes: n.sizes.value,
    })));
    assert.deepEqual(icons, [
      { rel: 'icon', href: '/favicon-192.png', type: 'image/png', sizes: '192x192' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', type: 'image/png', sizes: '180x180' },
    ]);
  } finally { await browser.close(); }
});
