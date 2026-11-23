// Mounted reservation controls + real HTTP handler/service/domain evaluation.
// Database RPCs and commercial resolution are isolated fixtures. Actual
// transaction/concurrency evidence lives in the local PostgreSQL suite.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createEventFunnelJourneyHandler } from '../api/_lib/eventFunnelJourneyHandler.js';

const tenant='00000000-0000-4000-8000-000000000001',id='00000000-0000-4000-8000-000000000002';
const member='00000000-0000-4000-8000-000000000003',eventId='00000000-0000-4000-8000-000000000004';
let server,browser,origin,fixture;
const makeSnapshot = (duration=900000,state='held') => {
  const event={id:eventId,kind:'simple',tenantId:tenant}, now=Date.now();
  return {
    session:{id,tenant_id:tenant,revision:2,state,first_reserved_at:new Date(now).toISOString(),
      expires_at:new Date(now+duration).toISOString(),journey:{version:1,decisions:{},checkoutNow:false}},
    graph:{version:1,tenantId:tenant,entry:'source',reservationSeconds:900,invoiceMode:'per_event',nodes:[
      {id:'source',type:'source',event,ticketIds:['A'],requires:[],accept:'parking'},
      {id:'parking',type:'addon',event,ticketIds:['P'],requires:['source'],accept:'checkout',skip:'checkout'},
      {id:'checkout',type:'checkout'},
    ]},drafts:{source:{name:'Saved attendee'}},
    holds:[{node_id:'source',ticket_id:'A',event_id:eventId,event_kind:'simple',quantity:1,places:1,
      price_snapshot:{unitMinor:1000,currency:'GBP'}}],
  };
};
const snapshot = () => ({...structuredClone(fixture.saved),serverNow:new Date().toISOString()});
before(async()=>{
  const output=await build({
    stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
      import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import Frame from './client/src/components/booking/EventFunnelJourneyFrame.jsx';
      function Contents({snapshot,change,saveAnswers,refresh}) {
        const [name,setName]=useState(snapshot.drafts.source?.name || '');
        return <div>
          <label>Attendee name<input data-testid="fixture-name" value={name} onChange={e=>setName(e.target.value)} /></label>
          <button data-testid="fixture-save" onClick={()=>saveAnswers('source',{name})}>Save attendee</button>
          {snapshot.route.currentNodeId==='parking' && <button data-testid="fixture-add" onClick={()=>change({
            type:'select',nodeId:'parking',tickets:[{id:'P',quantity:1}]
          })}>Add parking</button>}
          <button data-testid="fixture-refresh" onClick={refresh}>Reload reservation</button>
          <output data-testid="fixture-holds">{snapshot.holds.length}</output>
          <output data-testid="fixture-revision">{snapshot.session.revision}</output>
          <output data-testid="fixture-route">{snapshot.route.currentNodeId}</output>
        </div>;
      }
      function App() {
        const [session,setSession]=useState('${id}');
        window.switchSession=id=>setSession(id);
        return <main><Frame sessionId={session} sourceLabel="Conference admission" onBack={()=>{window.backCalls=(window.backCalls||0)+1;}}>
          {props=><Contents {...props}/>}
        </Frame></main>;
      }
      createRoot(document.getElementById('root')).render(<App/>);`},
    bundle:true,write:false,format:'esm',outdir:'out',loader:{'.css':'css'},
  });
  const js=output.outputFiles.find(f=>f.path.endsWith('.js')).text;
  const css=output.outputFiles.find(f=>f.path.endsWith('.css'))?.text||'';
  const db={rpc:async(name,args)=>{
    fixture.calls.push([name,structuredClone(args)]);
    if(name==='event_funnel_consume_limit')return {data:true};
    if(fixture.revoked||args.p_id!==id||args.p_tenant!==tenant||args.p_member!==member) return {error:{code:'PT404'}};
    if(name==='event_funnel_read_session') {
      if(fixture.failRead)return {error:{code:'57014'}};
      return {data:snapshot()};
    }
    if(name==='event_funnel_save_answers'){
      if(args.p_expected_revision!==fixture.saved.session.revision)return {error:{code:'PT409'}};
      fixture.saved.session.revision++;fixture.saved.drafts[args.p_node]=args.p_answers;
      return {data:fixture.saved.session};
    }
    if(name==='event_funnel_apply_journey') {
      if(args.p_expected_revision!==fixture.saved.session.revision)return {error:{code:'PT409'}};
      if(fixture.failCommit)return {error:{code:'23514'}};
      fixture.saved.session.revision++;
      fixture.saved.session.journey=args.p_journey;
      fixture.saved.holds=args.p_lines.map(line=>({
        node_id:line.nodeId,ticket_id:line.ticketId,event_id:eventId,event_kind:'simple',quantity:line.quantity,places:line.quantity,
        price_snapshot:line.priceSnapshot,
      }));
      if(args.p_rereserve){
        fixture.saved.session.state='held';
        fixture.saved.session.first_reserved_at=new Date().toISOString();
        fixture.saved.session.expires_at=new Date(Date.now()+900000).toISOString();
      } else if(Date.parse(fixture.saved.session.expires_at)<=Date.now())fixture.saved.session.state='expired';
      if(args.p_answer_node)fixture.saved.drafts[args.p_answer_node]=args.p_answers;
      return {data:snapshot()};
    }
    throw new Error(`Unexpected fixture RPC ${name}`);
  }};
  const handler=createEventFunnelJourneyHandler({
    db,resolveTenant:async()=>({id:tenant}),loadViewer:async()=>({tenantId:tenant,memberId:member}),
    resolveSelection:async({tickets})=>{
      if(fixture.failQuote)throw new Error('Fixture optional offer unavailable');
      return tickets.map(ticket=>({ticketId:ticket.id,priceSnapshot:{unitMinor:1200,currency:'GBP'}}));
    },
  });
  server=createServer(async(req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
    if(req.url==='/api/event-funnels/journey'){
      let body='';for await(const chunk of req)body+=chunk;
      req.body=JSON.parse(body);fixture.requests.push(req.body);
      res.status=n=>{res.statusCode=n;return res;};res.json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));return res;};
      await handler(req,res);return;
    }
    if(req.url!=='/'&&req.url!=='/favicon.ico'){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type','text/html');
    res.end(`<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>
      :root{--primary:225 58% 38%;--foreground:222 30% 18%;--card:0 0% 100%;--border:216 22% 85%;--muted:220 15% 94%;--muted-foreground:222 14% 42%;--warning:30 90% 40%;--radius:.6rem;}
      body{font-family:Arial,sans-serif;background:#f4f6fa;margin:0;padding:30px;}main{max-width:850px;margin:auto;}
      button{cursor:pointer;padding:10px;border:1px solid #ccd3de;border-radius:6px;background:white;}
      button:disabled{opacity:.5;cursor:default;}input{padding:8px;margin:10px;border:1px solid #ccd3de;}
      </style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim(),headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function open({duration=900000,state='held',viewport={width:1200,height:800}}={}){
  fixture={saved:makeSnapshot(duration,state),calls:[],requests:[]};
  const page=await browser.newPage({viewport});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin);
  await page.getByTestId('fixture-name').waitFor();
  return {page,errors};
}
test('owned attendee edits, optional failure, source-only checkout and refresh preserve the source',async()=>{
  const {page,errors}=await open();
  try{
    const deadline=fixture.saved.session.expires_at;
    await page.getByTestId('fixture-name').fill('Edited attendee');
    await page.getByTestId('fixture-save').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-revision"]').textContent==='3');
    fixture.failQuote=true;
    await page.getByTestId('fixture-add').click();
    await page.getByTestId('journey-error').waitFor();
    assert.equal(await page.getByTestId('fixture-name').inputValue(),'Edited attendee');
    assert.equal(await page.getByTestId('fixture-holds').textContent(),'1');
    assert.equal(fixture.saved.session.expires_at,deadline);
    await page.getByTestId('journey-source-only').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-route"]').textContent==='checkout');
    await page.reload();await page.getByTestId('fixture-name').waitFor();
    assert.equal(await page.getByTestId('fixture-name').inputValue(),'Edited attendee');
    assert.equal(await page.getByTestId('fixture-route').textContent(),'checkout');
    await page.getByTestId('journey-resume-offers').click();
    await page.getByTestId('fixture-add').waitFor();
    fixture.failQuote=false;
    await page.getByTestId('fixture-add').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-holds"]').textContent==='2');
    await page.getByTestId('journey-source-only').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-holds"]').textContent==='1');
    assert.equal(fixture.saved.session.expires_at,deadline);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('expiry does not silently renew; explicit re-reservation is the only write that restores the timer',async()=>{
  const {page,errors}=await open({duration:1500});
  try{
    await page.getByTestId('journey-rereserve').waitFor();
    assert.equal(fixture.requests.some(r=>r.command?.type==='rereserve'),false);
    const deadline=fixture.saved.session.expires_at;
    await page.getByTestId('journey-source-only').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-route"]').textContent==='checkout');
    assert.equal(fixture.saved.session.state,'expired');
    assert.equal(fixture.saved.session.expires_at,deadline);
    await page.getByTestId('journey-rereserve').click();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="journey-rereserve"]'));
    assert.equal(fixture.requests.filter(r=>r.command?.type==='rereserve').length,1);
    assert.notEqual(fixture.saved.session.expires_at,deadline);
    assert.equal(await page.getByTestId('fixture-name').inputValue(),'Saved attendee');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('payment uncertainty locks every mutation without inviting another payment',async()=>{
  const {page,errors}=await open({state:'payment_uncertain',viewport:{width:390,height:844}});
  try{
    assert.match(await page.locator('body').innerText(),/Do not pay again/);
    assert.equal(await page.getByTestId('fixture-save').isDisabled(),true);
    assert.equal(await page.getByTestId('journey-source-only').count(),0);
    assert.equal(await page.getByTestId('journey-rereserve').count(),0);
    fixture.saved.session.state='confirmed';
    fixture.saved.session.revision++;
    await page.getByTestId('journey-refresh').click();
    await page.getByText('Your booking is confirmed',{exact:true}).waitFor();
    assert.equal(fixture.requests.some(r=>r.action!=='read'),false);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('network errors retain saved data; lost ownership clears it',async()=>{
  const {page,errors}=await open();
  try{
    fixture.failRead=true;
    await page.getByTestId('fixture-refresh').click();
    await page.getByTestId('journey-error').waitFor();
    assert.equal(await page.getByTestId('fixture-name').inputValue(),'Saved attendee');
    fixture.failRead=false;fixture.revoked=true;
    await page.getByTestId('fixture-refresh').click();
    await page.waitForFunction(()=>!document.querySelector('[data-testid="fixture-name"]'));
    assert.equal(fixture.requests.filter(r=>r.action!=='read').length,0);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('a session switch never renders another reservation’s saved attendee',async()=>{
  const {page,errors}=await open();
  try{
    await page.evaluate(()=>window.switchSession('00000000-0000-4000-8000-000000000099'));
    await page.waitForFunction(()=>!document.querySelector('[data-testid="fixture-name"]'));
    assert.equal((await page.locator('body').innerText()).includes('Saved attendee'),false);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('ordinary revision updates never extend the visible timer and warnings are not per-second announcements',async()=>{
  const {page,errors}=await open({duration:59000});
  try{
    const time=async()=>Number((await page.getByTestId('journey-remaining-time').innerText()).match(/(\d+):(\d+)/)[1])*60
      +Number((await page.getByTestId('journey-remaining-time').innerText()).match(/(\d+):(\d+)/)[2]);
    const before=await time();
    const announcement=await page.getByTestId('journey-time-announcement').textContent();
    assert.match(announcement,/One minute/);
    fixture.saved.session.expires_at=new Date(Date.now()+900000).toISOString();
    fixture.saved.session.revision++;
    await page.getByTestId('fixture-refresh').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-revision"]').textContent==='3');
    assert.ok(await time()<=before);
    assert.equal(await page.getByTestId('journey-time-announcement').textContent(),announcement);
    assert.equal(fixture.requests.some(r=>r.command?.type==='rereserve'),false);
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
test('skipping is persisted and Back is navigation only, not an inventory mutation',async()=>{
  const {page,errors}=await open();
  try{
    await page.getByTestId('journey-back').click();
    assert.equal(await page.evaluate(()=>window.backCalls),1);
    assert.equal(fixture.requests.some(r=>r.action!=='read'),false);
    await page.getByTestId('journey-skip').click();
    await page.waitForFunction(()=>document.querySelector('[data-testid="fixture-route"]').textContent==='checkout');
    assert.deepEqual(fixture.saved.session.journey.decisions,{parking:'skip'});
    assert.equal(fixture.saved.holds.length,1);
    await page.reload();await page.getByTestId('fixture-name').waitFor();
    assert.equal(await page.getByTestId('fixture-route').textContent(),'checkout');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});
