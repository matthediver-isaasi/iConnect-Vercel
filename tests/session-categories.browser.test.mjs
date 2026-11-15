// Isolated real components; no tenant data or authenticated/live API calls.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';

let browser, server, origin;
const labels = [
  { id: 'practice', name: 'Clinical practice and interdisciplinary learning', is_active: true },
  { id: 'research', name: 'Research and innovation', is_active: true },
  { id: 'long', name: 'LongUnbrokenCategoryNameThatMustWrapWithoutMakingTheDialogWider', is_active: true },
];
before(async () => {
  // Extract the actual editor card, avoiding unrelated page initialization and
  // auth integrations. The card itself and all shared UI dependencies are real.
  const editor = readFileSync('client/src/pages/CreateComplexEvent.jsx', 'utf8');
  const card = editor.slice(editor.indexOf('function AdminSessionCard('), editor.indexOf('\nfunction AdminScheduleGrid('));
  assert.ok(card.includes('SessionCategoryBadges'));
  const bundle = await build({
    stdin: { contents: `
      import React,{useState,useMemo} from 'react'; import {createRoot} from 'react-dom/client';
      import DOMPurify from 'dompurify';
      import {Badge} from './client/src/components/ui/badge';
      import {Button} from './client/src/components/ui/button';
      import {Pencil,Trash2,Layers,Clock,Mic,MapPin,Monitor,Video,Building2} from 'lucide-react';
      import SessionCategoryBadges from './client/src/components/events/SessionCategoryBadges.jsx';
      import SessionCategoryField from './client/src/components/events/SessionCategoryField.jsx';
      import {ScheduleGrid,ExpandedSessionModal,formatTime as scheduleFormatTime} from './client/src/components/events/ComplexEventSchedule.jsx';
      ${card}
      const catalogue=${JSON.stringify(labels)};
      function App(){
        const [ids,setIds]=useState([]); const [saved,setSaved]=useState([]); const [selected,setSelected]=useState(null);
        const [failed,setFailed]=useState(false);
        const categories=catalogue.filter(c=>saved.includes(c.id));
        const session={id:'session',_localId:'session',title:'Clinical programme',start_time:'2026-11-15T09:00:00Z',end_time:'2026-11-15T09:15:00Z',track_names:['Track A','Track B'],categories,description:'Shared session'};
        return <main className="p-4 space-y-4">
          <h1>Session editor fixture</h1>
          <SessionCategoryField value={ids} onChange={setIds} query={{data:failed?undefined:catalogue,isError:failed,refetch:()=>setFailed(false)}}/>
          <button onClick={async()=>{await fetch('/api/fixture-session',{method:'POST',body:JSON.stringify({category_ids:ids})});setSaved(ids)}}>Save session</button>
          <button onClick={async()=>{const s=await(await fetch('/api/fixture-session')).json();setIds(s.category_ids);setSaved(s.category_ids)}}>Reload session</button>
          <button onClick={()=>setFailed(true)}>Fail catalogue</button>
          <h2>Editor preview</h2>
          <AdminSessionCard session={session} timezone="UTC" fixedHeight={64}/>
          <h2>Public programme</h2>
          <ScheduleGrid sessions={[session]} timezone="UTC" trackColorMap={{}} eventTracks={[{name:'Track A'},{name:'Track B'}]} onSessionClick={setSelected}/>
          <ExpandedSessionModal session={selected} open={!!selected} onOpenChange={open=>!open&&setSelected(null)} timezone="UTC" speakerMap={{}} isAdmin={false}/>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<App/>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` },
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
  });
  const css = execFileSync('node', ['node_modules/tailwindcss/lib/cli.js', '-i', 'client/src/index.css'], { maxBuffer: 10 * 1024 * 1024 });
  let saved = [];
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(bundle.outputFiles[0].text); }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); return res.end(css); }
    if (req.url === '/api/fixture-session') {
      res.setHeader('Content-Type', 'application/json');
      if (req.method === 'POST') { let body=''; req.on('data', c => body+=c); req.on('end',()=>{saved=JSON.parse(body).category_ids;res.end('{}')}); return; }
      return res.end(JSON.stringify({category_ids:saved}));
    }
    if (req.url.startsWith('/api/')) { res.statusCode = 500; return res.end('Unexpected API forbidden'); }
    res.setHeader('Content-Type', 'text/html');
    res.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim() });
  mkdirSync('generated-artifacts/session-categories', { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

for (const width of [1200, 390]) test(`editor, repeated cards and detail pills at ${width}px`, async () => {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  try {
    await page.goto(origin);
    for (const category of labels) await page.getByRole('checkbox', {name:category.name}).check();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= window.innerWidth+1));
    await page.getByRole('button',{name:'Save session',exact:true}).click();
    await page.getByRole('checkbox',{name:labels[0].name}).uncheck();
    await page.getByRole('button',{name:'Reload session',exact:true}).click();
    await expect(page.getByRole('checkbox',{name:labels[0].name})).toBeChecked();
    const cards = page.locator('[data-testid="session-card-session"]');
    await expect(cards).toHaveCount(3);
    // Editor preview and the same session in both tracks wrap identical labels.
    // Short duration cards keep their geometry and expose content by scrolling.
    for (let i=0;i<3;i++) {
      const card = cards.nth(i);
      const pills = card.getByRole('list', {name:'Session categories'});
      await expect(pills.getByRole('listitem')).toHaveCount(3);
      for(const category of labels) await expect(pills.getByText(category.name,{exact:true})).toBeAttached();
      assert.ok(await pills.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    }
    await page.getByRole('button',{name:'Open session details: Clinical programme'}).first().click();
    const dialog=page.getByRole('dialog');
    for(const category of labels) await expect(dialog.getByText(category.name,{exact:true})).toBeVisible();
    await expect(dialog).toBeVisible();
    await dialog.evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished.catch(()=>{}))); });
    await page.screenshot({path:`generated-artifacts/session-categories/detail-${width}.png`});
    const list=dialog.getByRole('list',{name:'Session categories'});
    assert.ok(await list.evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Fail catalogue'}).click();
    await expect(page.getByRole('alert')).toContainText('Saved assignments have been kept');
    await expect(page.getByRole('button',{name:'Remove Saved category'})).toHaveCount(3);
    await page.getByRole('button',{name:'Remove Saved category'}).first().click();
    await page.getByRole('button',{name:'Retry loading categories'}).click();
    await expect(page.getByRole('checkbox',{name:labels[0].name})).not.toBeChecked();
    await page.getByRole('button',{name:'Save session',exact:true}).click();
    await page.getByRole('button',{name:'Reload session',exact:true}).click();
    for(let i=0;i<3;i++) await expect(cards.nth(i).getByRole('listitem')).toHaveCount(2);
    await page.screenshot({path:`generated-artifacts/session-categories/editor-${width}.png`});
    assert.deepEqual(errors,[]);
  } finally { await page.close(); }
});
