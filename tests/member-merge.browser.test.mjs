// Real dialog + CSS, synthetic API only. Never contacts a tenant or executes a real merge.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';

let browser, server, origin;
const members = {
  a: { id: 'a', first_name: 'Alice', last_name: 'Original', email: 'alice@example.invalid', mobile: '', biography: 'Long biography '.repeat(60), show_in_directory: false, organization_id: 'one' },
  b: { id: 'b', first_name: 'Beth', last_name: 'Other', email: 'beth@example.invalid', mobile: '123', biography: 'Short', show_in_directory: true, organization_id: 'two' },
  c: { id: 'c', first_name: 'Cathy', email: 'cathy@example.invalid', organization_id: 'one' },
};
const fields = ['first_name', 'last_name', 'email', 'mobile', 'landline', 'job_title', 'biography', 'profile_photo_url', 'linkedin_url', 'twitter_url', 'show_in_directory', 'organization_id'];
function preview(body) {
  return { source: members[body.sourceId], target: members[body.targetId], copyableCoreFields: fields,
    sourcePreferenceValues: [{ field_id: 'multi', value: body.sourceId === 'a' ? '["A","B"]' : '["C"]' }, { field_id: 'empty', value: '' }],
    targetPreferenceValues: [{ field_id: 'multi', value: body.targetId === 'a' ? '["A","B"]' : '["C"]' }, { field_id: 'empty', value: '' }],
    sourceEngagement: { eventsAttended: body.sourceId === 'a' ? 9 : 2, articlesPublished: 0, jobsPosted: 0, awards: 0, engagementAwards: 0 },
    sameOrganisation: members[body.sourceId].organization_id === members[body.targetId].organization_id };
}
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import MemberMergeDialog from './client/src/components/MemberMergeDialog.jsx';
      import {Toaster} from 'sonner';
      function App() { const [open,setOpen]=useState(true); return <><button onClick={()=>setOpen(true)}>Reopen</button>
        <MemberMergeDialog open={open} onOpenChange={setOpen} currentMember={${JSON.stringify(members.a)}}
          customFields={[{id:'multi',label:'Interests'},{id:'empty',label:'Empty custom'}]}
          organizations={[{id:'one',name:'First org'},{id:'two',name:'Second org'}]}
          onMerged={(result,ids)=>{window.merged=ids}}/><Toaster/></>; }
      const queryClient=new QueryClient({defaultOptions:{queries:{retry:false}}});
      window.refetchMerge=()=>queryClient.refetchQueries({queryKey:['member-merge-preview'],type:'active'});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={queryClient}><App/></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 10 * 1024 * 1024 });
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url.startsWith('/api/')) { res.statusCode = 500; return res.end('Unmocked API forbidden'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function setup(options = {}) {
  const page = await browser.newPage({ viewport: options.viewport || { width: 1100, height: 900 } });
  const calls = [];
  await page.route('**/*', async route => {
    const req = route.request();
    if (!req.url().startsWith(origin)) return route.abort();
    if (req.url().includes('/api/admin/members/paginated')) return route.fulfill({ json: { members: [members.b, members.c] } });
    if (req.url().endsWith('/api/admin/members/merge')) {
      const body = req.postDataJSON(); calls.push(body);
      if (body.action === 'execute') return route.fulfill({ status: options.failExecute ? 409 : 200, json: options.failExecute ? { error: 'Billing must be resolved' } : { success: true, warnings: ['Synthetic warning'] } });
      if (options.previewHandler && await options.previewHandler(route, body)) return;
      return route.fulfill({ json: preview(body) });
    }
    return route.continue();
  });
  await page.goto(origin);
  await page.getByTestId('input-merge-search').fill('record');
  await page.getByTestId('merge-candidate-b').click();
  await page.getByTestId('button-merge-next-1').click();
  await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
  return { page, calls };
}
const value = (page, field, id) => page.getByTestId(`value-${field}-${id}`);
async function review(page) {
  await page.getByTestId('button-merge-next-2').click();
  await page.getByTestId('radio-disposal-keep').click();
  await page.getByTestId('checkbox-merge-engagement').click();
  await page.getByTestId('button-merge-next-3').click();
}

for (const survivor of ['a', 'b']) test(`independent choices, back navigation and exact execute payload: keep ${survivor}`, async () => {
  const { page, calls } = await setup();
  try {
    await expect(value(page, 'core:first_name', 'a')).toBeChecked();
    await value(page, 'core:first_name', 'b').click();
    await value(page, 'core:mobile', 'b').click();
    await value(page, 'core:mobile', 'a').click(); // explicit blank original value
    await value(page, 'custom:multi', 'b').click();
    await value(page, 'custom:empty', 'a').click(); // explicit already-selected blank
    await expect(page.getByTestId('survivor-a')).toBeChecked();
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await expect(value(page, 'core:mobile', 'a')).toBeChecked();
    await expect(value(page, 'custom:empty', 'a')).toBeChecked();
    await expect(value(page, 'core:show_in_directory', 'b')).toBeChecked();
    if (survivor === 'a') {
      await page.getByTestId('survivor-a').click();
      await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    }
    await expect(value(page, 'core:first_name', 'b')).toBeChecked();
    await review(page);
    await expect(page.getByRole('dialog')).toContainText('Merging source into kept record');
    await page.getByTestId('button-merge-back').click();
    await expect(page.getByRole('dialog')).toContainText(`Source totals: ${survivor === 'a' ? 2 : 9} events`);
    await expect(page.getByTestId('radio-disposal-keep')).toBeChecked();
    await page.getByTestId('button-merge-back').click();
    await expect(value(page, 'custom:multi', 'b')).toBeChecked();
    await page.getByTestId('button-merge-next-2').click();
    await page.getByTestId('button-merge-next-3').click();
    await page.getByTestId('button-merge-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.deepEqual(calls.find(c => c.action === 'execute'), {
      action: 'execute', sourceId: survivor === 'a' ? 'b' : 'a', targetId: survivor,
      coreFields: survivor === 'a' ? ['first_name'] : ['mobile'],
      customFieldIds: survivor === 'a' ? ['multi'] : ['empty'], includeEngagement: true, sourceDisposal: 'keep',
    });
    assert.deepEqual(await page.evaluate(() => window.merged), { sourceId: survivor === 'a' ? 'b' : 'a', targetId: survivor });
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByTestId('input-merge-search')).toHaveValue('');
    await expect(page.getByTestId('button-merge-next-1')).toBeDisabled();
  } finally { await page.close(); }
});

test('pair replacement resets fields and disposal; failed execution remains recoverable', async () => {
  const { page, calls } = await setup({ failExecute: true });
  try {
    await value(page, 'custom:multi', 'b').click();
    await page.getByTestId('button-merge-back').click();
    await page.getByTestId('merge-candidate-c').click();
    await page.getByTestId('button-merge-next-1').click();
    await expect(value(page, 'custom:multi', 'a')).toBeChecked();
    await page.getByTestId('button-merge-next-2').click();
    await expect(page.getByTestId('radio-disposal-reassign')).toBeChecked();
    await expect(page.getByRole('dialog')).toContainText('does not cancel Stripe or GoCardless payments');
    await page.getByTestId('button-merge-next-3').click();
    await page.getByTestId('button-merge-confirm').click();
    await expect(page.getByText('Billing must be resolved')).toBeVisible();
    await expect(page.getByTestId('button-merge-confirm')).toBeEnabled();
    assert.equal(calls.at(-1).sourceId, 'c');
    assert.deepEqual(calls.at(-1).customFieldIds, []);
  } finally { await page.close(); }
});

for (const second of ['b', 'c']) test(`same-direction refresh on review preserves leave-untouched disposal: ${second}`, async () => {
  const { page, calls } = await setup();
  try {
    if (second === 'c') {
      await page.getByTestId('button-merge-back').click();
      await page.getByTestId('merge-candidate-c').click();
      await page.getByTestId('button-merge-next-1').click();
      await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    }
    await review(page);
    await expect(page.getByRole('dialog')).toContainText('Left untouched');
    const previousRequests = calls.filter(c => c.action === 'preview').length;
    await page.evaluate(() => window.refetchMerge());
    await expect(page.getByTestId('button-merge-confirm')).toBeEnabled();
    assert.equal(calls.filter(c => c.action === 'preview').length, previousRequests + 1);
    await expect(page.getByRole('dialog')).toContainText('Left untouched');
    await page.getByTestId('button-merge-back').click();
    await expect(page.getByTestId('radio-disposal-keep')).toBeChecked();
    await page.getByTestId('button-merge-next-3').click();
    await page.getByTestId('button-merge-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(calls.at(-1).sourceDisposal, 'keep');
    assert.equal(calls.at(-1).sourceId, second);
  } finally { await page.close(); }
});

test('late direction preview cannot overwrite current pair; failed preview blocks progression and retries', async () => {
  let held, fail = false;
  const { page } = await setup({ previewHandler: async (route, body) => {
    if (body.targetId === 'b') { held = route; return true; }
    if (fail) { await route.fulfill({ status: 503, json: { error: 'Preview unavailable' } }); return true; }
    return false;
  } });
  try {
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeDisabled();
    await page.getByTestId('button-merge-back').click();
    await page.getByTestId('merge-candidate-c').click();
    fail = true;
    await page.getByTestId('button-merge-next-1').click();
    await expect(page.getByRole('alert')).toContainText('Preview unavailable');
    await held.fulfill({ json: preview({ sourceId: 'a', targetId: 'b' }) });
    await expect(page.getByTestId('button-merge-next-2')).toBeDisabled();
    fail = false;
    await page.getByRole('button', { name: 'Retry preview' }).click();
    await expect(value(page, 'core:first_name', 'c')).toBeVisible();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await expect(page.getByTestId('column-b')).toHaveCount(0);
  } finally { await page.close(); }
});

test('opaque colors, aligned long values, keyboard controls and narrow comparison', async () => {
  const { page } = await setup({ viewport: { width: 390, height: 844 } });
  try {
    const card = input => input.locator('..');
    await expect(page.getByTestId('column-a')).toHaveCSS('background-color', 'rgb(254, 252, 232)');
    await expect(card(value(page, 'core:first_name', 'a'))).toHaveCSS('background-color', 'rgb(240, 253, 244)');
    await value(page, 'core:first_name', 'b').focus();
    await page.keyboard.press('Space');
    await expect(value(page, 'core:first_name', 'b')).toBeChecked();
    await expect(card(value(page, 'core:first_name', 'a'))).toHaveCSS('background-color', 'rgb(255, 255, 255)');
    await expect(card(value(page, 'core:first_name', 'b'))).toHaveCSS('outline-style', 'solid');
    await expect(page.getByTestId('survivor-a')).toBeChecked();
    const a = await card(value(page, 'core:biography', 'a')).boundingBox();
    const b = await card(value(page, 'core:biography', 'b')).boundingBox();
    assert.equal(a.y, b.y); assert.equal(a.height, b.height);
    await expect(card(value(page, 'core:biography', 'a'))).toContainText(members.a.biography.trim());
    const region = page.getByRole('region', { name: 'Member records comparison' });
    assert.ok(await region.evaluate(el => el.scrollWidth > el.clientWidth));
    await page.getByTestId('survivor-a').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('survivor-b')).toBeChecked();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    assert.ok((await page.getByTestId('column-a').boundingBox()).x < (await page.getByTestId('column-b').boundingBox()).x);
  } finally { await page.close(); }
});
