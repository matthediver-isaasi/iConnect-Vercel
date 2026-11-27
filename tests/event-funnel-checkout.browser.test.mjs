import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
let browser,server,origin,fixture;
const id='00000000-0000-4000-8000-000000000001',orderId='00000000-0000-4000-8000-000000000002';
before(async()=>{
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import Checkout from './client/src/components/booking/EventFunnelCheckoutSlot.jsx';
    const snapshot={session:{id:'${id}',revision:2,state:'held',journey:{checkoutNow:true}}};
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Checkout snapshot={snapshot}
      checkoutEligibility={{allowed:true,canSubmitNow:()=>true}} change={async()=>{}} refresh={async()=>{}}/></QueryClientProvider>);
  `},bundle:true,write:false,outdir:'out',format:'esm',jsx:'automatic',
    alias:{'@':path.resolve('client/src')},plugins:[{name:'isolated-funding-and-provider-ui',setup(b){
      b.onResolve({filter:/EventFunnelCheckout(Funding|Payment)$/},args=>({path:args.path,namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Fixture(){return null}; export const EventFunnelTrainingFund = Fixture; export const EventFunnelDiscountCode = Fixture;',loader:'js'}));
    }}]});
  const js=output.outputFiles.find(file=>file.path.endsWith('.js')).text;
  server=createServer(async(req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(req.url==='/api/event-funnels/checkout'){
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);fixture.requests.push(body);
      res.setHeader('Content-Type','application/json');
      if(body.action==='summary') return res.end(JSON.stringify({revision:2,currency:'GBP',totalMinor:0,paymentMethods:['free'],
        atCheckout:true,customers:[],memberFunding:false,trainingFund:{enabled:false},order:fixture.order,
        lines:[{nodeId:'source',ticketId:'A',quantity:1,eventTitle:'Conference',ticketName:'Admission'}]}));
      if(body.action==='quote') return res.end(JSON.stringify({revision:2,currency:'GBP',payableMinor:0,
        trainingFundMinor:0,voucherMinor:0,discountMinor:0,discountCode:null,paymentMethod:'free',paymentMethods:['free'],invoiceMode:'per_event',
        lines:[{nodeId:'source',ticketId:'A',quantity:1,amountMinor:0,payableMinor:0,trainingFundMinor:0,voucherMinor:0}]}));
      if(body.action==='prepare'){
        if(fixture.closed){res.statusCode=409;return res.end(JSON.stringify({error:'Closed',code:'CHECKOUT_NOT_READY'}));}
        fixture.order={id:orderId,state:'payable',paymentMethod:'free',currency:'GBP',payableMinor:0};
        return res.end(JSON.stringify({order:fixture.order}));
      }
      if(body.action==='status'){
        const state=fixture.status || 'confirmed';
        if(fixture.order)fixture.order.state=state;
        return res.end(JSON.stringify({orderId,state}));
      }
      if(body.action==='payment'){
        if(fixture.failPayment){fixture.failPayment=false;res.statusCode=503;return res.end(JSON.stringify({error:'Uncertain fixture response'}));}
        return res.end(JSON.stringify({orderId,state:'requires_payment_method',clientSecret:'fixture',publishableKey:'fixture'}));
      }
      if(body.action==='cancel'){fixture.status='cancelled';fixture.order=null;return res.end(JSON.stringify({orderId,state:'cancelled'}));}
      res.statusCode=400;return res.end('{}');
    }
    if(req.url==='/api/event-funnels/invoices'){
      let data='';for await(const chunk of req)data+=chunk;
      const body=JSON.parse(data);fixture.invoiceRequests??=[];fixture.invoiceRequests.push(body);
      if(fixture.invoiceFailure){res.statusCode=503;return res.end('{}');}
      if(body.action==='list'&&fixture.invoicesPending>0){fixture.invoicesPending--;res.setHeader('Content-Type','application/json');
        return res.end(JSON.stringify({state:'pending',invoices:[{id:'00000000-0000-4000-8000-000000000003',number:null,status:'processing',available:false}]}));}
      if(body.action==='download'){res.setHeader('Content-Type','application/pdf');return res.end('%PDF-1.4 fixture');}
      res.setHeader('Content-Type','application/json');
      return res.end(JSON.stringify({state:'delivered',invoices:[{id:'00000000-0000-4000-8000-000000000003',
        number:'INV-FIXTURE',status:'complete',available:true}]}));
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim(),headless:true,args:['--no-sandbox']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
async function open(closed=false,overrides={}){
  fixture={requests:[],order:null,closed,...overrides};
  const page=await browser.newPage();
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin);await page.getByTestId('event-funnel-checkout').waitFor();
  return page;
}
test('one submit confirms silently and invoices show per-line progress',async()=>{
  const page=await open(false,{invoicesPending:1});
  await page.waitForTimeout(300);
  assert.equal(fixture.requests.filter(r=>r.action==='prepare').length,0);
  // Record every text that appears while submitting; interim panels must not flash.
  await page.evaluate(()=>{window.seen=new Set();new MutationObserver(()=>window.seen.add(document.body.innerText))
    .observe(document.body,{subtree:true,childList:true,characterData:true});});
  await page.getByTestId('event-funnel-submit').click();
  await page.getByRole('heading',{name:'Booking confirmed'}).waitFor();
  const seen=[...await page.evaluate(()=>[...window.seen])].join('\n');
  for(const text of ['Your booking is not confirmed yet','Checking the original reservation','Your original checkout','Server status'])
    assert.ok(!seen.includes(text),`unexpected interim text: ${text}`);
  const preparations=fixture.requests.filter(r=>r.action==='prepare');
  assert.equal(preparations.length,1);assert.equal(preparations[0].command.expectedPayableMinor,0);
  assert.equal(preparations[0].command.submissionAccepted,true);
  assert.ok(fixture.requests.some(r=>r.action==='status'));
  // First the invoice row is being prepared with a wait helper, then it updates by itself.
  await page.locator('[data-testid="event-funnel-invoice-row"][data-status="preparing"]').waitFor();
  await page.getByTestId('event-funnel-invoices-helper').waitFor();
  await page.locator('[data-testid="event-funnel-invoice-row"][data-status="ready"]').getByText('Invoice INV-FIXTURE').waitFor({timeout:10000});
  assert.equal(await page.getByTestId('event-funnel-invoices-helper').count(),0);
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download invoice'}).click();
  assert.equal((await downloaded).suggestedFilename(),'INV-FIXTURE.pdf');
  assert.deepEqual(fixture.invoiceRequests.at(-1),{action:'download',sessionId:id,orderId,
    invoiceId:'00000000-0000-4000-8000-000000000003'});
  await page.close();
});
test('an invoice list failure can be checked again without affecting the booking',async()=>{
  const page=await open(false,{invoiceFailure:true});
  await page.getByTestId('event-funnel-submit').click();
  await page.getByText('Invoices are not available right now. Your confirmed bookings have not changed.').waitFor();
  assert.equal(await page.getByRole('heading',{name:'Booking confirmed'}).count(),1);
  fixture.invoiceFailure=false;
  await page.getByRole('button',{name:'Check invoices again'}).click();
  await page.getByRole('button',{name:'Download invoice'}).waitFor();
  assert.equal(fixture.requests.filter(r=>r.action==='prepare').length,1);
  await page.close();
});
test('closed activation never presents confirmation',async()=>{
  const page=await open(true);
  await page.getByTestId('event-funnel-submit').click();
  await page.getByRole('heading',{name:'Checkout is not available yet'}).waitFor();
  assert.equal(fixture.order,null);
  assert.equal(await page.getByRole('heading',{name:'Booking confirmed'}).count(),0);
  await page.close();
});
test('verified cancellation permits an explicit return without preparing another order',async()=>{
  const page=await open(false,{order:{id:orderId,state:'payable',paymentMethod:'card',currency:'GBP',payableMinor:500},status:'processing'});
  await page.getByRole('button',{name:'Request cancellation',exact:true}).click();
  await page.getByRole('button',{name:'Request server cancellation',exact:true}).click();
  await page.getByTestId('event-funnel-return-reservation').click();
  await page.getByTestId('event-funnel-submit').waitFor();
  assert.equal(fixture.requests.filter(r=>r.action==='prepare').length,0);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),`event-funnel-checkout-attempt:${id}`),null);
  await page.close();
});
test('ambiguous setup resumes only the same verified payment after explicit action',async()=>{
  const page=await open(false,{order:{id:orderId,state:'payable',paymentMethod:'card',currency:'GBP',payableMinor:500},
    status:'requires_payment_method',failPayment:true});
  await page.getByTestId('event-funnel-resume-payment').click();
  await page.getByTestId('event-funnel-checkout-error').waitFor();
  await page.getByRole('button',{name:'Check booking status',exact:true}).click();
  const resume=page.getByRole('button',{name:'Resume verified original card payment'});
  await resume.waitFor();
  assert.equal(fixture.requests.filter(r=>r.action==='payment').length,1);
  await resume.click();
  await page.waitForFunction(()=>!document.querySelector('[data-testid="event-funnel-resume-payment"]'));
  assert.equal(fixture.requests.filter(r=>r.action==='payment').length,2);
  assert.ok(fixture.requests.filter(r=>r.action==='payment').every(r=>r.orderId===orderId));
  assert.equal(fixture.requests.filter(r=>r.action==='prepare').length,0);
  await page.close();
});
