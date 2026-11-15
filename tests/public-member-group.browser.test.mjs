// Real guest reading components and shared directory/Canvas cards, synthetic APIs.
// No customer data, real storage signing, accounts or mutations.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
let browser, server, origin;
const groupId = '22222222-2222-4222-8222-222222222222';
before(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BrowserRouter,Routes,Route,Link} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import PublicMemberGroup from './client/src/components/member-groups/PublicMemberGroup.jsx';
      import MemberGroupCard from './client/src/components/member-groups/MemberGroupCard.jsx';
      const client = new QueryClient({defaultOptions:{queries:{retry:false}}});
      function Cards(){ return <><h1>Group directory / Canvas fixture</h1><MemberGroupCard
        group={{id:'${groupId}',name:'Published managed group',is_public:true,allow_self_join:false,self_join_closed:true}}
        isAuthenticated={false}/><MemberGroupCard group={{id:'private',name:'Private group',allow_self_join:false}}
        isAuthenticated={false}/></> }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><BrowserRouter>
        <header>Public website header</header><Routes><Route path="/MemberGroups" element={<Cards/>}/>
        <Route path="/canvas" element={<Cards/>}/><Route path="/MemberGroupDetail" element={<PublicMemberGroup/>}/></Routes>
        <footer>Public website footer</footer></BrowserRouter></QueryClientProvider>);
    ` },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src`, '@shared': `${process.cwd()}/shared` },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
  });
  server = createServer((req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle.outputFiles[0].text); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script src="/bundle.js"></script>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  let executablePath;
  try { executablePath = execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(); } catch { /* use Playwright's installed browser outside Nix */ }
  browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function setup() {
  const page = await browser.newPage();
  const requests = [], errors = [];
  let publicGroup = true;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    requests.push(url.pathname + url.search);
    assert.equal(route.request().method(), 'GET');
    assert.equal(url.pathname, '/api/public/member-group-content');
    if (!publicGroup) return route.fulfill({ status: 404, json: { error: 'Unavailable' } });
    const action = url.searchParams.get('action');
    const responses = {
      detail: { id: groupId, name: 'Published managed group', description: '<p>Group description</p>', terms_of_reference: '<p>Terms available</p>', forum_enabled: true },
      resources: { records: [{ id: 'resource', title: 'Linked guide' }] },
      resource: { id: 'resource', title: 'Linked guide', description: '<p>Full resource text</p>', can_download: true },
      download: { url: origin + '/downloaded-file' },
      threads: { records: [{ id: 'thread', title: 'Group discussion' }] },
      thread: { thread: { id: 'thread', title: 'Group discussion' }, records: [{ id: 'post', content: 'Public readable post', author_name: 'Group member', created_at: '2026-01-01' }] },
      members: { records: [{ id: 'member', name: 'Visible member', group_role: 'Chair' }] },
      events: { records: [{ id: 'event', title: 'Group event', description: 'Event description' }] },
      vacancies: { records: [{ id: 'vacancy', role_title: 'Volunteer chair', role_description: 'Role description' }] },
    };
    return route.fulfill({ json: responses[action] || {} });
  });
  return { page, requests, errors, revoke: () => { publicGroup = false; } };
}
test('directory and Canvas cards lead through resources and discussions with reload/back support', async () => {
  for (const start of ['/MemberGroups', '/canvas']) {
    const { page, requests, errors, revoke } = await setup();
    try {
      await page.goto(origin + start);
      await expect(page.getByTestId('button-members-only-private')).toBeDisabled();
      await page.getByTestId(`button-public-group-${groupId}`).click();
      await expect(page.getByText('Terms available')).toBeVisible();
      await page.getByRole('link', { name: 'resources', exact: true }).click();
      await page.getByRole('link', { name: 'Read resource' }).click();
      await expect(page.getByText('Full resource text')).toBeVisible();
      await page.reload();
      await expect(page.getByRole('button', { name: 'Download resource' })).toBeVisible();
      await page.getByRole('button', { name: 'Download resource' }).click();
      await expect(page).toHaveURL(origin + '/downloaded-file');
      await page.goBack();
      await page.getByRole('link', { name: 'Discussions', exact: true }).click();
      await page.getByRole('link', { name: 'Read discussion' }).click();
      await expect(page.getByText('Public readable post')).toBeVisible();
      await page.reload();
      await expect(page.getByText('Public readable post')).toBeVisible();
      await expect(page.getByRole('button', { name: /reply|react|post|join|apply|book/i })).toHaveCount(0);
      await expect(page.locator('header')).toHaveText('Public website header');
      await expect(page.locator('footer')).toHaveText('Public website footer');
      revoke();
      await page.reload();
      await expect(page.getByRole('alert')).toContainText('not available');
      await expect(page.getByText('Public readable post')).toHaveCount(0);
      assert.ok(requests.some(url => url.includes('action=download')));
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});
