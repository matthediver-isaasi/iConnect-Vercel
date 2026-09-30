import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

test('actual campaign context controls keep template reusable and reset survey on event change', async ({ page }) => {
  const stylesheet = await postcss([tailwindcss({ config: './tailwind.config.ts' })])
    .process(await readFile('client/src/index.css', 'utf8'), { from: 'client/src/index.css' });
  const mocks = {
    '@/api/base44Client': `export const base44={entities:{
      Event:{list:async()=>[{id:'e1',title:'First event'},{id:'e2',title:'Second event'}]},
      ComplexEvent:{list:async()=>[]},
      Form:{list:async()=>[{id:'f1',name:'Feedback'},{id:'f2',name:'Follow-up'}]},
      EventSurveyAssignment:{filter:async q=>q.event_id==='e1'?
        [{id:'a1',form_id:'f1',access_mode:'public'},{id:'a2',form_id:'f2',access_mode:'authenticated'}]:
        [{id:'a3',form_id:'f2',access_mode:'public'}]}
    }};`,
  };
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import Settings from './client/src/components/CampaignEventSurveySettings.jsx';
      function App(){const [value,setValue]=React.useState(null);return <QueryClientProvider client={client}><Settings value={value} onChange={setValue}/><output>{JSON.stringify(value)}</output></QueryClientProvider>}
      const client=new QueryClient({defaultOptions:{queries:{retry:false}}});
      createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'fixture-mocks', setup(builder) {
      builder.onResolve({ filter: /^@\// }, args => mocks[args.path]
        ? { path: args.path, namespace: 'fixture' }
        : { path: path.resolve('client/src', args.path.slice(2)) });
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'jsx' }));
    } }],
  });
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'campaign.fixture.invalid') return route.abort();
    if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: result.outputFiles[0].text });
    if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: stylesheet.css });
    return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
  });
  await page.goto('https://campaign.fixture.invalid');
  await expect(page.getByText('{{event_survey_url}}', { exact: true })).toBeVisible();
  await page.getByLabel('Event', { exact: true }).selectOption('e1');
  await expect(page.getByLabel('Survey assignment')).toContainText('Follow-up (Login required)');
  await page.getByLabel('Survey assignment').selectOption('a2');
  await expect(page.locator('output')).toContainText('"assignment_id":"a2"');
  await page.screenshot({ path: 'screenshots/campaign-event-survey-fixture.png', fullPage: true });
  await page.getByLabel('Event', { exact: true }).selectOption('e2');
  await expect(page.getByLabel('Survey assignment')).toHaveValue('');
  await expect(page.locator('output')).toContainText('"event_id":"e2"');
});