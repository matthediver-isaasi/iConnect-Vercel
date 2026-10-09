// Isolated browser fixtures: real modal and hooks, no authentication bypass in
// the application and no requests to real tenant/accounting services.
// Run after npm run build so the fixture uses the application's compiled CSS.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

let browser, server, origin;
const options = {
  provider: 'xero', syncedAt: '2026-10-09T00:00:00Z',
  items: [
    { id: 'OUTPUT2', name: '20% VAT on Income', rateBps: 2000, selectable: true },
    { id: 'ZERO', name: 'Zero Rated Income', rateBps: 0, selectable: false, reason: 'Configure in Sales settings first' },
  ],
  note: 'Sales uses one accounting tax code per tax rate.',
};
before(async () => {
  const output = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {MemoryRouter} from 'react-router-dom';
      import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
      import {EditDialog} from './client/src/pages/sales/Catalogue.jsx';
      const edit = new URLSearchParams(location.search).has('edit');
      const row = {id:'existing',name:'Existing product',code:'EXISTING',currency:'GBP',
        standardPriceMinor:12500,minimumPriceMinor:null,costMinor:0,
        taxRateBps:2000,taxTreatment:'standard',capacityMetadata:{venueZone:'Hall A',nested:{keep:true}}};
      const config={type:'products', ...(edit?{row}:{})};
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      createRoot(document.getElementById('root')).render(
        <MemoryRouter><QueryClientProvider client={client}>
          <EditDialog config={config} categories={[{id:'category',name:'Training'}]} categoriesLoading={false}
            products={[]} events={{items:[{id:'event',name:'Fixture event',kind:'complex',ticketOptions:[{id:'ticket',name:'Group place',delegateCapacity:4}]}]}}
            saving={false} onClose={()=>{}} onSave={data=>{window.savedProduct=data}} />
        </QueryClientProvider></MemoryRouter>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'fixture-api-only',
      setup(builder) {
        builder.onResolve({ filter: /base44Client$/ }, () => ({ path: 'api', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: `export const base44={_apiRequest:async(path,options)=>{const r=await fetch(path,options);const b=await r.json();if(!r.ok)throw Error(b.error);return b}};`,
        }));
      },
    }],
  });
  const cssFiles = (await readdir('dist/public/assets')).filter(name => /^index-.*\.css$/.test(name));
  assert.ok(cssFiles.length, 'Run npm run build first');
  const css = await readFile(`dist/public/assets/${cssFiles[0]}`);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(output.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url === '/api/sales/catalogue/tax-options') {
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(options));
    }
    if (req.url.startsWith('/api/')) { res.statusCode = 500; return res.end('Unexpected fixture API'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
async function open(viewport, suffix = '', failTax = false) {
  const page = await browser.newPage({ viewport });
  await page.route('**/*', route => {
    const url = route.request().url();
    if (!url.startsWith(origin)) return route.abort();
    if (failTax && url.endsWith('/tax-options')) return route.fulfill({
      status: 503, contentType: 'application/json', body: '{"error":"Fixture unavailable"}',
    });
    return route.continue();
  });
  await page.goto(origin + '/' + suffix);
  await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').evaluate(async el => {
    await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
  });
  return page;
}
for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 640 }]) {
  test(`product scroll, currency and tax choices at ${viewport.width}px`, async () => {
    const page = await open(viewport);
    try {
      const form = page.locator('form');
      await form.locator('input').nth(0).fill('Test product');
      await form.locator('input').nth(1).fill('TEST_PRODUCT');
      await page.getByLabel('Category', { exact: true }).selectOption('category');
      await page.getByLabel('Standard price', { exact: true }).fill('125.00');
      await page.getByLabel('Standard price', { exact: true }).click();
      await page.mouse.wheel(0, 1000);
      await page.waitForFunction(() => document.querySelector('form').scrollTop > 0);
      await page.getByLabel('Cost', { exact: true }).fill('0.29');
      await page.getByLabel('Synced VAT code').selectOption('OUTPUT2');
      assert.equal(await page.getByLabel('VAT rate', { exact: true }).inputValue(), '20%');
      assert.equal(await page.locator('option[value="ZERO"]').isDisabled(), true);
      await page.getByLabel('Event', { exact: true }).selectOption('event');
      await page.getByLabel('Ticket type', { exact: true }).selectOption('ticket');
      assert.match(await form.innerText(), /Delegates per selected ticket: 4/);
      assert.ok(!(await form.innerText()).includes('Capacity metadata'));
      await page.getByRole('button', { name: 'Save catalogue item' }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/tmp/sales-product-modal-${viewport.width}.png` });
      await page.getByRole('button', { name: 'Save catalogue item' }).click();
      const saved = await page.evaluate(() => window.savedProduct);
      assert.equal(saved.standardPriceMinor, 12500);
      assert.equal(saved.minimumPriceMinor, null);
      assert.equal(saved.costMinor, 29);
      assert.equal(saved.taxRateBps, 2000);
      assert.deepEqual(saved.capacityMetadata, {});
      assert.equal(saved.eventReference.ticketTypeId, 'ticket');
    } finally { await page.close(); }
  });
}
test('existing product retains money, tax and hidden metadata when tax lookup fails', async () => {
  const page = await open({ width: 1280, height: 720 }, '?edit=1', true);
  try {
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByLabel('Standard price', { exact: true }).inputValue(), '125.00');
    await page.getByRole('button', { name: 'Save catalogue item' }).click();
    const saved = await page.evaluate(() => window.savedProduct);
    assert.equal(saved.standardPriceMinor, 12500);
    assert.equal(saved.costMinor, 0);
    assert.equal(saved.taxRateBps, 2000);
    assert.equal(saved.taxTreatment, 'standard');
    assert.deepEqual(saved.capacityMetadata, { venueZone: 'Hall A', nested: { keep: true } });
  } finally { await page.close(); }
});
