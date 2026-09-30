import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { resolveCampaignEventSponsors, replaceEventSponsors } from '../api/_lib/eventEmailSponsors.js';
import { sanitizeSlotHtml } from '../api/_lib/slotHtmlSanitizer.js';

test('mocked actual event-context UI and sanitized sponsor email preview (no network)', async () => {
  const rows = {
    event: [{ id: 'e1', tenant_id: 't' }],
    tenant: [{ id: 't', slug: 'fixture', domain: 'fixture.invalid' }],
    event_sponsor_assignment: [{ sponsor_id: 's', tenant_id: 't', event_id: 'e1', event_type: 'simple' }],
    event_sponsor: [{ id: 's', tenant_id: 't', name: 'Synthetic Science Foundation', category_id: 'gold', logo_url: null, website_url: 'https://fixture.invalid/sponsor?a=1&b=2' }],
    event_sponsor_category: [{ id: 'gold', tenant_id: 't', name: 'Gold sponsors', display_order: 1 }],
  };
  const db = { from(table) {
    const filters = [];
    const q = { select() { return q; }, order() { return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, v) { filters.push(r => v.includes(r[k])); return q; },
      result() { return rows[table].filter(r => filters.every(f => f(r))); },
      async maybeSingle() { return { data: q.result()[0] }; },
      then(resolve) { return Promise.resolve({ data: q.result() }).then(resolve); },
    };
    return q;
  }};
  const campaign = { subject: 'Event update', html_content: sanitizeSlotHtml('<p>{{event_sponsors}}</p>'), event_survey_context: { event_id: 'e1', event_type: 'event' } };
  const fragment = await resolveCampaignEventSponsors(db, campaign, 't');
  const html = replaceEventSponsors(campaign.html_content, fragment);
  const bundle = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import Settings from './client/src/components/CampaignEventSurveySettings.jsx';
      import { resolveEventEmailPreview } from './client/src/lib/eventEmailPreview.js';
      function App() {
        const [value, onChange] = React.useState({event_type:'event',event_id:'e1'});
        const [show, setShow] = React.useState(false);
        return <main><h1>Reusable event email · synthetic fixture</h1>
          <Settings value={value} onChange={onChange}/>
          <h2>Body block</h2><textarea aria-label="Body" readOnly value="<p>{{event_sponsors}}</p>" />
          <p><button onClick={()=>setShow(true)}>Preview email</button></p>
          {show && <section aria-label="Email preview"><h2>Event update</h2>
            <div dangerouslySetInnerHTML={{__html:resolveEventEmailPreview('<p>{{event_sponsors}}</p>',{sponsors:${JSON.stringify(fragment)}})}} />
          </section>}
        </main>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><App/></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{
      name: 'mock-base44',
      setup(b) {
        b.onResolve({ filter: /^@\/api\/base44Client$/ }, () => ({ path: 'base44', namespace: 'mock' }));
        b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
          contents: `export const base44={entities:{Event:{list:async()=>[{id:'e1',title:'Synthetic annual conference'},{id:'e2',title:'Synthetic regional event'}]},ComplexEvent:{list:async()=>[]},EventSurveyAssignment:{filter:async()=>[]},Form:{list:async()=>[]}}};`,
          loader: 'js',
        }));
      },
    }],
  });
  const browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1050, height: 850 } });
    let requests = 0;
    await page.route('**/*', route => { requests++; return route.abort(); });
    await page.setContent('<!doctype html><html><head><style>body{font:16px Arial;color:#243047;background:#f5f7fa}main{max-width:850px;margin:30px auto}fieldset,section{background:white;padding:24px;border:1px solid #ccd3df;border-radius:8px}label{display:block;margin:18px 0}select,textarea{display:block;padding:10px;width:100%;box-sizing:border-box;margin-top:8px}button{padding:12px;background:#2458a8;color:white;border:0;border-radius:6px}code{background:#edf1f7;padding:3px}p{line-height:1.6}</style></head><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('option', { name: 'Synthetic annual conference' }).waitFor({ state: 'attached' });
    assert.equal(await page.getByLabel('Event', { exact: true }).inputValue(), 'e1');
    await page.getByLabel('Event', { exact: true }).selectOption('e2');
    assert.equal(await page.getByLabel('Event', { exact: true }).inputValue(), 'e2');
    await page.getByLabel('Event', { exact: true }).selectOption('e1');
    await page.getByRole('button', { name: 'Preview email' }).click();
    assert.equal(await page.locator('section table').count(), 1);
    assert.equal(await page.locator('section p table').count(), 0);
    assert.ok((await page.locator('section').innerHTML()).includes('Synthetic Science Foundation'));
    assert.ok(html.includes('Gold sponsors'));
    assert.equal(requests, 0);
    await page.screenshot({ path: 'exports/event-sponsors-fixture.png', fullPage: true });
  } finally { await browser.close(); }
});