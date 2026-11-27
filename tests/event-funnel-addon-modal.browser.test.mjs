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
      import {BrowserRouter} from 'react-router-dom';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {ReservationBody} from './client/src/pages/EventReservation.jsx';
      const event={id:'conference',kind:'simple',tenantId:'fixture'};
      const nodes=[
        {id:'source',type:'source',event,ticketIds:['A'],requires:[],accept:'extra'},
        {id:'extra',type:'addon',event,ticketIds:['B'],requires:['source'],accept:'second',skip:'second',
          presentation:{heading:'Join our workshop',imageUrl:'/banner.svg',
            bodyHtml:'<p><strong>Hands-on learning</strong><script>window.injected=true</script><a href="javascript:alert(1)">Unsafe</a></p>'}},
        {id:'second',type:'addon',event,ticketIds:['C'],requires:['source'],accept:'checkout',skip:'checkout'},
        {id:'checkout',type:'checkout'}
      ];
      window.calls=[];window.selectors={};
      function App(){
        const [step,setStep]=useState('extra'),[revision,setRevision]=useState(1),[mode,setMode]=useState('');
        window.setMode=setMode;
        const route=step==='extra'?['source','extra']:step==='second'?['source','extra','second']:['source','extra','second','checkout'];
        const snapshot={session:{id:'fixture',revision,state:mode==='frozen'?'confirmed':'held',expires_at:new Date(Date.now()+600000).toISOString()},
          serverNow:new Date().toISOString(),graph:{nodes,entry:'source'},
          route:{route,currentNodeId:step,atCheckout:step==='checkout'},holds:[],drafts:{}};
        async function change(command){
          window.calls.push(command);
          setStep(command.nodeId==='extra'?'second':'checkout');setRevision(v=>v+1);
          return {ok:true};
        }
        return <ReservationBody snapshot={snapshot} change={change} refresh={()=>{}} pending={mode==='pending'}
          frozen={mode==='frozen'} expired={mode==='expired'} blocked={mode==='blocked'}
          canMutateOffer={()=>!mode} checkoutEligibility={{allowed:true}}
          renderEventFields={children=><div>{children}</div>} onNormal={()=>{}}/>;
      }
      createRoot(document.getElementById('root')).render(<BrowserRouter><QueryClientProvider client={new QueryClient({
        defaultOptions:{queries:{retry:false},mutations:{retry:false}}
      })}><App/></QueryClientProvider></BrowserRouter>);
    ` },
    bundle: true, write: false, format: 'esm', outdir: 'out', jsx: 'automatic',
    alias: { '@': path.resolve('client/src') },
    plugins: [{ name: 'isolated-event-page', setup(b) {
      b.onResolve({ filter: /\/(EventDetails|ComplexEventDetail)$/ }, () => ({ path: 'experience', namespace: 'fixture' }));
      b.onResolve({ filter: /EventFunnel(JourneyFrame|MembershipOffer|CheckoutSlot)$/ }, () => ({ path: 'empty', namespace: 'fixture' }));
      b.onResolve({ filter: /useEventFunnelEntry$/ }, () => ({ path: 'entry', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({
        loader: 'jsx',
        resolveDir: process.cwd(),
        contents: name === 'experience' ? `
          import React from 'react';import {useOwnedEventReservation} from '${path.resolve('client/src/contexts/EventReservationContext.jsx')}';
          function Experience(){const owned=useOwnedEventReservation();window.selectors[owned.offer.nodeId]=owned.select;
            return <section data-testid={'event-'+owned.offer.nodeId}><h2>{owned.offer.event.title}</h2>
              <p>Selected event details for {owned.offer.nodeId}</p><button disabled={owned.pending}
                onClick={()=>owned.select({tickets:[{id:'B',quantity:1}],answers:{name:'Fixture'}})}>Choose this extra</button></section>}
          export const EventDetailsExperience=Experience,ComplexEventDetailExperience=Experience;
        ` : name === 'entry' ? `
          export async function readEventFunnelOffer(session,node){return (await fetch('/offer/'+node)).json();}
          export const startEventFunnel=()=>{throw Error('Unexpected start')};
          export const useEventFunnelEntry=()=>({data:{active:false}});
        ` : 'export default function Empty(){return null};export const AcceptedMembershipSummary=()=>null;',
      }));
    } }],
  });
  const js = output.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = output.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  server = createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(js); return; }
    if (req.url === '/banner.svg') {
      res.setHeader('Content-Type', 'image/svg+xml');
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="130"><rect width="600" height="130" fill="#cce5e1"/><text x="20" y="70" font-size="26">Workshop</text></svg>'); return;
    }
    if (req.url.startsWith('/offer/')) {
      const nodeId = req.url.split('/').pop();
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ nodeId, eventId: 'conference', eventKind: 'simple',
        event: { title: 'Annual Conference' }, tickets: [{ id: 'B', name: 'Workshop' }],
        selectedTickets: [], draft: {} })); return;
    }
    if (req.url !== '/') { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><style>${css}
      body{font:16px system-ui;background:#eef3f5;padding:24px;color:#183342}
      [role=dialog]{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:white;padding:24px;width:min(600px,85vw);max-height:85vh;overflow:auto;border:1px solid #abc;border-radius:12px;z-index:50}
      [data-state=open][data-aria-hidden=true]{background:#0003}button{padding:8px;margin:4px}img{max-width:100%}fieldset{border:0}
    </style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(),
    headless: true, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

test('custom add-on modal stays over its event, closes without mutation and advances consecutive offers', async () => {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  await page.goto(origin);
  const dialog = page.getByTestId('addon-offer-dialog');
  await dialog.getByText('Join our workshop', { exact: true }).waitFor();
  await page.getByTestId('event-source').waitFor({ state: 'attached' });
  assert.equal(await page.getByTestId('event-source').locator('button').isDisabled(), true);
  assert.equal(await dialog.locator('img').count(), 1);
  assert.equal(await dialog.locator('strong').textContent(), 'Hands-on learning');
  assert.equal(await dialog.locator('script,[href^="javascript:"]').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.evaluate(() => window.selectors.source({ tickets: [{ id: 'A', quantity: 1 }] }));
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await mkdir('generated-artifacts/funnel-addon', { recursive: true });
  await page.screenshot({ path: 'generated-artifacts/funnel-addon/modal-desktop.png' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await page.getByTestId('addon-reopen').click();
  await dialog.waitFor();
  await dialog.getByTestId('addon-skip').click();
  await dialog.getByText('An optional extra for your event', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ type: 'skip', nodeId: 'extra' }]);
  assert.equal(await dialog.locator('img').count(), 0);
  await page.getByTestId('event-extra').waitFor({ state: 'attached' });
  await dialog.getByRole('button', { name: 'Choose this extra' }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.calls[1].nodeId), 'second');
  await page.close();
});

test('portal obeys pending, frozen, expired and blocked guards, including direct callbacks', async () => {
  for (const mode of ['pending', 'frozen', 'expired', 'blocked']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(origin);
    const dialog = page.getByTestId('addon-offer-dialog');
    await dialog.getByRole('button', { name: 'Choose this extra' }).waitFor();
    await page.evaluate(value => window.setMode(value), mode);
    assert.equal(await dialog.getByRole('button', { name: 'Choose this extra' }).isDisabled(), true, mode);
    await page.evaluate(() => window.selectors.extra({ tickets: [{ id: 'B', quantity: 1 }] }));
    assert.equal(await page.evaluate(() => window.calls.length), 0, mode);
    assert.equal(await dialog.getByTestId('addon-skip').isDisabled(), mode !== 'expired', mode);
    if (mode === 'expired') await page.screenshot({ path: 'generated-artifacts/funnel-addon/modal-mobile.png' });
    await page.close();
  }
});
