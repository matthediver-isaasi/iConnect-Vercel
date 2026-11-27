// Isolated UI evidence only: no tenant, database, storage or payment access.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';

let browser, server, origin;
before(async () => {
  const output = await build({
    stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
      import React,{useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {InPageBody} from './client/src/components/booking/EventFunnelInPageJourney.jsx';
      const event={id:'conference',kind:'simple',tenantId:'fixture'};
      const nodes=[
        {id:'source',type:'source',event,ticketIds:['A'],requires:[],accept:'extra'},
        {id:'extra',type:'addon',event,ticketIds:['B','C'],requires:['source'],accept:'checkout',skip:'checkout',
          presentation:{heading:'Join our workshop',imageUrl:'/banner.svg',bodyHtml:'<p><strong>Hands-on learning</strong><script>window.injected=true</script></p>'}},
        {id:'checkout',type:'checkout'}
      ];
      const sourceAnswers={purchaser:{first_name:'Pat',last_name:'Buyer',email:'pat@example.org'},terms_accepted:true,terms_content:'T',
        code_of_conduct_accepted:true,code_of_conduct_content:'C',
        attendeesByTicket:{A:[{first_name:'Ann',last_name:'A',email:'ann@example.org'},{first_name:'Bob',last_name:'B',email:'bob@example.org'}]}};
      window.calls=[];
      function App(){
        const [step,setStep]=useState('extra'),[revision,setRevision]=useState(1);
        const [requestError,setRequestError]=useState(null);
        const snapshot={session:{id:'fixture',revision,state:'held'},serverNow:new Date().toISOString(),graph:{nodes,entry:'source'},
          route:{route:['source','extra'],currentNodeId:step,atCheckout:step==='checkout'},holds:[],drafts:{source:sourceAnswers}};
        async function change(command){
          window.calls.push(command);
          if(window.rejectNextChoice){
            setRequestError({code:'INCOMPATIBLE_COMPANY',message:'These events use different payment or accounting accounts.'});
            return null;
          }
          setRequestError(null);setStep('checkout');setRevision(v=>v+1);return {ok:true};
        }
        return <main><h1>Spring Meeting</h1><InPageBody snapshot={snapshot} change={change} refresh={()=>{}} pending={false}
          frozen={false} expired={false} blocked={false} canMutateOffer={()=>true} checkoutEligibility={{allowed:true}}
          requestError={requestError} onExit={()=>{}}/></main>;
      }
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><App/></QueryClientProvider>);
    ` },
    bundle: true, write: false, format: 'esm', outdir: 'out', jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    plugins: [{ name: 'isolated', setup(b) {
      b.onResolve({ filter: /EventFunnel(JourneyFrame|CheckoutSlot)$/ }, () => ({ path: 'checkout', namespace: 'fixture' }));
      b.onResolve({ filter: /useEventFunnelEntry$/ }, () => ({ path: 'entry', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ loader: 'jsx', resolveDir: process.cwd(),
        contents: name === 'entry' ? `export async function readEventFunnelOffer(session,node){return (await fetch('/offer/'+node)).json();}`
          : `export default function Checkout(){return <p data-testid="cart">Cart</p>};export const EventFunnelCheckoutSlot=Checkout;` }));
    } }],
  });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = output.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (req.url === '/banner.svg') { res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200"><rect width="600" height="200" fill="#cce5e1"/></svg>'); return; }
    if (req.url.startsWith('/offer/')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ nodeId: 'extra', eventId: 'conference', eventKind: 'simple', selectionMode: 'multiple',
        event: { title: 'Spring Meeting' }, tickets: [{ id: 'B', name: 'Workshop', price: 40, remaining: 5 }, { id: 'C', name: 'Dinner', price: 0, is_free: true, remaining: null }],
        selectedTickets: [], draft: {} })); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><style>${css} body{font:16px system-ui;padding:24px}
      [role=dialog]{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:white;width:min(600px,90vw);max-height:85vh;overflow:auto;border:1px solid #abc;border-radius:12px}
      img{max-width:100%;display:block}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test('add-on step shows banner, heading, text and its tickets only, then hands over to the cart', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(origin);
  const dialog = page.getByTestId('journey-step-dialog');
  await dialog.getByText('Join our workshop', { exact: true }).waitFor();
  await dialog.getByTestId('journey-step-ticket-B').waitFor();
  assert.equal(await dialog.getByTestId('journey-step-banner').count(), 1);
  assert.equal(await dialog.locator('strong').textContent(), 'Hands-on learning');
  assert.equal(await dialog.locator('script').count(), 0);
  assert.equal(await dialog.getByText('Spring Meeting').count(), 0, 'the source event is not repeated in the modal');
  assert.equal(await dialog.getByTestId('journey-step-continue').isDisabled(), true);
  await dialog.getByTestId('journey-step-ticket-B').getByText('Bob B').click();
  await mkdir('generated-artifacts/funnel-in-page', { recursive: true });
  await page.screenshot({ path: 'generated-artifacts/funnel-in-page/addon-step.png' });
  await dialog.getByTestId('journey-step-continue').click();
  await page.getByTestId('cart').waitFor();
  const [command] = await page.evaluate(() => window.calls);
  assert.deepEqual(command.tickets, [{ id: 'B', quantity: 1 }]);
  assert.equal(command.answers.attendeesByTicket.B[0].email, 'bob@example.org');
  assert.equal(command.answers.terms_accepted, true);
  assert.equal(command.answers.purchaser.email, 'pat@example.org');
  assert.equal(await page.getByTestId('journey-step-dialog').count(), 0);
  await page.close();
});

test('skip records an explicit skip and closing keeps the reservation unchanged', async () => {
  const page = await browser.newPage();
  await page.goto(origin);
  const dialog = page.getByTestId('journey-step-dialog');
  await dialog.getByTestId('journey-step-ticket-B').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await page.getByTestId('journey-step-reopen').click();
  await dialog.getByTestId('journey-step-skip').click();
  await page.getByTestId('cart').waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ type: 'skip', nodeId: 'extra' }]);
  await page.close();
});

test('a rejected add-on shows its server reason in the modal and keeps the selection for retry', async () => {
  const page = await browser.newPage();
  await page.goto(origin);
  const dialog = page.getByTestId('journey-step-dialog');
  await dialog.getByTestId('journey-step-ticket-B').waitFor();
  await dialog.getByTestId('journey-step-ticket-B').getByText('Bob B').click();
  await page.evaluate(() => { window.rejectNextChoice = true; });
  await dialog.getByTestId('journey-step-continue').click();
  await dialog.getByRole('alert').getByText('These events use different payment or accounting accounts.', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('We could not save that choice. Your reservation is unchanged.').count(), 0);
  assert.equal(await page.getByTestId('cart').count(), 0);
  assert.equal(await dialog.getByTestId('journey-step-ticket-B').getByRole('checkbox').nth(1).getAttribute('aria-checked'), 'true');
  await page.evaluate(() => { window.rejectNextChoice = false; });
  await dialog.getByTestId('journey-step-continue').click();
  await page.getByTestId('cart').waitFor();
  await page.close();
});
