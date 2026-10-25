import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';

const stubs = {
  '@/api/base44Client': `
    export const getActiveTenantId=()=> 'tenant'; export const subscribeToActiveTenantId=()=>()=>{};
    const empty={list:async()=>[],listAll:async()=>[],filter:async()=>[]};
    export const base44={entities:new Proxy({}, {get:(_,key)=>key==='ComplexEvent'?{list:async()=>window.fixture.events.filter(e=>e.is_complex)}:key==='Booking'||key==='ComplexEventBooking'?{filter:async()=>{window.bookingReads++;return [{id:'booking',status:'confirmed',attendee_first_name:'Booked',attendee_last_name:'Person',attendee_email:'booked@example.invalid'}]}}:empty}),auth:{me:async()=>window.fixture.member},functions:{invoke:async()=>({})}};
    export const createClient=()=>base44;
  `,
  '@/api/publicClient': `export const publicClient={listSystemSettings:async()=>[],getTenantSlug:()=> 'tenant'};`,
  '@/lib/adminFetch': `export const adminFetch=(url,opts)=>fetch(url,opts);`,
  '@/lib/adminOrgList': `export const listAllOrganizationsForAdmin=async()=>[];`,
  '@/contexts/LayoutContext': `export const useLayoutContext=()=>({memberInfo:window.fixture.member,isFeatureExcluded:()=>false});`,
  '@/hooks/useMemberAccess': `export const useMemberAccess=()=>({isFeatureExcluded:()=>false,memberRole:{is_admin:true}});`,
  '@/hooks/useEventsData': `export const useEventsData=()=>({data:window.fixture.events.filter(e=>!e.is_complex)});export const useMyGroupIds=()=>({data:[]});export const filterGroupEventVisibility=e=>e;`,
  '@/hooks/useTrainingAgendaSummaries': `export const useTrainingAgendaSummaries=()=>({});`,
  '@/hooks/useEventTypes': `export const useEventTypes=()=>({eventTypes:[]});`,
  '@/hooks/useEventClickTracking': `export const useEventClickTracking=()=>({});export const useEventClickCounts=()=>({data:{simple:{},complex:{}}});`,
};
const resolveSource = base => ['', '.jsx', '.js', '.ts', '.tsx', '/index.js', '/index.ts', '/index.jsx'].map(ext => base + ext).find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || base;
let script, css;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
      import {MemoryRouter} from 'react-router-dom';
      import Events from './client/src/pages/Events.jsx';
      const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
      createRoot(document.getElementById('root')).render(<QueryClientProvider client={client}><MemoryRouter initialEntries={['/events']}><Events memberInfo={window.fixture.member} isFeatureExcluded={()=>false}/></MemoryRouter></QueryClientProvider>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env.DEV': 'false' },
    plugins: [{ name: 'isolated-events', setup(api) {
      api.onResolve({ filter: /.*/ }, args => {
        const normalized = args.path.startsWith('.') ? path.resolve(args.resolveDir, args.path) : '';
        const stubKey = Object.keys(stubs).find(key => key === args.path || normalized === path.resolve('client/src', key.slice(2)) || normalized === path.resolve('client/src', key.slice(2) + '.js'));
        if (stubKey) return { path: stubKey, namespace: 'stub' };
        if (/PageTour|TourButton/.test(args.path)) return { path: 'empty', namespace: 'stub' };
        if (args.path.startsWith('@/')) return { path: resolveSource(path.resolve('client/src', args.path.slice(2))) };
        if (args.path.startsWith('@shared/')) return { path: resolveSource(path.resolve('shared', args.path.slice(8))) };
      });
      api.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path] || 'export default function Empty(){return null}', loader: 'jsx' }));
    } }],
  });
  script = result.outputFiles[0].text;
  css = (await postcss([tailwindcss({
    content: ['client/src/pages/Events.jsx', 'client/src/components/events/*.jsx', 'client/src/components/ui/*.jsx'],
  })]).process('@tailwind base; @tailwind components; @tailwind utilities;', { from: undefined })).css;
});
const events = [
  { id: 'simple-wait', title: 'Simple Waiting', waiting_list_enabled: true },
  { id: 'complex-wait', title: 'Complex Waiting', waiting_list_enabled: true, is_complex: true },
  { id: 'ordinary', title: 'Ordinary Event' },
].map(event => ({ ...event, status: 'published', start_date: '2099-01-01T10:00:00Z', timezone: 'Europe/London', available_seats: 0 }));
async function mount(page, { fail = false, empty = false, status = 'published', featured = false, countsFail = false, delay = 0 } = {}) {
  const reads = [];
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/events') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (url.pathname === '/api/admin/events/attendee-counts') {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return route.fulfill({ status: countsFail ? 503 : 200, json: { counts: { 'simple-wait': empty ? 0 : 27, 'complex-wait': empty ? 0 : 27, ordinary: 1 } } });
    }
    if (url.pathname === '/api/admin/event-waiting-list') {
      reads.push(Object.fromEntries(url.searchParams));
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return route.fulfill({ status: fail ? 503 : 200, json: fail ? { error: 'Unavailable' } : { entries: empty ? [] : [
        ...Array.from({ length: 27 }, (_, i) => ({ id: `entry-${i}`, registration_id: 'one-registration', first_name: `Person${String(i).padStart(2, '0')}`, last_name: 'Waiting', email: `person${i}@example.invalid`, status: 'active', ticket_name: 'Standard' })),
        { id: 'withdrawn', first_name: 'Withdrawn', status: 'withdrawn' },
      ] } });
    }
    if (url.origin === 'http://waiting.test' && route.request().method() === 'GET' && url.pathname.startsWith('/api/')) return route.fulfill({ json: [] });
    throw new Error(`Unexpected network request: ${route.request().method()} ${url.pathname}`);
  });
  await page.goto('http://waiting.test/events');
  await page.evaluate(({ events }) => {
    window.fixture = { events, member: { id: 'member', tenant_id: 'tenant', page_tours_seen: { Events: true } } };
    window.bookingReads = 0;
  }, { events: events.map(event => ({ ...event, status, is_featured: featured })) });
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  return reads;
}
for (const status of ['published', 'tbc']) {
  test(`events ${status} cards show waiting entries, search, paginate and export without booking mutations`, async ({ page }) => {
    const reads = await mount(page, { status });
    await expect(page.getByRole('button', { name: 'Waiting list: 27', exact: true })).toHaveCount(2);
    expect(reads).toHaveLength(0);
    for (const kind of ['simple', 'complex']) {
      await page.getByTestId(`button-attendees-event-${kind}-wait`).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading')).toHaveText(`Waiting List - ${kind === 'simple' ? 'Simple' : 'Complex'} Waiting`);
      await expect(dialog.getByText('Total waiting-list entries: 27')).toBeVisible();
      await expect(dialog.getByRole('row')).toHaveCount(26);
      await dialog.getByRole('button', { name: 'Next', exact: true }).click();
      await expect(dialog.getByText('Person26 Waiting', { exact: true })).toBeVisible();
      await dialog.getByRole('textbox').fill('person2@example.invalid');
      await expect(dialog.getByRole('row')).toHaveCount(2);
      const download = page.waitForEvent('download');
      await dialog.getByRole('button', { name: 'Export CSV' }).click();
      const file = await download;
      expect(fs.readFileSync(await file.path(), 'utf8')).toContain('person2@example.invalid');
      await expect(dialog.getByRole('button', { name: /import|confirmation|cancel/i })).toHaveCount(0);
      await expect(dialog.getByText('Withdrawn', { exact: true })).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
    expect(reads.map(row => row.event_kind)).toEqual(['simple', 'complex']);
    expect(await page.evaluate(() => window.bookingReads)).toBe(0);
    await page.getByRole('button', { name: 'Attendees: 1', exact: true }).click();
    await expect(page.getByRole('dialog').getByText('Booked Person', { exact: true })).toBeVisible();
  });
}
test('failed requests show error rather than zero or empty', async ({ page }) => {
  await mount(page, { fail: true });
  await page.getByRole('button', { name: 'Waiting list: 27', exact: true }).first().click();
  await expect(page.getByRole('alert')).toContainText('Unable to load waiting list');
  await expect(page.getByText('No active waiting-list entries yet.')).toHaveCount(0);
});
test('zero entries have an explicit empty state', async ({ page }) => {
  await mount(page, { empty: true });
  await page.getByRole('button', { name: 'Waiting list: 0', exact: true }).first().click();
  await expect(page.getByText('No active waiting-list entries yet.')).toBeVisible();
});

test('featured variants open the same waiting-list source for both event kinds', async ({ page }) => {
  await mount(page, { featured: true });
  const featured = page.getByTestId('card-featured-events');
  for (const kind of ['simple', 'complex']) {
    await featured.getByTestId(`button-attendees-event-${kind}-wait`).click();
    await expect(page.getByRole('dialog').getByRole('heading')).toHaveText(`Waiting List - ${kind === 'simple' ? 'Simple' : 'Complex'} Waiting`);
    await expect(page.getByText('Total waiting-list entries: 27')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});
test('loading counts and modal results are not zero', async ({ page }) => {
  await mount(page, { delay: 1200 });
  await expect(page.getByRole('button', { name: 'Waiting list count loading', exact: true })).toHaveCount(2);
  await page.getByTestId('button-attendees-event-simple-wait').click();
  await expect(page.getByRole('dialog').getByText('Loading waiting list…')).toBeVisible();
  await expect(page.getByText('Total waiting-list entries: 27')).toBeVisible();
});
test('failed counts stay unavailable but allow opening the waiting list', async ({ page }) => {
  await mount(page, { countsFail: true });
  await expect(page.getByRole('button', { name: 'Waiting list count unavailable', exact: true })).toHaveCount(2);
  await page.getByTestId('button-attendees-event-complex-wait').click();
  await expect(page.getByText('Total waiting-list entries: 27')).toBeVisible();
});
