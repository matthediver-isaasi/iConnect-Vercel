import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

let script, css;
test.beforeAll(async () => {
  css = (await postcss([tailwindcss({ config: './tailwind.config.ts' })])
    .process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' })).css;
  const mocks = {
    '@/api/base44Client': `export const base44={entities:new Proxy({}, {get:(_,key)=>({
      list:async()=> {
        if(key==='Event') return [{id:'e1',title:'First event'},{id:'e2',title:'Second event'}];
        if(key==='ComplexEvent') return [{id:'c1',title:'A long complex event title with many descriptive words for the annual international conference'}];
        if(key==='Form') return [{id:'f1',name:'Detailed feedback survey for the annual international conference and its programme'}];
        return [];
      },
      filter:async()=>[{id:'a1',form_id:'f1',access_mode:'authenticated'}]
    })})};`,
    '@/lib/queryClient': 'export const maybeEmitPlanQuotaFromBody=()=>{};',
  };
  script = (await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MemoryRouter,Routes,Route} from 'react-router-dom'; import {Toaster} from 'sonner';
      import Editor from './client/src/pages/EmailCampaignEdit.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/EmailCampaignEdit/draft']}><Routes>
          <Route path="/EmailCampaignEdit/:id" element={<Editor/>}/>
        </Routes></MemoryRouter><Toaster/></QueryClientProvider>);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'isolated-boundaries', setup(builder) {
      builder.onResolve({ filter: /^@\/(api\/base44Client|lib\/queryClient)$/ }, args => ({ path: args.path, namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
  })).outputFiles[0].text;
});

async function fixture(page) {
  let campaign = { id: 'draft', name: 'Conference campaign', subject: 'Conference feedback',
    from_name: 'Association', from_email: 'news@example.invalid', status: 'draft',
    html_content: '<p>{{event_survey_url}}</p>', design_json: null,
    target_audiences: [{type:'audience_list',ids:['list']}], event_survey_context: null };
  const writes = [], unexpected = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.hostname === 'campaign-details.fixture.invalid') {
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'});
      if (url.pathname === '/fixture.js') return route.fulfill({contentType:'text/javascript',body:script});
      if (url.pathname === '/fixture.css') return route.fulfill({contentType:'text/css',body:css});
      if (url.pathname === '/api/email-campaigns/draft') {
        if (req.method() === 'PATCH') { writes.push(req.postDataJSON()); campaign = {...campaign,...req.postDataJSON()}; }
        return reply(campaign);
      }
      if (url.pathname === '/api/email-campaigns/preview-footer') return reply({hasFooter:false});
      if (url.pathname === '/api/audience-lists') return reply([{id:'list',name:'Fixture audience'}]);
      if (url.pathname === '/api/email-campaigns/preview-survey') return req.postDataJSON().event_survey_context?.event_id
        ? reply({}) : reply({error:'Select an event to preview this survey.'},400);
      if (url.pathname === '/api/email-campaigns/send' && req.postDataJSON().preview === true) return reply({recipientCount:1});
    }
    unexpected.push(req.method()+' '+req.url());
    return route.abort();
  });
  await page.goto('https://campaign-details.fixture.invalid/');
  await expect(page.getByTestId('input-campaign-name')).toHaveValue(campaign.name);
  return {writes,unexpected,errors};
}

for (const width of [1440, 390, 320]) {
  test(`campaign details layout and draft behavior at ${width}px`, async ({page}) => {
    await page.setViewportSize({width,height:1000});
    const state = await fixture(page);
    const name = page.getByTestId('input-campaign-name'), subject = page.getByTestId('input-campaign-subject');
    const section = page.getByRole('group', {name:'Event context (survey optional)'});
    const n = await name.boundingBox(), s = await subject.boundingBox(), e = await section.boundingBox();
    if (width >= 1024) {
      expect(Math.abs(n.y-s.y)).toBeLessThan(2);
      expect(Math.abs(n.width-s.width)).toBeLessThan(2);
      expect(s.x).toBeGreaterThan(n.x+n.width);
      expect(e.width).toBeGreaterThan(n.width*1.9);
    } else {
      expect(s.y).toBeGreaterThan(n.y+n.height);
      expect(Math.abs(n.x-s.x)).toBeLessThan(2);
    }
    expect(e.y).toBeGreaterThan(s.y+s.height);
    await expect(page.getByRole('alert').filter({hasText:'Select an event to preview'})).toBeVisible();
    await expect(section.getByText('{{event_sponsors}}', {exact:true})).toBeVisible();
    await expect(section.getByText('{{event_survey_url}}', {exact:true})).toBeVisible();
    await name.focus(); await page.keyboard.press('Tab'); await expect(subject).toBeFocused();
    await page.keyboard.press('Tab'); await expect(page.getByLabel('Event type',{exact:true})).toBeFocused();
    await page.getByLabel('Event',{exact:true}).selectOption('e1');
    await page.getByLabel('Survey assignment',{exact:true}).selectOption('a1');
    await page.getByLabel('Event',{exact:true}).selectOption('e2');
    await expect(page.getByLabel('Survey assignment',{exact:true})).toHaveValue('');
    await page.getByLabel('Event type',{exact:true}).selectOption('complex_event');
    await expect(page.getByLabel('Event',{exact:true})).toHaveValue('');
    await page.getByLabel('Event',{exact:true}).selectOption('c1');
    await page.getByLabel('Survey assignment',{exact:true}).selectOption('a1');
    await expect(page.getByRole('alert').filter({hasText:'Select an event to preview'})).toHaveCount(0);
    const controls = await page.getByLabel('Event type',{exact:true}).boundingBox();
    const guidance = await section.locator('p').first().boundingBox();
    if (width >= 1024) expect(guidance.x).toBeGreaterThan(controls.x+controls.width);
    else expect(guidance.y).toBeGreaterThan(controls.y);
    expect(await section.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    for (const select of await section.locator('select').all()) {
      const box = await select.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x+box.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({path:`generated-artifacts/campaign-details-${width}.png`,fullPage:true});
    await subject.fill('');
    await page.getByTestId('button-save-campaign').click();
    await expect(page.getByText('Name and subject are required',{exact:true})).toBeVisible();
    expect(state.writes).toHaveLength(0);
    await subject.fill('Updated feedback');
    await page.getByTestId('button-save-campaign').click();
    await expect(page.getByText('Campaign updated',{exact:true})).toBeVisible();
    expect(state.writes).toHaveLength(1);
    expect(state.writes[0].event_survey_context).toEqual({event_type:'complex_event',event_id:'c1',assignment_id:'a1'});
    await page.reload();
    await expect(subject).toHaveValue('Updated feedback');
    await expect(page.getByLabel('Event type',{exact:true})).toHaveValue('complex_event');
    await expect(page.getByLabel('Event',{exact:true})).toHaveValue('c1');
    await expect(page.getByLabel('Survey assignment',{exact:true})).toHaveValue('a1');
    expect(state.unexpected).toEqual([]);
    expect(state.errors).toEqual([]);
  });
}
