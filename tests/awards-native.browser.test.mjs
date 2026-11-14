import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:https';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {build} from 'esbuild';
import {chromium} from 'playwright';

test('native browser journey: scoring, moderation, event publication and certificates',{timeout:180000},async()=>{
  const bundle=await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
    import React from 'react';import{createRoot}from'react-dom/client';
    import{QueryClient,QueryClientProvider}from'@tanstack/react-query';
    import JudgingAssessment from './client/src/components/awards/JudgingAssessment.jsx';
    import ModerationPanel from './client/src/components/awards/ModerationPanel.jsx';
    import EventAwardsSection from './client/src/components/awards/EventAwardsSection.jsx';
    import CertificateIssuance from './client/src/components/awards/CertificateIssuance.jsx';
    const fixture=window.fixtureConfig;
    if(fixture.type==='certificate'){
      createRoot(document.getElementById('root')).render(<CertificateIssuance
        tenant={{tenantId:fixture.tenantId,scopeKey:'native-admin',assertCurrent(){}}}
        templates={[fixture.template]} outcomes={[fixture.outcome]} issues={[]} ready={true}
        onIssued={async()=>{}} onDirtyChange={()=>{}} onBusyChange={()=>{}}/>);
    }else if(fixture.type==='event'){
      createRoot(document.getElementById('root')).render(<EventAwardsSection eventId={fixture.eventId} type="event"/>);
    }else if(fixture.type==='moderation'){
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}>
        <ModerationPanel roundId={fixture.roundId} applicationId={fixture.applicationId}
          tenant={{tenantId:fixture.tenantId,scopeKey:'native-admin',assertCurrent(){}}}
          canModerate={fixture.action==='propose'} canApprove={fixture.action==='approve'}/>
      </QueryClientProvider>);
    }else fetch('/api/judging/assessment?assignmentId='+window.fixtureAssignmentId).then(r=>r.json()).then(data=>createRoot(document.getElementById('root')).render(
      <JudgingAssessment data={data} summary={{roundState:'judging',deadline:'2099-01-01T00:00:00Z'}}
        onDirtyChange={()=>{}} onBusyChange={()=>{}} onSaved={()=>{}}/>));
  `},bundle:true,write:false,outdir:'/tmp/awards-native-browser-build',format:'esm',jsx:'automatic',alias:{'@':`${process.cwd()}/client/src`},define:{'process.env.NODE_ENV':'"test"'},
    plugins:[{name:'existing-admin-identity-fixture',setup(builder){
      builder.onResolve({filter:/(?:^|\/)(?:base44Client|queryClient)$/},args=>({path:args.path,namespace:'fixture'}));
      builder.onLoad({filter:/.*/,namespace:'fixture'},()=>({loader:'js',contents:'export const getActiveTenantId=()=>window.fixtureConfig.tenantId;export const emitTenantContextChanged=()=>{};'}));
    }}]});
  const tlsDirectory=mkdtempSync(join(tmpdir(),'awards-browser-tls-'));
  let browser,server,child,assignmentId,cookie,fixtureConfig,nextId=0,steps=0,moderationSteps=0,eventSteps=0,certificateSteps=0,errors=[];
  const pending=new Map(),write=value=>child.stdin.write(`${JSON.stringify(value)}\n`);
  const request=(path,query,body=null,headers={})=>new Promise((resolve,reject)=>{
    const id=++nextId;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Native API response timed out'));},15000);
    pending.set(id,value=>{clearTimeout(timer);resolve(value);});
    write({type:'request',id,path,body,query,headers});
  });
  try{
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
      '-keyout',join(tlsDirectory,'key.pem'),'-out',join(tlsDirectory,'cert.pem')],{stdio:'ignore'});
    browser=await chromium.launch({headless:true,executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim()});
    server=createServer({key:readFileSync(join(tlsDirectory,'key.pem')),cert:readFileSync(join(tlsDirectory,'cert.pem'))},async(req,res)=>{
      try{
        if(req.url==='/bundle.js'){res.setHeader('Content-Type','text/javascript');return res.end(bundle.outputFiles.find(file=>file.path.endsWith('.js')).text);}
        if(req.url.startsWith('/api/')){
          let raw='';for await(const chunk of req)raw+=chunk;
          const url=new URL(req.url,'https://fixture.invalid');
          const response=await request(url.pathname.slice(5),Object.fromEntries(url.searchParams),raw?JSON.parse(raw):null,req.headers);
          if(response.status>=400)errors.push(`Native browser API ${response.status}: ${response.body?.error}; cookie present: ${Boolean(req.headers.cookie)}`);
          res.statusCode=response.status;res.setHeader('Content-Type',response.contentType||'application/json');
          return res.end(response.body?.type==='Buffer'?Buffer.from(response.body.data):JSON.stringify(response.body));
        }
        if(cookie)res.setHeader('Set-Cookie',cookie);
        res.setHeader('Content-Type','text/html');res.end(`<div id="root"></div><script>window.fixtureAssignmentId=${JSON.stringify(assignmentId??null)};window.fixtureConfig=${JSON.stringify(fixtureConfig)}</script><script type="module" src="/bundle.js"></script>`);
      }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const origin=`https://127.0.0.1:${server.address().port}`;
    child=spawn(process.execPath,['scripts/run-isolated-tests.mjs','--allow-local-postgrest','--allow-local-postgres','node',
      '--import','./scripts/test-support/awards-browser-mode.mjs','supabase/migrations/awardsFoundation.test.mjs'],{stdio:['pipe','pipe','pipe']});
    const finished=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
    child.stderr.on('data',chunk=>errors.push(String(chunk)));
    const lines=createInterface({input:child.stdout});
    lines.on('line',async line=>{
      const marker=line.indexOf('AWARDS_BROWSER_FRAME:');
      if(marker<0){if(/not ok|error:/.test(line))errors.push(line);return;}
      const frame=JSON.parse(line.slice(marker+'AWARDS_BROWSER_FRAME:'.length));
      if(frame.type==='response'){const resolve=pending.get(frame.id);pending.delete(frame.id);resolve?.(frame);return;}
      if(!['assessment','moderation','event','certificate'].includes(frame.type))return;
      assignmentId=frame.assignmentId;cookie=frame.cookie;
      fixtureConfig={...frame};delete fixtureConfig.cookie;delete fixtureConfig.csrf;
      const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:steps===1?390:1280,height:900}});
      page.setDefaultTimeout(12000);
      page.on('pageerror',error=>errors.push(error.message));
      try{
        if(frame.csrf)await page.addInitScript(csrf=>sessionStorage.setItem('iconnect.judging.csrf',csrf),frame.csrf);
        await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
        await page.goto(origin);
        if(frame.type==='certificate'){
          await page.getByRole('combobox').nth(0).selectOption(frame.template.id);
          await page.getByRole('combobox').nth(1).selectOption(frame.outcome.id);
          await page.getByRole('combobox').nth(2).selectOption('member');
          await page.getByRole('button',{name:'Generate server preview',exact:true}).click();
          const download=page.waitForEvent('download');
          await page.getByRole('button',{name:'Download preview for review',exact:true}).click();
          const stream=await (await download).createReadStream(),chunks=[];
          for await(const chunk of stream)chunks.push(chunk);
          const {PDFDocument}=await import('pdf-lib');
          assert.equal((await PDFDocument.load(Buffer.concat(chunks))).getPageCount(),1);
          await page.getByLabel('Generation approval reason',{exact:true}).fill('Reviewed native PDF before immutable issuance');
          await page.getByRole('button',{name:'Review immutable issuance…',exact:true}).click();
          await page.getByRole('button',{name:'Approve and generate certificate',exact:true}).click();
          await page.getByRole('status').filter({hasText:'Certificate issued'}).waitFor();
          certificateSteps++;write({type:'done'});return;
        }
        if(frame.type==='event'){
          await page.getByTestId('event-awards-section').waitFor();
          assert.equal(await page.getByText('Event winner',{exact:true}).count(),frame.published?1:0);
          assert.equal(await page.getByText('Native Applicant',{exact:true}).count(),frame.published?1:0);
          assert.equal(await page.getByRole('link',{name:/Apply for/}).count(),1);
          eventSteps++;write({type:'done'});return;
        }
        if(frame.type==='moderation'){
          if(frame.action==='propose'){
            await page.locator('#moderation-overall').fill(String(frame.score));
            await page.locator('#moderation-justification').fill('Native browser panel evidence justification');
            await page.getByRole('button',{name:'Save proposal',exact:true}).click();
            await page.getByText('Moderation: proposed',{exact:false}).waitFor();
          }else{
            await page.getByRole('button',{name:'Approve moderation…',exact:true}).click();
            await page.locator('#moderation-action-reason').fill('Independent native browser approval');
            await page.getByRole('button',{name:'Confirm action',exact:true}).click();
            await page.getByText('Moderation: approved',{exact:false}).waitFor();
          }
          moderationSteps++;write({type:'done'});return;
        }
        const input=`#judge-${frame.criterionId}-value`;
        await page.locator(input).fill(String(frame.value));
        await page.getByRole('button',{name:'Save draft',exact:true}).click();
        await page.getByText('Draft saved',{exact:false}).waitFor();
        await page.reload();
        await page.locator(input).waitFor();
        assert.equal(await page.locator(input).inputValue(),String(frame.value));
        await page.getByRole('button',{name:'Submit assessment',exact:true}).click();
        await page.getByRole('button',{name:'Confirm submission',exact:true}).click();
        await page.waitForFunction(selector=>document.querySelector(selector)?.matches(':disabled'),input);
        steps++;write({type:'done'});
      }catch(error){errors.push(error.message);write({type:'done',error:error.message});}
      finally{await page.close();}
    });
    const result=await finished;
    assert.equal(result.code,0,errors.join('\n').slice(-6000));
    assert.deepEqual(errors,[],'The native browser journey must not hide browser or API errors');
    assert.equal(steps,4);
    assert.equal(moderationSteps,2);
    assert.equal(eventSteps,2);
    assert.equal(certificateSteps,1);
  }finally{
    child?.kill('SIGTERM');child?.stdin.destroy();
    await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
    rmSync(tlsDirectory,{recursive:true,force:true});
  }
});
