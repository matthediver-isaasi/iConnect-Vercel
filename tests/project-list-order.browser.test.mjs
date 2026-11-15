import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import loadConfig from 'tailwindcss/loadConfig.js';

test('real board: mouse/keyboard list moves, overflow, colours, viewers, failures and filtered cards', { timeout: 120000 }, async () => {
  const output = await build({
    outfile: '/tmp/list-board-fixture.js',
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MemoryRouter,Routes,Route} from 'react-router-dom';
      import {Toaster} from 'sonner';
      import Board from './client/src/pages/ProjectBoard.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false},mutations:{retry:false}}});
      window.client=client;
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/ProjectBoard/board']}><Routes>
          <Route path="/ProjectBoard/:id" element={<Board/>}/></Routes></MemoryRouter><Toaster/>
      </QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' }, logLevel: 'silent',
    plugins: [{ name: 'board-boundaries', setup(b) {
      b.onLoad({ filter: /\/useMemberAccess\.[jt]sx?$/ }, () => ({ contents: 'const no=()=>false; export const useMemberAccess=()=>({isFeatureExcluded:no,isAccessReady:true});' }));
      b.onLoad({ filter: /\/useProjectBoardRealtime\.js$/ }, () => ({ contents: 'export const useProjectBoardRealtime=()=>{};' }));
      b.onLoad({ filter: /\/useBoardInbox\.[jt]sx?$/ }, () => ({ contents: 'export const useBoardInboxSummary=()=>({data:{unreadCardIds:[]}});' }));
      b.onLoad({ filter: /\/useInboxCardDeepLink\.[jt]sx?$/ }, () => ({ contents: 'export const useInboxCardDeepLink=()=>({cancel(){}});' }));
      b.onLoad({ filter: /\/(ProjectBoardInbox|ProjectBoardOpportunityPanel|ProjectBoardTaskDeepLink|ProjectCardDetailModal)\.[jt]sx?$/ }, () => ({ contents: 'export default function Stub(){return null;}' }));
    } }],
  });
  const config = loadConfig(`${process.cwd()}/tailwind.config.ts`);
  const css = (await postcss([tailwindcss({ ...config, content: [
    './client/src/pages/ProjectBoard.jsx', './client/src/components/projects/*.{jsx,js}',
    './client/src/components/ui/**/*.{jsx,tsx}',
  ] })]).process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
  let lists = Array.from({ length: 7 }, (_, position) => ({ id: `list${position}`, name: `List ${position}`, position, color: null }));
  let cards = [
    { id: 'hidden', title: 'Hidden', list_id: 'list0', position: 0, is_complete: true },
    { id: 'visible', title: 'Visible', list_id: 'list0', position: 1 },
    { id: 'target', title: 'Target', list_id: 'list1', position: 0 },
  ];
  let viewer = false, fail = false, delay = 0, moves = [];
  const snapshot = () => ({ board: { id: 'board', name: 'List fixture', user_role: viewer ? 'viewer' : 'member' }, lists, cards, members: [], labels: [] });
  const server = createServer(async (req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(output.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (!req.url.startsWith('/api/')) return res.end('<html><head><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(snapshot()));
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    await new Promise(resolve => setTimeout(resolve, delay));
    if (fail) { res.statusCode = 500; return res.end(JSON.stringify({ error: 'Save failed in fixture' })); }
    if (req.url.endsWith('/lists')) lists = body.lists.map(({ id }, position) => ({ ...lists.find(list => list.id === id), position }));
    else if (req.url.includes('/lists/')) lists = lists.map(list => list.id === req.url.split('/').pop() ? { ...list, ...body } : list);
    else if (req.url.endsWith('/move')) moves.push(body);
    res.end(JSON.stringify({ lists }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1050, height: 850 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const order = () => page.locator('[data-testid^="board-list-"]').evaluateAll(nodes => nodes.map(node => node.dataset.testid.replace('board-list-', '')));
  async function waitSaved(id) {
    await page.waitForFunction(id => !document.querySelector(`[aria-label="Move list ${id}"]`)?.disabled, id);
  }
  async function keyboardMove(name, key) {
    const handle = page.getByRole('button', { name: `Move list ${name}`, exact: true });
    await handle.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(100);
    await page.keyboard.press(key); await page.waitForTimeout(150); await page.keyboard.press('Space');
    await page.waitForTimeout(350); await waitSaved(name);
  }
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Move list List 0', exact: true }).waitFor();
    await keyboardMove('List 0', 'ArrowRight');
    assert.deepEqual((await order()).slice(0, 2), ['list1', 'list0']);
    await page.reload();
    await page.getByRole('button', { name: 'Move list List 0', exact: true }).waitFor();
    assert.deepEqual((await order()).slice(0, 2), ['list1', 'list0']);
    const handle = page.getByRole('button', { name: 'Move list List 0', exact: true });
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x - 10, box.y, { steps: 5 });
    await page.mouse.move(box.x - 300, box.y, { steps: 15 }); await page.waitForTimeout(200);
    await page.mouse.up(); await page.waitForTimeout(400); await waitSaved('List 0');
    assert.deepEqual((await order()).slice(0, 2), ['list0', 'list1']);
    // Move the last list off-screen with the keyboard: DnD must scroll its container.
    await keyboardMove('List 6', 'ArrowLeft');
    assert.deepEqual((await order()).slice(-2), ['list6', 'list5']);
    assert.ok(await page.locator('[data-testid="board-list-list6"]').evaluate(node => node.parentElement.parentElement.parentElement.scrollLeft > 0));
    await page.getByRole('button', { name: 'Background colour for List 0', exact: true }).click();
    await page.getByRole('button', { name: 'Slate', exact: true }).click();
    await page.waitForTimeout(300); await waitSaved('List 0');
    assert.equal(await page.locator('[data-testid="board-list-list0"]').evaluate(node => node.style.backgroundColor), 'rgb(51, 65, 85)');
    assert.equal(await page.locator('[data-testid="board-list-list0"]').evaluate(node => node.style.color), 'rgb(255, 255, 255)');
    await page.keyboard.press('Escape'); await page.reload();
    await page.getByRole('button', { name: 'Background colour for List 0', exact: true }).click();
    await page.getByLabel('Custom list colour').fill('#123456');
    await page.getByRole('button', { name: 'Apply custom', exact: true }).click();
    await page.waitForTimeout(250); await waitSaved('List 0');
    assert.equal(lists.find(list => list.id === 'list0').color, '#123456');
    await page.getByRole('button', { name: 'Default', exact: true }).click();
    await page.waitForTimeout(250); await waitSaved('List 0');
    assert.equal(lists.find(list => list.id === 'list0').color, null);
    await page.keyboard.press('Escape');
    // A stale realtime response cannot replace the visible pending list order.
    delay = 1200;
    const pendingHandle = page.getByRole('button', { name: 'Move list List 0', exact: true });
    await pendingHandle.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(100);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(150); await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.evaluate(() => window.client.invalidateQueries({ queryKey: ['project-board', 'board'] }));
    assert.deepEqual((await order()).slice(0, 2), ['list1', 'list0']);
    await waitSaved('List 0');
    delay = 0;
    const before = await order(); fail = true;
    await keyboardMove('List 0', 'ArrowRight');
    assert.deepEqual(await order(), before);
    await page.getByText('Save failed in fixture').first().waitFor();
    await page.getByRole('button', { name: 'Background colour for List 0', exact: true }).click();
    await page.getByRole('button', { name: 'Pink', exact: true }).click();
    await page.waitForTimeout(250); await waitSaved('List 0');
    assert.equal(await page.locator('[data-testid="board-list-list0"]').evaluate(node => node.style.backgroundColor), '');
    await page.keyboard.press('Escape');
    fail = false;
    const peer = await browser.newPage();
    await peer.goto(origin); await peer.getByText('List fixture').waitFor();
    assert.deepEqual(await peer.locator('[data-testid^="board-list-"]').evaluateAll(nodes => nodes.map(node => node.dataset.testid.replace('board-list-', ''))), before);
    await peer.close();
    await page.getByRole('button', { name: 'Hide completed', exact: true }).click();
    assert.equal(await page.locator('[data-testid="card-hidden"]').count(), 0);
    const card = page.locator('[data-testid="card-visible"]').locator('..');
    await card.focus(); await page.keyboard.press('Space'); await page.waitForTimeout(100);
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(150); await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    assert.equal(moves.length, 1);
    assert.equal(moves[0].list_id, 'list1');
    assert.equal(moves[0].position, 0);
    viewer = true; await page.reload(); await page.getByText('List fixture').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Move list / }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /^Background colour for / }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
