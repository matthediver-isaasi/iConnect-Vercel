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
    disposalSafety: { success: true },
     sourceCpd: { balance: body.sourceId === 'a' ? '-1.250001' : '2.500001', historyCount: body.sourceId === 'a' ? 31 : 3 },
    financialSummaries: Object.fromEntries([body.sourceId, body.targetId].map(id => [id, {
      membership: { state: id === 'a' ? 'active_paid' : 'none' },
      directDebit: { active: id === 'a', verified: true, statuses: id === 'a' ? ['active'] : [] },
    }])),
    sourcePreferenceValues: [{ field_id: 'class', value: body.sourceId === 'a' ? 'Full member' : '' }, { field_id: 'multi', value: body.sourceId === 'a' ? '["A","B"]' : '["C"]' }, { field_id: 'empty', value: '' }],
    targetPreferenceValues: [{ field_id: 'class', value: body.targetId === 'a' ? 'Full member' : '' }, { field_id: 'multi', value: body.targetId === 'a' ? '["A","B"]' : '["C"]' }, { field_id: 'empty', value: '' }],
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
          customFields={[{id:'class',name:'member_class',label:'Member class'},{id:'multi',label:'Interests'},{id:'empty',label:'Empty custom'}]}
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
  await expect(page.getByTestId('button-merge-next-1')).toBeDisabled();
  await assertSelectionOnly(page);
  await page.getByTestId('input-merge-search').fill('record');
  await page.getByTestId('merge-candidate-b').click();
  await assertSelectionOnly(page);
  await expect(page.getByTestId('button-merge-next-1')).toBeEnabled();
  await page.getByTestId('button-merge-next-1').click();
  await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
  await assertInitialChoices(page);
  assert.deepEqual(calls[0], { action: 'preview', sourceId: 'b', targetId: 'a' });
  return { page, calls };
}
const value = (page, field, id) => page.getByTestId(`value-${field}-${id}`);
test('CPD is independent, displays exact source totals and resets when direction changes', async () => {
  const {page,calls}=await setup();
  try {
    await page.getByTestId('button-merge-next-2').click();
    await expect(page.getByTestId('merge-cpd-summary')).toHaveText('Source CPD: 2.500001 points, 3 history entries.');
    await expect(page.getByTestId('checkbox-merge-cpd')).not.toBeChecked();
    await page.getByTestId('checkbox-merge-cpd').click();
    await expect(page.getByTestId('checkbox-merge-engagement')).not.toBeChecked();
    await page.getByTestId('button-merge-back').click();
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await page.getByTestId('button-merge-next-2').click();
    await expect(page.getByTestId('checkbox-merge-cpd')).not.toBeChecked();
    await expect(page.getByTestId('merge-cpd-summary')).toHaveText('Source CPD: -1.250001 points, 31 history entries.');
    await page.getByTestId('checkbox-merge-cpd').click();
    await page.getByTestId('radio-disposal-keep').click();
    await page.getByTestId('button-merge-next-3').click();
    await expect(page.getByRole('dialog')).toContainText('transfer 31 entries (-1.250001 points)');
    await expect(page.getByRole('dialog')).toContainText('source loses ownership even if retained');
    await page.getByTestId('button-merge-confirm').click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal(calls.at(-1).includeCpd,true);
    assert.equal(calls.at(-1).includeEngagement,false);
  } finally {await page.close();}
});
test('financial headers and refusal follow original records, not copied email or survivor', async () => {
  const { page, calls } = await setup({ viewport: { width: 390, height: 640 },
    previewHandler: async (route, body) => {
      const data = preview(body);
      data.disposalSafety = { success: body.sourceId !== 'a', error: 'Alice Original cannot be removed: active GoCardless mandate and different saved email.' };
      await route.fulfill({ json: data });
      return true;
    },
  });
  try {
    await expect(page.getByTestId('financial-a')).toContainText('Active paid membership');
    await expect(page.getByTestId('financial-a')).toContainText('Direct Debit: Active mandate');
    await expect(page.getByTestId('financial-b')).toContainText('No active paid membership');
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await value(page, 'core:email', 'a').click();
    await page.getByTestId('button-merge-next-2').click();
    await page.getByTestId('button-merge-next-3').click();
    await expect(page.getByTestId('button-merge-confirm')).toBeDisabled();
    await expect(page.getByRole('alert').filter({ hasText: 'Alice Original cannot be removed' })).toBeVisible();
    assert.equal(calls.some(call => call.action === 'execute'), false);
    await page.getByTestId('button-merge-back').click();
    await page.getByTestId('radio-disposal-keep').click();
    await page.getByTestId('button-merge-next-3').click();
    await expect(page.getByTestId('button-merge-confirm')).toBeEnabled();
  } finally { await page.close(); }
});
test('record headers show original member class below email without changing merge choices', async () => {
  const { page } = await setup();
  try {
    await expect(page.getByTestId('member-class-a')).toHaveText('Member class: Full member');
    await expect(page.getByTestId('member-class-b')).toHaveText('Member class: Not set');
    await expect(page.getByTestId('member-class-a').locator('input')).toHaveCount(0);
    await value(page, 'custom:class', 'b').click();
    await expect(page.getByTestId('member-class-a')).toHaveText('Member class: Full member');
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await expect(page.getByTestId('member-class-a')).toHaveText('Member class: Full member');
    await expect(page.getByTestId('member-class-b')).toHaveText('Member class: Not set');
    const belowEmail = await page.getByTestId('member-class-a').evaluate(el =>
      el.previousElementSibling.textContent.includes('alice@example.invalid'));
    assert.equal(belowEmail, true);
  } finally { await page.close(); }
});
for (const viewport of [{ width: 1100, height: 720 }, { width: 390, height: 640 }]) {
  test(`long field comparison scrolls inside modal with fixed actions at ${viewport.width}px`, async () => {
    const { page } = await setup({ viewport });
    try {
      const body = page.getByTestId('merge-scroll-body');
      const next = page.getByTestId('button-merge-next-2');
      await expect(next).toBeVisible();
      const before = await next.boundingBox();
      const metrics = await body.evaluate(el => ({
        height: el.clientHeight, content: el.scrollHeight, overflow: getComputedStyle(el).overflowY,
      }));
      assert.ok(metrics.content > metrics.height, 'long comparison must overflow the bounded body');
      assert.equal(metrics.overflow, 'auto');
      assert.ok(before.y + before.height <= viewport.height, 'actions stay within the viewport');
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.ok(await body.evaluate(el => el.scrollTop > 0), 'body actually scrolls');
      await expect(value(page, 'custom:empty', 'a')).toBeInViewport();
      const after = await next.boundingBox();
      assert.ok(Math.abs(before.y - after.y) < 1, 'footer must not move with the fields');
      const dialog = await page.getByRole('dialog').boundingBox();
      assert.ok(dialog.y >= 0 && dialog.y + dialog.height <= viewport.height);
      await next.click();
      await expect(page.getByTestId('button-merge-next-3')).toBeVisible();
    } finally { await page.close(); }
  });
}
async function assertSelectionOnly(page) {
  await expect(page.getByRole('dialog')).toContainText('Find and select the other member record to merge.');
  await expect(page.getByText('Which record should be kept?')).toHaveCount(0);
  await expect(page.getByRole('radio')).toHaveCount(0);
}
async function assertInitialChoices(page) {
  await expect(page.getByTestId('survivor-a')).toBeChecked();
  await expect(page.getByTestId('column-a')).toHaveCSS('background-color', 'rgb(254, 252, 232)');
  for (const field of [...fields.map(key => `core:${key}`), 'custom:multi', 'custom:empty']) {
    await expect(value(page, field, 'a')).toBeChecked();
  }
}
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
    await page.getByTestId('button-merge-back').click();
    await assertSelectionOnly(page);
    // Reselecting the same candidate must not reset explicit comparison choices.
    await page.getByTestId('merge-candidate-b').click();
    await page.getByTestId('button-merge-next-1').click();
    await expect(page.getByTestId(`survivor-${survivor}`)).toBeChecked();
    await expect(value(page, 'core:first_name', 'b')).toBeChecked();
    await expect(value(page, 'core:mobile', 'a')).toBeChecked();
    await expect(value(page, 'custom:multi', 'b')).toBeChecked();
    await expect(page.getByTestId(`column-${survivor}`)).toHaveCSS('background-color', 'rgb(254, 252, 232)');
    await review(page);
    await expect(page.getByRole('dialog')).toContainText('Merging source into kept record');
    assert.deepEqual(await page.getByRole('dialog').locator('strong').allTextContents(),
      survivor === 'a' ? ['Beth Other', 'Alice Original'] : ['Alice Original', 'Beth Other']);
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
      customFieldIds: survivor === 'a' ? ['multi'] : ['empty'], includeEngagement: true, includeCpd: false, sourceDisposal: 'keep',
    });
    assert.deepEqual(await page.evaluate(() => window.merged), { sourceId: survivor === 'a' ? 'b' : 'a', targetId: survivor });
    await page.getByRole('button', { name: 'Reopen' }).click();
    await expect(page.getByTestId('input-merge-search')).toHaveValue('');
    await expect(page.getByTestId('button-merge-next-1')).toBeDisabled();
    await assertSelectionOnly(page);
    await page.getByTestId('input-merge-search').fill('record');
    await page.getByTestId('merge-candidate-b').click();
    await page.getByTestId('button-merge-next-1').click();
    await assertInitialChoices(page);
  } finally { await page.close(); }
});

test('pair replacement resets fields and disposal; failed execution remains recoverable', async () => {
  const { page, calls } = await setup({ failExecute: true });
  try {
    await value(page, 'custom:multi', 'b').click();
    await value(page, 'core:first_name', 'b').click();
    await page.getByTestId('survivor-b').click();
    await expect(page.getByTestId('button-merge-next-2')).toBeEnabled();
    await page.getByTestId('button-merge-back').click();
    await page.getByTestId('merge-candidate-c').click();
    await page.getByTestId('button-merge-next-1').click();
    await assertInitialChoices(page);
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
