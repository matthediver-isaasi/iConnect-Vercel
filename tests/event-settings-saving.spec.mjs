import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

let script;
test.beforeAll(async () => {
  const stubs = {
    'fixture-card': `import React from 'react'; export const EventClickCountMetric = () => null; export default function EventCard({event}) { return <div>{event.title}</div>; }`,
    '@/api/base44Client': `
      export const getActiveTenantId = () => 'fixture';
      export const subscribeToActiveTenantId = () => () => {};
      const settings = {
        list: async () => {
          const rows = JSON.parse(JSON.stringify(window.fixture.rows));
          if (window.fixture.delayRead) await new Promise(resolve => { window.fixture.finishRead = resolve; });
          return rows;
        },
        create: async data => window.fixture.write(null, data),
        update: async (id, data) => window.fixture.write(id, data),
      };
      export const base44 = { entities: new Proxy({
        SystemSettings: settings, Event: { list: async () => [] },
        Program: { filter: async () => [], create: async data => window.fixture.write(null, data) },
      }, { get: (target, key) => target[key] || { list: async () => [], listAll: async () => [], filter: async () => [] } }),
      functions: { invoke: async () => ({ data: { success: true } }) } };
    `,
    '@/hooks/useMemberAccess': `const allowed = () => false; export const useMemberAccess = () => ({
      isAdmin: true, isAccessReady: true, isFeatureExcluded: allowed,
    });`,
    '@/utils': `export const createPageUrl = name => '/' + name;`,
    '@/components/canvas/LucideIconPicker': 'export const LucideIconPicker = () => null;',
    '@/api/publicClient': `export const publicClient = new Proxy({}, {get: (_, key) => async () => key === 'listSystemSettings' ? window.fixture.rows : []});`,
    '@/contexts/LayoutContext': `export const useLayoutContext = () => ({ memberInfo: window.fixture.member ? { id: 'fixture-member' } : null });`,
    '@/hooks/useEventsData': `import {useQuery} from '@tanstack/react-query';
      export const useEventsData = () => useQuery({queryKey:['fixture-events'],queryFn:async()=> {
        await new Promise(resolve=>setTimeout(resolve, 150));
        return [{id:'tbc',title:'Fixture pre-registration',status:'tbc',is_online:true}];
      }});
      export const useMyGroupIds = () => ({data:[]});
      export const filterGroupEventVisibility = events => events;`,
    '@/hooks/useEventTypes': `export const useEventTypes = () => ({eventTypes:[]});`,
    '@/hooks/useTrainingAgendaSummaries': `export const useTrainingAgendaSummaries = () => ({});`,
    '@/hooks/useEventClickTracking': `export const useEventClickTracking = () => ({}); export const useEventClickCounts = () => ({data:{simple:{},complex:{}}});`,
    '@/lib/eventAttendeeCounts': `export const buildActiveAttendeeCountMap = () => ({}); export const fetchEventAttendeeCounts = async () => ({});`,
  };
  const result = await build({
    stdin: { contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
      import { BrowserRouter, useNavigate } from 'react-router-dom';
      import { Toaster } from 'sonner';
      import EventSettings from './client/src/pages/EventSettings.jsx';
      import Events from './client/src/pages/Events.jsx';
      import { useTbcSectionNavigation } from './client/src/hooks/useTbcSectionNavigation.js';
      import { normalizeTbcAnchor, DEFAULT_TBC_ANCHOR } from './client/src/lib/tbcEventsBanner.js';
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      if (window.fixture.cachedRows) queryClient.setQueryData(['system-settings'], window.fixture.cachedRows);
      window.refetchSettings = () => queryClient.invalidateQueries({ queryKey: ['system-settings'] });
      function NavigationFixture() {
        const [ready, setReady] = React.useState(false);
        const [visible, setVisible] = React.useState(window.fixture.visible !== false);
        const [count, setCount] = React.useState(0);
        const anchor = normalizeTbcAnchor(window.fixture.anchor);
        const navigate = useNavigate();
        window.showContent = () => setReady(true);
        window.refreshContent = () => setCount(n => n + 1);
        window.navigateHash = hash => navigate('/events' + hash);
        window.setVisible = setVisible;
        useTbcSectionNavigation({ anchor, visible: visible && ready, loading: !ready });
        return <>
          <header style={{position:'fixed',top:0,height:120,background:'white'}}>Fixed header</header>
          <div style={{height:1400}}>Events {count}</div>
          {ready && visible && <div id={anchor} style={{scrollMarginTop:'10rem',position:'relative'}}>
            {anchor !== DEFAULT_TBC_ANCHOR && <span id={DEFAULT_TBC_ANCHOR} style={{position:'absolute',top:0,scrollMarginTop:'10rem'}} />}
            Pre-registration
          </div>}
          <div style={{height:1400}} />
        </>;
      }
      createRoot(document.getElementById('root')).render(
        <BrowserRouter><QueryClientProvider client={queryClient}>
          {window.fixture.listing ? <Events /> : window.fixture.navigation ? <NavigationFixture /> : <EventSettings />}
          <Toaster />
        </QueryClientProvider></BrowserRouter>);
    `, resolveDir: process.cwd(), loader: 'jsx' },
    bundle: true, write: false, jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{
      name: 'isolated-event-settings',
      setup(api) {
        api.onResolve({ filter: /^@\// }, args => {
          if (stubs[args.path]) return { path: args.path, namespace: 'stub' };
          const base = path.resolve('client/src', args.path.slice(2));
          return { path: [base, `${base}.js`, `${base}.jsx`, `${base}.ts`, `${base}.tsx`]
            .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) };
        });
        api.onResolve({ filter: /^@shared\// }, args => {
          const base = path.resolve('shared', args.path.slice(8));
          return { path: [base, base + '.js', base + '.ts'].find(file => fs.existsSync(file)) };
        });
        api.onResolve({ filter: /components\/events\/EventCard$/ }, () => ({ path: 'fixture-card', namespace: 'stub' }));
        api.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: stubs[args.path], loader: 'jsx', resolveDir: process.cwd() }));
      },
    }],
  });
  script = result.outputFiles[0].text;
});

async function mount(page, options = {}, url = '/EventSettings') {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).pathname === '/api/zoom/webinars') return route.fulfill({json:[]});
    if (route.request().isNavigationRequest() && new URL(route.request().url()).hostname === 'settings.invalid') {
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    }
    errors.push(`Unexpected network: ${route.request().url()}`);
    return route.abort();
  });
  const render = async (rows = options.rows || []) => {
    await page.goto('http://settings.invalid' + url);
    await page.evaluate(({ options, rows }) => {
      window.fixture = { ...options, rows, writes: [] };
      window.fixture.write = async (id, data) => {
        const f = window.fixture;
        f.writes.push({ id, data, start: performance.now() });
        if (f.slow) await new Promise(resolve => { f.finish = resolve; });
        if (f.fail || (f.failKey && data.setting_key === f.failKey)) throw new Error('Injected failed earlier write');
        const existing = f.rows.find(row => row.id === id);
        const row = { ...existing, ...data, id: id || 'row-' + f.writes.length };
        f.rows = [...f.rows.filter(item => item.id !== row.id), row];
        return row;
      };
    }, { options, rows });
    await page.addScriptTag({ content: script });
    if (!options.navigation && !options.listing) await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeVisible();
  };
  await render();
  return { errors, render };
}

test('focused banner save survives reload and bypasses failed unrelated write', async ({ page }) => {
  const { errors, render } = await mount(page, { failKey: 'require_attendee_job_title' });
  await page.getByTestId('input-tbc-banner-jump-description').fill('My persisted helper');
  await page.getByTestId('input-tbc-banner-jump-label').fill('Join waiting list');
  await page.getByTestId('input-tbc-section-anchor').fill('waitinglist');
  await page.getByTestId('button-save-tbc-banner').click();
  await expect(page.getByText('Settings saved successfully', { exact: true })).toBeVisible();
  const rows = await page.evaluate(() => {
    if (window.fixture.writes.length !== 1) throw new Error('Expected exactly one request');
    return window.fixture.rows;
  });
  await render(rows);
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toHaveValue('My persisted helper');
  await expect(page.getByTestId('input-tbc-banner-jump-label')).toHaveValue('Join waiting list');
  await expect(page.getByTestId('input-tbc-section-anchor')).toHaveValue('waitinglist');
  expect(errors).toEqual([]);
});

test('slow save locks controls, rejects double click, and preserves other drafts across refetch', async ({ page }) => {
  await mount(page, { slow: true });
  await page.getByTestId('input-summary-max-length').fill('321');
  await page.getByTestId('input-seat-label-unlimited').fill('Draft seat label');
  await page.getByTestId('input-tbc-banner-jump-description').fill('Saved helper');
  await page.getByTestId('button-save-tbc-banner').evaluate(button => { button.click(); button.click(); });
  await expect(page.getByTestId('button-save-tbc-banner')).toHaveText('Saving…');
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeDisabled();
  await expect(page.getByTestId('input-summary-max-length')).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(1);
  await page.evaluate(async () => { await window.refetchSettings(); });
  await page.evaluate(() => window.fixture.finish());
  await expect(page.getByTestId('input-summary-max-length')).toBeEnabled();
  await expect(page.getByTestId('input-summary-max-length')).toHaveValue('321');
  await expect(page.getByTestId('input-seat-label-unlimited')).toHaveValue('Draft seat label');
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toHaveValue('Saved helper');
});

test('failure retains draft, clears pending, and supports retry without false success', async ({ page }) => {
  await mount(page, { fail: true });
  await page.getByTestId('input-tbc-banner-jump-description').fill('Retry me');
  await page.getByTestId('button-save-tbc-banner').click();
  await expect(page.getByText(/Could not save all selected settings/)).toBeVisible();
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toHaveValue('Retry me');
  await expect(page.getByText('Settings saved successfully', { exact: true })).toHaveCount(0);
  await page.evaluate(() => { window.fixture.fail = false; });
  await page.getByTestId('button-save-tbc-banner').click();
  await expect(page.getByText('Settings saved successfully', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.rows.length)).toBe(1);
});

test('cached rows never hydrate or enable saving before the fresh initial fetch', async ({ page }) => {
  await mount(page, {
    delayRead: true,
    cachedRows: [{id:'banner', setting_key:'tbc_events_banner', setting_value:JSON.stringify({jumpDescription:'Cached helper'})}],
    rows: [{id:'banner', setting_key:'tbc_events_banner', setting_value:JSON.stringify({jumpDescription:'Fresh helper'})}],
  });
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeDisabled();
  await expect(page.getByTestId('button-save-tbc-banner')).toBeDisabled();
  await page.evaluate(() => { window.fixture.delayRead = false; window.fixture.finishRead(); });
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeEnabled();
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toHaveValue('Fresh helper');
});

test('refetch updates acknowledged values without replacing a draft or falsely skipping its save', async ({ page }) => {
  await mount(page, {rows:[{id:'summary',setting_key:'event_summary_max_length',setting_value:'150'}]});
  await expect(page.getByTestId('input-summary-max-length')).toBeEnabled();
  await page.evaluate(async () => {
    window.fixture.rows[0].setting_value = '250';
    await window.refetchSettings();
  });
  await expect(page.getByTestId('input-summary-max-length')).toHaveValue('150');
  await page.getByTestId('button-save-summary-settings').click();
  await expect(page.getByText('Settings saved successfully', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.fixture.writes.map(write => write.data.setting_value))).toEqual(['150']);
});

test('PO email save does not persist a Stripe bank-account draft', async ({ page }) => {
  await mount(page);
  await page.getByTestId('input-xero-stripe-bank-code').fill('UNSAVED-BANK');
  await page.getByTestId('input-po-notification-email').fill('fixture@example.invalid');
  await page.getByTestId('button-save-po-notification-email').click();
  await expect(page.getByText('Settings saved successfully', {exact:true})).toBeVisible();
  expect(await page.evaluate(() => window.fixture.writes.map(write => write.data.setting_key))).toEqual(['po_submission_notification_email']);
  await expect(page.getByTestId('input-xero-stripe-bank-code')).toHaveValue('UNSAVED-BANK');
});

test('invalid anchors do not write; duplicate settings fail closed', async ({ page }) => {
  await mount(page, { rows: [
    { id: 'a', setting_key: 'tbc_events_banner', setting_value: '{}' },
    { id: 'b', setting_key: 'tbc_events_banner', setting_value: '{}' },
  ] });
  await page.getByTestId('input-tbc-section-anchor').fill('#invalid');
  await page.getByTestId('button-save-tbc-banner').click();
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(0);
  await page.getByTestId('input-tbc-section-anchor').fill('valid');
  await page.getByTestId('button-save-tbc-banner').click();
  await expect(page.getByText(/Duplicate setting/)).toBeVisible();
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(0);
});

test('independent event type save has the same pending and failure protection', async ({ page }) => {
  await mount(page, { slow: true, fail: true });
  const save = page.getByTestId('button-save-internal-event-types');
  await save.evaluate(button => { button.click(); button.click(); });
  await expect(save).toHaveText('Saving…');
  await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeDisabled();
  expect(await page.evaluate(() => window.fixture.writes.length)).toBe(1);
  await page.evaluate(() => window.fixture.finish());
  await expect(save).toBeEnabled();
  await expect(page.getByText(/Failed to save internal event types/)).toBeVisible();
});

for (const suffix of ['event-types', 'agenda-item-types', 'cost-types', 'cta-config', 'booking-terms']) {
  test(`independent ${suffix} save locks controls and releases them on success`, async ({ page }) => {
    await mount(page, { slow: true });
    const save = page.getByTestId('button-save-' + suffix);
    await save.evaluate(button => { button.click(); button.click(); });
    await expect(save).toHaveText('Saving…');
    await expect(page.getByTestId('input-tbc-banner-jump-description')).toBeDisabled();
    expect(await page.evaluate(() => window.fixture.writes.length)).toBe(1);
    await page.evaluate(() => window.fixture.finish());
    await expect(save).toBeEnabled();
  });
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`delayed custom and legacy anchors scroll once below the header (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const { errors } = await mount(page, { navigation: true, anchor: 'waitinglist' }, '/events#waitinglist');
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.evaluate(() => window.showContent());
    await expect.poll(() => page.locator('#waitinglist').evaluate(node => node.getBoundingClientRect().top)).toBe(160);
    await page.evaluate(() => { window.scrollTo(0, 0); window.refreshContent(); });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await page.evaluate(() => window.navigateHash('#unrelated'));
    await page.evaluate(() => window.navigateHash('#tbc-events-banner'));
    await expect.poll(() => page.locator('#waitinglist').evaluate(node => node.getBoundingClientRect().top)).toBe(160);
    expect(errors).toEqual([]);
  });
}

test('hidden/no-matching sections and unrelated hashes do not scroll or throw', async ({ page }) => {
  const { errors } = await mount(page, { navigation: true, visible: false }, '/events#tbc-events-banner');
  await page.evaluate(() => window.showContent());
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await page.evaluate(() => window.navigateHash('#unrelated'));
  await page.evaluate(() => window.setVisible(true));
  await expect(page.locator('#tbc-events-banner')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(errors).toEqual([]);
});

for (const member of [false, true]) {
  test(`actual ${member ? 'member' : 'guest'} listing renders persisted banner configuration`, async ({ page }) => {
    const { errors } = await mount(page, { listing: true, member, rows: [{
      id: 'banner', setting_key: 'tbc_events_banner', setting_value: JSON.stringify({
        enabled: true, sectionAnchor: 'waitinglist', title: 'Join upcoming events',
        jumpLabel: 'Go to waiting list', jumpDescription: 'Saved helper on listing', color: '#123456',
      }),
    }] }, '/events#waitinglist');
    await expect(page.locator('#waitinglist')).toContainText('Join upcoming events');
    await expect(page.getByText('Saved helper on listing', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to waiting list' })).toBeVisible();
    await expect(page.locator('#waitinglist')).toHaveCSS('background-color', 'rgb(18, 52, 86)');
    expect(errors).toEqual([]);
  });
}
