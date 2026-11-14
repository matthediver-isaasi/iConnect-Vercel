// Real editor component against isolated in-memory command fixtures.
// This verifies browser interactions, not deployed tenant or provider behavior.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
let server, browser, origin;
before(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import AwardEditor from './client/src/components/awards/AwardEditor.jsx';
      const initial={id:'award',version:1,name:'Research Excellence',state:'draft',timezone:'UTC',cycle:'2027',
        opens_at:'2027-01-01T09:00:00Z',closes_at:'2027-02-01T17:00:00Z',form_id:'form',
        retention_policy:{retention_days:365,disposal_authority:'Privacy administrator',legal_hold_policy:'Suspend disposal while held'}};
      function Fixture() {
        const [award,setAward]=useState(initial),[dirty,setDirty]=useState(false);
        return <main style={{maxWidth:900,margin:'auto',padding:16}}>
          <AwardEditor award={award} creating={false} canEdit={!location.search.includes('readonly')} busy={false}
            onDirtyChange={setDirty} formsQuery={{data:[{id:'form',name:'Research application'},{id:'second',name:'Alternative application'}]}}
            onCommand={async(command,previous,payload)=>{
              if(location.search.includes('conflict')) throw new Error('Award changed; reload before continuing');
              window.commands=[...(window.commands||[]),{command,version:previous.version,payload}];
              const next={...previous,...(command==='configure'?payload:{}),
                ...(command==='bind_form'?{form_id:payload.form_id}:{}),
                ...(command==='transition'?{state:payload.state}:{}),version:previous.version+1};
              setAward(next);return next;
            }} onCancel={()=>{}} />
          <output data-testid="dirty">{String(dirty)}</output>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` }, bundle:true, write:false, format:'iife', jsx:'automatic', alias:{'@':`${process.cwd()}/client/src`},
    define:{'process.env.NODE_ENV':'"test"'},
  });
  server=createServer((req,res)=>{
    if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles[0].text);}
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
for (const width of [1280,390]) test(`configuration saves, binding survives state updates at ${width}px`,async()=>{
  const page=await browser.newPage({viewport:{width,height:900}});
  page.on('pageerror',error=>console.error(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.goto(origin);
    await page.getByText('Saved application form: Research application',{exact:true}).waitFor();
    await page.locator('#award-name').fill('Updated research award');
    await page.getByRole('button',{name:'Save configuration',exact:true}).click();
    await page.getByText('Configuration saved.',{exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.commands))[0].version,1);
    page.on('dialog',dialog=>dialog.accept());
    await page.locator('#award-form').selectOption('second');
    await page.getByRole('button',{name:'Bind selected form'}).click();
    await page.getByText('Saved application form: Alternative application',{exact:true}).waitFor();
    assert.equal((await page.evaluate(()=>window.commands))[1].version,2);
  }finally{await page.close();}
});
test('read-only and stale-version error preserve configuration',async()=>{
  const page=await browser.newPage();
  page.on('pageerror',error=>console.error(error.message));
  page.setDefaultTimeout(5000);
  try{
    await page.goto(`${origin}?readonly`);
    assert.equal(await page.locator('#award-name').isDisabled(),true);
    assert.equal(await page.getByRole('button',{name:'Save configuration',exact:true}).count(),0);
    await page.goto(`${origin}?conflict`);
    await page.locator('#award-name').fill('Unsaved change');
    await page.getByRole('button',{name:'Save configuration',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'Award changed; reload before continuing'}).waitFor();
    assert.equal(await page.locator('#award-name').inputValue(),'Unsaved change');
    assert.equal(await page.getByTestId('dirty').textContent(),'true');
  }finally{await page.close();}
});
