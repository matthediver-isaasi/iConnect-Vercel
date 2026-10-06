import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';

// Controlled browser fixture: real React navigation hook, no live tenant data.
const result = await build({
  stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { BrowserRouter, useLocation } from 'react-router-dom';
    import { useHomepageCanonical } from './client/src/hooks/useHomepageCanonical.js';
    function App() {
      useHomepageCanonical();
      const location = useLocation();
      return React.createElement('main', null, location.pathname === '/' ? 'Selected homepage' : 'Direct page');
    }
    createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter, null, React.createElement(App)));
  `, resolveDir: process.cwd(), loader: 'jsx' },
  bundle: true, write: false, format: 'iife',
});
const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/app.js') return route.fulfill({ contentType: 'application/javascript', body: result.outputFiles[0].text });
    if (url.pathname === '/api/public/homepage-route') return route.fulfill({
      json: { target: '/?campaign=one#section' },
    });
    if (url.pathname.endsWith('.svg')) return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' });
    return route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="icon" id="dynamic-favicon" href="/tenant.svg"></head><body><div id="root"></div><script src="/app.js"></script></body></html>' });
  });
  await page.goto('https://fixture.test/welcome?campaign=one#section');
  await page.waitForURL('https://fixture.test/?campaign=one#section');
  await page.waitForSelector('main');
  assert.equal(await page.locator('main').textContent(), 'Selected homepage');
  assert.equal(await page.locator('link[rel="icon"]').getAttribute('href'), '/tenant.svg');
  await page.goto('https://fixture.test/welcome?_canvasPreview=1');
  await page.waitForSelector('main');
  assert.equal(new URL(page.url()).pathname, '/welcome');
  console.log('Browser fixture passed: canonical navigation, query/hash preservation, preview exemption, icon persistence.');
} finally { await browser.close(); }
