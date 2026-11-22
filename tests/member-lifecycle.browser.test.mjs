// Real browser against current components and isolated fixtures only. This does
// not bypass or modify the application's authentication or contact a tenant.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { DEFAULT_LIFECYCLE_POLICY } from '../shared/memberLifecyclePolicy.mjs';

let browser,server,origin;
const memberId='33333333-3333-4333-8333-333333333333', previewId='44444444-4444-4444-8444-444444444444';
const calls=[];
let enabled=false;
const config=()=>({policy:{...DEFAULT_LIFECYCLE_POLICY},revision:7,enabled,executionReady:true,reviewReady:true,
  permissions:{view:true,configure:true,review:true,archive:true,minimise:true,delete:true},roles:[],readinessIssues:[],
  runtime:{paused:!enabled,lastRunAt:null}});
before(async()=>{
  const output=await build({stdin:{contents:`
    import React from 'react';import{createRoot}from'react-dom/client';
    import MemberLifecycle from './client/src/pages/MemberLifecycle.jsx';
    createRoot(document.getElementById('root')).render(<MemberLifecycle/>);
  `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',
    outdir:'/tmp/member-lifecycle-fixture-build',alias:{'@':`${process.cwd()}/client/src`},
    define:{'process.env.NODE_ENV':'"test"','import.meta.env':'{}'}});
  const css=execFileSync('node',['node_modules/tailwindcss/lib/cli.js','-i','client/src/index.css'],{maxBuffer:10*1024*1024});
  const javascript=output.outputFiles.find(file=>file.path.endsWith('.js')).text;
  const localCss=output.outputFiles.find(file=>file.path.endsWith('.css'))?.text || '';
  server=createServer(async(req,res)=>{
    if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(javascript);}
    if(req.url==='/fixture.css'){res.setHeader('Content-Type','text/css');return res.end(css+'\n'+localCss);}
    if(req.url.startsWith('/api/admin/member-lifecycle')){
      res.setHeader('Content-Type','application/json');
      const url=new URL(req.url,'https://fixture.invalid');
      if(req.method==='GET'){
        const section=url.searchParams.get('section');
        if(section==='operations'||section==='cleanup')return res.end(JSON.stringify({items:[],limited:false}));
        if(section==='review')return res.end(JSON.stringify({items:[{memberId,state:'archived',reason:'archive_retention_elapsed'}],nextCursor:null}));
        if(section==='detail')return res.end(JSON.stringify({memberId,revision:3,state:'archived',evidence:{membershipComplete:true},
          blockers:[],audit:[],proposal:{action:'deletion_review',reason:'archive_retention_elapsed'}}));
        return res.end(JSON.stringify(config()));
      }
      let raw='';for await(const chunk of req)raw+=chunk;
      const body=JSON.parse(raw);calls.push(body);
      if(body.action==='preview')return res.end(JSON.stringify({previewId,revision:7,complete:!!body.cursor,
        nextCursor:body.cursor?null:memberId,counts:{archive:1},items:body.cursor?[]:[{memberId,action:'archive',reason:'former_inactivity_elapsed'}]}));
      if(body.action==='approve'){assert.equal(body.confirmed,true);enabled=true;return res.end(JSON.stringify(config()));}
      if(body.action==='pause'){enabled=false;return res.end(JSON.stringify(config()));}
      if(body.action==='retain')return res.end(JSON.stringify({memberId,revision:4,state:'archived',hold:true}));
      res.statusCode=409;return res.end(JSON.stringify({error:'Unexpected fixture mutation'}));
    }
    if(req.url.startsWith('/api/')){res.statusCode=500;return res.end('Unexpected fixture API');}
    res.setHeader('Content-Type','text/html');
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
test('real browser requires every preview page and acknowledgement before enabling, then pauses',async()=>{
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading',{name:'Member lifecycle',exact:true}).waitFor();
  await page.getByRole('button',{name:'Generate impact preview',exact:true}).click();
  const approve=page.getByRole('button',{name:'Approve preview & enable rules'});
  await approve.waitFor();
  assert.equal(await approve.isDisabled(),true);
  await page.getByRole('button',{name:'Load next preview page'}).click();
  await page.getByText(/All pages loaded/).waitFor();
  assert.equal(await approve.isDisabled(),true);
  await page.getByRole('checkbox').last().check();
  await approve.click();
  await page.getByRole('button',{name:'Pause automation'}).click();
  await page.getByRole('button',{name:'Pause automation'}).waitFor({state:'detached'});
  assert.deepEqual(calls.find(row=>row.action==='approve'),{action:'approve',previewId,expectedRevision:7,confirmed:true});
  assert.deepEqual(calls.find(row=>row.action==='pause'),{action:'pause',expectedRevision:7});
  assert.deepEqual(errors,[]);
  await page.close();
});
test('mobile configuration remains contained and approval is never implicit',async()=>{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin);
  await page.getByRole('heading',{name:'Member lifecycle',exact:true}).waitFor();
  const overflow=await page.evaluate(()=>[...document.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>window.innerWidth+1)
    .slice(0,8).map(el=>({tag:el.tagName,className:el.className,width:el.getBoundingClientRect().width})));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),JSON.stringify(overflow));
  assert.equal(await page.getByRole('button',{name:'Approve preview & enable rules'}).count(),0);
  await page.close();
});
