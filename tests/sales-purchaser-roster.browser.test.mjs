import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

test('browser purchaser journey saves, returns, amends, and keeps closed allocations independent', {timeout:60000}, async()=>{
  const output=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';
    import Page from './client/src/pages/PublicSalesTicketRegistration.jsx';
    createRoot(document.getElementById('root')).render(<Page/>);`,resolveDir:process.cwd(),loader:'jsx'},
    bundle:true,write:false,format:'iife',jsx:'automatic',alias:{'@':`${process.cwd()}/client/src`},
    define:{'process.env.NODE_ENV':'"test"'}});
  const server=createServer((req,res)=>{
    res.setHeader('Content-Type',req.url==='/fixture.js'?'text/javascript':'text/html');
    res.end(req.url==='/fixture.js'?output.outputFiles[0].text:'<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try{
    browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
    const page=await browser.newPage();
    const origin=`http://127.0.0.1:${server.address().port}`;
    const token='isolated-browser-bearer-value-not-a-real-token';
    let saved=null;const writes=[];
    await page.route('**/*',async route=>{
      const req=route.request();
      if(!req.url().startsWith(origin))return route.abort();
      if(!req.url().includes('/api/'))return route.continue();
      assert.equal(new URL(req.url()).pathname,'/api/public/sales-ticket-registration');
      assert.equal(req.method(),'POST');
      const body=req.postDataJSON();assert.equal(body.token,token);
      if(body.action==='context')return route.fulfill({json:{customerName:'Fixture purchaser',serverNow:new Date().toISOString(),
        settings:{terms:'',codeOfConduct:null,requireJobTitle:false,collectOptions:false},
        allocations:[{id:'allocation',eventName:'Conference',ticketName:'Delegate',remaining:saved?.status==='registered'?0:1,
          registered:saved?.status==='registered'?1:0,allocated:1,closed:false,closesAt:null,slots:saved?[saved]:[]},
        {id:'closed',eventName:'Closed allocation',ticketName:'Delegate',remaining:1,registered:0,allocated:1,closed:true,
          reason:'Registration is closed',closesAt:'2000-01-01T00:00:00Z',slots:[]}] }});
      assert.equal(body.action,'saveSlot');writes.push(body);
      assert.equal(body.expectedVersion,saved?.version||0);
      saved={id:body.slotId,version:(saved?.version||0)+1,details:body.details,status:body.complete?'registered':'draft'};
      return route.fulfill({json:saved});
    });
    await page.goto(`${origin}/#token=${token}`);
    const section=page.getByRole('region',{name:'Conference — Delegate'});
    await section.getByRole('button',{name:'Add attendee'}).click();
    await section.getByLabel(/First name/).fill('Partial');
    await section.getByRole('button',{name:'Save draft',exact:true}).click();
    await page.getByText(/Draft saved/).waitFor();
    assert.equal(writes[0].complete,false);
    assert.equal(new URL(page.url()).search,'','bearer stays in the fragment, never in a request query');
    await page.goto(`${origin}/#token=${token}`);
    await section.getByLabel(/First name/).waitFor();
    assert.equal(await section.getByLabel(/First name/).inputValue(),'Partial');
    await section.getByLabel(/Last name/).fill('Person');
    await section.getByLabel(/Attendee email/).fill('attendee@example.invalid');
    await section.getByRole('button',{name:'Complete registration',exact:true}).click();
    await section.getByText('Registration saved.',{exact:true}).waitFor();
    await section.getByLabel(/First name/).fill('Amended');
    await section.getByRole('button',{name:'Save registration changes'}).click();
    await page.waitForFunction(()=>document.querySelector('input[autocomplete="given-name"]')?.value==='Amended');
    assert.equal(writes.length,3);
    assert.equal(new Set(writes.map(w=>w.slotId)).size,1);
    assert.deepEqual(writes.map(w=>w.expectedVersion),[0,1,2]);
    assert.equal(await page.getByRole('region',{name:'Closed allocation — Delegate'}).getByRole('button',{name:'Add attendee'}).count(),0);
    assert.equal(await page.evaluate(()=>localStorage.length+sessionStorage.length),0);
  }finally{
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
  }
});
