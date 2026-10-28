import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';

let script, css, image;
test.beforeAll(async () => {
  image = await sharp({ create: { width: 280, height: 140, channels: 3, background: '#007b88' } }).png().toBuffer();
  css = (await postcss([tailwindcss({ config: './tailwind.config.ts' })])
    .process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
  script = (await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MemoryRouter} from 'react-router-dom'; import {Toaster} from 'sonner';
      import EmailCampaigns from './client/src/components/EmailCampaigns.jsx';
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><EmailCampaigns/><Toaster/></MemoryRouter></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'isolate', setup(b) {
      b.onResolve({ filter: /^@\/(api\/base44Client|lib\/queryClient)$/ }, a => ({ path: a.path, namespace: 'mock' }));
      b.onLoad({ filter: /.*/, namespace: 'mock' }, a => ({ contents: a.path.includes('base44')
        ? 'export const base44={entities:new Proxy({}, {get:()=>({list:async()=>[],filter:async()=>[]})})}'
        : 'export const maybeEmitPlanQuotaFromBody=()=>{}' }));
    } }],
  })).outputFiles[0].text;
});

async function mount(page, content, { status = 'sending', failure = false, delay = 0 } = {}) {
  const calls = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/image.png') {
      await new Promise(resolve => setTimeout(resolve, 500));
      return route.fulfill({ contentType: 'image/png', body: image, headers: { 'access-control-allow-origin': '*' } });
    }
    if (url.pathname === '/broken.png') return route.fulfill({ status: 404, body: '' });
    calls.push({ path: url.pathname, method: request.method() });
    if (request.method() !== 'GET') throw new Error(`Unexpected mutation ${url.pathname}`);
    const campaign = { id: 'pdf-test', name: 'Spring / briefing: 2026', subject: 'Saved news', status, ...content };
    let body;
    if (url.searchParams.has('lifecycle')) body = { ready: true };
    else if (url.searchParams.has('summary')) body = { totalSent: 1, totalOpened: 0, totalClicked: 0, sentCampaigns: 1 };
    else if (url.searchParams.has('archive')) body = [campaign];
    else if (url.pathname === '/api/email-campaigns/pdf-test') {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return route.fulfill({ status: failure ? 503 : 200, contentType: 'application/json', body: JSON.stringify(campaign) });
    } else throw new Error(`Unexpected read ${url}`);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('https://pdf.example.test/');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId('button-download-pdf-pdf-test')).toBeVisible();
  return { calls, errors };
}

for (const status of ['sending', 'sent']) test(`${status}: saved HTML fallback downloads a real PDF without preview or mutation`, async ({ page }) => {
  const { calls, errors } = await mount(page, {
    design_json: { blocks: [{ id: 'unknown', type: 'unsupported' }] },
    html_content: '<h1>Saved campaign heading</h1><p>Dear {{first_name}}, generic content.</p><a href="https://example.org/resource">Read resource</a>',
  }, { status, delay: 300 });
  expect(calls.filter(c => c.path.endsWith('pdf-test'))).toHaveLength(0);
  const downloadPromise = page.waitForEvent('download');
  const button = page.getByTestId('button-download-pdf-pdf-test');
  await button.click();
  await expect(button).toBeDisabled();
  await button.evaluate(element => element.click());
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('campaign-Spring-briefing-2026-pdf-test.pdf');
  const bytes = await readFile(await download.path());
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBe(1);
  expect(pdf.getPages()[0].node.Annots().size()).toBe(1);
  expect(calls.filter(c => c.path.endsWith('pdf-test'))).toHaveLength(1);
  expect(calls.every(c => c.method === 'GET')).toBe(true);
  expect(errors).toEqual([]);
  await expect(button).toBeEnabled();
  expect(await page.locator('iframe').count()).toBe(0);
});

test('image-rich columns and long email retain all content across PDF pages', async ({ page }) => {
  const paragraphs = Array.from({ length: 90 }, (_, i) => `<p>Paragraph ${i}: Readable saved email text, including the final paragraph.</p>`).join('');
  await mount(page, { design_json: { blocks: [
    { id: 'heading', type: 'text', content: '<h1>Brand newsletter</h1>', styles: {} },
    { id: 'cols', type: 'columns', styles: {}, columns: [
      { id: 'left', width: '50%', blocks: [{ id: 'image', type: 'image', src: 'https://pdf.example.test/image.png', styles: {} }] },
      { id: 'right', width: '50%', blocks: [{ id: 'copy', type: 'text', content: '<h2>Column heading</h2><p>Column copy alongside the brand image.</p>', styles: {} }] },
    ] },
    { id: 'long', type: 'text', content: paragraphs, styles: {} },
  ] } });
  // Inspect actual rendered export surface before download, not mailbox UI.
  await page.evaluate(() => {
    const observer = new MutationObserver(() => {
      const frame = document.querySelector('iframe');
      if (!frame?.contentDocument?.body?.textContent) return;
      window.exportText = frame.contentDocument.body.textContent;
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  const promise = page.waitForEvent('download');
  await page.getByTestId('button-download-pdf-pdf-test').click();
  const download = await promise;
  const bytes = await readFile(await download.path());
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPageCount()).toBeGreaterThan(2);
  expect(bytes.length).toBeGreaterThan(50000);
  // Independently render the downloaded PDF, not just the source DOM.
  execFileSync('pdftoppm', ['-png', '-scale-to', '1200', await download.path(), '/tmp/campaign-pdf-page']);
  for (let i = 1; i <= pdf.getPageCount(); i++) {
    const pixels = await sharp(`/tmp/campaign-pdf-page-${i}.png`).removeAlpha().raw().toBuffer();
    let nonwhite = 0;
    for (let j = 0; j < pixels.length; j += 3) if (pixels[j] < 200) nonwhite++;
    expect(nonwhite).toBeGreaterThan(1000);
  }
});

for (const fixture of [
  { title: 'missing content', content: {}, error: /no saved email content/ },
  { title: 'invisible content', content: { html_content: '<p style="display:none">Hidden</p>' }, error: /no visible printable content/ },
  { title: 'image failure', content: { html_content: '<h1>News</h1><img src="/broken.png">' }, error: /image could not load/ },
  { title: 'read failure', content: {}, failure: true, error: /Unable to read this campaign/ },
]) test(`${fixture.title} shows actionable failure without a download`, async ({ page }) => {
  const { calls } = await mount(page, fixture.content, fixture);
  let downloaded = false;
  page.on('download', () => { downloaded = true; });
  await page.getByTestId('button-download-pdf-pdf-test').click();
  await expect(page.getByText(fixture.error)).toBeVisible();
  await expect(page.getByTestId('button-download-pdf-pdf-test')).toBeEnabled();
  expect(downloaded).toBe(false);
  expect(await page.locator('iframe').count()).toBe(0);
  expect(calls.every(c => c.method === 'GET')).toBe(true);
});

test('saved campaign slots survive changed templates without recipient lookup or editor chrome', async ({ page }) => {
  const { calls } = await mount(page, { email_template_id: 'subsequently-edited-template',
    design_json: { slotValues: { title: '<p><strong>Saved rich heading</strong></p>', plain: '<literal> {{member.first_name}}',
      photo: 'https://pdf.example.test/image.png', button: 'Saved button', link: 'https://example.org/saved-link', hidden: 'Must not appear' },
    richSlots: ['title'], hiddenSlots: ['hidden'],
    blocks: [
      { id: 'title', type: 'dynamic_text', token: 'title' },
      { id: 'plain', type: 'dynamic_text', token: 'plain' },
      { id: 'photo', type: 'dynamic_image', token: 'photo', src: '/broken.png' },
      { id: 'button', type: 'dynamic_button', token: 'button', linkToken: 'link', content: 'Template button', href: 'https://example.org/template' },
      { id: 'section', type: 'section', children: [{ id: 'hidden', type: 'dynamic_text', token: 'hidden' }] },
    ] } });
  // This represents the linked template changing after the campaign snapshot.
  // It must never be read by the export.
  await page.route('**/api/**template**', route => {
    throw new Error(`Export consulted a subsequently edited template: ${route.request().url()}`);
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('button-download-pdf-pdf-test').click();
  const surface = page.frameLocator('iframe[aria-hidden="true"]').locator('body');
  await expect(surface).toContainText('Saved rich heading');
  await expect(surface).toContainText('<literal> {{member.first_name}}');
  await expect(surface).toContainText('Saved button');
  await expect(surface).not.toContainText('Must not appear');
  await expect(surface).not.toContainText('Template button');
  await expect(surface.locator('button,[data-testid^="campaign-slot-"]')).toHaveCount(0);
  const download = await downloadPromise;
  const pdf = await PDFDocument.load(await readFile(await download.path()));
  expect(pdf.getPages()[0].node.Annots().size()).toBe(1);
  expect(calls.filter(call => call.path.endsWith('pdf-test'))).toHaveLength(1);
  expect(calls.every(call => call.method === 'GET' && !call.path.includes('recipient'))).toBe(true);
});
