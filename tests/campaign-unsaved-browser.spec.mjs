import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

let script, css;
test.beforeAll(async () => {
  await mkdir('/tmp/campaign-unsaved/evidence', { recursive: true });
  css = (await postcss([tailwindcss({ config: './tailwind.config.ts' })])
    .process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
  const mocks = {
    '@/api/base44Client': `export const base44={entities:new Proxy({}, {get:(_,key)=>({
      list:async()=>key==='CommunicationCategory'?[{id:'category',name:'News'}]:
        key==='Event'?[{id:'event',title:'Fixture event'}]:[],
      filter:async()=>[]
    })})};`,
    '@/lib/queryClient': 'export const maybeEmitPlanQuotaFromBody=()=>{};',
  };
  script = (await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {BrowserRouter,Routes,Route,Link,useNavigate} from 'react-router-dom'; import {Toaster} from 'sonner';
      import Editor from './client/src/pages/EmailCampaignEdit.jsx';
      import {TooltipProvider} from './client/src/components/ui/tooltip.jsx';
      function App(){const navigate=useNavigate();window.fixtureNavigate=navigate;return <>
        <nav><Link to="/elsewhere">Another application page</Link> <Link to="/EmailCampaignEdit/new">New campaign</Link>
        <Link to="/EmailCampaignEdit/draft">Existing campaign</Link><Link to="/EmailCampaignEdit/second">Second campaign</Link></nav>
        <Routes><Route path="/EmailCampaignEdit/:id" element={<Editor/>}/>
        <Route path="*" element={<h1>Destination page</h1>}/></Routes></>}
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      window.fixtureClient=client;
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
        <TooltipProvider><BrowserRouter><App/></BrowserRouter><Toaster/></TooltipProvider></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'isolated-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/(api\/base44Client|lib\/queryClient)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  })).outputFiles[0].text;
});

const design = { type: 'custom-email-builder', version: 1,
  blocks: [{ id: 'copy', type: 'text', content: '<p>Design original</p>', styles: {} }] };
async function fixture(page, { fresh = false, visual = false, review = false } = {}) {
  const state = { writes: [], unexpected: [], errors: [], fail: false, networkFail: false, release: null, delay: false };
  let record = { id: 'draft', name: 'Campaign original', subject: 'Subject original',
    from_name: 'Association', from_email: 'news@example.invalid', status: 'draft',
    html_content: '<p>Original HTML</p>', design_json: visual ? design : null,
    target_audiences: [{ type: 'audience_list', ids: ['list'] }], category_review_required: review };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('console', message => {
    if (/Cannot update a component|Maximum update depth/.test(message.text())) state.errors.push(message.text());
  });
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname !== 'campaign-unsaved.fixture.invalid') return route.abort();
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
    if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
    if (!url.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
    if (/^\/api\/email-campaigns(?:\/(?:draft|saved|second))?$/.test(url.pathname)) {
      if (['PATCH', 'POST'].includes(req.method())) {
        state.writes.push({ method: req.method(), path: url.pathname, body: req.postDataJSON() });
        if (state.delay) await new Promise(resolve => { state.release = resolve; });
        if (state.networkFail) return route.abort('failed');
        if (state.fail) return reply({ error: 'Fixture save conflict' }, 409);
        record = { ...record, ...req.postDataJSON(), id: url.pathname.endsWith('draft') ? 'draft' : 'saved',
          category_review_required: req.postDataJSON().category_review_confirmed ? false : record.category_review_required };
      }
      return reply(url.pathname.endsWith('second') ? { ...record, id: 'second', name: 'Second campaign' } : record);
    }
    if (url.pathname === '/api/email-campaigns/preview-footer') return reply({ hasFooter: false });
    if (url.pathname === '/api/audience-lists') return reply([{ id: 'list', name: 'First audience' }, { id: 'other', name: 'Second audience' }]);
    if (url.pathname === '/api/email-campaigns/send' && req.postDataJSON().preview === true) return reply({ recipientCount: 2, stats: {} });
    state.unexpected.push(req.method() + ' ' + url.pathname);
    return route.abort();
  });
  await page.goto('https://campaign-unsaved.fixture.invalid/start');
  await page.getByRole('link', { name: fresh ? 'New campaign' : 'Existing campaign', exact: true }).click();
  await expect(page.getByTestId('input-campaign-name')).toHaveValue(fresh ? '' : record.name);
  return state;
}
const modal = page => page.getByRole('dialog', { name: 'Unsaved campaign changes' });
const dirty = page => page.getByTestId('input-campaign-name').fill('Campaign edited');
const leave = page => page.getByTestId('button-back').click();
const unloadBlocked = page => page.evaluate(() => !window.dispatchEvent(new Event('beforeunload', { cancelable: true })));
function isolated(state) { expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]); }
async function fillNew(page) {
  await dirty(page);
  await page.getByTestId('input-campaign-subject').fill('New subject');
  await page.getByTestId('list-option-list').getByRole('checkbox').check();
}

test('untouched new, unchanged existing, reverted edits and display controls remain clean', async ({ page }) => {
  const state = await fixture(page, { fresh: true });
  expect(await unloadBlocked(page)).toBe(false);
  await leave(page);
  await expect(modal(page)).toHaveCount(0);
  await page.getByRole('link', { name: 'Existing campaign', exact: true }).click();
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('Campaign original');
  await dirty(page);
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByTestId('input-campaign-name').fill('Campaign original');
  await page.getByTestId('button-visual-mode').click();
  await page.getByTestId('button-html-mode').click();
  expect(await unloadBlocked(page)).toBe(false);
  await leave(page);
  await expect(page).toHaveURL(/CommunicationsManagement$/);
  expect(state.writes).toHaveLength(0); isolated(state);
});

test('back button and links retain editor; Escape, close and focus trap cancel without saving', async ({ page }) => {
  const state = await fixture(page);
  await dirty(page); await leave(page);
  await expect(modal(page)).toBeVisible();
  await page.screenshot({ path: '/tmp/campaign-unsaved/evidence/normal-modal.png' });
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    expect(await modal(page).evaluate(el => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('Campaign edited');
  await page.getByRole('link', { name: 'Another application page' }).click();
  await modal(page).getByRole('button', { name: 'Close', exact: true }).click();
  await leave(page);
  await modal(page).getByRole('button', { name: 'Leave without saving' }).click();
  await expect(page).toHaveURL(/CommunicationsManagement$/);
  expect(state.writes).toHaveLength(0); isolated(state);
});

for (const fresh of [false, true]) for (const choice of ['Save and leave', 'Save and stay']) {
  test(`${fresh ? 'create' : 'edit'} ${choice} persists once and preserves the correct route`, async ({ page }) => {
    const state = await fixture(page, { fresh });
    if (fresh) await fillNew(page); else await dirty(page);
    await page.getByRole('link', { name: 'Another application page' }).click();
    await modal(page).getByRole('button', { name: choice, exact: true }).click();
    await expect(modal(page)).toHaveCount(0);
    await expect(page).toHaveURL(choice === 'Save and leave' ? /elsewhere$/ : fresh ? /EmailCampaignEdit\/saved$/ : /EmailCampaignEdit\/draft$/);
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].method).toBe(fresh ? 'POST' : 'PATCH');
    if (choice === 'Save and stay') {
      expect(await unloadBlocked(page)).toBe(false);
      await dirty(page);
      await page.getByTestId('input-campaign-subject').fill('Later edit');
      await page.getByTestId('button-save-campaign').click();
      await expect.poll(() => state.writes.length).toBe(2);
      expect(state.writes[1].method).toBe('PATCH');
      await expect.poll(() => unloadBlocked(page)).toBe(false);
      await leave(page);
      await expect(modal(page)).toHaveCount(0);
    }
    isolated(state);
  });
}

test('validation, server and network errors keep edits; duplicate saves and competing decisions are locked', async ({ page }) => {
  const state = await fixture(page, { fresh: true });
  await dirty(page); await leave(page);
  await modal(page).getByRole('button', { name: 'Save and leave' }).click();
  await expect(modal(page).getByRole('alert')).toBeVisible();
  expect(state.writes).toHaveLength(0);
  await page.keyboard.press('Escape'); await fillNew(page);
  state.fail = true;
  await leave(page);
  await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(page.getByText('Fixture save conflict', { exact: true })).toBeVisible();
  await expect(modal(page).getByRole('alert')).toBeVisible();
  state.fail = false; state.networkFail = true;
  await modal(page).getByRole('button', { name: 'Save and leave' }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  await expect(modal(page).getByRole('button', { name: 'Save and leave' })).toBeEnabled();
  state.networkFail = false; state.delay = true;
  await modal(page).getByRole('button', { name: 'Save and leave' }).evaluate(el => { el.click(); el.click(); });
  await expect.poll(() => state.writes.length).toBe(3);
  for (const button of ['Save and leave', 'Save and stay', 'Leave without saving']) await expect(modal(page).getByRole('button', { name: button })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(modal(page)).toBeVisible();
  state.release();
  await expect(page).toHaveURL(/CommunicationsManagement$/);
  expect(state.writes).toHaveLength(3); isolated(state);
});

test('Back and Forward cancellation preserves route identity and history; accepted traversal happens once', async ({ page }) => {
  const state = await fixture(page);
  await page.evaluate(() => window.fixtureNavigate('/EmailCampaignEdit/draft?later=1'));
  await page.goBack();
  await expect(page).not.toHaveURL(/later/);
  await dirty(page);
  await page.getByTestId('input-campaign-name').evaluate(el => { el.dataset.identity = 'retained'; });
  const index = await page.evaluate(() => history.state.idx);
  await page.goForward();
  await expect(modal(page)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => history.state.idx)).toBe(index);
  await expect(page.getByTestId('input-campaign-name')).toHaveAttribute('data-identity', 'retained');
  await page.goBack();
  await expect(modal(page)).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => history.state.idx)).toBe(index);
  await page.goForward();
  await modal(page).getByRole('button', { name: 'Save and leave' }).click();
  await expect(page).toHaveURL(/later=1$/);
  expect(await page.evaluate(() => history.state.idx)).toBe(index + 1);
  expect(await unloadBlocked(page)).toBe(false);
  expect(state.writes).toHaveLength(1); isolated(state);
});

test('ordinary create save keeps in-flight edits dirty and never creates twice', async ({ page }) => {
  const state = await fixture(page, { fresh: true });
  await fillNew(page); state.delay = true;
  await page.getByTestId('button-save-campaign').click();
  await expect.poll(() => !!state.release).toBe(true);
  await page.getByTestId('input-campaign-subject').fill('Changed during save');
  state.release();
  await expect(page).toHaveURL(/EmailCampaignEdit\/saved$/);
  await expect(page.getByTestId('input-campaign-subject')).toHaveValue('Changed during save');
  expect(await unloadBlocked(page)).toBe(true);
  state.delay = false;
  await leave(page); await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(state.writes.map(w => w.method)).toEqual(['POST', 'PATCH']);
  expect(await unloadBlocked(page)).toBe(false); isolated(state);
});

test('audience, HTML, sender, subscription, scheduling and test/inbox settings are guarded', async ({ page }) => {
  const state = await fixture(page);
  await page.getByTestId('list-option-other').getByRole('checkbox').check();
  await leave(page);
  await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(state.writes[0].body.target_ids).toEqual(['list', 'other']);
  await page.getByTestId('button-html-mode').click();
  const html = page.getByTestId('textarea-html-content');
  await html.fill('<p>Changed HTML</p>');
  await leave(page); await page.keyboard.press('Escape');
  await expect(html).toHaveValue('<p>Changed HTML</p>');
  await page.getByTestId('input-from-name').fill('Updated sender');
  await leave(page); await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(modal(page)).toHaveCount(0);
  expect(state.writes.at(-1).body.html_content).toContain('Changed HTML');
  expect(state.writes.at(-1).body.from_name).toBe('Updated sender');
  for (const change of [
    async () => {
      await page.getByTestId('select-campaign-category').click();
      await page.getByRole('option', { name: 'News', exact: true }).click();
    },
    async () => { await page.getByTestId('radio-send-scheduled').check(); },
    async () => { await page.getByTestId('input-scheduled-at').fill('2027-01-01T12:00'); },
    async () => { await page.getByTestId('checkbox-test-mode').check(); },
    async () => { await page.getByTestId('campaign-inbox-opted-out').check(); },
    async () => { await page.getByLabel('Event', { exact: true }).selectOption('event'); },
  ]) {
    await change();
    expect(await unloadBlocked(page)).toBe(true);
    await leave(page);
    await modal(page).getByRole('button', { name: 'Save and stay' }).click();
    await expect(modal(page)).toHaveCount(0);
    expect(await unloadBlocked(page)).toBe(false);
  }
  isolated(state);
});

test('visual editor retains current content on dismissal and saves the latest design', async ({ page }) => {
  const state = await fixture(page, { visual: true });
  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByRole('heading', { name: 'Visual Email Builder', level: 2 })).toBeVisible();
  await page.evaluate(() => window.fixtureNavigate('/elsewhere'));
  // Opening an unchanged design is not dirty.
  await expect(page).toHaveURL(/elsewhere$/);
  await page.getByRole('link', { name: 'Existing campaign', exact: true }).click();
  await expect(page.getByTestId('input-campaign-name')).toBeVisible();
  await page.getByTestId('button-open-visual-editor').click();
  await page.getByTestId('global-bg-color').fill('#123456');
  await page.getByTestId('button-undo').click();
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByTestId('button-redo').click();
  expect(await unloadBlocked(page)).toBe(true);
  await page.getByTestId('email-builder-layout').evaluate(el => { el.dataset.identity = 'retained'; });
  // Navigate in the same browser turn, before the 300ms HTML debounce.
  await page.evaluate(() => window.fixtureNavigate('/elsewhere'));
  await expect(modal(page)).toBeVisible();
  await page.screenshot({ path: '/tmp/campaign-unsaved/evidence/visual-modal.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: 'Visual Email Builder', level: 2 })).toBeVisible();
  await expect(page.getByTestId('email-builder-layout')).toHaveAttribute('data-identity', 'retained');
  await page.evaluate(() => window.fixtureNavigate('/elsewhere'));
  await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(modal(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Visual Email Builder', level: 2 })).toBeVisible();
  expect(state.writes[0].body.design_json.blocks[0].content).toContain('Design original');
  expect(state.writes[0].body.design_json.globalStyles.backgroundColor).toBe('#123456');
  expect(await unloadBlocked(page)).toBe(false); isolated(state);
});

test('campaign identity switches reset defaults and do not leak another campaign baseline', async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole('link', { name: 'New campaign', exact: true }).click();
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('');
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByRole('link', { name: 'Second campaign', exact: true }).click();
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('Second campaign');
  expect(await unloadBlocked(page)).toBe(false);
  await dirty(page); await leave(page);
  await modal(page).getByRole('button', { name: 'Leave without saving' }).click();
  expect(state.writes).toHaveLength(0); isolated(state);
});

test('opening an untouched new visual builder stays clean; failed visual Save and Close keeps it open', async ({ page }) => {
  const state = await fixture(page, { fresh: true });
  await page.getByTestId('button-open-visual-editor').click();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  expect(await unloadBlocked(page)).toBe(false);
  await page.getByTestId('button-save-visual-editor').click();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  await page.getByTestId('button-cancel-visual-editor').click();
  await fillNew(page);
  await page.getByTestId('button-open-visual-editor').click();
  await page.getByTestId('global-bg-color').fill('#654321');
  state.fail = true;
  await page.getByTestId('button-save-visual-editor').click();
  await expect(page.getByText('Fixture save conflict', { exact: true })).toBeVisible();
  await expect(page.getByTestId('email-builder-layout')).toBeVisible();
  state.fail = false;
  await page.getByTestId('button-save-visual-editor').click();
  await expect(page.getByTestId('email-builder-layout')).toHaveCount(0);
  await expect(page).toHaveURL(/EmailCampaignEdit\/saved$/);
  expect(await unloadBlocked(page)).toBe(false);
  expect(state.writes).toHaveLength(2); isolated(state);
});

test('audience/category review selections are guarded and confirmed save establishes a clean baseline', async ({ page }) => {
  const state = await fixture(page, { review: true });
  await page.getByTestId('list-option-list').getByRole('checkbox').uncheck();
  await page.getByTestId('list-option-list').getByRole('checkbox').check();
  await page.getByTestId('select-campaign-category').click();
  await page.getByRole('option', { name: 'News', exact: true }).click();
  await page.getByTestId('checkbox-confirm-category-review').check();
  await leave(page);
  await modal(page).getByRole('button', { name: 'Save and stay' }).click();
  await expect(modal(page)).toHaveCount(0);
  await expect(page.getByTestId('alert-category-review-required')).toHaveCount(0);
  expect(state.writes[0].body.category_review_confirmed).toBe(true);
  expect(await unloadBlocked(page)).toBe(false);
  // A metadata refetch must neither overwrite edits nor establish a new baseline.
  await dirty(page);
  await page.evaluate(() => window.fixtureClient.invalidateQueries({ queryKey: ['email-campaign', 'draft'] }));
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('Campaign edited');
  expect(await unloadBlocked(page)).toBe(true);
  isolated(state);
});

test('mobile modal fits viewport and actual document departure uses native warning', async ({ page }) => {
  const state = await fixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await dirty(page); await leave(page);
  await expect(modal(page)).toBeVisible();
  const box = await modal(page).boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: '/tmp/campaign-unsaved/evidence/mobile-modal.png' });
  await page.keyboard.press('Escape');
  const native = page.waitForEvent('dialog');
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const warning = await native;
  expect(warning.type()).toBe('beforeunload');
  await warning.dismiss();
  await expect(page.getByTestId('input-campaign-name')).toHaveValue('Campaign edited');
  expect(state.writes).toHaveLength(0); isolated(state);
});
