import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';

test('first-load and filter updates retain the waiting-list deep link until content is ready', async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React, {useEffect, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {BrowserRouter, useNavigate} from 'react-router-dom';
      import {useEventFilterParams} from './client/src/hooks/useEventFilterParams';
      import {useTbcSectionNavigation} from './client/src/hooks/useTbcSectionNavigation';
      function Events() {
        const [params, update] = useEventFilterParams();
        const navigate = useNavigate();
        const [ready, setReady] = useState(false);
        useEffect(() => { const timer=setTimeout(()=>setReady(true),200); return ()=>clearTimeout(timer); },[]);
        useEffect(() => { update(p=>{p.delete('search');p.delete('sort');}); },[update]);
        useTbcSectionNavigation({anchor:'waiting-lists', visible:ready, loading:!ready});
        return <><button id="filter" onClick={()=>update(p=>p.set('type','training'))}>Filter</button>
          <button id="back" onClick={()=>navigate(-1)}>Back</button>
          <button id="other" onClick={()=>navigate('/Events#other')}>Other section</button>
          <output id="type">{params.get('type')}</output>
          {ready && <><div style={{height:1800}}/><section id="waiting-lists">Waiting lists</section>
          <div style={{height:1000}}/></>}</>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><Events/></BrowserRouter>);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
    alias: { '@': path.resolve('client/src') }, define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const browser = await chromium.launch({headless:true,
    executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim(),
    args:['--no-sandbox']});
  try {
    const page=await browser.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://events.test/**', route=>route.fulfill({contentType:'text/html',
      body:`<div id="root"></div><script>${bundle.outputFiles[0].text}</script>`}));
    for (const query of ['', '?search=&sort=date&campaign=retain']) {
      await page.goto(`http://events.test/Events${query}#waiting-lists`);
      await page.waitForFunction(()=>document.getElementById('waiting-lists')
        && window.scrollY>1000);
      assert.equal(new URL(page.url()).hash,'#waiting-lists');
      if(query) assert.equal(new URL(page.url()).searchParams.get('campaign'),'retain');
      const historyLength=await page.evaluate(()=>history.length);
      await page.locator('#filter').click();
      await page.waitForFunction(()=>new URL(location.href).searchParams.get('type')==='training');
      assert.equal(new URL(page.url()).hash,'#waiting-lists');
      assert.equal(await page.evaluate(()=>history.length),historyLength);
      await page.locator('#other').click();
      await page.waitForFunction(()=>location.hash==='#other');
      await page.locator('#back').click();
      await page.waitForFunction(()=>location.hash==='#waiting-lists' && window.scrollY>1000);
    }
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
