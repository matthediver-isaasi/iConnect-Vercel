// Real dashboard component in an isolated browser fixture. No app auth bypass,
// live database, recipient addresses or delivery calls.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';

let browser, server, origin;
before(async () => {
  const bundle = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {MemoryRouter} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {SalesDashboard} from './client/src/components/sales/SalesReportingWorkspace.jsx';
      createRoot(document.getElementById('root')).render(<MemoryRouter><QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><SalesDashboard/></QueryClientProvider></MemoryRouter>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src`, '@shared': `${process.cwd()}/shared` },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'fixture-naming',
      setup(builder) {
        builder.onResolve({ filter: /\/useSalesSettings$/ }, () => ({ path: 'naming', namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export const useQuoteNaming=()=>({singular:"Training Proposal",plural:"Training Proposals",slug:"training-proposals"});',
        }));
      },
    }],
  });
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 10 * 1024 * 1024 });
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); return res.end(bundle.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="root" style="max-width:1200px;margin:auto;padding:16px"></main><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

for (const width of [1280, 390]) {
  test(`contextual milestones, links and independent close controls at ${width}px`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 950 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const requests = [];
    const progressRequests = [];
    await page.route('**/api/sales/reports?*', route => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('view') === 'task-progress') {
        progressRequests.push(url);
        const currentPage = Number(url.searchParams.get('taskProgressPage'));
        const items = Array.from({length:13}, (_,i)=>({
          id:`progress/${i}`,name:i===0?'Annual conference sponsorship and professional training programme':`Opportunity ${i+1}`,
          taskMode:'standard',status:'available',totalTasks:i===1?0:4,openTasks:i===1?0:2,overdueTasks:i===1?0:1,
          completedTasks:i===1?0:2,completionPercent:i===1?null:50,
          latestCompletion:i===1?null:{at:'2026-11-25T15:04:00Z',actorName:i===2?null:'Alex Smith'},
        }));
        items[3]={...items[3],status:'restricted',totalTasks:null,latestCompletion:null};
        items[4]={...items[4],status:'unavailable',totalTasks:null,latestCompletion:null};
        return route.fulfill({json:{items:items.slice((currentPage-1)*10,currentPage*10),
          page:currentPage,pageSize:10,total:13,pages:2,
          summary:{opportunityCount:13,availableOpportunities:11,restrictedOpportunities:1,unavailableOpportunities:1,
            totalTasks:40,openTasks:20,overdueTasks:10,completedTasks:20,completionPercent:50,partial:true}}});
      }
      assert.equal(url.searchParams.get('view'), 'dashboard');
      assert.equal(route.request().method(), 'GET', 'fixture never authorizes mutations');
      requests.push(url);
      return route.fulfill({ json: {
        summary: { currency: 'GBP', pipelineValue: 123456, weightedPipeline: 50000, wonValue: 90000, wonCount: 1, outstandingQuoteValue: 80000 },
        expectedCloses: [{ id: 'close', title: 'Autumn sponsorship', opportunityId: 'opp', date: '2026-12-12' }],
        recentActivity: [
          { id: 'send:1', description: 'Proposal sent', quoteId: 'q1', quoteNumber: 'P-0001', opportunityName: 'Annual conference sponsorship', organizationName: 'Example Professional Association', actorName: 'Alex Smith', date: '2026-11-25T12:00:00Z' },
          { id: 'stage:1', description: 'Stage moved: Negotiating → Won', opportunityId: 'opp', opportunityName: 'Training programme renewal', organizationName: 'Example Professional Association', actorName: 'Name unavailable', date: '2026-11-24T12:00:00Z' },
          { id: 'accepted:1', description: 'Proposal accepted', quoteId: 'q2', quoteNumber: 'P-0002', organizationName: 'Another Organisation', actorName: 'Customer', date: '2026-11-23T12:00:00Z' },
        ],
      } });
    });
    try {
      await page.goto(origin + '/sales/dashboard');
      const sent = page.getByRole('link').filter({ hasText: 'Training Proposal sent' });
      await sent.waitFor();
      assert.equal(await sent.getAttribute('href'), '/sales/training-proposals/q1');
      for (const value of ['P-0001', 'Annual conference sponsorship', 'Example Professional Association', 'Recorded by: Alex Smith', '25/11/2026']) {
        assert.ok((await sent.innerText()).includes(value), value);
      }
      const stage = page.getByRole('link').filter({ hasText: 'Stage moved:' });
      assert.equal(await stage.getAttribute('href'), '/sales/opportunities/opp');
      assert.match(await stage.innerText(), /Negotiating → Won/);
      assert.match(await page.locator('body').innerText(), /£1,234.56/);
      const rowLayout = await sent.evaluate(el => ({ width: el.clientWidth, scrollWidth: el.scrollWidth }));
      assert.ok(rowLayout.scrollWidth <= rowLayout.width, JSON.stringify(rowLayout));
      await page.getByLabel('From date', { exact: true }).fill('01/12/2026');
      await page.getByLabel('To date', { exact: true }).fill('31/12/2026');
      await page.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.waitForFunction(() => document.body.textContent.includes('Applied range: 01/12/2026'));
      await page.getByLabel('Close date order').selectOption('desc');
      await page.waitForTimeout(100);
      assert.equal(requests.at(-1).searchParams.get('expectedCloseFrom'), '2026-12-01');
      assert.equal(requests.at(-1).searchParams.get('expectedCloseSort'), 'desc');
      assert.equal(requests.at(-1).searchParams.has('dateFrom'), false);
      assert.match(await page.locator('body').innerText(), /£1,234.56/);
      assert.match(await sent.innerText(), /25\/11\/2026/);
      assert.equal(progressRequests.length,1,'expected-close controls never change progress requests');
      const progress = page.getByRole('region',{name:'Opportunity task progress'});
      assert.match(await progress.innerText(),/Partial totals: 1 restricted and 1 unavailable opportunities excluded/);
      assert.match(await progress.innerText(),/25\/11\/2026 15:04 UTC · Recorded by: Alex Smith/);
      assert.match(await progress.innerText(),/Not recorded/);
      assert.match(await progress.innerText(),/No tasks completed/);
      assert.equal(await progress.getByRole('link').first().getAttribute('href'),'/sales/opportunities/progress%2F0');
      const layout = await progress.evaluate(el=>({width:el.clientWidth,scrollWidth:el.scrollWidth}));
      assert.ok(layout.scrollWidth<=layout.width,JSON.stringify(layout));
      await progress.getByRole('link').first().focus();
      assert.equal(await progress.getByRole('link').first().evaluate(el=>el===document.activeElement),true);
      await mkdir('generated-artifacts/sales-activity', { recursive: true });
      await progress.screenshot({path:`generated-artifacts/sales-activity/progress-${width}.png`});
      const next = progress.getByRole('button',{name:'Next opportunity task progress page'});
      await next.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(()=>document.body.textContent.includes('Page 2 of 2'));
      assert.equal(await progress.getByRole('link').count(),3);
      assert.match(await progress.innerText(),/Opportunity 13/);
      assert.match(await progress.innerText(),/Weighted completion\s*50%/);
      assert.equal(requests.length,3,'progress pagination leaves dashboard and financial requests unchanged');
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `generated-artifacts/sales-activity/dashboard-${width}.png`, fullPage: true });
    } finally { await page.close(); }
  });
}
