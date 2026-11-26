import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
let server, browser, origin;
const calls = [];
before(async () => {
  const result = await build({ stdin: { resolveDir: process.cwd(), loader: 'jsx', contents: `
    import React,{useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {MemoryRouter,useLocation} from 'react-router-dom';
    import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    import {useEventReservation} from './client/src/contexts/EventReservationContext.jsx';
    import {ReservationOffer} from './client/src/pages/EventReservation.jsx';
    function App(){
      const [ticket,setTicket]=useState('class-0'),[name,setName]=useState('Alex'),[quantity,setQuantity]=useState(3);
      const location=useLocation();
      const reservation=useEventReservation({eventId:'00000000-0000-4000-8000-000000000002',eventKind:'complex',
        viewerKey:'member',selectedTicketIds:[ticket]});
      const [normal,setNormal]=useState(null);
      if(window.location.pathname==='/switch')return <main>
        <ReservationOffer nodeId="source" pending={false} change={()=>{throw new Error('Wrong command path')}}
          onSaved={()=>{}} onNormal={setNormal} snapshot={{
          session:{id:'00000000-0000-4000-8000-000000000010',revision:7,source_ticket_id:'class-0'},
          purchaser:{first_name:'Original'},holds:[],graph:{entry:'source',nodes:[]}
        }}/>
        {normal&&<output data-testid="normal-ticket">{normal.offer.selectedTickets[0].id}</output>}
        <output data-testid="path">{location.pathname}</output>
      </main>;
      return <main><select aria-label="Ticket" value={ticket} onChange={e=>setTicket(e.target.value)}>
        {Array.from({length:21},(_,i)=><option key={i} value={'class-'+i}>{'Ticket '+i}</option>)}
      </select><input aria-label="Attendee" value={name} onChange={e=>setName(e.target.value)}/>
      <input aria-label="Quantity" type="number" value={quantity} onChange={e=>setQuantity(Number(e.target.value))}/>
      <button disabled={reservation.loading||reservation.pending} onClick={()=>reservation.submit({
        tickets:[{id:ticket,quantity}],answers:{attendees:[{first_name:name}]}})}>Continue</button>
      <output data-testid="mode">{reservation.normalCheckout?'normal':reservation.singleChoice?'single':'legacy'}</output>
      <output data-testid="path">{location.pathname}</output>
      {reservation.error&&<p role="alert">{reservation.error.message}</p>}
      </main>;
    }
    createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><App/></MemoryRouter></QueryClientProvider>);
  ` }, bundle: true, write: false, outdir: '/tmp/ticket-routing-browser-fixture', format: 'iife', jsx: 'automatic',
    alias: { '@': `${process.cwd()}/client/src` }, define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'isolated-event-fields', setup(build) {
      build.onResolve({ filter: /EventFunnel(JourneyFrame|CheckoutSlot)$/ }, () => ({ path: 'unused-shell', namespace: 'unused-shell' }));
      build.onLoad({ filter: /.*/, namespace: 'unused-shell' }, () => ({ contents: 'export default function UnusedShell(){return null;}' }));
      build.onResolve({ filter: /^\.\/(EventDetails|ComplexEventDetail)$/ }, args =>
        args.importer.endsWith('/EventReservation.jsx') ? { path: args.path, namespace: 'event-field-fixture' } : null);
      build.onLoad({ filter: /.*/, namespace: 'event-field-fixture' }, () => ({
        resolveDir: process.cwd(), loader: 'jsx', contents: `
          import React from 'react';
          import {useOwnedEventReservation} from './client/src/contexts/EventReservationContext.jsx';
          export function EventDetailsExperience(){const owned=useOwnedEventReservation();
            return <section><p>Original attendee answers</p>
            {['class-0','class-1','class-2','class-20'].map(id=><button key={id} onClick={()=>owned.select({
              tickets:[{id,quantity:3}],answers:{purchaser:{first_name:'Original'},attendees:[{first_name:'Jordan'}]}})}>{'Choose '+id}</button>)}</section>;
          }
          export const ComplexEventDetailExperience=EventDetailsExperience;
        `,
      }));
    } }],
  });
  const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text || '';
  server = createServer(async (req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(js); return; }
    if (req.url.startsWith('/api/event-funnels/entry')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ active: true, routing: 'ticket', selectionMode: 'single' })); return;
    }
    if (req.url === '/api/event-funnels/start') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body); calls.push(input);
      res.setHeader('Content-Type', 'application/json');
      if (input.tickets[0].id === 'class-20') {
        res.statusCode = 503; res.end(JSON.stringify({ error: 'Routing could not be verified.' })); return;
      }
      res.end(JSON.stringify(['class-0', 'class-2'].includes(input.tickets[0].id)
        ? { active: false, outcome: 'normal', reason: 'no_match' }
        : { outcome: 'funnel', session: { id: input.requestId } })); return;
    }
    if (req.url === '/api/event-funnels/offer') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ nodeId: 'source', eventId: '00000000-0000-4000-8000-000000000002',
        eventKind: 'complex', event: {}, tickets: [], sourceSwitch: true, selectionMode: 'single' })); return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><style>${css}</style></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: execFileSync('which', ['chromium'], { encoding: 'utf8' }).trim(), headless: true, args: ['--no-sandbox'] });
});
test('editing the initial ticket uses a source restart, retains errors, and handles a normal-checkout result', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(`${origin}/switch`);
    await page.getByRole('button', { name: 'Choose class-20', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.match(await page.getByRole('alert').innerText(), /previous reservation has been kept/);
    assert.equal(calls.at(-1).previousSessionId, '00000000-0000-4000-8000-000000000010');
    assert.equal(calls.at(-1).expectedRevision, 7);
    await page.getByRole('button', { name: 'Choose class-1', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=path]').textContent === '/EventReservation');
    await page.goto(`${origin}/switch`);
    await page.getByRole('button', { name: 'Choose class-2', exact: true }).click();
    await page.getByTestId('normal-ticket').waitFor();
    assert.equal(await page.getByTestId('normal-ticket').innerText(), 'class-2');
    assert.equal(calls.at(-1).answers.attendees[0].first_name, 'Jordan');
  } finally { await page.close(); }
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
test('ticket-aware entry keeps 21 choices, preserves no-match answers, and reroutes a changed class', async () => {
  const page = await browser.newPage();
  try {
    await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    await page.goto(origin);
    await page.getByText('single', { exact: true }).waitFor();
    assert.equal(await page.locator('option').count(), 21);
    await page.getByLabel('Attendee').fill('Jordan');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByText('normal', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Attendee').inputValue(), 'Jordan');
    assert.equal(await page.getByLabel('Quantity').inputValue(), '3');
    await page.getByLabel('Ticket', { exact: true }).selectOption('class-20');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('alert').waitFor();
    assert.equal(await page.getByTestId('mode').innerText(), 'single');
    assert.equal(await page.getByTestId('path').innerText(), '/');
    await page.getByLabel('Ticket', { exact: true }).selectOption('class-1');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid=path]').textContent === '/EventReservation');
    assert.equal(calls.at(-1).tickets[0].id, 'class-1');
    assert.equal(calls.at(-1).tickets[0].quantity, 3);
    assert.equal(calls.at(-1).versionId, undefined);
  } finally { await page.close(); }
});
