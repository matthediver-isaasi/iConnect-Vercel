import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Funnel discount codes: inline Apply/Remove, preview on the source line and
// totals, the code sent with the quote, and the server quote as authority.
let browser,server,origin,fixture;
const id='00000000-0000-4000-8000-000000000001';
const lines=[{nodeId:'source',ticketId:'A',quantity:1,eventTitle:'Spring Meeting',ticketName:'Delegate',unitMinor:10000,amountMinor:10000,taxPercentage:null,includedTaxMinor:0},
  {nodeId:'addon',ticketId:'P',quantity:1,eventTitle:'Spring Meeting',ticketName:'Parking',unitMinor:2000,amountMinor:2000,taxPercentage:null,includedTaxMinor:0}];
function quote(discountMinor) {
  const quoted=lines.map(line=>{
    const saving=line.nodeId==='source'?discountMinor:0;
    return {nodeId:line.nodeId,ticketId:line.ticketId,quantity:1,listMinor:line.amountMinor,discountMinor:saving,
      amountMinor:line.amountMinor-saving,payableMinor:line.amountMinor-saving,trainingFundMinor:0,voucherMinor:0};
  });
  return {revision:2,currency:'GBP',payableMinor:12000-discountMinor,trainingFundMinor:0,voucherMinor:0,
    discountMinor,discountCode:discountMinor?'SPRING10':null,paymentMethod:'card',paymentMethods:['card'],invoiceMode:'per_event',lines:quoted};
}
before(async()=>{
  const output=await build({stdin:{resolveDir:process.cwd(),loader:'jsx',contents:`
    import React from 'react';import {createRoot} from 'react-dom/client';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import Checkout from './client/src/components/booking/EventFunnelCheckoutSlot.jsx';
    const snapshot={session:{id:'${id}',revision:2,state:'held',journey:{checkoutNow:true}}};
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient()}><Checkout snapshot={snapshot}
      checkoutEligibility={{allowed:true,canSubmitNow:()=>true}} change={async()=>{}} refresh={async()=>{}}/></QueryClientProvider>);
  `},bundle:true,write:false,outdir:'out',format:'esm',jsx:'automatic',loader:{'.css':'empty'},
    alias:{'@':path.resolve('client/src')},plugins:[{name:'isolated-provider-ui',setup(b){
      b.onResolve({filter:/(EventFunnelCheckoutPayment|useBookingVouchers)$/},args=>({path:args.path,namespace:'fixture'}));
      b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export default function Fixture(){return null}; export function useBookingVouchers(){return {data:[]}}',loader:'js'}));
    }}]});
  const js=output.outputFiles.find(file=>file.path.endsWith('.js')).text;
  server=createServer(async(req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
    if(req.url==='/api/event-funnels/checkout'){
      let raw='';for await(const part of req)raw+=part;
      const body=JSON.parse(raw);fixture.requests.push(body);
      res.setHeader('Content-Type','application/json');
      if(body.action==='summary') return res.end(JSON.stringify({revision:2,currency:'GBP',totalMinor:12000,paymentMethods:['card'],
        atCheckout:true,customers:[],memberFunding:false,trainingFund:{enabled:false},discountCodes:{enabled:true},order:null,lines}));
      if(body.action==='discount') {
        if(body.command.discountCode!=='SPRING10'){res.statusCode=409;return res.end(JSON.stringify({error:'Invalid or inactive discount code',code:'DISCOUNT_INVALID'}));}
        return res.end(JSON.stringify({revision:2,code:'SPRING10',discountMinor:1000,lines:[{nodeId:'source',ticketId:'A',discountMinor:1000}]}));
      }
      if(body.action==='quote') return res.end(JSON.stringify(quote(body.command.discountCode?fixture.serverDiscount:0)));
      res.statusCode=400;return res.end('{}');
    }
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><div id="root"></div><script type="module" src="/app.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({executablePath:execFileSync('which',['chromium'],{encoding:'utf8'}).trim(),headless:true,args:['--no-sandbox']});
});
async function fillAddress(page) {
  for(const input of await page.locator('input[required]').all()) if(!(await input.inputValue())) await input.fill('Fixture');
  const country=page.locator('select[required]');
  for(const select of await country.all()) await select.selectOption({index:1});
}
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

test('discount code applies inline to the source ticket only and is sent with the quote',async()=>{
  fixture={requests:[],serverDiscount:1000};
  const page=await browser.newPage();
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin);await page.getByTestId('event-funnel-checkout').waitFor();
  const input=page.getByRole('textbox',{name:'Discount code'});
  await input.fill('wrong');
  await page.getByRole('button',{name:'Apply'}).click();
  await page.getByRole('alert').filter({hasText:'Invalid or inactive discount code'}).waitFor();
  assert.equal(await page.getByTestId('event-funnel-checkout').getByText('Invalid or inactive discount code').count(),1);
  await input.fill('spring10');
  await page.getByRole('button',{name:'Apply'}).click();
  await page.getByText('Saving £10.00 on your main event ticket').waitFor();
  assert.equal(await page.getByTestId('event-funnel-total').textContent(),'£110.00');
  assert.match(await page.locator('[data-testid^="event-funnel-cart-discount-"]').first().textContent(),/£100\.00£90\.00Discount −£10\.00/);
  assert.equal(await page.locator('[data-testid^="event-funnel-cart-discount-"]').count(),1);
  await fillAddress(page);
  await page.getByRole('button',{name:'Review order'}).click();
  await page.getByRole('region',{name:'Payment summary'}).getByText('Discount (SPRING10):').waitFor();
  assert.equal(fixture.requests.find(r=>r.action==='quote').command.discountCode,'SPRING10');
  await page.close();
});

test('removing the code clears the saving and the next quote has no code',async()=>{
  fixture={requests:[],serverDiscount:1000};
  const page=await browser.newPage();
  await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  await page.goto(origin);await page.getByTestId('event-funnel-checkout').waitFor();
  await page.getByRole('textbox',{name:'Discount code'}).fill('SPRING10');
  await page.getByRole('button',{name:'Apply'}).click();
  await page.getByRole('button',{name:'Remove'}).last().click();
  await page.getByRole('textbox',{name:'Discount code'}).waitFor();
  assert.equal(await page.getByTestId('event-funnel-total').textContent(),'£120.00');
  await fillAddress(page);
  await page.getByRole('button',{name:'Review order'}).click();
  await page.getByTestId('event-funnel-confirm').waitFor();
  assert.equal(fixture.requests.filter(r=>r.action==='quote').at(-1).command.discountCode,undefined);
  await page.close();
});
